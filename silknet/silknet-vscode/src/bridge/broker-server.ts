// Silknet — the local WebSocket bridge broker.
//
// Hosted BY this VS Code extension (Node has no browser CORS restrictions, so
// it can call Ollama directly; a Chrome-hosted server would fight CORS).
//
// Security posture:
//   - bound to 127.0.0.1 ONLY, never 0.0.0.0;
//   - token checked AT THE UPGRADE — an unauthenticated socket is never
//     accepted, so it cannot be flooded before rejection;
//   - nothing is processed before AUTH_OK: exactly 0 pre-auth application
//     messages are accepted (any such message is a protocol violation → close);
//   - full schema validation at the parse layer before any processing;
//   - rate limit 10 msg/s, payload cap 512 KB, max 1 concurrent debate;
//   - single-session: a new authenticated client replaces the old one, and the
//     token rotates whenever the broker restarts.

import { WebSocketServer, type WebSocket } from 'ws';
import { generateSessionToken, originAllowed, authenticateUpgrade } from './auth';
import { HEARTBEAT_INTERVAL_MS, startHeartbeat, type HeartbeatHandle } from './heartbeat';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeMessage,
  protocolVersionsCompatible,
  type BridgeMessage,
} from './message-schema';

// ---------------------------------------------------------------------------
// Limits (the brief's concrete v1.0 starting values)
// ---------------------------------------------------------------------------

export const BRIDGE_LIMITS = {
  /** Max messages/second per connection. */
  maxMessagesPerSecond: 10,
  /** Max concurrent debates. */
  maxConcurrentDebates: 1,
  /** Max message payload size in bytes. */
  maxPayloadBytes: 512 * 1024,
  /** Max messages accepted before AUTH succeeds. */
  maxPreAuthMessages: 0,
} as const;

const RATE_WINDOW_MS = 1_000;

// ---------------------------------------------------------------------------
// Server-side state
// ---------------------------------------------------------------------------

export interface BrokerOptions {
  port: number;
  /** Called with the fresh human-readable token for the user to copy across. */
  onToken: (token: string) => void;
  onClientConnected: () => void;
  onClientDisconnected: () => void;
  /** Handles one validated, authenticated application message from the client. */
  onClientMessage: (message: BridgeMessage) => void;
  /** Log sink (VS Code output channel). Never log tokens. */
  log: (line: string) => void;
}

type ClientState = 'awaiting-hello' | 'awaiting-auth' | 'authenticated';

interface ClientSession {
  ws: WebSocket;
  state: ClientState;
  sessionId: string;
  /** Rate limiter: accept timestamps inside the current 1s window. */
  acceptedAt: number[];
  heartbeat: HeartbeatHandle | null;
}

export interface BrokerHandle {
  port: number;
  /** The CURRENT session token. Rotates on every broker start. Never log it. */
  token: string;
  close(): Promise<void>;
  /** Push a message to the connected, authenticated client. False if none. */
  sendToClient(message: BridgeMessage): boolean;
  isClientAuthenticated(): boolean;
  /** This broker's single-debate slot (max 1 concurrent debate). */
  debateSlot: DebateSlot;
}

// ---------------------------------------------------------------------------
// The single debate slot (max 1 concurrent debate) — PER BROKER INSTANCE.
// State deliberately lives in the startBroker closure, not at module scope:
// two broker instances (e.g. tests, or a restart) must never share a claim.
// ---------------------------------------------------------------------------

export interface DebateSlot {
  /** Claims the slot; false when another debate currently holds it. */
  claim(debateId: string): boolean;
  /** Releases the slot when (and only when) `debateId` holds it. */
  release(debateId: string): void;
  current(): string | null;
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export function startBroker(options: BrokerOptions): BrokerHandle {
  const log = options.log;
  const token = generateSessionToken();
  options.onToken(token);
  log(`Silknet bridge listening on ws://127.0.0.1:${options.port} (loopback only)`);

  const debateSlot: DebateSlot = (() => {
    let holder: string | null = null;
    return {
      claim(debateId: string): boolean {
        if (holder !== null && holder !== debateId) return false;
        holder = debateId;
        return true;
      },
      release(debateId: string): void {
        if (holder === debateId) holder = null;
      },
      current: (): string | null => holder,
    };
  })();

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port,
    maxPayload: BRIDGE_LIMITS.maxPayloadBytes,
    // Runs during the HTTP upgrade: rejecting here means an unauthenticated
    // socket is never accepted at all, so there is nothing to flood.
    verifyClient: (info, done) => {
      const origin = info.req.headers.origin;
      if (!originAllowed(typeof origin === 'string' ? origin : undefined)) {
        done(false, 403, 'origin not allowed');
        return;
      }
      const auth = authenticateUpgrade(info.req, token);
      if (!auth.ok) {
        log(`bridge upgrade rejected: ${auth.reason}`);
        done(false, 401, 'bridge authentication failed (see VS Code extension)');
        return;
      }
      done(true);
    },
  });

  wss.on('error', (err: Error) => {
    log(`bridge server error: ${err.message}`);
  });

  let current: ClientSession | null = null;

  const dropCurrent = (reason: string): void => {
    if (current === null) return;
    const session = current;
    current = null;
    session.heartbeat?.stop();
    log(`bridge client torn down: ${reason}`);
    try {
      session.ws.close();
    } catch {
      /* already closing */
    }
    // A gone client can never deliver the egress decision, so its claim on the
    // single debate slot dies with the connection.
    const held = debateSlot.current();
    if (held !== null) {
      log(`debate slot released (${held})`);
      debateSlot.release(held);
    }
    options.onClientDisconnected();
  };

  wss.on('connection', (ws: WebSocket) => {
    log('bridge client connected');

    // Single session: a newer connection replaces an existing one.
    if (current !== null) dropCurrent('replaced by a newer connection');

    const session: ClientSession = {
      ws,
      state: 'awaiting-hello',
      sessionId: '',
      acceptedAt: [],
      heartbeat: null,
    };
    current = session;

    // Server → client heartbeat direction. Interval is renegotiated once HELLO
    // arrives; this pre-hello instance guards against a silent client and does
    // NOT ping immediately, so it can never race the HELLO/AUTH exchange.
    session.heartbeat = startHeartbeat({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      initialPing: false,
      sendPing: () => send(session, { type: 'PING' }),
      onMissed: () => dropCurrent('heartbeat grace period missed (pre-hello)'),
    });

    ws.on('message', (data: unknown) => {
      handleMessage(session, data);
    });

    ws.on('close', () => {
      if (current === session) dropCurrent('client disconnected');
    });

    ws.on('error', (err: Error) => {
      log(`bridge client socket error: ${err.message}`);
      // 'close' always follows 'error'; teardown happens there.
    });
  });

  // -------------------------------------------------------------------------
  // Inbound message pipeline: size → parse → validate → state machine
  // -------------------------------------------------------------------------

  function handleMessage(session: ClientSession, data: unknown): void {
    // --- payload size (belt; braces is maxPayload on the server itself) -----
    let raw: Buffer;
    if (Buffer.isBuffer(data)) {
      raw = data;
    } else if (Array.isArray(data)) {
      raw = Buffer.concat(data as Buffer[]);
    } else {
      raw = Buffer.from(String(data));
    }
    if (raw.length > BRIDGE_LIMITS.maxPayloadBytes) {
      send(session, {
        type: 'ERROR',
        code: 'payload-too-large',
        message: `message exceeds the ${BRIDGE_LIMITS.maxPayloadBytes} byte cap`,
      });
      dropCurrent('payload limit exceeded');
      return;
    }

    // --- parse layer --------------------------------------------------------
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      send(session, { type: 'ERROR', code: 'bad-json', message: 'message is not valid JSON' });
      return;
    }
    const message = parseBridgeMessage(parsed);
    if (message === null) {
      // Malformed/unrecognized messages are rejected outright (never acted on).
      send(session, {
        type: 'ERROR',
        code: 'schema-rejected',
        message: 'message does not conform to the BridgeMessage schema',
      });
      return;
    }

    // Any validated inbound message proves the peer is alive.
    session.heartbeat?.noteReceived();

    // --- handshake state machine ---------------------------------------------
    switch (message.type) {
      case 'PONG':
        return; // liveness only
      case 'HELLO':
        handleHello(session, message);
        return;
      case 'AUTH':
        handleAuth(session, message);
        return;
      default:
        break;
    }

    // --- pre-auth discipline: 0 application messages accepted ---------------
    if (session.state !== 'authenticated') {
      send(session, {
        type: 'ERROR',
        code: 'pre-auth-rejected',
        message: 'no messages accepted before AUTH succeeds',
      });
      dropCurrent('pre-auth application message');
      return;
    }

    // --- rate limit (authenticated application traffic) ----------------------
    if (!admitByRate(session)) {
      send(session, { type: 'ERROR', code: 'rate-limited', message: 'exceeded 10 messages/second' });
      return;
    }

    // --- debate slot ----------------------------------------------------------
    if (message.type === 'CONTEXT_REQUEST') {
      if (!debateSlot.claim(message.debateId)) {
        send(session, {
          type: 'ERROR',
          code: 'debate-slot-busy',
          message: `another debate (${String(debateSlot.current())}) holds the single debate slot`,
        });
        return;
      }
    }

    options.onClientMessage(message);
  }

  function handleHello(session: ClientSession, message: Extract<BridgeMessage, { type: 'HELLO' }>): void {
    if (session.state !== 'awaiting-hello') {
      send(session, { type: 'ERROR', code: 'handshake-order', message: 'unexpected HELLO' });
      return;
    }
    if (!protocolVersionsCompatible(message.protocolVersion, BRIDGE_PROTOCOL_VERSION)) {
      const reason = `Bridge protocol mismatch — client speaks ${message.protocolVersion}, broker speaks ${BRIDGE_PROTOCOL_VERSION}. Please update the VS Code extension.`;
      send(session, { type: 'ERROR', code: 'protocol-version-mismatch', message: reason });
      log(reason);
      dropCurrent('protocol version mismatch');
      return;
    }
    session.state = 'awaiting-auth';
    session.sessionId = message.sessionId;
    // Restart the server-direction heartbeat at the negotiated interval.
    session.heartbeat?.stop();
    session.heartbeat = startHeartbeat({
      intervalMs: message.heartbeatIntervalMs,
      sendPing: () => send(session, { type: 'PING' }),
      onMissed: () => dropCurrent('heartbeat grace period missed'),
    });
    log(`bridge client HELLO (session ${message.sessionId}, heartbeat ${message.heartbeatIntervalMs}ms)`);
  }

  function handleAuth(session: ClientSession, message: Extract<BridgeMessage, { type: 'AUTH' }>): void {
    if (session.state !== 'awaiting-auth') {
      send(session, { type: 'ERROR', code: 'handshake-order', message: 'AUTH before HELLO' });
      dropCurrent('AUTH before HELLO');
      return;
    }
    // The upgrade already verified the token cryptographically. A mismatching
    // in-band token means the client is confused or spoofing; reject it.
    if (!authenticateUpgrade({ url: '', headers: { authorization: `Bearer ${message.token}` } }, token).ok) {
      send(session, { type: 'AUTH_FAILED', reason: 'token rejected' });
      dropCurrent('AUTH token mismatch');
      return;
    }
    session.state = 'authenticated';
    send(session, { type: 'AUTH_OK' });
    log(`bridge session ${session.sessionId} authenticated (protocol ${BRIDGE_PROTOCOL_VERSION})`);
    options.onClientConnected();
  }

  function admitByRate(session: ClientSession): boolean {
    const now = Date.now();
    session.acceptedAt = session.acceptedAt.filter((t) => now - t < RATE_WINDOW_MS);
    if (session.acceptedAt.length >= BRIDGE_LIMITS.maxMessagesPerSecond) return false;
    session.acceptedAt.push(now);
    return true;
  }

  function send(session: ClientSession, message: BridgeMessage): void {
    if (session.ws.readyState !== 1) return;
    try {
      session.ws.send(JSON.stringify(message));
    } catch {
      /* socket closing; the 'close' handler cleans up */
    }
  }

  // -------------------------------------------------------------------------
  // Handle
  // -------------------------------------------------------------------------

  const handle: BrokerHandle = {
    port: options.port,
    token,
    debateSlot,
    isClientAuthenticated: (): boolean => current !== null && current.state === 'authenticated',
    sendToClient: (message: BridgeMessage): boolean => {
      if (current === null || current.state !== 'authenticated') return false;
      send(current, message);
      return true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        try {
          if (current !== null) {
            current.heartbeat?.stop();
            try {
              current.ws.close();
            } catch {
              /* already closing */
            }
            current = null;
          }
          wss.close(() => resolve());
          // Force-close any lingering sockets when the runtime supports it.
          (wss as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        } catch {
          resolve();
        }
      }),
  };

  return handle;
}

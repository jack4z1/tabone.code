// Silknet — bridge client (Chrome side of the VS Code ⇄ Chrome bridge).
//
// Small, ADDITIVE module: it does not touch the debate/adapter/tamper machinery.
// The service worker hosts one instance and routes its callbacks.
//
// MV3 notes: the service worker's lifetime is extended by ACTIVE WebSocket
// traffic — which is exactly why the bidirectional heartbeat exists. During a
// long, silent model-generation wait the periodic PING/PONG exchange keeps the
// worker from being treated as inactive.
//
// Security: every inbound message is schema-validated before use; the token is
// supplied by the host (side panel entry), kept in chrome.storage.session, and
// never logged. If the bridge is unavailable the rest of the extension works
// fully standalone — this module's failure is never fatal to a debate.

import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeMessage,
  type BridgeMessage,
} from './bridge-protocol';

export type BridgeClientState = 'disconnected' | 'connecting' | 'connected';

export const BRIDGE_DEFAULT_PORT = 8712;
/** Client's offered heartbeat interval — inside the brief's 20–25s window. */
export const BRIDGE_HEARTBEAT_MS = 22_000;
const BRIDGE_GRACE_MULTIPLIER = 2;
const AUTH_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 30_000;

export interface BridgeClientHost {
  /** Human-readable log line sink. NEVER log the token. */
  log: (line: string) => void;
  /** State transitions, for the side panel chip. */
  onStateChange: (state: BridgeClientState, detail?: string) => void;
  /** Validated, post-handshake application messages. */
  onMessage: (message: BridgeMessage) => void;
}

export interface BridgeClientHandle {
  connect(port: number, token: string): void;
  /** Drops the socket and stops reconnecting (user-initiated). */
  disconnect(): void;
  /** Sends one typed message; false when not connected. */
  send(message: BridgeMessage): boolean;
  state(): BridgeClientState;
}

export function createBridgeClient(host: BridgeClientHost): BridgeClientHandle {
  let state: BridgeClientState = 'disconnected';
  let ws: WebSocket | null = null;
  let currentToken: string | null = null;
  let currentPort = BRIDGE_DEFAULT_PORT;

  let wantConnected = false;
  let manualStop = false;
  let backoffMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastInboundAt = 0;
  let authTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: BridgeClientState, detail?: string): void {
    if (state === next && detail === undefined) return;
    state = next;
    host.onStateChange(state, detail);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    lastInboundAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (ws === null || ws.readyState !== WebSocket.OPEN) return;
      // Missed the server's grace period → treat exactly like a disconnect.
      if (Date.now() - lastInboundAt > BRIDGE_HEARTBEAT_MS * BRIDGE_GRACE_MULTIPLIER) {
        host.log('bridge server missed heartbeat grace period — reconnecting');
        closeSocket();
        scheduleReconnect();
        return;
      }
      sendRaw({ type: 'PING' });
    }, BRIDGE_HEARTBEAT_MS);
    // First beat immediately after AUTH_OK: proves liveness at once and keeps
    // MV3 lifetime extension active from the start of the session.
    sendRaw({ type: 'PING' });
  }

  function clearAuthTimer(): void {
    if (authTimer !== null) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  }

  function closeSocket(): void {
    clearAuthTimer();
    stopHeartbeat();
    if (ws !== null) {
      const socket = ws;
      ws = null;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  }

  function scheduleReconnect(): void {
    if (!wantConnected || manualStop) return;
    setState('disconnected');
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (wantConnected && !manualStop && currentToken !== null) {
        void openSocket(currentPort, currentToken);
      }
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  function sendRaw(message: BridgeMessage): boolean {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  async function openSocket(port: number, token: string): Promise<void> {
    setState('connecting');
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      host.log(`bridge connect failed: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return; // stale socket from a previous attempt
      // Handshake: HELLO then AUTH. The broker has ALREADY verified the token
      // at the HTTP upgrade (the URL carries it); AUTH completes the typed
      // handshake so both ends share a validated session identity.
      socket.send(
        JSON.stringify({
          type: 'HELLO',
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          sessionId: crypto.randomUUID(),
          heartbeatIntervalMs: BRIDGE_HEARTBEAT_MS,
        } satisfies BridgeMessage),
      );
      socket.send(JSON.stringify({ type: 'AUTH', token } satisfies BridgeMessage));
      clearAuthTimer();
      authTimer = setTimeout(() => {
        host.log('bridge handshake timed out');
        closeSocket();
        scheduleReconnect();
      }, AUTH_TIMEOUT_MS);
    };

    socket.onmessage = (event: MessageEvent) => {
      lastInboundAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        host.log('bridge: dropped non-JSON inbound frame');
        return;
      }
      const message = parseBridgeMessage(parsed);
      if (message === null) {
        // Malformed/unrecognized messages are rejected outright, never acted on.
        host.log('bridge: dropped schema-invalid inbound message');
        return;
      }
      switch (message.type) {
        case 'AUTH_OK': {
          clearAuthTimer();
          backoffMs = 1_000; // success resets the backoff ladder
          setState('connected');
          host.log(`bridge connected (protocol ${BRIDGE_PROTOCOL_VERSION})`);
          startHeartbeat();
          return;
        }
        case 'AUTH_FAILED':
          // The broker rejected the token: stop retrying with a stale secret.
          manualStop = true;
          wantConnected = false;
          clearAuthTimer();
          setState('disconnected', 'token rejected — enter the fresh VS Code session token');
          host.log('bridge auth rejected by broker');
          closeSocket();
          return;
        case 'PING':
          sendRaw({ type: 'PONG' });
          return;
        case 'PONG':
          return; // liveness only
        case 'ERROR':
          host.log(`bridge error from broker: ${message.code} — ${message.message}`);
          if (message.code === 'protocol-version-mismatch') {
            // Hard stop: no point retrying until an extension is updated.
            manualStop = true;
            wantConnected = false;
            clearAuthTimer();
            setState('disconnected', message.message);
            closeSocket();
          }
          return;
        default:
          // Application traffic (CONTEXT_REPORT, EGRESS_MANIFEST, …) is only
          // meaningful once authenticated.
          if (state === 'connected') host.onMessage(message);
          return;
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      clearAuthTimer();
      stopHeartbeat();
      if (manualStop) {
        setState('disconnected');
        return;
      }
      host.log('bridge socket closed');
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      host.log('bridge socket error');
      // 'close' follows 'error'; reconnection is handled there.
    };
  }

  const handle: BridgeClientHandle = {
    connect(port: number, token: string): void {
      manualStop = false;
      wantConnected = true;
      backoffMs = 1_000;
      currentPort = port;
      currentToken = token;
      closeSocket();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      void openSocket(port, token);
    },

    disconnect(): void {
      manualStop = true;
      wantConnected = false;
      currentToken = null;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      closeSocket();
      setState('disconnected');
    },

    send(message: BridgeMessage): boolean {
      if (state !== 'connected') return false;
      return sendRaw(message);
    },

    state: (): BridgeClientState => state,
  };

  return handle;
}

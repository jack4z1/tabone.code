// Silknet — bridge heartbeat.
//
// An explicit PING/PONG every interval in BOTH directions while a bridge
// session is open. The interval is negotiated via HELLO.heartbeatIntervalMs.
//
// Why this matters on the Chrome side: an MV3 service worker's lifetime
// extension depends on ACTIVE WebSocket traffic. During a long, silent
// model-generation wait the socket would otherwise idle long enough for the
// worker to be treated as inactive.
//
// A missed heartbeat beyond the grace period (2x the interval) is treated
// exactly like a detected disconnect: the connection is torn down and the
// reconnect flow runs — never silently ignored.

import type { BridgeMessage } from './message-schema';

/** Default negotiated interval, inside the brief's 20–25s window. */
export const HEARTBEAT_INTERVAL_MS = 22_000;

/** Multiplier defining the grace period before a miss counts as a disconnect. */
export const HEARTBEAT_GRACE_MULTIPLIER = 2;

export interface HeartbeatHandle {
  stop(): void;
  /** Feed EVERY validated inbound message through here: proof of life. */
  noteReceived(): void;
}

export interface HeartbeatOptions {
  /** Sends one typed PING message over the wire. */
  sendPing: () => void;
  /** Called when the peer misses the grace deadline. */
  onMissed: () => void;
  /** Negotiated interval (from HELLO), clamped to a sane window. */
  intervalMs?: number;
  /** Send the first PING immediately (default true). The pre-handshake guard
   *  instance disables this so it cannot race the HELLO/AUTH exchange. */
  initialPing?: boolean;
}

/**
 * Runs one direction of the heartbeat: send a PING every interval, and demand
 * evidence of life within the grace period. Both sides run this, so liveness is
 * proven symmetrically. Every inbound message (PONG in practice) resets the
 * grace clock.
 */
export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const intervalMs = clampInterval(options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  const graceMs = intervalMs * HEARTBEAT_GRACE_MULTIPLIER;

  let lastReceivedAt = Date.now();
  let stopped = false;
  let missed = false;

  const sendOnce = (): void => {
    if (!stopped && !missed) options.sendPing();
  };

  // First PING goes out immediately: a fresh session should prove liveness at
  // once (and tests should not wait a full interval for the first beat).
  if (options.initialPing !== false) queueMicrotask(sendOnce);
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (stopped) return;
    if (!missed && Date.now() - lastReceivedAt > graceMs) {
      missed = true;
      clearInterval(timer);
      options.onMissed();
      return;
    }
    options.sendPing();
  }, intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    noteReceived(): void {
      lastReceivedAt = Date.now();
    },
  };
}

export function clampInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return HEARTBEAT_INTERVAL_MS;
  return Math.min(Math.max(Math.round(intervalMs), 5_000), 120_000);
}

/** Convenience: build a typed PING message. */
export function pingMessage(): BridgeMessage {
  return { type: 'PING' };
}

/** Convenience: build a typed PONG message. */
export function pongMessage(): BridgeMessage {
  return { type: 'PONG' };
}

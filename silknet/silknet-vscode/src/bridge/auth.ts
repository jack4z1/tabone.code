// Silknet — bridge authentication.
//
// The session token IS the security boundary. Origin-header checking is kept as
// a cheap extra layer only — a native local process can send any Origin it
// likes, so Origin is never treated as auth.
//
// Rules from the brief:
//   - cryptographically random, high-entropy token (Node crypto);
//   - checked AT the WebSocket upgrade handshake — never "accept first, auth
//     later", because an accepted-but-unauthenticated socket can be flooded;
//   - never logged, never echoed in error messages, never persisted in
//     plaintext, bound to ONE active session, rotated on every restart /
//     reconnect.

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes = 256 bits of entropy, hex-encoded (64 chars). */
const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Constant-time string comparison so token checks do not leak timing. */
export function tokensMatch(a: string, b: string): boolean {
  // An empty token must never authenticate, even against an (impossible)
  // empty expected value — this keeps a misconfigured secret from opening the
  // bridge to any anonymous local client.
  if (a.length === 0 || b.length === 0) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Lengths differ: still do one comparison pass over dummy buffers to keep
    // the timing profile flat, then reject.
    timingSafeEqual(Buffer.alloc(TOKEN_BYTES), Buffer.alloc(TOKEN_BYTES));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface UpgradeAuthResult {
  ok: boolean;
  /** Human-readable reason. NEVER contains the attempted token. */
  reason?: string;
}

/**
 * Authenticates a WebSocket upgrade request. The token arrives as either
 * `?token=...` on the upgrade URL or an `Authorization: Bearer <token>` header.
 * Anything missing, malformed, or wrong is rejected AT THE UPGRADE.
 */
export function authenticateUpgrade(
  request: { url?: string; headers: { origin?: string; authorization?: string } },
  expectedToken: string,
): UpgradeAuthResult {
  let provided: string | undefined;

  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice('Bearer '.length).trim();
  }

  if (provided === undefined && typeof request.url === 'string') {
    try {
      const parsed = new URL(request.url, 'http://127.0.0.1'); // base only to parse the query
      const queryToken = parsed.searchParams.get('token');
      if (queryToken !== null) provided = queryToken;
    } catch {
      return { ok: false, reason: 'malformed upgrade URL' };
    }
  }

  if (provided === undefined || provided.length === 0) {
    return { ok: false, reason: 'missing session token — supply ?token=… or an Authorization: Bearer header on the upgrade request' };
  }

  if (!tokensMatch(provided, expectedToken)) {
    return { ok: false, reason: 'invalid session token' };
  }

  return { ok: true };
}

/**
 * Cheap additional layer: browsers honor CORS/Origin; native processes need not.
 * Allow-listed origins only; absence of an Origin header is allowed (the
 * 'ws' Node client does not send one), because this check is NOT the boundary.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  const allowed = new Set(['vscode-webview://silknet', 'chrome-extension://']);
  if (allowed.has(origin)) return true;
  // Any chrome-extension:// origin is accepted here; the token is the boundary.
  return origin.startsWith('chrome-extension://');
}

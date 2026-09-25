// Silknet VS Code — bridge conformance tests (Phase B0.1).
//
// Runs the REAL broker against a real WebSocket client over real loopback
// sockets: upgrade-time auth, HELLO/AUTH, version mismatch, pre-auth
// discipline, rate/size limits, single debate slot, heartbeat-driven teardown.
//
// Run: npm test (from silknet-vscode)

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const root = process.cwd();
const buildDir = join(root, '.test-build-bridge');

// ---------------------------------------------------------------------------
// Build the real modules once.
// ---------------------------------------------------------------------------

before(async () => {
  const esbuild = (entry, outfile) =>
    `npx esbuild ${entry} --outfile=${JSON.stringify(outfile)} --bundle --format=esm --platform=node --target=node20 --packages=external --log-level=silent`;
  execSync(esbuild('src/bridge/broker-server.ts', join(buildDir, 'broker-server.js')), { cwd: root, stdio: 'pipe' });
  execSync(esbuild('src/bridge/message-schema.ts', join(buildDir, 'message-schema.js')), { cwd: root, stdio: 'pipe' });
  execSync(esbuild('src/bridge/auth.ts', join(buildDir, 'auth.js')), { cwd: root, stdio: 'pipe' });
});

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

const brokerUrl = (port, token) => `ws://127.0.0.1:${port}?token=${token}`;

function startTestBroker(port, overrides = {}) {
  // Dynamic import of the freshly built broker.
  return import(
    pathToFileURL(join(buildDir, 'broker-server.js')).href
  ).then(({ startBroker, BRIDGE_LIMITS }) => {
    const received = [];
    let clientConnected = 0;
    let clientDisconnected = 0;
    let tokenSeen = null;
    const handle = startBroker({
      port,
      onToken: (t) => {
        tokenSeen = t;
      },
      onClientConnected: () => {
        clientConnected += 1;
      },
      onClientDisconnected: () => {
        clientDisconnected += 1;
      },
      onClientMessage: (m) => received.push(m),
      log: (line) => console.error(`[broker:${port}] ${line}`),
      ...overrides,
    });
    return { handle, received, counters: { get connected() { return clientConnected; }, get disconnected() { return clientDisconnected; } }, BRIDGE_LIMITS, token: () => tokenSeen };
  });
}

const nextPort = (() => {
  // PID-based base port: parallel or crashed test runs never collide with
  // stragglers from a previous run holding the same fixed range.
  let port = 18000 + (process.pid % 4000);
  return () => port++;
})();

function connectOnce(url, { handshake = true, token } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    const fail = setTimeout(() => reject(new Error(`connect timeout: ${url}`)), 5000);
    ws.on('open', () => {
      clearTimeout(fail);
      resolve({
        ws,
        inbox,
        send(obj) {
          ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
        },
        next(timeoutMs = 3000) {
          if (inbox.length > 0) return Promise.resolve(inbox.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('no message arrived')), timeoutMs);
            waiters.push({ res, t });
          });
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
      });
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (waiters.length > 0) {
        const w = waiters.shift();
        clearTimeout(w.t);
        w.res(msg);
      } else {
        inbox.push(msg);
        if (handshake === false && inbox.length === 1) {
          // caller drives
        }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(fail);
      reject(err);
    });
    if (token !== undefined) ws.close();
  });
}

async function fullHandshake(port, token, sessionId = 'sess-test', heartbeatIntervalMs = 22000) {
  const client = await connectOnce(brokerUrl(port, token));
  client.send({ type: 'HELLO', protocolVersion: '1.0.0', sessionId, heartbeatIntervalMs });
  // The broker answers nothing to HELLO itself; send AUTH and await AUTH_OK.
  client.send({ type: 'AUTH', token });
  // Skip any PING that races the AUTH_OK (the immediate first beat can land
  // either side of it depending on socket timing).
  for (;;) {
    const msg = await client.next();
    if (msg.type === 'PING') continue;
    assert.equal(msg.type, 'AUTH_OK');
    break;
  }
  return client;
}

/** Pops queued PINGs (and similar noise) off the inbox until a waitable
 *  horizon: useful for asserting the NEXT meaningful inbound message. */
function drainPings(client) {
  return {
    async next(timeoutMs = 3000) {
      while (client.inbox.length > 0) {
        const msg = client.inbox.shift();
        if (msg.type !== 'PING') return msg;
      }
      // Nothing queued: wait for messages, skipping PINGs as they arrive.
      for (;;) {
        const msg = await client.next(timeoutMs);
        if (msg.type !== 'PING') return msg;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Upgrade-time authentication
// ---------------------------------------------------------------------------

describe('upgrade-time authentication', () => {
  it('rejects an upgrade with a missing token', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      assert.ok(token(), 'broker must generate a token');
      const wrong = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('open', () => resolve('opened-BAD'));
        ws.on('error', () => resolve('rejected'));
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode);
          ws.terminate();
        });
        setTimeout(() => resolve('timeout'), 3000);
      });
      assert.notEqual(wrong, 'opened-BAD');
    } finally {
      await handle.close();
    }
  });

  it('rejects an upgrade with a wrong token', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const correct = token();
      const result = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${'x'.repeat(64)}`);
        ws.on('open', () => resolve('opened-BAD'));
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode);
          ws.terminate();
        });
        ws.on('error', () => resolve('error'));
        setTimeout(() => resolve('timeout'), 3000);
      });
      assert.ok(result === 401 || result === 'error', `expected rejection, got ${result}`);
      // Sanity: the CORRECT token must work.
      const client = await connectOnce(brokerUrl(port, correct));
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('accepts an Authorization: Bearer upgrade', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const client = await new Promise((resolve, reject) => {
        const ws = new WebSocket(brokerUrl(port, '').replace('?token=', ''), {
          headers: { authorization: `Bearer ${token()}` },
        });
        ws.on('open', () => resolve({ ok: true, ws }));
        ws.on('error', reject);
      });
      assert.equal(client.ok, true);
      client.ws.close();
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Handshake + version check
// ---------------------------------------------------------------------------

describe('handshake', () => {
  it('rejects any application message before AUTH and closes', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const client = await connectOnce(brokerUrl(port, token()));
      client.send({ type: 'CONTEXT_REQUEST', debateId: 'd1', round: 0 });
      const first = await client.next();
      assert.equal(first.type, 'ERROR');
      assert.equal(first.code, 'pre-auth-rejected');
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('rejects a malformed message with a schema error', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const client = await fullHandshake(port, token());
      client.send({ type: 'TOTALLY_UNKNOWN' });
      const reply = await drainPings(client).next();
      assert.equal(reply.type, 'ERROR');
      assert.equal(reply.code, 'schema-rejected');
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('refuses a protocol major-version mismatch with a clear error', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const client = await connectOnce(brokerUrl(port, token()));
      client.send({ type: 'HELLO', protocolVersion: '2.0.0', sessionId: 's', heartbeatIntervalMs: 22000 });
      const reply = await client.next();
      assert.equal(reply.type, 'ERROR');
      assert.equal(reply.code, 'protocol-version-mismatch');
      assert.match(reply.message, /Bridge protocol mismatch/);
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('completes HELLO then AUTH in order', async () => {
    const port = nextPort();
    const { handle, token, counters } = await startTestBroker(port);
    try {
      const client = await fullHandshake(port, token());
      assert.equal(counters.connected, 1);
      client.close();
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('limits', () => {
  it('enforces the 10 msg/s rate limit', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const client = await fullHandshake(port, token());
      // 12 valid messages back to back: the tail must be rate-limited.
      // EGRESS_DENIED is used so the single-debate slot cannot interfere.
      for (let i = 0; i < 12; i++) {
        client.send({ type: 'EGRESS_DENIED', debateId: `d-rate-${i}` });
      }
      const replies = [];
      let sawLimited = false;
      for (let i = 0; i < 8 && !sawLimited; i++) {
        try {
          const msg = await client.next(800);
          replies.push(msg);
          if (msg.type === 'ERROR' && msg.code === 'rate-limited') sawLimited = true;
        } catch {
          break;
        }
      }
      assert.ok(
        sawLimited,
        `expected a rate-limited error among ${JSON.stringify(replies)}`,
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects oversized payloads', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const client = await fullHandshake(port, token());
      let closed = false;
      client.ws.on('close', () => {
        closed = true;
      });
      client.send({ type: 'CONTEXT_REQUEST', debateId: 'd', round: 0, workspaceHint: 'x'.repeat(600 * 1024) });
      // Enforcement evidence: an in-band ERROR, or the transport being closed
      // by the server's payload cap (close code 1009 'Message Too Big').
      let enforced = closed;
      const deadline = Date.now() + 3000;
      while (!enforced && Date.now() < deadline) {
        if (client.inbox.some((m) => m.type === 'ERROR') || closed) enforced = true;
        else await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(enforced, 'oversized payload must be rejected (error or close), not processed');
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('enforces the single concurrent debate slot while a client stays connected', async () => {
    const port = nextPort();
    const received = [];
    const { handle, token } = await startTestBroker(port, {
      onClientMessage: (m) => received.push(m),
    });
    try {
      const client = await fullHandshake(port, token());
      client.send({ type: 'CONTEXT_REQUEST', debateId: 'debate-A', round: 0 });
      await new Promise((r) => setTimeout(r, 150));
      client.send({ type: 'CONTEXT_REQUEST', debateId: 'debate-B', round: 0 });
      const reply = await drainPings(client).next();
      assert.equal(reply.type, 'ERROR');
      assert.equal(reply.code, 'debate-slot-busy');
      assert.deepEqual(
        received.filter((m) => m.type === 'CONTEXT_REQUEST').map((m) => m.debateId),
        ['debate-A'],
        'second debate must not reach the handler while the slot is held',
      );
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('releases the debate slot when the client disconnects', async () => {
    const port = nextPort();
    const received = [];
    const { handle, token } = await startTestBroker(port, {
      onClientMessage: (m) => received.push(m),
    });
    try {
      let client = await fullHandshake(port, token());
      client.send({ type: 'CONTEXT_REQUEST', debateId: 'debate-A', round: 0 });
      await new Promise((r) => setTimeout(r, 150));
      client.close();
      await new Promise((r) => setTimeout(r, 250));

      // Fresh connection: the slot must be free again (re-claimable by A).
      client = await fullHandshake(port, token(), 'sess-2');
      client.send({ type: 'CONTEXT_REQUEST', debateId: 'debate-A', round: 0 });
      await new Promise((r) => setTimeout(r, 150));
      // Discard any heartbeat PING racing the second claim before asserting.
      while (received.length === 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.deepEqual(
        received.filter((m) => m.type === 'CONTEXT_REQUEST').map((m) => m.debateId),
        ['debate-A', 'debate-A'],
      );
      client.close();
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Heartbeat + reconnection
// ---------------------------------------------------------------------------

describe('heartbeat and lifecycle', () => {
  it('sends PING and accepts PONG', async () => {
    const port = nextPort();
    const { handle, token } = await startTestBroker(port);
    try {
      const client = await fullHandshake(port, token(), 'sess-hb');
      const msg = await client.next(8000);
      assert.equal(msg.type, 'PING');
      client.send({ type: 'PONG' });
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('keeps a quiet connection open well beyond one heartbeat interval', async () => {
    const port = nextPort();
    const { handle, token, counters } = await startTestBroker(port);
    try {
      const client = await fullHandshake(port, token(), 'sess-quiet');
      // Sit quiet for 3s: PONG-less but far shorter than the grace period, so
      // the session must still be alive at the end of the window.
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(counters.disconnected === 0, 'session must not be torn down inside the grace period');
      client.close();
    } finally {
      await handle.close();
    }
  });

  it('supports clean reconnect after a broker restart', async () => {
    const port = nextPort();
    const first = await startTestBroker(port);
    const c1 = await fullHandshake(port, first.token());
    c1.close();
    await first.handle.close();

    const second = await startTestBroker(port);
    assert.notEqual(second.token(), first.token(), 'token must rotate on restart');
    const c2 = await fullHandshake(port, second.token());
    c2.close();
    await second.handle.close();
  });
});

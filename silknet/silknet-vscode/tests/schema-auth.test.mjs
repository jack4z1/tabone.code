// Silknet VS Code — bridge message schema + auth unit tests.
//
// Run: npm test (from silknet-vscode)

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const buildDir = join(root, '.test-build-schema');

before(async () => {
  execSync(
    `npx esbuild src/bridge/message-schema.ts src/bridge/auth.ts --outdir=${JSON.stringify(buildDir)} --bundle --format=esm --platform=node --target=node20 --log-level=silent`,
    { cwd: root, stdio: 'pipe' },
  );
});

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

const { parseBridgeMessage, protocolVersionsCompatible, BRIDGE_PROTOCOL_VERSION } = await import(
  pathToFileURL(join(buildDir, 'message-schema.js')).href
);
const { generateSessionToken, tokensMatch, authenticateUpgrade } = await import(
  pathToFileURL(join(buildDir, 'auth.js')).href
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('BridgeMessage schema', () => {
  it('accepts every specified message shape', () => {
    assert.notEqual(parseBridgeMessage({ type: 'HELLO', protocolVersion: '1.0.0', sessionId: 's', heartbeatIntervalMs: 22000 }), null);
    assert.notEqual(parseBridgeMessage({ type: 'AUTH', token: 't' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'AUTH_OK' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'AUTH_FAILED', reason: 'r' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'PING' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'PONG' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'CONTEXT_REQUEST', debateId: 'd', round: 0 }), null);
    assert.notEqual(parseBridgeMessage({ type: 'CONTEXT_REQUEST', debateId: 'd', round: 0, workspaceHint: 'w', targetProviders: ['chatgpt'] }), null);
    assert.notEqual(parseBridgeMessage({ type: 'CONTEXT_REPORT', debateId: 'd', files: [{ path: 'a.ts', lines: 'x' }], approxLines: 1, truncated: false }), null);
    assert.notEqual(parseBridgeMessage({ type: 'EGRESS_MANIFEST', debateId: 'd', targetProviders: ['chatgpt'], fileCount: 1, approxLines: 2, paths: ['a.ts'] }), null);
    assert.notEqual(parseBridgeMessage({ type: 'EGRESS_APPROVED', debateId: 'd', mode: 'report-only' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'EGRESS_APPROVED', debateId: 'd', mode: 'selected-files', selectedFiles: ['a.ts'] }), null);
    assert.notEqual(parseBridgeMessage({ type: 'EGRESS_DENIED', debateId: 'd' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'REDACTION_FOUND', debateId: 'd', matches: [{ pattern: 'aws-key', location: 'loc' }] }), null);
    assert.notEqual(parseBridgeMessage({ type: 'REDACTION_DECISION', debateId: 'd', decision: 'redact' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'ERROR', code: 'c', message: 'm' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'FILE_PROPOSAL', debateId: 'd', proposalId: 'p', path: 'x', baseHash: 'h', diff: '', provenance: 'v' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'FILE_APPROVAL', proposalId: 'p', decision: 'reject' }), null);
  });

  it('rejects malformed and unknown messages', () => {
    assert.equal(parseBridgeMessage(null), null);
    assert.equal(parseBridgeMessage('hello'), null);
    assert.equal(parseBridgeMessage(42), null);
    assert.equal(parseBridgeMessage({}), null);
    assert.equal(parseBridgeMessage({ type: 'NOPE' }), null);
    assert.notEqual(parseBridgeMessage({ type: 'PING', extra: true }), null, 'structural superset tolerated');
    // Extra top-level keys on an otherwise valid PING are tolerated (structural
    // superset) — assert the real rule: missing required fields reject.
    assert.equal(parseBridgeMessage({ type: 'HELLO', protocolVersion: '1.0.0' }), null);
    assert.equal(parseBridgeMessage({ type: 'HELLO', protocolVersion: '1.0.0', sessionId: 's' }), null);
    assert.equal(parseBridgeMessage({ type: 'HELLO', protocolVersion: '1.0.0', sessionId: 's', heartbeatIntervalMs: 50 }), null, 'interval below floor rejected');
    assert.equal(parseBridgeMessage({ type: 'HELLO', protocolVersion: '1.0.0', sessionId: 's', heartbeatIntervalMs: 5_000_000 }), null, 'interval above ceiling rejected');
    assert.equal(parseBridgeMessage({ type: 'CONTEXT_REQUEST', debateId: 'd', round: -1 }), null);
    assert.equal(parseBridgeMessage({ type: 'CONTEXT_REQUEST', debateId: 'd', round: 1.5 }), null);
    assert.equal(parseBridgeMessage({ type: 'EGRESS_APPROVED', debateId: 'd', mode: 'nuclear' }), null);
    assert.equal(parseBridgeMessage({ type: 'EGRESS_APPROVED', debateId: 'd', mode: 'selected-files' }), null, 'selected-files requires an explicit non-empty selection');
    assert.equal(parseBridgeMessage({ type: 'EGRESS_APPROVED', debateId: 'd', mode: 'selected-files', selectedFiles: [] }), null);
    assert.equal(parseBridgeMessage({ type: 'REDACTION_DECISION', debateId: 'd', decision: 'maybe' }), null);
    assert.equal(parseBridgeMessage({ type: 'CONTEXT_REPORT', debateId: 'd', files: 'nope', approxLines: 1, truncated: false }), null);
    assert.equal(parseBridgeMessage({ type: 'CONTEXT_REPORT', debateId: 'd', files: [{ path: 'a' }], approxLines: 1, truncated: false }), null);
  });

  it('enforces protocol version compatibility by major version', () => {
    assert.equal(protocolVersionsCompatible('1.0.0', '1.0.0'), true);
    assert.equal(protocolVersionsCompatible('1.2.9', '1.0.0'), true, 'minor/patch differences interoperate');
    assert.equal(protocolVersionsCompatible('2.0.0', '1.0.0'), false, 'major mismatch refuses');
    assert.equal(protocolVersionsCompatible('garbage', '1.0.0'), false);
    assert.equal(BRIDGE_PROTOCOL_VERSION, '1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('generates a high-entropy token with proper shape', () => {
    const token = generateSessionToken();
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 64, '256 bits hex-encoded is 64 chars');
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, generateSessionToken(), 'tokens must not repeat');
  });

  it('compares tokens in constant time without length leaks in the result', () => {
    assert.equal(tokensMatch('abc', 'abc'), true);
    assert.equal(tokensMatch('abc', 'abd'), false);
    assert.equal(tokensMatch('abc', 'abcd'), false);
    assert.equal(tokensMatch('', ''), false);
  });

  it('authenticates a token passed as a URL query parameter', () => {
    const token = generateSessionToken();
    const ok = authenticateUpgrade({ url: `/ws?token=${token}`, headers: {} }, token);
    assert.equal(ok.ok, true);
    const bad = authenticateUpgrade({ url: '/ws?token=wrong', headers: {} }, token);
    assert.equal(bad.ok, false);
    assert.doesNotMatch(bad.reason ?? '', /wrong/, 'error must never echo the attempted token');
  });

  it('authenticates a token passed as an Authorization header', () => {
    const token = generateSessionToken();
    const ok = authenticateUpgrade({ url: '/ws', headers: { authorization: `Bearer ${token}` } }, token);
    assert.equal(ok.ok, true);
    const bad = authenticateUpgrade({ url: '/ws', headers: { authorization: 'Bearer nope' } }, token);
    assert.equal(bad.ok, false);
  });

  it('rejects upgrades with no token at all', () => {
    const res = authenticateUpgrade({ url: '/ws', headers: {} }, generateSessionToken());
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /missing session token/);
  });
});

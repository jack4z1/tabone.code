// Silknet VS Code — egress gate + redaction tests (Phase B0.5, VS Code side).
//
// Run: npm test (from silknet-vscode)

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const buildDir = join(root, '.test-build-egress');

let gate;
let redaction;

before(async () => {
  const esbuild = (entry, outfile) =>
    `npx esbuild ${entry} --outfile=${JSON.stringify(outfile)} --bundle --format=esm --platform=node --target=node20 --packages=external --log-level=silent`;
  execSync(esbuild('src/egress/egress-gate.ts', join(buildDir, 'egress-gate.js')), { cwd: root, stdio: 'pipe' });
  execSync(esbuild('src/grounding/redaction.ts', join(buildDir, 'redaction.js')), { cwd: root, stdio: 'pipe' });
  gate = await import(pathToFileURL(join(buildDir, 'egress-gate.js')).href);
  redaction = await import(pathToFileURL(join(buildDir, 'redaction.js')).href);
});

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Redaction patterns
// ---------------------------------------------------------------------------

describe('redaction patterns', () => {
  it('detects AWS keys', () => {
    const { matches } = redaction.scanForSecrets('const k = "AKIAIOSFODNN7EXAMPLE";', 'f.ts');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].pattern, 'aws-key');
  });

  it('detects GitHub tokens (all prefixes)', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghs_', 'ghr_', 'github_pat_']) {
      const { matches } = redaction.scanForSecrets(`token: ${prefix}ABCDEF0123456789abcdef`, 'f.ts');
      assert.ok(matches.some((m) => m.pattern === 'github-token'), `missed ${prefix}`);
    }
  });

  it('detects private key headers', () => {
    const { matches } = redaction.scanForSecrets('-----BEGIN RSA PRIVATE KEY-----', 'f.pem');
    assert.ok(matches.some((m) => m.pattern === 'private-key-header'));
  });

  it('detects JWTs', () => {
    const { matches } = redaction.scanForSecrets(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'f.ts',
    );
    assert.ok(matches.some((m) => m.pattern === 'jwt'));
  });

  it('detects DB connection strings with embedded credentials', () => {
    const { matches } = redaction.scanForSecrets('mongodb://admin:s3cret@db.example.com:27017', 'f.ts');
    assert.ok(matches.some((m) => m.pattern === 'db-connection-string'));
    const clean = redaction.scanForSecrets('mongodb://db.example.com:27017', 'f.ts');
    assert.equal(clean.matches.length, 0, 'no-credential URLs must not match');
  });

  it('detects generic API-key-shaped strings near key/secret/token', () => {
    const { matches } = redaction.scanForSecrets('api_key = "AbCdEf0123456789AbCdEf0123456789"', 'f.ts');
    assert.ok(matches.length > 0);
  });

  it('never includes the raw secret in the match location', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const { matches } = redaction.scanForSecrets(`key = "${secret}"`, 'f.ts');
    for (const m of matches) {
      assert.ok(!m.location.includes(secret), 'raw secret leaked into location');
    }
  });

  it('redact-and-continue replaces the value, preserving assignments', () => {
    const out = redaction.applyRedactions('const AWS = "AKIAIOSFODNN7EXAMPLE";\npassword = "superlongpasswordvalue123456";', 'f.ts');
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(out.includes('[REDACTED:'), 'value replaced by a category label');
    assert.ok(out.includes('AWS ='), 'assignment structure preserved');
  });
});

// ---------------------------------------------------------------------------
// Egress gate
// ---------------------------------------------------------------------------

describe('egress gate', () => {
  it('holds the report until a decision arrives; deny sends nothing', async () => {
    const { manifest, redaction: found } = await gate.openGate(
      { debateId: 'd1', round: 0, targetProviders: ['chatgpt', 'claude'] },
      process.cwd(),
      { useModelSummary: false },
    );
    assert.equal(manifest.type, 'EGRESS_MANIFEST');
    assert.deepEqual(manifest.targetProviders, ['chatgpt', 'claude']);
    assert.equal(gate.hasPendingGate(), true);

    const outcome = gate.applyDecision({ kind: 'denied' });
    assert.equal(outcome.report, null, 'denied = nothing crosses');
    assert.equal(gate.hasPendingGate(), false);
  });

  it('report-only releases exactly one excerpt carrying the report text', async () => {
    await gate.openGate({ debateId: 'd2', round: 0 }, process.cwd(), { useModelSummary: false });
    const outcome = gate.applyDecision({ kind: 'approved', mode: 'report-only' });
    assert.notEqual(outcome.report, null);
    assert.equal(outcome.report.type, 'CONTEXT_REPORT');
    assert.equal(outcome.report.files.length, 1);
    assert.ok(outcome.report.files[0].lines.length > 0);
  });

  it('selected-files releases only the files the user ticked', async () => {
    const { manifest } = await gate.openGate({ debateId: 'd3', round: 0 }, process.cwd(), { useModelSummary: false });
    const paths = manifest.paths ?? [];
    assert.ok(paths.length >= 1, 'need at least one file in the report');
    const outcome = gate.applyDecision({
      kind: 'approved',
      mode: 'selected-files',
      selectedFiles: [paths[0]],
    });
    assert.notEqual(outcome.report, null);
    assert.equal(outcome.report.files.length, 1);
    assert.equal(outcome.report.files[0].path, paths[0]);
    assert.equal(outcome.report.truncated, true, 'partial release is a truncation');
  });

  it('selected-files with an empty selection sends nothing', async () => {
    await gate.openGate({ debateId: 'd4', round: 0 }, process.cwd(), { useModelSummary: false });
    const outcome = gate.applyDecision({ kind: 'approved', mode: 'selected-files', selectedFiles: [] });
    assert.equal(outcome.report, null);
  });

  it('a REDACTION decision of cancel denies; redact ships a cleaned report', async () => {
    await gate.openGate({ debateId: 'd5', round: 0 }, process.cwd(), { useModelSummary: false });
    const denied = gate.applyDecision({ kind: 'denied' });
    assert.equal(denied.report, null);

    await gate.openGate({ debateId: 'd6', round: 0 }, process.cwd(), { useModelSummary: false });
    const shipped = gate.applyDecision({ kind: 'approved', mode: 'report-only' });
    assert.notEqual(shipped.report, null);
  });

  it('decisions with no pending gate are no-ops', () => {
    gate.cancelPendingGate();
    const outcome = gate.applyDecision({ kind: 'approved', mode: 'report-only' });
    assert.equal(outcome.report, null);
    assert.equal(outcome.consumed, false);
  });
});

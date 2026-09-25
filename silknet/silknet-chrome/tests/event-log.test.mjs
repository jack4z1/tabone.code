// Silknet — event log validation and schema tests.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.test-build-eventlog');

await esbuild.build({
  entryPoints: [join(root, 'src/background/event-log.ts')],
  outfile: join(buildDir, 'event-log.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'silent',
});

const eventLog = await import(pathToFileURL(join(buildDir, 'event-log.mjs')).href);

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

test('validateEvent accepts valid events across all defined schemas', () => {
  const now = Date.now();

  const validEvents = [
    { type: 'RUN_CREATED', id: 'run-1', objective: 'Test topic', providers: ['chatgpt', 'claude'], timestamp: now },
    { type: 'ROUND_STARTED', runId: 'run-1', round: 1, timestamp: now },
    { type: 'SUBMISSION_REQUESTED', runId: 'run-1', round: 1, provider: 'chatgpt', opId: 'op-1', text: 'Prompt text', timestamp: now },
    { type: 'SUBMISSION_ACKNOWLEDGED', runId: 'run-1', opId: 'op-1', timestamp: now },
    { type: 'REPLY_DETECTED', runId: 'run-1', opId: 'op-1', text: 'Reply text', reason: ['response-stable-1800ms'], timestamp: now },
    { type: 'PROVIDER_FAILED', runId: 'run-1', provider: 'claude', reason: 'Timeout', timestamp: now },
    { type: 'ROUND_COMPLETED', runId: 'run-1', round: 1, timestamp: now },
    { type: 'USER_INTERJECTED', runId: 'run-1', text: 'Clarify trade-offs', timestamp: now },
    { type: 'RUN_STOPPED', runId: 'run-1', reason: 'User requested abort', timestamp: now },
    { type: 'TAMPER_DETECTED', runId: 'run-1', provider: 'chatgpt', opId: 'doc-1', timestamp: now },
  ];

  for (const ev of validEvents) {
    const res = eventLog.validateEvent(ev);
    assert.equal(res.ok, true, `Expected valid event for ${ev.type}: ${res.reason}`);
    assert.equal(res.event.type, ev.type);
  }
});

test('validateEvent rejects malformed or unvalidated events', () => {
  assert.equal(eventLog.validateEvent(null).ok, false);
  assert.equal(eventLog.validateEvent(undefined).ok, false);
  assert.equal(eventLog.validateEvent({}).ok, false);
  assert.equal(eventLog.validateEvent({ type: 'UNKNOWN_TYPE', timestamp: Date.now() }).ok, false);
  assert.equal(eventLog.validateEvent({ type: 'RUN_CREATED', id: '', timestamp: Date.now() }).ok, false);
  assert.equal(eventLog.validateEvent({ type: 'ROUND_STARTED', runId: 'run-1', round: 0, timestamp: Date.now() }).ok, false);
  assert.equal(eventLog.validateEvent({ type: 'SUBMISSION_REQUESTED', runId: 'run-1', round: 1, provider: '', opId: '', text: '', timestamp: Date.now() }).ok, false);
});

test('RETENTION constants match specification requirements (100 debates / 30 days)', () => {
  assert.equal(eventLog.RETENTION_MAX_RUNS, 100);
  assert.equal(eventLog.RETENTION_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
});

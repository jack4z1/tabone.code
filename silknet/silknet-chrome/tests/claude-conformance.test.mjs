// Silknet — Claude adapter conformance tests (Phase v0.2).
//
// These run the REAL adapter core against mocks/mock-claude.html under jsdom,
// verifying text injection, completion detection and correct-reply identification
// for Claude (claude.ai).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.test-build');

await esbuild.build({
  entryPoints: [join(root, 'src/content-scripts/shared/adapter-core.ts')],
  outfile: join(buildDir, 'adapter-core-claude.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'silent',
});

const core = await import(pathToFileURL(join(buildDir, 'adapter-core-claude.mjs')).href);

async function importSelectorValidator() {
  await esbuild.build({
    entryPoints: [join(root, 'src/content-scripts/shared/selectors.ts')],
    outfile: join(buildDir, 'selectors-claude.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  return import(pathToFileURL(join(buildDir, 'selectors-claude.mjs')).href);
}

const selectors = await importSelectorValidator();

const shippedConfigRaw = JSON.parse(readFileSync(join(root, 'src/selectors/claude.json'), 'utf8'));
const validated = selectors.validateSelectorConfig(shippedConfigRaw);
assert.equal(validated.ok, true, `shipped selectors/claude.json must validate: ${validated.reason}`);
const shippedConfig = validated.config;

/** @type {JSDOM} */
let dom;

before(async () => {
  const html = readFileSync(join(root, 'mocks/mock-claude.html'), 'utf8').replace(
    'src="mock-claude.js"',
    `src="${pathToFileURL(join(root, 'mocks/mock-claude.js')).href}"`,
  );

  dom = new JSDOM(html, {
    url: 'https://claude.ai/chat/silknet-mock',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });

  globalThis.MutationObserver = dom.window.MutationObserver;

  await waitFor(() => dom.window.__mock !== undefined, 5000, 'mock driver never initialised');
  dom.window.__mock.speedUp(25, 0);
});

after(() => {
  dom?.window.close();
});

function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        rejectPromise(err);
        return;
      }
      if (value) {
        resolvePromise(value);
        return;
      }
      if (Date.now() > deadline) {
        rejectPromise(new Error(message));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const mock = () => dom.window.__mock;

function testConfig(overrides = {}) {
  return {
    ...shippedConfig,
    behavior: { ...shippedConfig.behavior, stabilityMs: 60, watchdogMs: 4000, ...overrides },
  };
}

function makeAdapter(config = testConfig(), documentId = crypto.randomUUID()) {
  const win = dom.window;
  const env = {
    document: win.document,
    location: { href: win.location.href, origin: win.location.origin },
    isTopFrame: true,
    provider: 'claude',
    tabId: 2,
    frameId: 0,
    documentId,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
  };
  return { adapter: core.createAdapter(env, config), env, config, mock: mock() };
}

async function semiTurn(ctx, prompt, timeoutMs = 8000) {
  const submitted = await ctx.adapter.submit(prompt, { autoSend: false });
  assert.equal(submitted.autoSent, false, 'SEMI mode must not auto-send');
  assert.equal(
    core.composerMatches(ctx.env, ctx.config, prompt),
    true,
    'the staged composer text must match exactly what was requested',
  );
  assert.equal(ctx.mock.send(), true, 'mock refused the simulated human send');
  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId, { timeoutMs });
  const reply = completion.complete ? await ctx.adapter.readReply(submitted.submissionId) : '';
  return { submitted, completion, reply };
}

test('Claude shipped selector config validates and carries expected timings', () => {
  assert.equal(shippedConfig.provider, 'claude');
  assert.deepEqual(shippedConfig.match.origins, ['https://claude.ai']);
  assert.equal(shippedConfig.match.topFrameOnly, true);
  assert.equal(shippedConfig.behavior.stabilityMs, 1800);
  assert.equal(shippedConfig.behavior.watchdogMs, 180000);
  assert.equal(shippedConfig.behavior.inputType, 'contenteditable');
  assert.equal(shippedConfig.behavior.injectionMethod, 'execCommand');
});

test('Claude probe recognises the mock as Claude', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const probe = await ctx.adapter.probe();
  assert.equal(probe.recognized, true, `probe failed: ${probe.reason}`);
  assert.equal(await ctx.adapter.getState(), 'idle');
  const capabilities = ctx.adapter.capabilities();
  assert.equal(capabilities.inputType, 'contenteditable');
  assert.equal(capabilities.readReply, true);
  assert.ok(capabilities.completionDetectionMethods.includes('mutation-stability'));
});

test('Claude probe reports a reason when origin is wrong', async () => {
  const ctx = makeAdapter();
  ctx.env.location.origin = 'https://not-claude.example';
  const probe = await ctx.adapter.probe();
  assert.equal(probe.recognized, false);
});

test('20 clean SEMI cycles on Claude mock', async () => {
  mock().reset();
  const ctx = makeAdapter();
  for (let i = 1; i <= 20; i++) {
    const prompt = `Claude debate prompt cycle #${i} — test position`;
    const { completion, reply } = await semiTurn(ctx, prompt);
    assert.equal(completion.complete, true, `cycle ${i} failed completion: ${completion.reason.join(', ')}`);
    assert.ok(reply.includes('MOCK-CLAUDE-REPLY'), `cycle ${i} missing expected content`);
  }
  assert.equal(mock().replyCount, 20);
});

test('Claude reply belongs to THIS submission, not an earlier turn', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const p1 = 'First prompt to Claude';
  const p2 = 'Second prompt to Claude';
  const r1 = await semiTurn(ctx, p1);
  const r2 = await semiTurn(ctx, p2);
  assert.notEqual(r1.reply, r2.reply);
  assert.ok(r2.reply.includes('prompt #2'));
});

test('Claude submission bound to replaced document is rejected (TOCTOU guard)', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const submitted = await ctx.adapter.submit('test prompt', { autoSend: false });
  ctx.env.documentId = crypto.randomUUID();
  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId);
  assert.equal(completion.complete, false);
  assert.ok(completion.reason.some((r) => r.includes('TOCTOU')));
});

test('Claude recover() retires in-flight submissions as outcome-unknown', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const submitted = await ctx.adapter.submit('test prompt', { autoSend: false });
  await ctx.adapter.recover();
  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId);
  assert.equal(completion.complete, false);
  assert.ok(completion.reason.some((r) => r.includes('unknown-after-recovery')));
});

// Silknet — Gemini adapter conformance tests.
//
// These run the REAL adapter core against mocks/mock-gemini.html under jsdom,
// verifying text injection, completion detection and correct-reply identification
// for Google Gemini (gemini.google.com).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.test-build-gemini');

await esbuild.build({
  entryPoints: [join(root, 'src/content-scripts/shared/adapter-core.ts')],
  outfile: join(buildDir, 'adapter-core-gemini.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'silent',
});

const core = await import(pathToFileURL(join(buildDir, 'adapter-core-gemini.mjs')).href);

async function importSelectorValidator() {
  await esbuild.build({
    entryPoints: [join(root, 'src/content-scripts/shared/selectors.ts')],
    outfile: join(buildDir, 'selectors-gemini.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  return import(pathToFileURL(join(buildDir, 'selectors-gemini.mjs')).href);
}

const selectors = await importSelectorValidator();

const shippedConfigRaw = JSON.parse(readFileSync(join(root, 'src/selectors/gemini.json'), 'utf8'));
const validated = selectors.validateSelectorConfig(shippedConfigRaw);
assert.equal(validated.ok, true, `shipped selectors/gemini.json must validate: ${validated.reason}`);
const shippedConfig = validated.config;

/** @type {JSDOM} */
let dom;

before(async () => {
  const html = readFileSync(join(root, 'mocks/mock-gemini.html'), 'utf8').replace(
    'src="mock-gemini.js"',
    `src="${pathToFileURL(join(root, 'mocks/mock-gemini.js')).href}"`,
  );

  dom = new JSDOM(html, {
    url: 'https://gemini.google.com/app/silknet-mock',
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
    provider: 'gemini',
    tabId: 3,
    frameId: 0,
    documentId,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
  };
  return { adapter: core.createAdapter(env, config), env, config, mock: mock() };
}

async function semiTurn(ctx, prompt, timeoutMs = 8000) {
  const submitted = await ctx.adapter.submit(prompt, { autoSend: false });
  assert.equal(ctx.mock.send(), true, 'mock refused the simulated human send');
  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId, { timeoutMs });
  const reply = completion.complete ? await ctx.adapter.readReply(submitted.submissionId) : '';
  return { submitted, completion, reply };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Gemini shipped selector config validates and carries expected timings', () => {
  assert.equal(shippedConfig.provider, 'gemini');
  assert.deepEqual(shippedConfig.match.origins, ['https://gemini.google.com']);
  assert.equal(shippedConfig.match.topFrameOnly, true);
  assert.equal(shippedConfig.behavior.stabilityMs, 1800);
  assert.equal(shippedConfig.behavior.watchdogMs, 180000);
  assert.equal(shippedConfig.behavior.inputType, 'contenteditable');
  assert.equal(shippedConfig.behavior.injectionMethod, 'execCommand');
});

test('Gemini probe recognises the mock as Gemini', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const probe = await ctx.adapter.probe();
  assert.equal(probe.recognized, true, `probe failed: ${probe.reason}`);
  assert.equal(probe.isClean, true, 'empty mock must report isClean: true');
  assert.equal(ctx.adapter.isClean(), true, 'adapter.isClean() must report true on empty chat');
  assert.equal(await ctx.adapter.getState(), 'idle');
  const cap = ctx.adapter.capabilities();
  assert.equal(cap.inputType, 'contenteditable');
  assert.equal(cap.readReply, true);
});

test('Gemini probe reports a reason when origin is wrong', async () => {
  const ctx = makeAdapter();
  ctx.env.location.origin = 'https://not-gemini.example';
  const probe = await ctx.adapter.probe();
  assert.equal(probe.recognized, false);
  assert.match(String(probe.reason), /not a declared gemini origin/);
});

test('20 clean SEMI cycles on Gemini mock', async () => {
  mock().reset();
  const ctx = makeAdapter();

  for (let i = 1; i <= 20; i++) {
    const prompt = `Gemini cycle ${i} of 20. Argue position ${i}.`;
    const expected = ctx.mock.expectedReply(prompt, i);
    const { completion, reply } = await semiTurn(ctx, prompt);

    assert.equal(completion.complete, true, `cycle ${i}: completion not detected — ${completion.reason?.join('; ')}`);
    assert.equal(reply, expected, `cycle ${i}: wrong or garbled reply read back`);
  }
});

test('Gemini reply belongs to THIS submission, not an earlier turn', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const p1 = 'First prompt to Gemini';
  const p2 = 'Second prompt to Gemini';
  const r1 = await semiTurn(ctx, p1);
  assert.equal(ctx.adapter.isClean(), false, 'adapter.isClean() must report false after a turn');
  const r2 = await semiTurn(ctx, p2);
  assert.notEqual(r1.reply, r2.reply);
  assert.ok(r2.reply.includes('prompt #2'));
});

test('Gemini submission bound to replaced document is rejected (TOCTOU guard)', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const submitted = await ctx.adapter.submit('test prompt', { autoSend: false });
  ctx.env.documentId = crypto.randomUUID();
  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId);
  assert.equal(completion.complete, false);
  assert.ok(completion.reason.some((r) => r.includes('TOCTOU')));
});

test('Gemini recover() retires in-flight submissions as outcome-unknown', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const submitted = await ctx.adapter.submit('test prompt', { autoSend: false });
  await ctx.adapter.recover();
  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId);
  assert.equal(completion.complete, false);
  assert.ok(completion.reason.some((r) => r.includes('unknown-after-recovery')));
});

test('Gemini tamper detection blocks Send click if composer text is modified before human send', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const composer = ctx.env.document.getElementById('prompt-editor');
  const sendButton = ctx.env.document.getElementById('send-button');
  let tamperCallbackFired = false;
  ctx.env.onTamperBlocked = () => {
    tamperCallbackFired = true;
  };

  const submitted = await ctx.adapter.submit('Legitimate staged prompt.', { autoSend: false });
  assert.equal(composer.textContent, 'Legitimate staged prompt.');

  // Tamper: simulate user modifying composer text
  composer.textContent = 'Illegitimate tampered text!';

  const clickEvent = new ctx.env.document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  sendButton.dispatchEvent(clickEvent);

  assert.equal(clickEvent.defaultPrevented, true, 'tamper guard must cancel the click event');
  assert.equal(tamperCallbackFired, true, 'tamper callback must be invoked');
  assert.equal(ctx.mock.state, 'idle', 'provider must not have transitioned to generating');

  // Restore legitimate text
  composer.textContent = 'Legitimate staged prompt.';
  tamperCallbackFired = false;

  const validClick = new ctx.env.document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  sendButton.dispatchEvent(validClick);

  assert.equal(validClick.defaultPrevented, false, 'legitimate click must not be cancelled');
});

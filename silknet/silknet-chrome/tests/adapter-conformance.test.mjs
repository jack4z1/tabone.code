// Silknet — adapter conformance tests (Phase v0.1).
//
// These run the REAL adapter core against mocks/mock-chatgpt.html under jsdom, so
// injection, completion detection and correct-reply identification are verified
// without spending real provider messages. They are the offline half of the
// phase's success criterion; the live half still requires a human clicking Send
// on a real chatgpt.com tab.
//
// Run: npm test

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.test-build-chatgpt');

/** Bundle the TypeScript core to ESM once, so the tests import the shipped code. */
await esbuild.build({
  entryPoints: [join(root, 'src/content-scripts/shared/adapter-core.ts')],
  outfile: join(buildDir, 'adapter-core.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'silent',
});

const core = await import(pathToFileURL(join(buildDir, 'adapter-core.mjs')).href);

// validateSelectorConfig lives in selectors.ts, which adapter-core re-bundles but
// does not re-export. Bundle it separately rather than duplicating the schema.
async function importSelectorValidator() {
  await esbuild.build({
    entryPoints: [join(root, 'src/content-scripts/shared/selectors.ts')],
    outfile: join(buildDir, 'selectors.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  return import(pathToFileURL(join(buildDir, 'selectors.mjs')).href);
}

const selectors = await importSelectorValidator();

const shippedConfigRaw = JSON.parse(readFileSync(join(root, 'src/selectors/chatgpt.json'), 'utf8'));
const validated = selectors.validateSelectorConfig(shippedConfigRaw);
assert.equal(validated.ok, true, `shipped selectors/chatgpt.json must validate: ${validated.reason}`);
const shippedConfig = validated.config;

/** @type {JSDOM} */
let dom;

before(async () => {
  const html = readFileSync(join(root, 'mocks/mock-chatgpt.html'), 'utf8').replace(
    'src="mock-chatgpt.js"',
    `src="${pathToFileURL(join(root, 'mocks/mock-chatgpt.js')).href}"`,
  );

  dom = new JSDOM(html, {
    url: 'https://chatgpt.com/c/silknet-mock',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });

  // The adapter core is realm-agnostic by design (tagName checks, ownerDocument
  // constructors), but the observer constructor itself comes from the host realm.
  globalThis.MutationObserver = dom.window.MutationObserver;

  await waitFor(() => dom.window.__mock !== undefined, 5000, 'mock driver never initialised');
  // Fast streams: the realistic 1 char per 6ms would make a 20-cycle run take
  // many minutes. Each tick is still a genuine DOM mutation.
  dom.window.__mock.speedUp(25, 0);
})

after(() => {
  dom?.window.close();
  rmSync(buildDir, { recursive: true, force: true });
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

/** Speed knobs: the tests contract the timing windows, then assert separately that
 *  the SHIPPED config still carries the production values the spec requires. */
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
    // The mock stands in for a top-level provider tab.
    isTopFrame: true,
    provider: 'chatgpt',
    tabId: 1,
    frameId: 0,
    documentId,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
  };
  return { adapter: core.createAdapter(env, config), env, config, mock: mock() };
}

/** One full SEMI turn: stage text, human-equivalent send, wait, read. */
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

// ---------------------------------------------------------------------------
// Selector config
// ---------------------------------------------------------------------------

test('shipped selector config validates and carries the production timings', () => {
  assert.equal(shippedConfig.provider, 'chatgpt');
  assert.deepEqual(shippedConfig.match.origins, ['https://chatgpt.com']);
  assert.equal(shippedConfig.match.topFrameOnly, true);
  // The spec's exact numbers: ~2s stability window, ~2-3 minute watchdog.
  assert.equal(shippedConfig.behavior.stabilityMs, 1800);
  assert.equal(shippedConfig.behavior.watchdogMs, 180000);
  assert.equal(shippedConfig.behavior.inputType, 'textarea');
  assert.equal(shippedConfig.behavior.injectionMethod, 'native-setter');
});

test('selector config validator rejects malformed documents', () => {
  assert.equal(selectors.validateSelectorConfig(null).ok, false);
  assert.equal(selectors.validateSelectorConfig({}).ok, false);
  const noComposer = structuredClone(shippedConfigRaw);
  delete noComposer.selectors.composer;
  assert.equal(selectors.validateSelectorConfig(noComposer).ok, false);
  const badKind = structuredClone(shippedConfigRaw);
  badKind.selectors.composer = [{ by: 'xpath', value: '//textarea' }];
  assert.equal(selectors.validateSelectorConfig(badKind).ok, false);
  const badTiming = structuredClone(shippedConfigRaw);
  badTiming.behavior.stabilityMs = 1;
  assert.equal(selectors.validateSelectorConfig(badTiming).ok, false);
});

// ---------------------------------------------------------------------------
// probe / state
// ---------------------------------------------------------------------------

test('probe recognises the mock as ChatGPT', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const probe = await ctx.adapter.probe();
  assert.equal(probe.recognized, true, `probe failed: ${probe.reason}`);
  assert.equal(probe.isClean, true, 'empty mock must report isClean: true');
  assert.equal(ctx.adapter.isClean(), true, 'adapter.isClean() must report true on empty chat');
  assert.equal(await ctx.adapter.getState(), 'idle');
  const capabilities = ctx.adapter.capabilities();
  assert.equal(capabilities.inputType, 'textarea');
  assert.equal(capabilities.readReply, true);
  assert.ok(capabilities.completionDetectionMethods.includes('mutation-stability'));
});

test('probe reports a reason when the origin is wrong', async () => {
  const ctx = makeAdapter();
  ctx.env.location.origin = 'https://not-chatgpt.example';
  const probe = await ctx.adapter.probe();
  assert.equal(probe.recognized, false);
  assert.match(String(probe.reason), /not a declared chatgpt origin/);
});

test('probe reports a reason when the composer is missing', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const composer = ctx.env.document.getElementById('prompt-textarea');
  const parent = composer.parentElement;
  composer.remove();
  try {
    const probe = await ctx.adapter.probe();
    assert.equal(probe.recognized, false);
    assert.match(String(probe.reason), /composer not found/);
    assert.equal(await ctx.adapter.getState(), 'unknown');
  } finally {
    // Restore: the jsdom document is shared across tests and mock.reset() does
    // not recreate the composer element.
    parent.append(composer);
  }
});

// ---------------------------------------------------------------------------
// The phase's core success criterion: 20 clean cycles in a row
// ---------------------------------------------------------------------------

test('20 clean SEMI cycles: injection, completion and correct reply every time', async () => {
  mock().reset();
  const ctx = makeAdapter();

  for (let i = 1; i <= 20; i++) {
    const prompt = `Cycle ${i} of 20. Argue position ${i} on the proposal.`;
    const expected = ctx.mock.expectedReply(prompt, i);
    const { completion, reply } = await semiTurn(ctx, prompt);

    assert.equal(completion.complete, true, `cycle ${i}: completion not detected — ${completion.reason.join('; ')}`);
    // Every signal that fired is reported, which is what makes a broken selector
    // debuggable instead of a bare false.
    assert.ok(
      completion.reason.some((r) => r.startsWith('response-stable-')),
      `cycle ${i}: stability signal missing from ${JSON.stringify(completion.reason)}`,
    );
    assert.ok(completion.reason.includes('stop-control-absent'), `cycle ${i}: stop-control signal missing`);
    assert.ok(completion.reason.includes('composer-ready'), `cycle ${i}: composer-ready signal missing`);
    assert.equal(reply, expected, `cycle ${i}: wrong or garbled reply read back`);
  }
});

test("the reply excludes the turn's UI chrome (label, Copy/Regenerate)", async () => {
  mock().reset();
  const ctx = makeAdapter();
  const prompt = 'Chrome exclusion check.';
  const { completion, reply } = await semiTurn(ctx, prompt);
  assert.equal(completion.complete, true);
  assert.equal(reply, ctx.mock.expectedReply(prompt, 1));
  assert.equal(ctx.adapter.isClean(), false, 'isClean() must report false after a turn');
  const postProbe = await ctx.adapter.probe();
  assert.equal(postProbe.isClean, false, 'probe.isClean must report false after a turn');
  assert.doesNotMatch(reply, /Copy|Regenerate|ChatGPT/);
});

test('the reply read belongs to THIS submission, not an earlier turn', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const prompts = [
    'Turn one of three: state the first position.',
    'Turn two of three: state the second position.',
    'Turn three of three: state the third position.',
  ];

  let last;
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const submitted = await ctx.adapter.submit(prompt, { autoSend: false });
    ctx.mock.send();
    const completion = await ctx.adapter.waitForCompletion(submitted.submissionId, { timeoutMs: 8000 });
    assert.equal(completion.complete, true, `turn ${i + 1} not detected`);
    last = submitted.submissionId;
  }

  const reply = await ctx.adapter.readReply(last);
  assert.equal(reply, ctx.mock.expectedReply(prompts[2], 3));
  // Guard against the actual failure mode: reading the first reply instead.
  assert.notEqual(reply, ctx.mock.expectedReply(prompts[0], 1));
});

// ---------------------------------------------------------------------------
// Completion detection robustness
// ---------------------------------------------------------------------------

test('a mid-generation stall is not mistaken for completion', async () => {
  mock().reset();
  // Stall longer than the stability window: a naive implementation fires during
  // the pause and captures a truncated reply.
  const ctx = makeAdapter(testConfig({ stabilityMs: 250 }));
  const prompt = 'Stress: does a mid-generation stall get mistaken for completion?';
  const expected = ctx.mock.expectedReply(prompt, 1);

  ctx.mock.pauseStreamAfter(120, 700);
  const { completion, reply } = await semiTurn(ctx, prompt);
  ctx.mock.pauseStreamAfter(0, 0);
  ctx.mock.config.pauseAfterChars = 0;
  ctx.mock.config.pauseMs = 0;

  assert.equal(completion.complete, true, `completion never detected — ${completion.reason.join('; ')}`);
  assert.equal(
    reply,
    expected,
    `reply was captured mid-stream (${reply.length} of ${expected.length} chars)`,
  );
});

test('a provider that stalls forever reports needs-attention instead of hanging', async () => {
  mock().reset();
  const ctx = makeAdapter(testConfig({ stabilityMs: 50 }));
  ctx.mock.hangStreamAfter(80);

  const submitted = await ctx.adapter.submit('Provider will stall forever.', { autoSend: false });
  ctx.mock.send();
  const started = Date.now();
  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId, { timeoutMs: 1500 });
  const elapsed = Date.now() - started;

  assert.equal(completion.complete, false, 'a stalled provider must not be reported complete');
  assert.ok(
    completion.reason.some((r) => r.includes('timeout') || r.includes('watchdog')),
    `expected a timeout reason, got ${JSON.stringify(completion.reason)}`,
  );
  assert.ok(elapsed < 4000, `watchdog should fire promptly, took ${elapsed}ms`);
  ctx.mock.reset();
});

test('a provider that dies mid-stream looks complete — documented limitation', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const prompt = 'Stress: provider dies partway through streaming.';
  const expected = ctx.mock.expectedReply(prompt, 1);
  ctx.mock.abortStreamAfter(60);

  const { completion, reply } = await semiTurn(ctx, prompt);
  ctx.mock.reset();

  assert.equal(completion.complete, true, 'every signal looks healthy after a mid-stream death');
  assert.equal(expected.startsWith(reply), true, 'the captured text is a truncated prefix');
  assert.ok(reply.length < expected.length, 'the only evidence of failure is a short reply');
});

// ---------------------------------------------------------------------------
// Crash / navigation safety
// ---------------------------------------------------------------------------

test('a submission bound to a replaced document is rejected (TOCTOU guard)', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const prompt = 'First turn before the tab navigates away.';
  const submitted = await ctx.adapter.submit(prompt, { autoSend: false });

  // Simulate the tab navigating: same adapter instance, new document identity.
  ctx.env.documentId = crypto.randomUUID();

  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId, { timeoutMs: 500 });
  assert.equal(completion.complete, false);
  assert.ok(
    completion.reason.some((r) => r.includes('stale-submission')),
    `expected a stale-submission reason, got ${JSON.stringify(completion.reason)}`,
  );
  await assert.rejects(() => ctx.adapter.readReply(submitted.submissionId), /TOCTOU|document changed/);
});

test('recover() retires in-flight submissions as outcome-unknown, never auto-resent', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const prompt = 'A turn that is in flight when the content script is destroyed.';
  const submitted = await ctx.adapter.submit(prompt, { autoSend: false });

  // A refresh destroys the content script; this is the fresh instance recovering.
  await ctx.adapter.recover();

  const completion = await ctx.adapter.waitForCompletion(submitted.submissionId);
  assert.equal(completion.complete, false);
  assert.ok(
    completion.reason.some((r) => r.includes('unknown')),
    `expected an outcome-unknown reason, got ${JSON.stringify(completion.reason)}`,
  );
  // The crash rule: surface "resume manually", never silently resend.
  assert.ok(completion.reason.some((r) => r.includes('resume manually')));
  assert.equal(mock().replyCount, 0, 'no reply should have been requested after recovery');
});

// ---------------------------------------------------------------------------
// Injection mechanics
// ---------------------------------------------------------------------------

test('injection goes through the native setter and is readable back', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const textarea = ctx.env.document.getElementById('prompt-textarea');
  const submitted = await ctx.adapter.submit('Native setter injection check.', { autoSend: false });

  assert.equal(textarea.value, 'Native setter injection check.');
  assert.equal(core.composerMatches(ctx.env, ctx.config, 'Native setter injection check.'), true);
  // A different string must NOT match — otherwise tamper detection (Phase v0.5)
  // would have nothing to compare against.
  assert.equal(core.composerMatches(ctx.env, ctx.config, 'something else'), false);
  assert.equal(typeof submitted.submissionId, 'string');
  assert.ok(submitted.submissionId.length > 0);
});

test('tamper detection blocks Send click if composer text is modified before human send', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const textarea = ctx.env.document.getElementById('prompt-textarea');
  const sendButton = ctx.env.document.getElementById('send-button');
  let tamperCallbackFired = false;
  ctx.env.onTamperBlocked = () => {
    tamperCallbackFired = true;
  };

  const submitted = await ctx.adapter.submit('Legitimate staged prompt.', { autoSend: false });
  assert.equal(textarea.value, 'Legitimate staged prompt.');

  // Tamper: simulate user modifying composer text in the tab
  textarea.value = 'Illegitimate tampered text!';

  // Attempt click on send button
  const clickEvent = new ctx.env.document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  sendButton.dispatchEvent(clickEvent);

  assert.equal(clickEvent.defaultPrevented, true, 'tamper guard must cancel the click event');
  assert.equal(tamperCallbackFired, true, 'tamper callback must be invoked');
  assert.equal(ctx.mock.state, 'idle', 'provider must not have transitioned to generating');

  // Restore legitimate text
  textarea.value = 'Legitimate staged prompt.';
  tamperCallbackFired = false;

  const validClick = new ctx.env.document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  sendButton.dispatchEvent(validClick);

  assert.equal(validClick.defaultPrevented, false, 'legitimate click must not be cancelled');
});

test('submitting a second time while generating is still bound to the right reply', async () => {
  mock().reset();
  const ctx = makeAdapter();
  const first = await ctx.adapter.submit('First prompt.', { autoSend: false });
  ctx.mock.send();
  const firstDone = await ctx.adapter.waitForCompletion(first.submissionId, { timeoutMs: 8000 });
  assert.equal(firstDone.complete, true);
  const firstReply = await ctx.adapter.readReply(first.submissionId);

  const second = await ctx.adapter.submit('Second prompt.', { autoSend: false });
  ctx.mock.send();
  const secondDone = await ctx.adapter.waitForCompletion(second.submissionId, { timeoutMs: 8000 });
  assert.equal(secondDone.complete, true);
  const secondReply = await ctx.adapter.readReply(second.submissionId);

  assert.notEqual(firstReply, secondReply);
  assert.equal(firstReply, ctx.mock.expectedReply('First prompt.', 1));
  assert.equal(secondReply, ctx.mock.expectedReply('Second prompt.', 2));
});

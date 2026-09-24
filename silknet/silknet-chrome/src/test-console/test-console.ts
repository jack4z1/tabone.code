// Silknet — Phase v0.1 dev test console.
//
// Phase v0.1 is a spike whose entire purpose is to answer one question: does the
// DOM trick actually work? This console answers it two ways:
//
//   1. A conformance harness that runs the REAL adapter core against
//      mocks/mock-chatgpt.html — fast, offline, and it does not burn real
//      provider messages while the injection/detection logic is being debugged.
//   2. A live flow that drives the real service worker against a real
//      chatgpt.com tab, which is what actually satisfies the phase's success
//      criterion.
//
// Nothing here is product UI: the side panel is Phase v0.5 scope. Page-sourced
// text is rendered with textContent only, never innerHTML.

import {
  composerMatches,
  createAdapter,
  type AdapterEnv,
  type SilknetAdapter,
} from '../content-scripts/shared/adapter-core';
import { isUiResultMessage, NS, type UiOp } from '../content-scripts/shared/messaging';
import {
  validateSelectorConfig,
  type ProviderSelectorConfig,
} from '../content-scripts/shared/selectors';
import type { AdapterState, ProbeResult } from '../content-scripts/shared/types';
import type { StoredEvent } from '../background/event-log';

let currentMockProvider = 'chatgpt';

// ---------------------------------------------------------------------------
// Small DOM helpers (textContent-only rendering)
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`console markup missing #${id}`);
  return found as T;
}

function cell(row: HTMLTableRowElement, text: string, className?: string): void {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  row.append(td);
}

function row(cells: Array<{ text: string; className?: string }>): HTMLTableRowElement {
  const tr = document.createElement('tr');
  for (const c of cells) cell(tr, c.text, c.className);
  return tr;
}

function setText(target: HTMLElement, text: string): void {
  // textContent, always: reply text originates from a web page.
  target.textContent = text;
}

function log(target: HTMLElement, line: string): void {
  target.textContent += (target.textContent ? '\n' : '') + line;
}

// ---------------------------------------------------------------------------
// Service-worker messaging
// ---------------------------------------------------------------------------

async function ui<T>(op: UiOp, args?: unknown): Promise<T> {
  const requestId = crypto.randomUUID();
  const response = await chrome.runtime.sendMessage({ ns: NS, kind: 'UI', op, requestId, args });
  // Validate the reply against the explicit schema before using it.
  if (!isUiResultMessage(response)) throw new Error(`malformed UI_RESULT for ${op}`);
  if (response.requestId !== requestId) throw new Error(`UI_RESULT correlation mismatch for ${op}`);
  if (!response.ok) throw new Error(response.error ?? `${op} failed`);
  return response.result as T;
}

// ---------------------------------------------------------------------------
// Mock harness
// ---------------------------------------------------------------------------

interface MockApi {
  provider: string;
  config: {
    streamIntervalMs: number;
    charsPerTick: number;
    pauseAfterChars: number;
    pauseMs: number;
    abortAfterChars: number;
    hangAfterChars: number;
  };
  buildReply(prompt: string, index: number): string;
  readonly state: 'idle' | 'generating';
  readonly replyCount: number;
  send(): boolean;
  setNextReply(text: string): void;
  abortStreamAfter(chars: number): void;
  hangStreamAfter(chars: number): void;
  pauseStreamAfter(chars: number, ms: number): void;
  /** Speed knobs for automated runs; not part of the simulated behaviour. */
  speedUp(charsPerTick: number, streamIntervalMs: number): void;
  expectedReply(prompt: string, index: number): string;
  isGenerating(): boolean;
  reset(): void;
}

interface Harness {
  doc: Document;
  mock: MockApi;
  config: ProviderSelectorConfig;
  env: AdapterEnv;
  adapter: SilknetAdapter;
}

type MockWindow = Window & { __mock?: MockApi };

function frame(): HTMLIFrameElement {
  return el<HTMLIFrameElement>('mock-frame');
}

function requireMock(): { doc: Document; win: MockWindow; mock: MockApi } {
  const doc = frame().contentDocument;
  const win = frame().contentWindow as MockWindow | null;
  if (!doc || !win) throw new Error('mock iframe is not loaded yet');
  const mock = win.__mock;
  if (!mock) throw new Error('mock iframe has no __mock driver (did mock-chatgpt.js load?)');
  return { doc, win, mock };
}

const configs = new Map<string, ProviderSelectorConfig>();

async function loadBaseConfig(provider = currentMockProvider): Promise<ProviderSelectorConfig> {
  const existing = configs.get(provider);
  if (existing) return existing;
  const response = await fetch(chrome.runtime.getURL(`selectors/${provider}.json`));
  if (!response.ok) throw new Error(`could not fetch selectors/${provider}.json (${response.status})`);
  const raw: unknown = await response.json();
  const validation = validateSelectorConfig(raw);
  if (!validation.ok) throw new Error(`selectors/${provider}.json failed validation: ${validation.reason}`);
  configs.set(provider, validation.config);
  return validation.config;
}

function createHarness(): Harness {
  const { doc, win, mock } = requireMock();
  const config = configs.get(currentMockProvider);
  if (!config) throw new Error(`selector config for ${currentMockProvider} not loaded`);

  // Two deliberate deviations from production, both narrow:
  //   - origins is rewritten to the mock's own origin so the origin gate passes
  //     for a page that is not actually the real provider origin.
  //   - isTopFrame is forced true because the mock runs inside an iframe.
  const harnessConfig: ProviderSelectorConfig = {
    ...config,
    match: { origins: [doc.location.origin], topFrameOnly: false },
  };

  const env: AdapterEnv = {
    document: doc,
    location: { href: doc.location.href, origin: doc.location.origin },
    isTopFrame: true,
    provider: currentMockProvider,
    tabId: 0,
    frameId: 0,
    documentId: crypto.randomUUID(),
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
  };

  void win;
  mock.reset();
  return { doc, mock, config: harnessConfig, env, adapter: createAdapter(env, harnessConfig) };
}

interface ScenarioOutcome {
  ok: boolean;
  detail: string;
}

const scenarioTable = (): HTMLTableSectionElement =>
  el<HTMLTableElement>('scenario-table').tBodies[0] as HTMLTableSectionElement;

function showScenario(name: string, state: 'run' | 'pass' | 'fail', detail: string): void {
  const tbody = scenarioTable();
  const existing = [...tbody.rows].find((r) => r.cells[0]?.textContent === name);
  const className = state === 'pass' ? 'pass' : state === 'fail' ? 'fail' : 'run';
  const label = state === 'run' ? 'running…' : state === 'pass' ? 'PASS' : 'FAIL';
  if (existing) {
    existing.cells[1]!.textContent = label;
    existing.cells[1]!.className = className;
    existing.cells[2]!.textContent = detail;
    return;
  }
  tbody.append(row([{ text: name }, { text: label, className }, { text: detail }]));
}

/** One full SEMI-mode turn: stage text, human-equivalent send, wait, read. */
async function semiTurn(
  h: Harness,
  prompt: string,
): Promise<{ reply: string; reason: string[]; complete: boolean }> {
  const submitted = await h.adapter.submit(prompt, { autoSend: false });
  if (submitted.autoSent) throw new Error('SEMI turn unexpectedly auto-sent');
  if (!composerMatches(h.env, h.config, prompt)) {
    throw new Error('staged composer text does not match what was requested');
  }
  // "A human clicks send": drive the mock's own submit path.
  if (!h.mock.send()) throw new Error('mock refused the send (composer empty or already generating)');
  const completion = await h.adapter.waitForCompletion(submitted.submissionId, { timeoutMs: 20_000 });
  const reply = completion.complete
    ? await h.adapter.readReply(submitted.submissionId)
    : '';
  return { reply, reason: completion.reason, complete: completion.complete };
}

async function scenarioCleanCycles(count: number): Promise<ScenarioOutcome> {
  const h = createHarness();
  for (let i = 1; i <= count; i++) {
    // Unique body per cycle so a reply can only be matched to the prompt that
    // actually produced it.
    const prompt = `Cycle ${i} of ${count}. Argue position ${i} on the proposal.`;
    const expected = h.mock.expectedReply(prompt, i);
    const turn = await semiTurn(h, prompt);
    if (!turn.complete) {
      return { ok: false, detail: `cycle ${i}: completion not detected — ${turn.reason.join('; ')}` };
    }
    if (turn.reply !== expected) {
      const got = turn.reply.slice(0, 90).replace(/\s+/g, ' ');
      return { ok: false, detail: `cycle ${i}: wrong or garbled reply (got "${got}…")` };
    }
  }
  return { ok: true, detail: `${count}/${count} cycles clean — injection, completion and reply binding all held` };
}

/**
 * A model that pauses mid-generation and resumes must NOT be mistaken for a
 * finished one. The stall below is longer than the 1800ms stability window, so a
 * naive implementation would declare completion during the pause and read a
 * truncated reply.
 */
async function scenarioPauseResume(): Promise<ScenarioOutcome> {
  const h = createHarness();
  const prompt = 'Stress: does a mid-generation stall get mistaken for completion?';
  const expected = h.mock.expectedReply(prompt, 1);
  h.mock.pauseStreamAfter(120, 2500);
  const turn = await semiTurn(h, prompt);
  h.mock.pauseStreamAfter(0, 0); // pauseMs reset; pauseAfterChars=0 disables it
  h.mock.config.pauseAfterChars = 0;
  if (!turn.complete) return { ok: false, detail: `completion never detected — ${turn.reason.join('; ')}` };
  if (turn.reply !== expected) {
    return {
      ok: false,
      detail: `reply was captured mid-stream and truncated (got ${turn.reply.length} of ${expected.length} chars)`,
    };
  }
  return { ok: true, detail: 'stall + resume handled: stability timer reset correctly, full reply captured' };
}

async function scenarioWatchdog(): Promise<ScenarioOutcome> {
  const h = createHarness();
  const prompt = 'Stress: provider stalls forever and never finishes.';
  h.mock.hangStreamAfter(80);
  const submitted = await h.adapter.submit(prompt, { autoSend: false });
  h.mock.send();
  const started = Date.now();
  const completion = await h.adapter.waitForCompletion(submitted.submissionId, { timeoutMs: 6000 });
  const elapsed = Date.now() - started;
  h.mock.reset();
  if (completion.complete) return { ok: false, detail: 'stalled provider was reported as complete' };
  if (!completion.reason.some((r) => r.includes('timeout') || r.includes('watchdog'))) {
    return { ok: false, detail: `timeout reason missing from ${JSON.stringify(completion.reason)}` };
  }
  return {
    ok: true,
    detail: `reported needs-attention after ${elapsed}ms with ${completion.reason.length} reasons, no hang`,
  };
}

/**
 * Documents a real limitation: a provider that dies mid-stream leaves every
 * completion signal looking healthy (stop control gone, composer ready, text
 * stable). The only evidence is a suspiciously short reply.
 */
async function scenarioMidStreamAbort(): Promise<ScenarioOutcome> {
  const h = createHarness();
  const prompt = 'Stress: provider dies partway through streaming.';
  const expected = h.mock.expectedReply(prompt, 1);
  h.mock.abortStreamAfter(60);
  const turn = await semiTurn(h, prompt);
  h.mock.reset();
  if (!turn.complete) {
    return { ok: false, detail: `completion not detected — ${turn.reason.join('; ')}` };
  }
  const truncated = turn.reply.length < expected.length && expected.startsWith(turn.reply);
  return truncated
    ? {
        ok: true,
        detail: `known limitation confirmed: mid-stream death looks complete, only the short reply (${turn.reply.length}/${expected.length} chars) reveals it`,
      }
    : { ok: false, detail: 'expected a truncated reply prefix' };
}

/** The reply read must belong to THIS submission, not to an earlier turn. */
async function scenarioCorrectReplyAmongPriorTurns(): Promise<ScenarioOutcome> {
  const h = createHarness();
  const prompts = [
    'Turn one of three: state the first position.',
    'Turn two of three: state the second position.',
    'Turn three of three: state the third position.',
  ];
  let lastSubmissionId: string | null = null;
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!;
    const submitted = await h.adapter.submit(prompt, { autoSend: false });
    h.mock.send();
    const completion = await h.adapter.waitForCompletion(submitted.submissionId, { timeoutMs: 20_000 });
    if (!completion.complete) {
      return { ok: false, detail: `turn ${i + 1} not detected — ${completion.reason.join('; ')}` };
    }
    lastSubmissionId = submitted.submissionId;
  }
  if (!lastSubmissionId) return { ok: false, detail: 'no submission recorded' };
  const reply = await h.adapter.readReply(lastSubmissionId);
  const expected = h.mock.expectedReply(prompts[2]!, 3);
  if (reply !== expected) {
    return { ok: false, detail: `read the wrong turn: got "${reply.slice(0, 60)}…"` };
  }
  return { ok: true, detail: '3rd reply read correctly despite two earlier assistant turns on the page' };
}

const SCENARIOS: Array<{ name: string; run: () => Promise<ScenarioOutcome> }> = [
  { name: 'clean-20-cycles-semi', run: () => scenarioCleanCycles(20) },
  { name: 'stability-pause-resume', run: scenarioPauseResume },
  { name: 'watchdog-on-stall', run: scenarioWatchdog },
  { name: 'mid-stream-abort', run: scenarioMidStreamAbort },
  { name: 'correct-reply-among-prior-turns', run: scenarioCorrectReplyAmongPriorTurns },
];

/**
 * Realistic streaming is ~1 char per 6ms, which makes a 20-cycle run take
 * minutes. Bulk scenarios raise throughput; each tick remains a real mutation, so
 * the detection behaviour being tested is unchanged.
 */
async function withFastMock<T>(fn: () => Promise<T>): Promise<T> {
  const { mock } = requireMock();
  mock.speedUp(25, 1);
  try {
    return await fn();
  } finally {
    mock.speedUp(1, 6);
  }
}

async function runAllScenarios(): Promise<void> {
  scenarioTable().replaceChildren();
  const { mock } = requireMock();
  mock.speedUp(25, 1);
  for (const scenario of SCENARIOS) {
    showScenario(scenario.name, 'run', '');
    try {
      const outcome = await scenario.run();
      showScenario(scenario.name, outcome.ok ? 'pass' : 'fail', outcome.detail);
    } catch (err) {
      showScenario(scenario.name, 'fail', err instanceof Error ? err.message : String(err));
    }
    // Let the mock settle between scenarios before the next reset.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  mock.speedUp(1, 6);
}

// ---------------------------------------------------------------------------
// Single steps
// ---------------------------------------------------------------------------

let harnessOut: HTMLElement | null = null;
let lastSubmissionId: string | null = null;

function harnessLog(line: string): void {
  if (harnessOut) log(harnessOut, line);
}

async function singleSteps(): Promise<void> {
  harnessOut = el<HTMLElement>('live-out');
  setText(harnessOut, '');

  el('step-probe').addEventListener('click', () => {
    void (async () => {
      const h = createHarness();
      const probe: ProbeResult = await h.adapter.probe();
      harnessLog(`probe(): ${JSON.stringify(probe)}`);
      const state: AdapterState = await h.adapter.getState();
      harnessLog(`capabilities(): ${JSON.stringify(h.adapter.capabilities())}`);
      harnessLog(`getState(): ${state}`);
    })().catch((err: unknown) => harnessLog(`probe failed: ${describe(err)}`));
  });

  el('step-state').addEventListener('click', () => {
    void (async () => {
      const h = createHarness();
      harnessLog(`getState(): ${await h.adapter.getState()}`);
    })().catch((err: unknown) => harnessLog(`getState failed: ${describe(err)}`));
  });

  el('step-submit').addEventListener('click', () => {
    void (async () => {
      const h = createHarness();
      const prompt = el<HTMLInputElement>('harness-prompt').value;
      const submitted = await h.adapter.submit(prompt, { autoSend: false });
      lastSubmissionId = submitted.submissionId;
      harnessLog(`submit(): submissionId=${submitted.submissionId} autoSent=${submitted.autoSent}`);
      harnessLog(`staged text matches: ${composerMatches(h.env, h.config, prompt)}`);
    })().catch((err: unknown) => harnessLog(`submit failed: ${describe(err)}`));
  });

  el('step-send').addEventListener('click', () => {
    try {
      const { mock } = requireMock();
      harnessLog(`simulated human Send: ${mock.send() ? 'accepted' : 'rejected'}`);
    } catch (err) {
      harnessLog(`send failed: ${describe(err)}`);
    }
  });

  el('step-wait').addEventListener('click', () => {
    void (async () => {
      const h = createHarness();
      const submissionId = lastSubmissionId;
      if (!submissionId) {
        harnessLog('waitForCompletion: nothing staged yet (click submit first)');
        return;
      }
      const completion = await h.adapter.waitForCompletion(submissionId, { timeoutMs: 20_000 });
      harnessLog(`waitForCompletion(): complete=${completion.complete} reason=${completion.reason.join(', ')}`);
    })().catch((err: unknown) => harnessLog(`waitForCompletion failed: ${describe(err)}`));
  });

  el('step-read').addEventListener('click', () => {
    void (async () => {
      const h = createHarness();
      const submissionId = lastSubmissionId;
      if (!submissionId) {
        harnessLog('readReply: nothing staged yet (click submit first)');
        return;
      }
      const reply = await h.adapter.readReply(submissionId);
      harnessLog(`readReply() [${reply.length} chars]:\n${reply}`);
    })().catch((err: unknown) => harnessLog(`readReply failed: ${describe(err)}`));
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Live flow
// ---------------------------------------------------------------------------

interface CandidateView {
  provider: string;
  tabId: number;
  frameId: number;
  documentId: string;
  href: string;
  origin: string;
  probe: ProbeResult;
  seenAt: number;
}

let candidates: CandidateView[] = [];
let boundRunId: string | null = null;

async function refreshCandidates(): Promise<void> {
  const out = el<HTMLElement>('live-out');
  try {
    const result = await ui<{ candidates: CandidateView[]; live: unknown[] }>('listCandidates');
    candidates = result.candidates;
    const select = el<HTMLSelectElement>('candidate-select');
    select.replaceChildren();
    if (candidates.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'no provider tabs seen yet — open chatgpt.com and reload it';
      select.append(option);
    }
    for (const candidate of candidates) {
      const option = document.createElement('option');
      option.value = `${candidate.provider}|${candidate.tabId}|${candidate.documentId}`;
      option.textContent = `${candidate.provider} · tab ${candidate.tabId} · ${truncate(candidate.href)} · ${
        candidate.probe.recognized ? 'recognized' : `NOT recognized (${candidate.probe.reason ?? '?'})`
      }`;
      select.append(option);
    }
    setText(
      out,
      `${candidates.length} candidate tab(s). Live adapters: ${JSON.stringify(result.live)}`,
    );
  } catch (err) {
    setText(out, `listCandidates failed: ${describe(err)}`);
  }
}

function selectedCandidate(): CandidateView | null {
  const value = el<HTMLSelectElement>('candidate-select').value;
  if (!value) return null;
  const [provider, tabId, documentId] = value.split('|');
  return (
    candidates.find(
      (c) => c.provider === provider && c.tabId === Number(tabId) && c.documentId === documentId,
    ) ?? null
  );
}

async function bindRun(): Promise<string> {
  const candidate = selectedCandidate();
  if (!candidate) throw new Error('select a provider tab first');
  const runId = boundRunId ?? `run-${Date.now().toString(36)}`;
  const objective = el<HTMLInputElement>('objective').value;
  await ui('bindRun', {
    runId,
    objective,
    provider: candidate.provider,
    tabId: candidate.tabId,
    documentId: candidate.documentId,
  });
  boundRunId = runId;
  return runId;
}

function truncate(text: string, max = 70): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// Event log view
// ---------------------------------------------------------------------------

function eventDetail(event: StoredEvent): string {
  switch (event.type) {
    case 'RUN_CREATED':
      return `objective="${truncate(event.objective, 60)}" providers=${event.providers.join(',')}`;
    case 'SUBMISSION_REQUESTED':
      return `round ${event.round} op=${event.opId.slice(0, 8)} text="${truncate(event.text, 50)}"`;
    case 'REPLY_DETECTED':
      return `op=${event.opId.slice(0, 8)} ${event.text.length} chars · ${event.reason.join(', ')}`;
    case 'PROVIDER_FAILED':
      return event.reason;
    case 'ROUND_STARTED':
    case 'ROUND_COMPLETED':
      return `round ${event.round}`;
    case 'RUN_STOPPED':
      return event.reason;
    case 'USER_INTERJECTED':
      return `"${truncate(event.text, 60)}"`;
    case 'SUBMISSION_ACKNOWLEDGED':
    case 'TAMPER_DETECTED':
      return `op=${event.opId.slice(0, 8)}`;
  }
}

async function refreshLog(): Promise<void> {
  const tbody = el<HTMLTableElement>('log-table').tBodies[0] as HTMLTableSectionElement;
  tbody.replaceChildren();
  try {
    const { events } = await ui<{ events: StoredEvent[] }>('readLog');
    for (const event of events.slice(-200)) {
      const provider = 'provider' in event ? event.provider : '';
      tbody.append(
        row([
          { text: String(event.seq) },
          { text: event.type },
          { text: event.type === 'RUN_CREATED' ? event.id : 'runId' in event ? event.runId : '' },
          { text: provider },
          { text: eventDetail(event) },
        ]),
      );
    }
  } catch (err) {
    tbody.append(row([{ text: '—' }, { text: 'ERROR' }, { text: '' }, { text: '' }, { text: describe(err) }]));
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire(): void {
  const out = el<HTMLElement>('live-out');
  harnessOut = out;

  el('run-all').addEventListener('click', () => {
    void runAllScenarios().catch((err: unknown) => harnessLog(`run-all failed: ${describe(err)}`));
  });

  el('run-cycles').addEventListener('click', () => {
    void (async () => {
      const name = 'clean-20-cycles-semi';
      showScenario(name, 'run', '');
      const outcome = await withFastMock(() => scenarioCleanCycles(20));
      showScenario(name, outcome.ok ? 'pass' : 'fail', outcome.detail);
    })().catch((err: unknown) => showScenario('clean-20-cycles-semi', 'fail', describe(err)));
  });

  el('reset-mock').addEventListener('click', () => {
    try {
      requireMock().mock.reset();
      harnessLog('mock reset');
    } catch (err) {
      harnessLog(`reset failed: ${describe(err)}`);
    }
  });

  void singleSteps();

  el('refresh-candidates').addEventListener('click', () => void refreshCandidates());

  el('bind-run').addEventListener('click', () => {
    void (async () => {
      const runId = await bindRun();
      setText(out, `bound run ${runId}`);
    })().catch((err: unknown) => setText(out, `bind failed: ${describe(err)}`));
  });

  el('start-semi').addEventListener('click', () => void startFlow(false));
  el('start-auto').addEventListener('click', () => {
    el('auto-warning').hidden = false;
    void startFlow(true);
  });

  el('refresh-log').addEventListener('click', () => void refreshLog());
  el('clear-log').addEventListener('click', () => {
    void (async () => {
      await ui('clearLog');
      await refreshLog();
    })().catch((err: unknown) => setText(out, `clear log failed: ${describe(err)}`));
  });

  const mockSelect = el<HTMLSelectElement>('mock-provider-select');
  mockSelect.addEventListener('change', () => {
    currentMockProvider = mockSelect.value;
    const iframe = frame();
    iframe.src = currentMockProvider === 'claude' ? '../mocks/mock-claude.html' : '../mocks/mock-chatgpt.html';
    void loadBaseConfig(currentMockProvider)
      .then(() => harnessLog(`Switched harness to ${currentMockProvider} mock — ready`))
      .catch((err: unknown) => harnessLog(`Failed loading config: ${describe(err)}`));
  });

  frame().addEventListener('load', () => {
    void loadBaseConfig(currentMockProvider)
      .then(() => harnessLog(`${currentMockProvider} mock loaded and selector config validated — harness ready`))
      .catch((err: unknown) => harnessLog(`config load failed: ${describe(err)}`));
  });

  if (frame().contentDocument?.readyState === 'complete') {
    void loadBaseConfig(currentMockProvider).catch((err: unknown) => harnessLog(`config load failed: ${describe(err)}`));
  }

  void refreshCandidates();
  void refreshLog();
}

async function startFlow(autoSend: boolean): Promise<void> {
  const out = el<HTMLElement>('live-out');
  setText(out, '');
  try {
    if (!boundRunId) await bindRun();
    const runId = boundRunId;
    if (!runId) throw new Error('no run bound');
    const text = el<HTMLTextAreaElement>('live-prompt').value;
    log(out, `startFlow(autoSend=${autoSend}) on ${runId} …`);
    if (!autoSend) log(out, 'SEMI: text is staged in the composer — click Send in the provider tab now.');
    const { results } = await ui<{ results: unknown[] }>('startFlow', { runId, text, autoSend });
    log(out, JSON.stringify(results, null, 2));
    await refreshLog();
  } catch (err) {
    log(out, `startFlow failed: ${describe(err)}`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}

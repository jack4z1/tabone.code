// Silknet — MV3 background service worker (orchestration authority).
//
// Orchestration state and authority live HERE, not in the side panel: the panel
// can be closed by the user, or torn down by Chrome under memory pressure, at
// any point, and if it held the state, closing it would kill a running run.
//
// Phase v0.1 scope: enough of the state machine to drive ONE flow end-to-end
// (configure a bound tab -> inject text -> wait for completion -> read the reply
// -> log it). No debate protocol, no rounds, no side-panel. The machinery that
// v0.5 will build on (operation ids, idempotency, watchdog, TOCTOU binding) is
// real now because retrofitting it later is far more expensive than the extra
// code here.
//
// Status of a flow is derived from the append-only event log, never from an
// assumption that an in-memory async chain is still running.

import {
  appendEvent,
  clearLog,
  isOpAcknowledged,
  readAll,
  readRun,
  type StoredEvent,
} from './event-log';
import {
  isAdapterReadyMessage,
  isCmdResultMessage,
  isProbeHelloMessage,
  isUiMessage,
  NS,
  type CmdResultMessage,
  type UiMessage,
  type UiOp,
} from '../content-scripts/shared/messaging';
import {
  validateSelectorConfig,
  type ProviderSelectorConfig,
} from '../content-scripts/shared/selectors';
import type { AdapterCapabilities, ProbeResult } from '../content-scripts/shared/types';

const PROVIDERS = ['chatgpt'] as const;
type ProviderId = (typeof PROVIDERS)[number];

const isProviderId = (v: unknown): v is ProviderId =>
  typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

/** Authoritative selector documents, keyed by provider. */
interface LoadedProvider {
  id: ProviderId;
  config: ProviderSelectorConfig;
  script: string;
}

const PROVIDER_SCRIPTS: Record<ProviderId, string> = {
  chatgpt: 'content-scripts/adapter-chatgpt.js',
};

const loadedProviders = new Map<ProviderId, LoadedProvider>();

/** Lightweight passive-probe sightings: which tabs look like valid providers. */
interface Candidate {
  provider: ProviderId;
  tabId: number;
  frameId: number;
  documentId: string;
  href: string;
  origin: string;
  probe: ProbeResult;
  /** Last time this document was seen; a refresh changes documentId. */
  seenAt: number;
}

const candidates = new Map<string, Candidate>();
const candidateKey = (provider: string, tabId: number, frameId: number): string =>
  `${provider}:${tabId}:${frameId}`;

/** Which adapters are currently live, for diagnostics and recovery. */
const adaptersLive = new Map<string, { documentId: string; capabilities: AdapterCapabilities }>();

interface RunBinding {
  runId: string;
  objective: string;
  providers: ProviderId[];
  /** provider -> the exact document this run is bound to. */
  bound: Partial<Record<ProviderId, { tabId: number; frameId: number; documentId: string; origin: string }>>;
}

const runs = new Map<string, RunBinding>();

const WATCHDOG_PREFIX = 'silknet:watchdog:';

// ---------------------------------------------------------------------------
// Persistence
//
// An MV3 service worker is evicted after ~30s idle, so bindings cannot live only
// in memory. chrome.storage.session is the right home for these small ephemeral
// values. Note: content scripts CANNOT read chrome.storage.session unless the
// worker calls setAccessLevel(TRUSTED_AND_UNTRUSTED_CONTEXTS) — we deliberately
// do NOT do that, because nothing in a page context has any business reading
// run bindings. The authoritative long-lived record is the IndexedDB event log.
// ---------------------------------------------------------------------------

const SESSION_KEY = 'silknet/v0.1/session-state';

interface PersistedState {
  candidates: Candidate[];
  runs: RunBinding[];
}

let readyPromise: Promise<void> | null = null;

function ready(): Promise<void> {
  readyPromise ??= restoreState();
  return readyPromise;
}

async function restoreState(): Promise<void> {
  try {
    const bag = await chrome.storage.session.get(SESSION_KEY);
    const raw = bag[SESSION_KEY];
    if (typeof raw !== 'object' || raw === null) return;
    const state = raw as Partial<PersistedState>;
    if (Array.isArray(state.candidates)) {
      for (const candidate of state.candidates) {
        if (candidate && typeof candidate.tabId === 'number' && typeof candidate.provider === 'string') {
          candidates.set(candidateKey(candidate.provider, candidate.tabId, candidate.frameId), candidate);
        }
      }
    }
    if (Array.isArray(state.runs)) {
      for (const run of state.runs) {
        if (run && typeof run.runId === 'string') runs.set(run.runId, run);
      }
    }
  } catch {
    // A cold session store is normal on first run; nothing to recover.
  }
}

async function persistState(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [SESSION_KEY]: { candidates: [...candidates.values()], runs: [...runs.values()] },
    });
  } catch {
    // Persisting is best-effort convenience; the event log remains truth.
  }
}

// ---------------------------------------------------------------------------
// Selector config: loaded at runtime from the decoupled JSON, then validated.
// Never hardcoded into adapter code.
// ---------------------------------------------------------------------------

async function loadProvider(id: ProviderId): Promise<LoadedProvider> {
  const existing = loadedProviders.get(id);
  if (existing) return existing;

  const url = chrome.runtime.getURL(`selectors/${id}.json`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not load ${url}: HTTP ${response.status}`);
  }
  const raw: unknown = await response.json();
  const validation = validateSelectorConfig(raw);
  if (!validation.ok) {
    throw new Error(`selectors/${id}.json rejected by schema validation — ${validation.reason}`);
  }
  if (validation.config.provider !== id) {
    throw new Error(
      `selectors/${id}.json declares provider "${validation.config.provider}", expected "${id}"`,
    );
  }
  const script = PROVIDER_SCRIPTS[id];
  const loaded: LoadedProvider = { id, config: validation.config, script };
  loadedProviders.set(id, loaded);
  return loaded;
}

// ---------------------------------------------------------------------------
// RPC to content scripts
// ---------------------------------------------------------------------------

interface PendingRpc {
  opId: string;
  tabId: number;
  provider: ProviderId;
  expectedDocumentId: string;
  settle: (result: CmdResultMessage | { error: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRpc = new Map<string, PendingRpc>();

const RPC_TIMEOUT_MS = 15_000;

function isNoReceiver(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Receiving end does not exist|Could not establish connection|message port closed/i.test(
    message,
  );
}

/**
 * The exact document an operation is bound to: provider + tabId + frameId +
 * document identity. Binding to provider + tabId alone leaves a
 * time-of-check-to-time-of-use gap, because the tab can navigate between the
 * check and the action that follows it.
 */
interface RpcTarget {
  provider: ProviderId;
  tabId: number;
  documentId: string;
  origin: string;
}

/**
 * Sends one validated command to a bound content script and awaits its
 * CMD_RESULT. The reply's documentId is checked against the document the caller
 * believed it was addressing, so a mid-flight navigation is detected rather than
 * silently acted upon.
 */
async function rpc<T>(
  target: RpcTarget, 
  op: string, 
  args: unknown, 
  timeoutMs = RPC_TIMEOUT_MS
): Promise<T> {
  const { provider, tabId, documentId: expectedDocumentId, origin } = target;
  const opId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const settle = (result: CmdResultMessage | { error: string }): void => {
      const entry = pendingRpc.get(opId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingRpc.delete(opId);
      }
      if ('error' in result) {
        reject(new Error(result.error));
        return;
      }
      if (!result.ok) {
        reject(new Error(result.error ?? 'content script reported failure'));
        return;
      }
      if (result.documentId !== expectedDocumentId) {
        reject(new Error('document-identity-mismatch: bound document changed (TOCTOU guard)'));
        return;
      }
      resolve(result.result as T);
    };

    pendingRpc.set(opId, {
      opId,
      tabId,
      provider,
      expectedDocumentId,
      settle,
      timer: setTimeout(() => {
        pendingRpc.delete(opId);
        reject(new Error(`rpc timeout after ${timeoutMs}ms (op ${op})`));
      }, timeoutMs),
    });

    chrome.tabs
      .sendMessage(tabId, {
        ns: NS,
        kind: 'CMD',
        provider,
        opId,
        expect: { documentId: expectedDocumentId, origin },
        op,
        args,
      })
      .catch((err: unknown) => {
        const entry = pendingRpc.get(opId);
        if (entry) {
          clearTimeout(entry.timer);
          pendingRpc.delete(opId);
        }
        reject(new Error(err instanceof Error ? err.message : String(err)));
      });
  });
}

async function injectAdapter(loaded: LoadedProvider, tabId: number, documentId: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (id) => { (globalThis as any).__silknet_document_id = id; },
    args: [documentId],
  });
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: [loaded.script],
  });
}

/**
 * Guarantees a live, configured adapter for the bound document, injecting it on
 * demand (Phase 2 of two-phase loading) if it is not already running.
 */
async function ensureConfiguredAdapter(
  loaded: LoadedProvider,
  binding: { tabId: number; frameId: number; documentId: string; origin: string },
): Promise<void> {
  // Re-verify the tab before acting on it: the check that produced `binding` and
  // the action below are separated in time, so confirm the document is still the
  // expected origin right before injecting.
  const tab = await chrome.tabs.get(binding.tabId).catch(() => null);
  if (!tab) throw new Error(`tab ${binding.tabId} no longer exists`);
  const tabOrigin = tab.url ? safeOrigin(tab.url) : null;
  if (tabOrigin === null || !loaded.config.match.origins.includes(tabOrigin)) {
    throw new Error(
      `tab ${binding.tabId} is no longer on a ${loaded.id} origin (${tab.url ?? 'unknown'})`,
    );
  }

  const target: RpcTarget = {
    provider: loaded.id,
    tabId: binding.tabId,
    documentId: binding.documentId,
    origin: binding.origin,
  };

  try {
    await rpc(target, 'probe', {});
    return;
  } catch (err) {
    if (!isNoReceiver(err)) throw err;
  }

  await injectAdapter(loaded, binding.tabId, binding.documentId);
  await rpc(target, 'configure', {
    config: loaded.config,
    tabId: binding.tabId,
    frameId: binding.frameId,
  });
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The one v0.1 flow
// ---------------------------------------------------------------------------

interface FlowResult {
  provider: ProviderId;
  status: 'reply-captured' | 'failed' | 'needs-attention';
  submissionId?: string;
  reply?: string;
  detail: string;
}

interface StartFlowArgs {
  runId: string;
  text: string;
  autoSend: boolean;
}

function parseStartFlowArgs(args: unknown): StartFlowArgs | null {
  if (typeof args !== 'object' || args === null) return null;
  const record = args as Record<string, unknown>;
  const runId = record['runId'];
  const text = record['text'];
  const autoSend = record['autoSend'];
  if (typeof runId !== 'string' || !runId) return null;
  if (typeof text !== 'string') return null;
  return { runId, text, autoSend: autoSend === true };
}

async function startFlow(args: StartFlowArgs): Promise<FlowResult[]> {
  const run = runs.get(args.runId);
  if (!run) throw new Error(`unknown runId ${args.runId}`);

  await appendEvent({
    type: 'ROUND_STARTED',
    runId: run.runId,
    round: 1,
    timestamp: Date.now(),
  });

  const results: FlowResult[] = [];
  for (const provider of run.providers) {
    results.push(await runProviderTurn(run, provider, args));
  }

  await appendEvent({
    type: 'ROUND_COMPLETED',
    runId: run.runId,
    round: 1,
    timestamp: Date.now(),
  });

  return results;
}

/**
 * One provider's turn. A single provider failing never aborts the run: the
 * failure is logged and the remaining providers continue ("Claude unavailable —
 * continuing with ChatGPT"). Building this correctly is what makes the system
 * feel resilient rather than brittle.
 */
async function runProviderTurn(
  run: RunBinding,
  provider: ProviderId,
  args: StartFlowArgs,
): Promise<FlowResult> {
  const binding = run.bound[provider];
  if (!binding) {
    const detail = `${provider} is not bound to a tab`;
    await appendEvent({ type: 'PROVIDER_FAILED', runId: run.runId, provider, reason: detail, timestamp: Date.now() });
    return { provider, status: 'failed', detail };
  }

  let loaded: LoadedProvider;
  try {
    loaded = await loadProvider(provider);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendEvent({ type: 'PROVIDER_FAILED', runId: run.runId, provider, reason: detail, timestamp: Date.now() });
    return { provider, status: 'failed', detail };
  }

  // opId is generated by the orchestrator at call time and is the idempotency
  // key: a retried operation whose acknowledgement is already in the log must be
  // recognised and ignored, never double-submitted.
  const opId = crypto.randomUUID();
  if (await isOpAcknowledged(opId)) {
    return { provider, status: 'needs-attention', detail: 'duplicate opId ignored' };
  }

  await appendEvent({
    type: 'SUBMISSION_REQUESTED',
    runId: run.runId,
    round: 1,
    provider,
    opId,
    text: args.text,
    timestamp: Date.now(),
  });

  try {
    await ensureConfiguredAdapter(loaded, binding);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendEvent({ type: 'PROVIDER_FAILED', runId: run.runId, provider, reason: detail, timestamp: Date.now() });
    return { provider, status: 'failed', detail };
  }

  const target: RpcTarget = {
    provider,
    tabId: binding.tabId,
    documentId: binding.documentId,
    origin: binding.origin,
  };

  let probe: ProbeResult;
  try {
    probe = await rpc<ProbeResult>(target, 'probe', {});
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendEvent({ type: 'PROVIDER_FAILED', runId: run.runId, provider, reason: `probe failed: ${detail}`, timestamp: Date.now() });
    return { provider, status: 'failed', detail };
  }
  if (!probe.recognized) {
    const detail = `probe() failed: ${probe.reason ?? 'unrecognised UI — selector config needs updating'}`;
    await appendEvent({ type: 'PROVIDER_FAILED', runId: run.runId, provider, reason: detail, timestamp: Date.now() });
    return { provider, status: 'failed', detail };
  }

  let submissionId: string;
  try {
    const submitted = await rpc<{ submissionId: string; autoSent: boolean }>(target, 'submit', {
      text: args.text,
      autoSend: args.autoSend,
    });
    submissionId = submitted.submissionId;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendEvent({ type: 'PROVIDER_FAILED', runId: run.runId, provider, reason: detail, timestamp: Date.now() });
    return { provider, status: 'failed', detail };
  }

  await appendEvent({
    type: 'SUBMISSION_ACKNOWLEDGED',
    runId: run.runId,
    opId,
    timestamp: Date.now(),
  });

  // Watchdog via chrome.alarms, not an in-memory timer: an in-memory timer dies
  // with the service worker invocation, whereas an alarm survives sleep/wake.
  const watchdogMs = loaded.config.behavior.watchdogMs;
  await chrome.alarms.create(`${WATCHDOG_PREFIX}${opId}`, { delayInMinutes: watchdogMs / 60_000 });

  try {
    const completion = await rpc<{ complete: boolean; reason: string[] }>(target, 'waitForCompletion', {
      submissionId,
      // Slightly inside the watchdog so the in-band timeout is the one that
      // normally reports the failure with richer reasons.
      timeoutMs: Math.max(1000, watchdogMs - 5000),
    }, watchdogMs + 10000);

    if (!completion.complete) {
      await chrome.alarms.clear(`${WATCHDOG_PREFIX}${opId}`);
      const detail = completion.reason.join('; ');
      await appendEvent({
        type: 'PROVIDER_FAILED',
        runId: run.runId,
        provider,
        reason: `incomplete: ${detail} — status unknown, resume manually`,
        timestamp: Date.now(),
      });
      return { provider, status: 'needs-attention', submissionId, detail };
    }

    const reply = await rpc<string>(target, 'readReply', { submissionId });

    await chrome.alarms.clear(`${WATCHDOG_PREFIX}${opId}`);
    await appendEvent({
      type: 'REPLY_DETECTED',
      runId: run.runId,
      opId,
      text: reply,
      reason: completion.reason,
      timestamp: Date.now(),
    });
    return {
      provider,
      status: 'reply-captured',
      submissionId,
      reply,
      detail: completion.reason.join(', '),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendEvent({
      type: 'PROVIDER_FAILED',
      runId: run.runId,
      provider,
      reason: `${detail} — status unknown, resume manually (never auto-resent)`,
      timestamp: Date.now(),
    });
    return { provider, status: 'needs-attention', submissionId, detail };
  }
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(WATCHDOG_PREFIX)) return;
  const opId = alarm.name.slice(WATCHDOG_PREFIX.length);
  // The alarm fires after the command already resolved in the happy path; only
  // an unresolved pending RPC means the provider genuinely stalled.
  const stillPending = [...pendingRpc.values()].find((p) => p.opId === opId);
  if (!stillPending) return;
  stillPending.settle({ error: 'watchdog-fired: provider needs attention' });
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    // --- from content scripts -------------------------------------------------
    if (isProbeHelloMessage(message)) {
      if (!isProviderId(message.provider)) return false;
      // Captured in a const so the narrowing survives into the async callback
      // below (property narrowing is dropped across a function boundary).
      const provider = message.provider;
      const tabId = sender.tab?.id;
      if (tabId === undefined) return false;
      if (sender.frameId !== undefined && sender.frameId !== 0 && !message.topFrame) return false;
      const origin = safeOrigin(sender.tab?.url ?? message.href);
      if (origin === null || origin !== message.origin) {
        // A message whose claimed origin disagrees with the sender's tab url is
        // not trusted for binding purposes.
        return false;
      }
      const frameId = sender.frameId ?? 0;
      void ready().then(() => {
        candidates.set(candidateKey(provider, tabId, frameId), {
          provider,
          tabId,
          frameId,
          documentId: message.documentId,
          href: message.href,
          origin: message.origin,
          probe: message.probe,
          seenAt: Date.now(),
        });
        void persistState();
      });
      return false;
    }

    if (isAdapterReadyMessage(message)) {
      if (!isProviderId(message.provider)) return false;
      const provider = message.provider;
      const tabId = sender.tab?.id;
      if (tabId === undefined) return false;
      const frameId = sender.frameId ?? 0;
      // A freshly announced adapter means a NEW document (refresh / re-injection):
      // the previous document's in-flight operations are dead, so the binding's
      // identity is replaced rather than reused.
      void ready().then(() => {
        adaptersLive.set(candidateKey(provider, tabId, frameId), {
          documentId: message.documentId,
          capabilities: message.capabilities,
        });
        const key = candidateKey(provider, tabId, frameId);
        const existing = candidates.get(key);
        if (existing) candidates.set(key, { ...existing, documentId: message.documentId, seenAt: Date.now() });
        void persistState();
      });
      return false;
    }

    if (isCmdResultMessage(message)) {
      const entry = pendingRpc.get(message.opId);
      if (entry) entry.settle(message);
      return false;
    }

    // --- from the test console / side panel ----------------------------------
    if (isUiMessage(message)) {
      void ready()
        .then(() => handleUi(message))
        .then((result) => sendResponse({ ns: NS, kind: 'UI_RESULT', op: message.op, requestId: message.requestId, ok: true, result }))
        .catch((err: unknown) =>
          sendResponse({
            ns: NS,
            kind: 'UI_RESULT',
            op: message.op,
            requestId: message.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true; // async response
    }

    return false;
  },
);

async function handleUi(message: UiMessage): Promise<unknown> {
  switch (message.op as UiOp) {
    case 'listCandidates':
      return { candidates: [...candidates.values()], live: [...adaptersLive.entries()] };

    case 'bindRun': {
      const args = message.args;
      if (typeof args !== 'object' || args === null) throw new Error('bindRun: invalid args');
      const record = args as Record<string, unknown>;
      const runId = record['runId'];
      const objective = record['objective'];
      const provider = record['provider'];
      const tabId = record['tabId'];
      const documentId = record['documentId'];
      if (typeof runId !== 'string' || !runId) throw new Error('bindRun: runId required');
      if (typeof objective !== 'string') throw new Error('bindRun: objective required');
      if (!isProviderId(provider)) throw new Error(`bindRun: unsupported provider ${String(provider)}`);
      if (typeof tabId !== 'number' || !Number.isInteger(tabId)) throw new Error('bindRun: tabId required');
      if (typeof documentId !== 'string' || !documentId) throw new Error('bindRun: documentId required');

      const candidate = [...candidates.values()].find(
        (c) => c.provider === provider && c.tabId === tabId && c.documentId === documentId,
      );
      if (!candidate) {
        throw new Error('bindRun: that tab has not announced itself as a valid provider document');
      }

      const existing = runs.get(runId);
      const run: RunBinding = existing ?? {
        runId,
        objective,
        providers: [],
        bound: {},
      };
      run.objective = objective;
      if (!run.providers.includes(provider)) run.providers.push(provider);
      run.bound[provider] = {
        tabId: candidate.tabId,
        frameId: candidate.frameId,
        documentId: candidate.documentId,
        origin: candidate.origin,
      };
      runs.set(runId, run);
      void persistState();

      if (!existing) {
        await appendEvent({
          type: 'RUN_CREATED',
          id: runId,
          objective,
          providers: [provider],
          timestamp: Date.now(),
        });
      }
      return { binding: run.bound[provider] };
    }

    case 'startFlow': {
      const parsed = parseStartFlowArgs(message.args);
      if (!parsed) throw new Error('startFlow: invalid args');
      return { results: await startFlow(parsed) };
    }

    case 'probeBoundTabs': {
      const out: Record<string, unknown> = {};
      for (const [runId, run] of runs) {
        for (const provider of run.providers) {
          const binding = run.bound[provider];
          if (!binding) continue;
          try {
            const loaded = await loadProvider(provider);
            await ensureConfiguredAdapter(loaded, binding);
            const probe = await rpc<ProbeResult>(
              {
                provider,
                tabId: binding.tabId,
                documentId: binding.documentId,
                origin: binding.origin,
              },
              'probe',
              {},
            );
            out[`${runId}:${provider}`] = { ok: true, probe };
          } catch (err) {
            out[`${runId}:${provider}`] = {
              ok: false,
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }
      return out;
    }

    case 'getRunState': {
      const args = message.args;
      if (typeof args !== 'object' || args === null) throw new Error('getRunState: invalid args');
      const runId = (args as Record<string, unknown>)['runId'];
      if (typeof runId !== 'string' || !runId) throw new Error('getRunState: runId required');
      return { events: await readRun(runId) };
    }

    case 'readLog': {
      const events: StoredEvent[] = await readAll();
      return { events };
    }

    // Dev-only reset for the spike. The log is append-only in normal operation;
    // this exists so a tester can start from a clean slate between runs.
    case 'clearLog': {
      await clearLog();
      return { cleared: true };
    }

    default:
      throw new Error(`unhandled UI op ${message.op}`);
  }
}

// ---------------------------------------------------------------------------
// Dev entry point (Phase v0.1 only)
//
// There is no side panel yet by design — Phase v0.1 is a spike, and the panel is
// Phase v0.5 scope. Clicking the toolbar icon opens the dev test console, which
// drives this worker and runs the adapter conformance suite against the mocks.
// When the side panel lands, this handler is replaced by sidePanel.setPanelBehavior.
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('test-console/test-console.html') });
});

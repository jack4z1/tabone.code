// Silknet — provider adapter core.
//
// One implementation of the ProviderAdapter contract, parameterised by a
// provider selector config and an injected "environment". The environment exists
// so the identical code path can run:
//   - as a real content script, against the live provider page; and
//   - against mocks/mock-*.html inside the dev test console (conformance tests),
// without a second, divergent implementation that could pass tests while the
// real adapter is broken.
//
// Security posture: everything read out of the page is inert DATA. Page text can
// influence the *content* of the next prompt and nothing else — it never selects
// a branch that triggers an action, never changes a selector, and is never
// interpreted as an instruction.

import {
  evaluateCompletionSignals,
  watchForStability,
  type SignalEvaluation,
} from './completion-detection';
import {
  extractInertText,
  injectComposerText,
  isDisabledLike,
  readComposerText,
  textsMatch,
} from './injection-utils';
import {
  describeSpecs,
  queryAll,
  queryFirst,
  queryFirstVisible,
  type ProviderSelectorConfig,
} from './selectors';
import type {
  AdapterCapabilities,
  AdapterState,
  CompletionResult,
  DocumentIdentity,
  ProbeResult,
  ProviderAdapter,
  SubmitResult,
} from './types';

export interface AdapterEnv {
  document: Document;
  location: { href: string; origin: string };
  /** True when this script is running in the top frame (spec: reject iframes). */
  isTopFrame: boolean;
  provider: string;
  tabId: number;
  frameId: number;
  /** Regenerated on every real document load; the TOCTOU guard. */
  documentId: string;
  now(): number;
  randomId(): string;
  onTamperBlocked?: (expectedText: string, actualText: string) => void;
}

export interface SilknetAdapter extends ProviderAdapter {
  identity(): DocumentIdentity;
  /** Applies a validated selector config (service worker is the source). */
  configure(config: ProviderSelectorConfig): void;
  /** Completion-detection methods this adapter implements. */
  readonly completionDetectionMethods: string[];
}

interface SubmissionRecord {
  submissionId: string;
  text: string;
  autoSent: boolean;
  documentId: string;
  /** Assistant-turn count observed BEFORE this submission. The reply belonging
   *  to this submission is the turn at this index — never "the last assistant
   *  message on the page", which would risk reading an old, regenerated, or
   *  prior-state message. */
  baselineAssistantCount: number;
  baselineUserCount: number;
  submittedAt: number;
}

const SAFETY_RECHECK_MS = 2000;

/**
 * Awaits a value produced by `probe`, driven by a MutationObserver rather than a
 * poll loop. A low-frequency safety recheck exists only to (a) resolve the
 * deadline and (b) re-attach the observer if the observed root was replaced by a
 * re-render — it is never itself the completion criterion.
 */
export function waitForValue<T>(
  root: Node,
  probe: () => T | undefined,
  opts: { deadline: number; now: () => number; safetyIntervalMs?: number },
): Promise<T | null> {
  const safetyIntervalMs = opts.safetyIntervalMs ?? SAFETY_RECHECK_MS;
  return new Promise<T | null>((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let safety: ReturnType<typeof setInterval> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    // Realm-safe detached check: never `instanceof`, because the observed root
    // can belong to an iframe document.
    const isDetached = (node: Node): boolean => {
      const connected = (node as Partial<Element>).isConnected;
      return typeof connected === 'boolean' ? !connected : false;
    };

    const cleanup = (): void => {
      settled = true;
      observer?.disconnect();
      observer = null;
      if (safety !== null) clearInterval(safety);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    };

    const attach = (): void => {
      observer?.disconnect();
      observer = new MutationObserver(evaluate);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    };

    const evaluate = (): void => {
      if (settled) return;
      const value = probe();
      if (value !== undefined) {
        cleanup();
        resolve(value);
        return;
      }
      if (opts.now() >= opts.deadline) {
        cleanup();
        resolve(null);
        return;
      }
      // Container may have been swapped out mid-stream by a re-render.
      if (observer && isDetached(root)) attach();
    };

    safety = setInterval(evaluate, safetyIntervalMs);
    deadlineTimer = setTimeout(evaluate, Math.max(0, opts.deadline - opts.now()));
    attach();
    evaluate();
  });
}

export function createAdapter(env: AdapterEnv, config: ProviderSelectorConfig): SilknetAdapter {
  let selectorConfig = config;
  const records = new Map<string, SubmissionRecord>();
  /** Records wiped by recover(); their outcome is unknown, never auto-resent. */
  const retired = new Set<string>();
  let activeTamperCleanup: (() => void) | null = null;

  const doc = env.document;
  const body = doc.body;

  const cleanupTamperGuard = (): void => {
    if (activeTamperCleanup) {
      activeTamperCleanup();
      activeTamperCleanup = null;
    }
    const docWithGuard = doc as unknown as { __silknetTamperCleanup?: (() => void) | null };
    if (docWithGuard.__silknetTamperCleanup === cleanupTamperGuard) {
      docWithGuard.__silknetTamperCleanup = null;
    }
  };

  const assistantTurns = (): Element[] =>
    queryAll(selectorConfig.selectors.assistantTurn, body);

  const userTurns = (): Element[] => queryAll(selectorConfig.selectors.userTurn, body);

  const capabilities = (): AdapterCapabilities => ({
    autoSend: true,
    manualSend: true,
    readReply: true,
    completionDetectionMethods: [
      'mutation-stability',
      'stop-control-absent',
      'composer-ready',
      'reply-controls-present',
    ],
    inputType: selectorConfig.behavior.inputType,
  });

  const probe = async (): Promise<ProbeResult> => {
    if (selectorConfig.match.topFrameOnly && !env.isTopFrame) {
      return { recognized: false, reason: 'adapter is running in a sub-frame, not the top frame' };
    }
    if (!selectorConfig.match.origins.includes(env.location.origin)) {
      return {
        recognized: false,
        reason: `origin ${env.location.origin} is not a declared ${selectorConfig.provider} origin`,
      };
    }
    const composer = queryFirst(selectorConfig.selectors.composer, body);
    if (!composer) {
      return {
        recognized: false,
        reason: `composer not found (tried ${describeSpecs(selectorConfig.selectors.composer)})`,
      };
    }
    // Visibility-aware: at idle the send control is shown and the stop control is
    // hidden (or vice versa while generating), so only a RENDERED control counts.
    // NOTE: Some providers (ChatGPT) lazily render the send button only when text
    // is present in the composer, so missing buttons at probe time is NOT a hard
    // failure — we warn but proceed. Buttons are re-checked at submit time.
    const send = queryFirstVisible(selectorConfig.selectors.sendButton, body);
    const stop = queryFirstVisible(selectorConfig.selectors.stopButton, body);
    const container = queryFirst(selectorConfig.selectors.responseContainer, body);
    if (!container) {
      return {
        recognized: false,
        reason: `response container not found (tried ${describeSpecs(selectorConfig.selectors.responseContainer)})`,
      };
    }
    const clean = assistantTurns().length === 0 && userTurns().length === 0;
    if (clean) {
      // Recognised structure with an empty conversation is a valid, clean page
      // (in fact the required precondition for a debate round).
      const warning = !send && !stop ? ' (send/stop buttons not yet visible — will recheck at submit)' : '';
      return { recognized: true, isClean: true, reason: `empty conversation, composer recognised${warning}` };
    }
    return { recognized: true, isClean: false, reason: 'conversation has prior history' };
  };

  const isClean = (): boolean => assistantTurns().length === 0 && userTurns().length === 0;

  const composerReadyNow = (): boolean => {
    const composer = queryFirst<HTMLElement>(selectorConfig.selectors.composer, body);
    if (!composer) return false;
    const el = composer.el;
    return !isDisabledLike(el) && !(el as HTMLTextAreaElement).readOnly;
  };

  const getState = async (): Promise<AdapterState> => {
    const composer = queryFirst(selectorConfig.selectors.composer, body);
    if (!composer) return 'unknown';

    if (queryFirstVisible(selectorConfig.selectors.stopButton, body)) return 'generating';

    // Composer present but unusable with nothing generating usually means a
    // rate limit, login wall, or blocking modal.
    if (!composerReadyNow()) return 'blocked';

    // "done" = a completed assistant turn is on screen and the composer is
    // usable again; "idle" = recognised but no reply yet.
    return assistantTurns().length > 0 ? 'done' : 'idle';
  };

  const submit = async (text: string, opts?: { autoSend?: boolean }): Promise<SubmitResult> => {
    const composer = queryFirst<HTMLElement>(selectorConfig.selectors.composer, body);
    if (!composer) throw new Error('submit: composer not found');

    // Marker is recorded BEFORE submitting, so the reply that follows can be
    // attributed unambiguously.
    const submissionId = env.randomId();
    const record: SubmissionRecord = {
      submissionId,
      text,
      autoSent: opts?.autoSend === true,
      documentId: env.documentId,
      baselineAssistantCount: assistantTurns().length,
      baselineUserCount: userTurns().length,
      submittedAt: env.now(),
    };
    records.set(submissionId, record);

    const outcome = injectComposerText(composer.el, text, selectorConfig.behavior);
    if (!outcome.ok) {
      records.delete(submissionId);
      throw new Error(`submit: injection failed — ${outcome.reason}`);
    }

    if (!record.autoSent) {
      // Clean up any lingering listener from an earlier turn or prior adapter on this document
      const docWithGuard = doc as unknown as { __silknetTamperCleanup?: (() => void) | null };
      if (typeof docWithGuard.__silknetTamperCleanup === 'function') {
        docWithGuard.__silknetTamperCleanup();
      }
      cleanupTamperGuard();
      docWithGuard.__silknetTamperCleanup = cleanupTamperGuard;

      const lastInjectedText = text;
      const sendResolved = queryFirst<HTMLElement>(selectorConfig.selectors.sendButton, body);
      const targetEl = sendResolved?.el;

      const checkAndBlockTamper = (event: Event): boolean => {
        const composerEl = queryFirst<HTMLElement>(selectorConfig.selectors.composer, body);
        if (!composerEl) return true;
        const currentText = readComposerText(composerEl.el);
        if (!textsMatch(currentText, lastInjectedText)) {
          // Block click in capture phase before page listeners see it!
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          if (typeof env.onTamperBlocked === 'function') {
            env.onTamperBlocked(lastInjectedText, currentText);
          }
          return false;
        }
        return true;
      };

      const onCaptureClick = (event: Event): void => {
        const target = event.target as Node | null;
        if (target) {
          const currentSend = queryFirst(selectorConfig.selectors.sendButton, body);
          if (currentSend && (currentSend.el === target || currentSend.el.contains(target))) {
            const ok = checkAndBlockTamper(event);
            if (ok) cleanupTamperGuard();
            return;
          }
        }
        if (targetEl && (event.currentTarget === targetEl || event.target === targetEl)) {
          const ok = checkAndBlockTamper(event);
          if (ok) cleanupTamperGuard();
        }
      };

      const onCaptureKeydown = (event: Event): void => {
        const keyEvent = event as KeyboardEvent;
        if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
          const ok = checkAndBlockTamper(event);
          if (ok) cleanupTamperGuard();
        }
      };

      // Attach capture-phase listener to the send button directly and document for delegated clicks
      targetEl?.addEventListener('click', onCaptureClick, true);
      doc.addEventListener('click', onCaptureClick, true);
      composer.el.addEventListener('keydown', onCaptureKeydown, true);

      activeTamperCleanup = () => {
        targetEl?.removeEventListener('click', onCaptureClick, true);
        doc.removeEventListener('click', onCaptureClick, true);
        composer.el.removeEventListener('keydown', onCaptureKeydown, true);
      };

      return { submissionId, autoSent: false };
    }

    const send = queryFirstVisible<HTMLElement>(selectorConfig.selectors.sendButton, body);
    if (!send) throw new Error('submit: autoSend requested but no rendered send control found');
    // NOTE: this synthetic click carries event.isTrusted === false. That is exactly
    // why AUTO mode is off by default and SEMI is the primary supported mode.
    send.el.click();
    return { submissionId, autoSent: true };
  };

  const awaitStability = (
    container: Node,
    stableMs: number,
    deadline: number,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      let cancel = (): void => {};
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        cancel();
        resolve(value);
      };

      cancel = watchForStability(container, stableMs, () => finish(true));
      deadlineTimer = setTimeout(() => finish(false), Math.max(0, deadline - env.now()));
    });

  const waitForCompletion = async (
    submissionId: string,
    opts?: { timeoutMs?: number },
  ): Promise<CompletionResult> => {
    if (retired.has(submissionId)) {
      return {
        complete: false,
        reason: [
          'submission-outcome-unknown-after-recovery: never auto-resent — resume manually',
        ],
      };
    }
    const record = records.get(submissionId);
    if (!record) {
      return {
        complete: false,
        reason: [
          'unknown-submission: adapter holds no record for this id (content script was reloaded) — resume manually',
        ],
      };
    }
    if (record.documentId !== env.documentId) {
      return {
        complete: false,
        reason: ['stale-submission: bound document changed (TOCTOU guard) — resume manually'],
      };
    }

    const timeoutMs = opts?.timeoutMs ?? selectorConfig.behavior.watchdogMs;
    const deadline = env.now() + timeoutMs;

    // 1. Wait specifically for the NEW assistant turn created after THIS
    //    submission, not for "the last assistant message on the page".
    const targetIndex = record.baselineAssistantCount;
    const turn = await waitForValue<Element>(
      body,
      () => assistantTurns()[targetIndex],
      { deadline, now: env.now },
    );
    if (!turn) {
      return {
        complete: false,
        reason: [
          `timeout-${timeoutMs}ms-waiting-for-new-assistant-turn`,
          'watchdog-fired: no reply turn observed for this submission (was Send clicked?)',
        ],
      };
    }

    const container =
      queryFirst(selectorConfig.selectors.responseContainer, body)?.el ?? body;

    // 2. Combine corroborating signals. If the response becomes stable but the
    //    stop control is still up (a mid-generation pause that resumed), keep
    //    waiting rather than declaring completion early.
    let last: SignalEvaluation | null = null;
    for (;;) {
      const stable = await awaitStability(container, selectorConfig.behavior.stabilityMs, deadline);
      if (!stable) {
        // Report whichever signal was actually missing rather than a generic
        // timeout: the whole point of a structured result is diagnosability.
        return {
          complete: false,
          reason: last
            ? [
                ...last.reason,
                `timeout-${timeoutMs}ms: completion signals never all satisfied`,
              ]
            : [
                `timeout-${timeoutMs}ms-without-response-stability`,
                'watchdog-fired: response never stopped changing',
              ],
        };
      }
      const evaluation = evaluateCompletionSignals(selectorConfig, body, {
        stableObserved: true,
        stableMs: selectorConfig.behavior.stabilityMs,
      });
      last = evaluation;
      if (evaluation.complete || env.now() >= deadline) break;
      // Still generating: a resumed mutation will reset the stability timer.
    }

    if (!last) {
      return { complete: false, reason: ['internal: no signal evaluation produced'] };
    }
    if (!last.complete) {
      return {
        complete: false,
        reason: [...last.reason, `timeout-${timeoutMs}ms: completion signals never all satisfied`],
      };
    }
    cleanupTamperGuard();
    return { complete: true, reason: last.reason };
  };

  const readReply = async (submissionId: string): Promise<string> => {
    if (retired.has(submissionId)) {
      throw new Error(
        'readReply: outcome for this submission is unknown after a content-script reload — resume manually',
      );
    }
    const record = records.get(submissionId);
    if (!record) throw new Error(`readReply: unknown submissionId ${submissionId}`);
    if (record.documentId !== env.documentId) {
      throw new Error('readReply: bound document changed (TOCTOU guard)');
    }
    // Always requery fresh: message nodes are detached and rebuilt mid-stream,
    // so a reference held from earlier may be stale.
    const turn = assistantTurns()[record.baselineAssistantCount];
    if (!turn) {
      throw new Error(
        `readReply: no assistant turn at index ${record.baselineAssistantCount} yet`,
      );
    }
    // Read the turn's MESSAGE BODY, not the turn element: a turn also carries UI
    // chrome (turn label, Copy/Regenerate buttons) whose text would otherwise be
    // spliced into the reply.
    const bodyEl = queryFirst(selectorConfig.selectors.assistantMessageBody, turn);
    // Clone + textContent: never innerHTML, and reading must not fire listeners
    // attached to the live node.
    return extractInertText(bodyEl?.el ?? turn);
  };

  const recover = async (): Promise<void> => {
    cleanupTamperGuard();
    // A fresh content script instance means the page reloaded. Any in-flight
    // submission belongs to a document that no longer exists, so its outcome is
    // UNKNOWN — retire it and let a human decide. Never resend automatically:
    // that risks a duplicate send into a live chat.
    for (const id of records.keys()) retired.add(id);
    records.clear();
    await probe();
  };

  return {
    probe,
    getState,
    isClean,
    submit,
    waitForCompletion,
    readReply,
    recover,
    capabilities,
    identity: () => ({
      provider: env.provider,
      tabId: env.tabId,
      frameId: env.frameId,
      documentId: env.documentId,
      href: env.location.href,
      origin: env.location.origin,
    }),
    configure: (next: ProviderSelectorConfig): void => {
      selectorConfig = next;
    },
    completionDetectionMethods: capabilities().completionDetectionMethods,
  };
}

/**
 * True when the composer currently holds `expected`. Used by SEMI mode to show
 * the "text is staged and unmodified" state before a human clicks Send.
 * (Full tamper blocking on the capture-phase Send listener is Phase v0.5.)
 */
export function composerMatches(env: AdapterEnv, config: ProviderSelectorConfig, expected: string): boolean {
  const composer = queryFirst(config.selectors.composer, env.document.body);
  if (!composer) return false;
  return textsMatch(readComposerText(composer.el), expected);
}

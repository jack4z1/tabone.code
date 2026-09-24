// Silknet — completion detection.
//
// NEVER rely on a single signal:
//   - NOT a fixed timer (a slow model and a fast one are indistinguishable);
//   - NOT generic "network idle" (streaming keeps connections open, and
//     unrelated page network activity creates false signals).
//
// Instead, combine multiple corroborating signals, and return a STRUCTURED
// result rather than a boolean, so a selector/detection break tells you WHICH
// signal was missing.
//
// Every check requeries the DOM fresh. A message node must never be held across
// time: providers routinely detach and recreate message nodes mid-stream during
// re-renders, and a stale reference can silently stop updating or throw.

import { isDisabledLike } from './injection-utils';
import type { ProviderSelectorConfig } from './selectors';
import { queryFirst, queryFirstVisible } from './selectors';
import type { CompletionResult } from './types';

/**
 * Attaches a MutationObserver to the response container and calls `onStable`
 * once no mutations have occurred for `stableMs`.
 *
 * Preferred over fixed-interval polling because it costs zero polling overhead
 * while nothing is changing, and detects completion as soon as mutations
 * actually stop. It also correctly handles a model that pauses mid-generation
 * and resumes: a resumed mutation simply resets the timer again.
 *
 * @returns a cancel function that detaches the observer and clears the timer.
 */
export function watchForStability(
  responseContainer: Node,
  stableMs: number,
  onStable: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const observer = new MutationObserver(() => {
    if (done) return;
    clearTimeout(timer ?? undefined);
    timer = setTimeout(fire, stableMs);
  });

  const fire = (): void => {
    if (done) return;
    done = true;
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
    onStable();
  };

  observer.observe(responseContainer, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Also start the timer immediately in case no mutation ever fires (e.g. the
  // reply was already complete before the observer attached).
  timer = setTimeout(fire, stableMs);

  return () => {
    done = true;
    if (timer !== null) clearTimeout(timer);
    observer.disconnect();
  };
}

export interface CompletionSignals {
  stopControlAbsent: boolean;
  responseStable: boolean;
  composerReady: boolean;
  replyActionControlsPresent: boolean;
}

export interface SignalEvaluation extends CompletionResult {
  signals: CompletionSignals;
}

export interface SignalArgs {
  /** Whether the stability watcher has already fired for the target turn. */
  stableObserved: boolean;
  stableMs: number;
}

/**
 * Evaluates completion by requerying the live DOM. `stableObserved` comes from
 * the MutationObserver watcher; everything else is read fresh here.
 */
export function evaluateCompletionSignals(
  config: ProviderSelectorConfig,
  root: ParentNode,
  args: SignalArgs,
): SignalEvaluation {
  // VISIBLE-only for the stop control: providers hide it rather than remove it,
  // so bare presence would report a phantom in-flight generation forever.
  const stop = queryFirstVisible(config.selectors.stopButton, root);
  const composer = queryFirst<HTMLElement>(config.selectors.composer, root);
  const replyControls = queryFirstVisible(config.selectors.replyActionControls, root);

  const stopControlAbsent = stop === null;

  const composerReady =
    composer !== null &&
    !isDisabledLike(composer.el) &&
    !(composer.el as HTMLTextAreaElement).readOnly;

  const replyActionControlsPresent = replyControls !== null;

  const signals: CompletionSignals = {
    stopControlAbsent,
    responseStable: args.stableObserved,
    composerReady,
    replyActionControlsPresent,
  };

  const reason: string[] = [];
  if (signals.responseStable) reason.push(`response-stable-${args.stableMs}ms`);
  if (signals.stopControlAbsent) reason.push('stop-control-absent');
  if (signals.composerReady) reason.push('composer-ready');
  if (signals.replyActionControlsPresent) reason.push('reply-controls-present');

  // Required corroboration: the response has stopped changing AND the
  // stop-generating control is gone AND the composer is usable again. Signal D
  // (reply action controls) is recorded but treated as optional, because
  // providers expose it inconsistently.
  const complete = signals.responseStable && signals.stopControlAbsent && signals.composerReady;

  if (!complete) {
    if (!signals.responseStable) reason.push('MISSING:response-stable');
    if (!signals.stopControlAbsent) reason.push('MISSING:stop-control-absent (still generating)');
    if (!signals.composerReady) reason.push('MISSING:composer-ready');
  }

  return { complete, reason, signals };
}

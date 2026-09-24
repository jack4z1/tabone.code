// Silknet v0.1 — mock ChatGPT driver.
//
// This file is EXTERNAL (not inline) on purpose: when the mock is embedded in
// the extension's test-console iframe it inherits the MV3 extension-pages CSP
// ("script-src 'self'"), which blocks inline scripts. An external same-origin
// script satisfies both that CSP and plain file:// loading.
//
// It simulates the parts of ChatGPT's real DOM behaviour that the adapter
// depends on, so injection/detection logic can be iterated offline without
// spending real provider messages:
//   - a genuine <textarea> composer that the native-setter injection targets
//   - a send button that swaps out for a "stop generating" control
//   - streaming output appended incrementally (real mutation traffic)
//   - a completion state: stop control removed, composer re-enabled,
//     reply-action controls (Copy / Regenerate) appended

(() => {
  'use strict';

  const conversation = document.getElementById('conversation');
  const form = document.getElementById('composer-form');
  const composer = document.getElementById('prompt-textarea');
  const sendButton = document.getElementById('send-button');
  const stopButton = document.getElementById('stop-button');

  /** @type {'idle'|'generating'} */
  let state = 'idle';
  let streamTimer = null;
  let replyCounter = 0;
  let pendingReply = null;

  const config = {
    // Per-character streaming delay.
    streamIntervalMs: 6,
    // Characters appended per tick. 1 is the realistic streaming shape; the
    // automated conformance tests raise it so a 20-cycle run stays fast, while
    // still producing one mutation per tick.
    charsPerTick: 1,
    // Optional mid-generation stall: after N characters, pause for M ms.
    // Exercises the stability watcher's "resumed mutation resets the timer" path.
    pauseAfterChars: 0,
    pauseMs: 0,
    // Fail the stream partway through, to exercise dropout handling.
    abortAfterChars: 0,
    // Stall forever partway through (stop control stays up), to exercise the
    // per-provider watchdog path.
    hangAfterChars: 0,
  };

  function buildReply(prompt, index) {
    const head = prompt.trim().replace(/\s+/g, ' ').slice(0, 48);
    return [
      `MOCK-REPLY #${index} responding to: "${head}"`,
      '',
      'Simulated streamed output. Used to validate text injection, completion',
      'detection and correct-reply identification without live provider traffic.',
      '',
      `CLAIM-01: mock claim one for prompt #${index}.`,
      `CLAIM-02: mock claim two for prompt #${index}.`,
      `UNRESOLVED: mock open question for prompt #${index}.`,
    ].join('\n');
  }

  function appendTurn(role, text) {
    // Requery rather than cache: reset() replaces the conversation's children.
    document.getElementById('empty-state')?.remove();
    const article = document.createElement('article');
    article.dataset.messageAuthorRole = role;
    const label = document.createElement('span');
    label.className = 'turn-label';
    label.textContent = role === 'user' ? 'You' : 'ChatGPT';
    // Named `markdown` to match the class ChatGPT actually puts on a turn's
    // prose container, so the production selector resolves here unmodified. The
    // turn's own chrome (the label above, the actions below) sits OUTSIDE it.
    const body = document.createElement('span');
    body.className = 'markdown';
    body.textContent = text;
    article.append(label, body);
    conversation.append(article);
    conversation.scrollTop = conversation.scrollHeight;
    return article;
  }

  function setGenerating(on) {
    state = on ? 'generating' : 'idle';
    sendButton.hidden = on;
    sendButton.disabled = on || composer.value.trim().length === 0;
    stopButton.hidden = !on;
    // Mirrors the real composer going read-only while a reply streams; the
    // adapter's "composer-ready" signal depends on this actually changing.
    composer.disabled = on;
    composer.placeholder = on ? 'ChatGPT is responding…' : 'Message ChatGPT';
  }

  function streamInto(article, text, onDone) {
    const body = article.querySelector('.markdown');
    const step = Math.max(1, Math.floor(config.charsPerTick) || 1);
    let i = 0;
    const pauseAt = config.pauseAfterChars;
    let pauseDone = pauseAt <= 0;

    const tick = () => {
      // Mid-generation stall: one exact timeout, matching how a real provider
      // pauses. Long enough to exceed the adapter's stability window when the
      // test asks for it, which is what exercises the timer-reset path.
      if (!pauseDone && i >= pauseAt) {
        pauseDone = true;
        article.dataset.mockPaused = 'true';
        streamTimer = setTimeout(tick, config.pauseMs);
        return;
      }
      if (config.abortAfterChars > 0 && i >= config.abortAfterChars) {
        streamTimer = null;
        article.dataset.mockAborted = 'true';
        onDone({ aborted: true });
        return;
      }
      if (config.hangAfterChars > 0 && i >= config.hangAfterChars) {
        // Never calls onDone and never clears the generating state: the reply
        // stays unfinished and the stop control stays visible forever.
        streamTimer = null;
        article.dataset.mockHung = 'true';
        return;
      }
      if (i >= text.length) {
        streamTimer = null;
        onDone({ aborted: false });
        return;
      }
      // Appended in slices: every tick is a real characterData/childList mutation.
      const end = Math.min(text.length, i + step);
      body.textContent += text.slice(i, end);
      i = end;
      conversation.scrollTop = conversation.scrollHeight;
      streamTimer = setTimeout(tick, config.streamIntervalMs);
    };

    streamTimer = setTimeout(tick, config.streamIntervalMs);
  }

  function addReplyActions(article) {
    const actions = document.createElement('div');
    actions.className = 'reply-actions';
    for (const label of ['Copy', 'Regenerate']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', label);
      btn.dataset.testid = label === 'Copy' ? 'copy-turn-action-button' : 'regenerate-turn-action-button';
      btn.textContent = label;
      actions.append(btn);
    }
    article.append(actions);
  }

  function beginGeneration(prompt) {
    replyCounter += 1;
    const article = appendTurn('assistant', '');
    article.dataset.mockReplyIndex = String(replyCounter);
    const text = pendingReply ?? buildReply(prompt, replyCounter);
    pendingReply = null;

    streamInto(article, text, ({ aborted }) => {
      setGenerating(false);
      if (aborted) {
        article.dataset.mockAborted = 'true';
        return;
      }
      article.dataset.mockComplete = 'true';
      addReplyActions(article);
    });
  }

  /**
   * Simulates a human send: submit handler -> user turn -> generating state.
   * SEMI mode relies on this being a real (isTrusted) user gesture.
   */
  function submit() {
    if (state === 'generating') return false;
    const text = composer.value;
    if (!text.trim()) return false;
    appendTurn('user', text);
    composer.value = '';
    setGenerating(true);
    beginGeneration(text);
    return true;
  }

  composer.addEventListener('input', () => {
    if (state !== 'generating') sendButton.disabled = composer.value.trim().length === 0;
  });

  composer.addEventListener('keydown', (event) => {
    // Real ChatGPT sends on Enter without Shift.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  stopButton.addEventListener('click', () => {
    if (streamTimer !== null) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    const last = conversation.querySelector('article:last-of-type');
    if (last) {
      last.dataset.mockStopped = 'true';
      addReplyActions(last);
    }
    setGenerating(false);
  });

  // ---------------------------------------------------------------------
  // Dev driver surface. The test console (same-origin iframe) uses this to
  // script deterministic scenarios; nothing here is used by the extension.
  // ---------------------------------------------------------------------
  window.__mock = {
    provider: 'chatgpt',
    config,
    buildReply,
    get state() {
      return state;
    },
    get replyCount() {
      return replyCounter;
    },
    /** Human-equivalent send (clicks the real submit path). */
    send: submit,
    /** Force the next reply's text, instead of the deterministic default. */
    setNextReply(text) {
      pendingReply = text;
    },
    /** Simulate a provider dying mid-stream. */
    abortStreamAfter(chars) {
      config.abortAfterChars = chars;
    },
    /** Simulate a provider stalling forever, leaving the stop control up. */
    hangStreamAfter(chars) {
      config.hangAfterChars = chars;
    },
    /**
     * Speed knobs for automated runs. Real streaming appends one character per
     * tick; the conformance suite raises both values so a 20-cycle run takes
     * seconds instead of minutes, while each tick is still a real mutation.
     */
    speedUp(charsPerTick, streamIntervalMs) {
      config.charsPerTick = Math.max(1, Math.floor(charsPerTick) || 1);
      config.streamIntervalMs = Math.max(0, streamIntervalMs) || 0;
    },
    /** Simulate a mid-generation stall, to test the stability-timer reset. */
    pauseStreamAfter(chars, ms) {
      config.pauseAfterChars = chars;
      config.pauseMs = ms;
    },
    /** Convenience for adapter tests: the expected text of the Nth reply. */
    expectedReply(prompt, index) {
      return buildReply(prompt, index);
    },
    /** True when no streaming is in flight. */
    isGenerating() {
      return state === 'generating';
    },
    reset() {
      if (streamTimer !== null) clearTimeout(streamTimer);
      streamTimer = null;
      state = 'idle';
      replyCounter = 0;
      pendingReply = null;
      config.abortAfterChars = 0;
      config.hangAfterChars = 0;
      config.pauseAfterChars = 0;
      config.pauseMs = 0;
      // NB: streamIntervalMs and charsPerTick are deliberately NOT reset — they
      // are speed knobs for automated runs, not per-scenario state.
      conversation.innerHTML =
        '<p id="empty-state">New chat. Nothing submitted yet.</p>';
      composer.value = '';
      composer.disabled = false;
      composer.placeholder = 'Message ChatGPT';
      sendButton.hidden = false;
      sendButton.disabled = true;
      stopButton.hidden = true;
    },
  };
})();

// Silknet v0.2 — mock Claude driver.
//
// Simulates Claude's ProseMirror DOM behavior and streaming output
// for automated offline conformance testing.

(() => {
  'use strict';

  const conversation = document.getElementById('conversation');
  const composer = document.getElementById('prompt-editor');
  const sendButton = document.getElementById('send-button');
  const stopButton = document.getElementById('stop-button');

  /** @type {'idle'|'generating'} */
  let state = 'idle';
  let streamTimer = null;
  let replyCounter = 0;
  let pendingReply = null;

  const config = {
    streamIntervalMs: 6,
    charsPerTick: 1,
    pauseAfterChars: 0,
    pauseMs: 0,
    abortAfterChars: 0,
    hangAfterChars: 0,
  };

  function buildReply(prompt, index) {
    const head = prompt.trim().replace(/\s+/g, ' ').slice(0, 48);
    return [
      `MOCK-CLAUDE-REPLY #${index} responding to: "${head}"`,
      '',
      'Simulated Claude streamed output.',
      '',
      `ARGUMENT-A: mock thesis from Claude for prompt #${index}.`,
      `ARGUMENT-B: mock counter-point for prompt #${index}.`,
      `SYNTHESIS: mock balanced resolution #${index}.`,
    ].join('\n');
  }

  function appendTurn(role, text) {
    document.getElementById('empty-state')?.remove();
    const turn = document.createElement('div');
    turn.className = `message-turn ${role === 'user' ? 'font-user-message' : 'font-claude-message'}`;
    turn.dataset.messageAuthor = role;
    turn.dataset.testid = `chat-message-${role}`;

    const label = document.createElement('span');
    label.className = 'turn-label';
    label.textContent = role === 'user' ? 'Human' : 'Claude';

    const body = document.createElement('div');
    body.className = 'grid-cols-1';
    const p = document.createElement('p');
    p.textContent = text;
    body.append(p);

    turn.append(label, body);
    conversation.append(turn);
    conversation.scrollTop = conversation.scrollHeight;
    return turn;
  }

  function setGenerating(on) {
    state = on ? 'generating' : 'idle';
    sendButton.hidden = on;
    const hasText = (composer.textContent ?? '').trim().length > 0;
    sendButton.disabled = on || !hasText;
    stopButton.hidden = !on;
    composer.setAttribute('contenteditable', on ? 'false' : 'true');
  }

  function streamInto(turn, text, onDone) {
    const bodyP = turn.querySelector('.grid-cols-1 p') || turn.querySelector('.grid-cols-1');
    const step = Math.max(1, Math.floor(config.charsPerTick) || 1);
    let i = 0;
    const pauseAt = config.pauseAfterChars;
    let pauseDone = pauseAt <= 0;

    const tick = () => {
      if (!pauseDone && i >= pauseAt) {
        pauseDone = true;
        turn.dataset.mockPaused = 'true';
        streamTimer = setTimeout(tick, config.pauseMs);
        return;
      }
      if (config.abortAfterChars > 0 && i >= config.abortAfterChars) {
        streamTimer = null;
        turn.dataset.mockAborted = 'true';
        onDone({ aborted: true });
        return;
      }
      if (config.hangAfterChars > 0 && i >= config.hangAfterChars) {
        streamTimer = null;
        turn.dataset.mockHung = 'true';
        return;
      }
      if (i >= text.length) {
        streamTimer = null;
        onDone({ aborted: false });
        return;
      }
      const end = Math.min(text.length, i + step);
      bodyP.textContent += text.slice(i, end);
      i = end;
      conversation.scrollTop = conversation.scrollHeight;
      streamTimer = setTimeout(tick, config.streamIntervalMs);
    };

    streamTimer = setTimeout(tick, config.streamIntervalMs);
  }

  function addReplyActions(turn) {
    const actions = document.createElement('div');
    actions.className = 'reply-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy text');
    btn.dataset.testid = 'copy-button';
    btn.textContent = 'Copy';
    actions.append(btn);
    turn.append(actions);
  }

  function beginGeneration(prompt) {
    replyCounter += 1;
    const turn = appendTurn('assistant', '');
    turn.dataset.mockReplyIndex = String(replyCounter);
    const text = pendingReply ?? buildReply(prompt, replyCounter);
    pendingReply = null;

    streamInto(turn, text, ({ aborted }) => {
      setGenerating(false);
      if (aborted) {
        turn.dataset.mockAborted = 'true';
        return;
      }
      turn.dataset.mockComplete = 'true';
      addReplyActions(turn);
    });
  }

  function submit() {
    if (state === 'generating') return false;
    const text = (composer.textContent ?? '').trim();
    if (!text) return false;

    composer.innerHTML = '<p><br></p>';
    sendButton.disabled = true;
    appendTurn('user', text);
    setGenerating(true);
    beginGeneration(text);
    return true;
  }

  composer.addEventListener('input', () => {
    const hasText = (composer.textContent ?? '').trim().length > 0;
    sendButton.disabled = state === 'generating' || !hasText;
  });

  sendButton.addEventListener('click', () => {
    submit();
  });

  stopButton.addEventListener('click', () => {
    if (streamTimer !== null) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    const last = conversation.querySelector('.message-turn:last-of-type');
    if (last) {
      last.dataset.mockStopped = 'true';
      addReplyActions(last);
    }
    setGenerating(false);
  });

  window.__mock = {
    provider: 'claude',
    config,
    buildReply,
    get state() {
      return state;
    },
    get replyCount() {
      return replyCounter;
    },
    send: submit,
    setNextReply(text) {
      pendingReply = text;
    },
    abortStreamAfter(chars) {
      config.abortAfterChars = chars;
    },
    hangStreamAfter(chars) {
      config.hangAfterChars = chars;
    },
    speedUp(charsPerTick, streamIntervalMs) {
      config.charsPerTick = Math.max(1, Math.floor(charsPerTick) || 1);
      config.streamIntervalMs = Math.max(0, streamIntervalMs) || 0;
    },
    pauseStreamAfter(chars, ms) {
      config.pauseAfterChars = chars;
      config.pauseMs = ms;
    },
    expectedReply(prompt, index) {
      return buildReply(prompt, index);
    },
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
      conversation.innerHTML =
        '<p id="empty-state">New chat. Nothing submitted yet.</p>';
      composer.innerHTML = '<p><br></p>';
      composer.setAttribute('contenteditable', 'true');
      sendButton.hidden = false;
      sendButton.disabled = true;
      stopButton.hidden = true;
    },
  };
})();

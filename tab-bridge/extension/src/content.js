// Tab Bridge Content Script — Auto Inject, Auto Send, and Auto Read
// Zero tamper guards, zero mouse click interference, 100% automated flow.

console.log('[Tab Bridge] Content script initialized on', window.location.hostname);

function detectProvider() {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('gemini.google.com')) return 'gemini';
  return 'unknown';
}

const PROVIDER = detectProvider();
let isAborted = false;

// Listen for execution commands and abort signals from background worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ status: 'ok', provider: PROVIDER, url: window.location.href });
    return false;
  }

  if (message.type === 'ABORT_EXECUTION') {
    isAborted = true;
    console.log('[Tab Bridge] 🛑 EMERGENCY KILLSWITCH TRIGGERED: Halting execution on', PROVIDER);
    clickStopButton(PROVIDER);
    sendResponse({ success: false, aborted: true });
    return false;
  }

  if (message.type === 'EXECUTE_PROMPT') {
    isAborted = false;
    handleExecutePrompt(message.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          reply: '',
        });
      });
    return true; // Keep channel open for async response
  }
});

function clickStopButton(provider) {
  let selectors = [];
  if (provider === 'chatgpt') {
    selectors = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'];
  } else if (provider === 'claude') {
    selectors = ['button[aria-label*="Stop"]', 'button[data-testid*="stop"]'];
  } else if (provider === 'gemini') {
    selectors = ['button[aria-label*="Stop"]', 'button[data-test-id*="stop"]'];
  }

  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el && isVisible(el)) {
      console.log('[Tab Bridge] 🛑 Clicking native Stop button on', provider);
      el.click();
      return true;
    }
  }
  return false;
}

async function handleExecutePrompt(promptText) {
  console.log(`[Tab Bridge] Executing prompt on ${PROVIDER}... Length: ${promptText.length}`);

  // 1. Find composer
  const composer = await findComposer(PROVIDER);
  if (!composer) {
    throw new Error(`Could not find message composer on ${PROVIDER}`);
  }

  // Record baseline turns before sending
  const baselineCount = countAssistantTurns(PROVIDER);

  // 2. Inject text
  await injectText(composer, promptText, PROVIDER);

  // 3. Auto-send
  await autoSend(composer, PROVIDER);

  // 4. Wait for completion
  const reply = await waitForResponseCompletion(PROVIDER, baselineCount);

  return {
    success: true,
    provider: PROVIDER,
    reply,
  };
}

async function findComposer(provider, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    let el = null;
    if (provider === 'chatgpt') {
      el = document.querySelector('#prompt-textarea') ||
           document.querySelector('div[contenteditable="true"]') ||
           document.querySelector('textarea');
    } else if (provider === 'claude') {
      el = document.querySelector('div.ProseMirror[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"]');
    } else if (provider === 'gemini') {
      el = document.querySelector('div.ql-editor[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"]') ||
           document.querySelector('textarea');
    }

    if (el && isVisible(el)) return el;
    await sleep(200);
  }
  return null;
}

async function injectText(el, text, provider) {
  el.focus();
  const view = el.ownerDocument.defaultView || window;

  const isTextArea = el.tagName === 'TEXTAREA';
  const isInput = el.tagName === 'INPUT';

  if (isTextArea || isInput) {
    el.dispatchEvent(
      new view.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }),
    );

    const proto = isTextArea ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    const nativeSetter = descriptor?.set;
    if (nativeSetter) {
      nativeSetter.call(el, text);
    } else {
      el.value = text;
    }

    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
  } else {
    // Rich text / contenteditable editor (ProseMirror / Quill / Lexical)
    const sel = view.getSelection();
    if (sel) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    let inserted = false;
    if (typeof el.ownerDocument.execCommand === 'function') {
      inserted = el.ownerDocument.execCommand('insertText', false, text);
    }

    if (!inserted) {
      el.textContent = text;
    }

    el.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
  }

  // Small delay for web framework (React / Angular) state update
  await sleep(300);
}

async function autoSend(composerEl, provider) {
  console.log(`[Tab Bridge] Triggering Auto-Send on ${provider}...`);
  const view = composerEl.ownerDocument.defaultView || window;

  const sendBtn = findSendButton(provider);
  let clicked = false;

  if (sendBtn) {
    sendBtn.removeAttribute('disabled');
    sendBtn.disabled = false;

    try {
      // Modern frameworks listen to pointer events as well as mouse events
      sendBtn.dispatchEvent(new view.PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new view.PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      sendBtn.click();
      clicked = true;
    } catch (e) {
      console.log('[Tab Bridge] Button click fallback to Enter key');
    }
  }

  // Wait a brief moment to check if sending started
  await sleep(400);

  // If send button click didn't trigger, or if button wasn't found, dispatch Enter key
  const stillHasText = (composerEl.value || composerEl.textContent || '').trim().length > 0;
  if (!clicked || stillHasText) {
    composerEl.focus();
    composerEl.dispatchEvent(new view.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
    composerEl.dispatchEvent(new view.KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
  }
}

function findSendButton(provider) {
  let selectors = [];
  if (provider === 'chatgpt') {
    selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'form button:last-of-type'
    ];
  } else if (provider === 'claude') {
    selectors = [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button:has(svg)'
    ];
  } else if (provider === 'gemini') {
    selectors = [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button.send-button',
      'div.send-button'
    ];
  }

  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el && isVisible(el)) return el;
  }
  return null;
}

function countAssistantTurns(provider) {
  if (provider === 'chatgpt') {
    return document.querySelectorAll('article, [data-message-author-role="assistant"]').length;
  }
  if (provider === 'claude') {
    return document.querySelectorAll('div[data-is-streaming], div.font-claude-message, [data-message-author="assistant"]').length;
  }
  if (provider === 'gemini') {
    return document.querySelectorAll('model-response, message-content, [data-test-id="model-response"]').length;
  }
  return 0;
}

async function waitForResponseCompletion(provider, baselineCount, maxTimeoutMs = 180000) {
  console.log(`[Tab Bridge] Waiting for completion on ${provider} (baseline turns: ${baselineCount})...`);
  const start = Date.now();

  // 1. Wait for generation to start (turn count increases or stop button appears)
  let started = false;
  while (Date.now() - start < 15000) {
    if (isAborted) {
      throw new Error('Execution aborted by user emergency stop.');
    }
    if (isStopButtonPresent(provider) || countAssistantTurns(provider) > baselineCount) {
      started = true;
      break;
    }
    await sleep(250);
  }

  if (!started && !isAborted) {
    console.log('[Tab Bridge] Proceeding to extract available response');
  }

  // 2. Wait for generation to complete (stop button disappears + DOM stability)
  let lastText = '';
  let stableTicks = 0;

  while (Date.now() - start < maxTimeoutMs) {
    if (isAborted) {
      throw new Error('Execution aborted by user emergency stop.');
    }
    const stopPresent = isStopButtonPresent(provider);
    const currentReply = extractLatestReply(provider);

    if (stopPresent) {
      // Still streaming
      stableTicks = 0;
      lastText = currentReply;
    } else {
      // Stop button not present; verify text stability
      if (currentReply.length > 0 && currentReply === lastText) {
        stableTicks++;
        if (stableTicks >= 3) { // 3 consecutive ticks of stability (~1.2s)
          console.log('[Tab Bridge] AI generation complete and verified stable.');
          return currentReply;
        }
      } else {
        lastText = currentReply;
        stableTicks = 0;
      }
    }

    await sleep(400);
  }

  // Timeout reached, return whatever we captured
  return extractLatestReply(provider);
}

function isStopButtonPresent(provider) {
  let selectors = [];
  if (provider === 'chatgpt') {
    selectors = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'];
  } else if (provider === 'claude') {
    selectors = ['button[aria-label*="Stop"]', 'button[data-testid*="stop"]'];
  } else if (provider === 'gemini') {
    selectors = ['button[aria-label*="Stop"]', 'button[data-test-id*="stop"]'];
  }

  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el && isVisible(el)) return true;
  }
  return false;
}

function extractLatestReply(provider) {
  let elements = [];
  if (provider === 'chatgpt') {
    elements = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"], article'));
  } else if (provider === 'claude') {
    elements = Array.from(document.querySelectorAll('div.font-claude-message, [data-message-author="assistant"], div.grid-cols-1'));
  } else if (provider === 'gemini') {
    elements = Array.from(document.querySelectorAll('model-response, message-content, [data-test-id="model-response"]'));
  }

  if (elements.length === 0) return '';
  const last = elements[elements.length - 1];

  // Clean copy of node text
  const clone = last.cloneNode(true);

  // Strip UI noise buttons (Copy code, thumbs up/down, etc.)
  const buttons = clone.querySelectorAll('button, svg, [role="button"], .copy-button');
  buttons.forEach((b) => b.remove());

  return (clone.textContent || '').trim();
}

function isVisible(el) {
  return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tab Bridge Background Service Worker
// Manages WebSocket bridge to the local IDE server and coordinates tab execution

const BRIDGE_WS_URL = 'ws://127.0.0.1:4040/ws';
let ws = null;
let reconnectTimer = null;

console.log('[Tab Bridge Worker] Background worker started');

// Connect to local bridge server
connectBridge();

async function connectBridge() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Silent pre-check: test if the server is running without triggering a Chrome WebSocket error badge
  try {
    const res = await fetch('http://127.0.0.1:4040/health', { method: 'GET' });
    if (!res.ok) throw new Error('Server not ready');
  } catch {
    // Server is not running yet; retry quietly in 3 seconds without cluttering Chrome's error log
    scheduleReconnect();
    return;
  }

  console.log('[Tab Bridge Worker] Connecting to local server at', BRIDGE_WS_URL);

  try {
    ws = new WebSocket(BRIDGE_WS_URL);

    ws.onopen = async () => {
      console.log('[Tab Bridge Worker] 🟢 Connected to Tab Bridge Local Server!');
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
      // Announce all currently open AI tabs to the server
      await syncAllAiTabs();
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[Tab Bridge Worker] Received server command:', msg.type);

        if (msg.type === 'EXECUTE_PROMPT') {
          await handleExecuteRequest(msg);
        } else if (msg.type === 'ABORT_EXECUTION') {
          console.log('[Tab Bridge Worker] 🛑 Received ABORT_EXECUTION from server!');
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (getProviderFromUrl(tab.url) && tab.id) {
              chrome.tabs.sendMessage(tab.id, { type: 'ABORT_EXECUTION' }).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.error('[Tab Bridge Worker] Error handling message from server:', err);
      }
    };

    ws.onclose = () => {
      console.log('[Tab Bridge Worker] 🔴 Disconnected from local server. Will retry in 3s...');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.log('[Tab Bridge Worker] WebSocket error:', err);
      ws?.close();
    };
  } catch (e) {
    console.error('[Tab Bridge Worker] Failed to create WebSocket:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => {
      connectBridge();
    }, 3000);
  }
}

async function syncAllAiTabs() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const tabs = await chrome.tabs.query({});
  const aiTabs = [];
  for (const tab of tabs) {
    const provider = getProviderFromUrl(tab.url);
    if (provider && tab.id) {
      aiTabs.push({
        id: String(tab.id),
        provider,
        title: tab.title,
        url: tab.url,
      });
      ws.send(
        JSON.stringify({
          type: 'HELLO',
          id: String(tab.id),
          provider,
          title: tab.title,
          url: tab.url,
        }),
      );
    }
  }

  // Send complete active AI tab list so server immediately purges any stale or closed tabs
  ws.send(
    JSON.stringify({
      type: 'SYNC_ALL_TABS',
      tabs: aiTabs,
    }),
  );
}

async function handleExecuteRequest(msg) {
  const { id, prompt, provider } = msg;

  try {
    // 1. Locate the best target tab
    const tab = await findTargetTab(provider);
    if (!tab || !tab.id) {
      throw new Error(`No open browser tab found for provider: ${provider}`);
    }

    // 2. Focus tab optionally or execute in background
    console.log(`[Tab Bridge Worker] Dispatching prompt (${id}) to Tab ${tab.id} (${provider})...`);

    // 3. Ensure content script is ready
    let isReady = false;
    try {
      const ping = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      if (ping?.status === 'ok') isReady = true;
    } catch {
      // Content script may need programmatic injection if tab was open before extension load
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content.js'],
      });
      isReady = true;
    }

    // 4. Send execution command to content script
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_PROMPT',
      id,
      prompt,
    });

    // 5. Send result back over WebSocket
    ws?.send(
      JSON.stringify({
        type: 'PROMPT_RESULT',
        id,
        provider: result?.provider || provider,
        success: result?.success ?? false,
        reply: result?.reply || '',
        error: result?.error,
      }),
    );
  } catch (err) {
    console.error(`[Tab Bridge Worker] Execution error on ${provider}:`, err);
    ws?.send(
      JSON.stringify({
        type: 'PROMPT_RESULT',
        id,
        provider,
        success: false,
        reply: '',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function findTargetTab(requestedProvider) {
  const tabs = await chrome.tabs.query({});
  const matched = [];

  for (const tab of tabs) {
    const p = getProviderFromUrl(tab.url);
    if (p) {
      matched.push({ tab, provider: p });
    }
  }

  if (matched.length === 0) return null;

  if (requestedProvider && requestedProvider !== 'auto') {
    const exact = matched.find((m) => m.provider === requestedProvider);
    return exact ? exact.tab : null;
  }

  // Priority for 'auto': active tab first, then chatgpt -> claude -> gemini
  const activeTab = matched.find((m) => m.tab.active);
  if (activeTab) return activeTab.tab;

  const chatgpt = matched.find((m) => m.provider === 'chatgpt');
  if (chatgpt) return chatgpt.tab;

  const claude = matched.find((m) => m.provider === 'claude');
  if (claude) return claude.tab;

  const gemini = matched.find((m) => m.provider === 'gemini');
  if (gemini) return gemini.tab;

  return matched[0].tab;
}

function getProviderFromUrl(url) {
  if (!url) return null;
  if (url.includes('chatgpt.com')) return 'chatgpt';
  if (url.includes('claude.ai')) return 'claude';
  if (url.includes('gemini.google.com')) return 'gemini';
  return null;
}

// Watch for tab events to keep server registry updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const provider = getProviderFromUrl(tab.url);
    if (provider && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'HELLO',
          id: String(tabId),
          provider,
          title: tab.title,
          url: tab.url,
        }),
      );
    } else if (!provider && ws && ws.readyState === WebSocket.OPEN) {
      // Tab navigated away from AI provider
      ws.send(JSON.stringify({ type: 'TAB_CLOSED', id: String(tabId) }));
    }
  }
});

// Track when user focuses / switches to an AI tab in Chrome
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const provider = getProviderFromUrl(tab.url);
    if (provider && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'TAB_ACTIVATED', id: String(activeInfo.tabId), provider }));
    }
  } catch {}
});

// Track when a tab is closed in Chrome
chrome.tabs.onRemoved.addListener((tabId) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'TAB_CLOSED', id: String(tabId) }));
  }
  setTimeout(syncAllAiTabs, 200);
});

// Track when a window is closed
chrome.windows.onRemoved.addListener(() => {
  setTimeout(syncAllAiTabs, 200);
});

// Periodic keepalive ping to maintain connection
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'PING' }));
  }
}, 20000);

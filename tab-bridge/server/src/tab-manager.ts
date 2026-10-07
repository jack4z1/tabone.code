import { WebSocket } from 'ws';

export interface TabConnection {
  id: string;
  provider: 'chatgpt' | 'claude' | 'gemini' | 'unknown';
  title?: string;
  url?: string;
  ws: WebSocket;
  connectedAt: number;
  lastActive?: number;
}

export interface PromptResult {
  provider: string;
  success: boolean;
  reply: string;
  error?: string;
  durationMs: number;
}

export interface PendingApproval {
  id: string;
  timestamp: number;
  caller: string;
  task: string;
  prompt: string;
  provider: string;
  resolve: (approved: boolean) => void;
}

interface PendingRequest {
  id: string;
  provider: string;
  resolve: (result: PromptResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  startTime: number;
}

export class TabManager {
  private tabs: Map<string, TabConnection> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requireApproval: boolean = true;
  private pendingApprovals: Map<string, PendingApproval> = new Map();

  public registerTab(ws: WebSocket, data: { id: string; provider: string; title?: string; url?: string }): TabConnection {
    const provider = this.normalizeProvider(data.provider);
    const tab: TabConnection = {
      id: data.id,
      provider,
      title: data.title,
      url: data.url,
      ws,
      connectedAt: Date.now(),
    };

    this.tabs.set(data.id, tab);
    console.log(`[TabManager] 🟢 Tab registered: ${provider.toUpperCase()} (${data.id})`);
    return tab;
  }

  public markTabActive(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) {
      tab.lastActive = Date.now();
      console.log(`[TabManager] 🎯 Tab focused in browser: ${tab.provider.toUpperCase()} (${id})`);
    }
  }

  public unregisterTab(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) {
      console.log(`[TabManager] 🔴 Tab disconnected: ${tab.provider.toUpperCase()} (${id})`);
      this.tabs.delete(id);

      // Cancel any pending requests waiting on this specific tab
      for (const [reqId, req] of this.pendingRequests.entries()) {
        if (req.provider === tab.provider) {
          clearTimeout(req.timer);
          this.pendingRequests.delete(reqId);
          req.resolve({
            provider: tab.provider,
            success: false,
            reply: '',
            error: `Tab ${tab.provider} closed while awaiting response`,
            durationMs: Date.now() - req.startTime,
          });
        }
      }
    }
  }

  public unregisterTabsForSocket(ws: WebSocket): void {
    const toDelete: string[] = [];
    for (const [id, tab] of this.tabs.entries()) {
      if (tab.ws === ws) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.unregisterTab(id);
    }
  }

  public syncTabsForSocket(
    ws: WebSocket,
    currentTabs: Array<{ id: string; provider: string; title?: string; url?: string }>,
  ): void {
    const currentIdSet = new Set(currentTabs.map((t) => t.id));
    for (const [id, tab] of this.tabs.entries()) {
      if (tab.ws === ws && !currentIdSet.has(id)) {
        this.unregisterTab(id);
      }
    }
    for (const t of currentTabs) {
      this.registerTab(ws, t);
    }
  }

  public getConnectedTabs(): Array<{ id: string; provider: string; title?: string; url?: string }> {
    const validTabs: Array<{ id: string; provider: string; title?: string; url?: string }> = [];
    const deadIds: string[] = [];

    for (const [id, tab] of this.tabs.entries()) {
      if (tab.ws.readyState !== WebSocket.OPEN) {
        deadIds.push(id);
      } else {
        validTabs.push({
          id: tab.id,
          provider: tab.provider,
          title: tab.title,
          url: tab.url,
        });
      }
    }

    for (const id of deadIds) {
      this.unregisterTab(id);
    }

    return validTabs;
  }

  public getActiveProviders(): string[] {
    const set = new Set<string>();
    for (const tab of this.getConnectedTabs()) {
      set.add(tab.provider);
    }
    return Array.from(set);
  }

  public pickProvider(requested?: string): TabConnection | null {
    if (this.tabs.size === 0) return null;

    if (requested && requested !== 'auto') {
      const normalized = this.normalizeProvider(requested);
      for (const tab of this.tabs.values()) {
        if (tab.provider === normalized && tab.ws.readyState === WebSocket.OPEN) {
          return tab;
        }
      }
      return null;
    }

    // Default 'auto': Prioritize the tab the user is actually active/focused on in Chrome!
    const openTabs = Array.from(this.tabs.values()).filter((t) => t.ws.readyState === WebSocket.OPEN);
    if (openTabs.length === 0) return null;

    openTabs.sort((a, b) => (b.lastActive || b.connectedAt) - (a.lastActive || a.connectedAt));
    return openTabs[0];
  }

  /**
   * Executes auto-inject, auto-send, and auto-read on a single browser tab.
   */
  public async executePrompt(
    prompt: string,
    targetProvider?: string,
    timeoutMs = 180000, // 3 minutes maximum timeout
  ): Promise<PromptResult> {
    const tab = this.pickProvider(targetProvider);
    if (!tab) {
      const available = this.getActiveProviders();
      throw new Error(
        `No browser tab available for provider "${targetProvider || 'auto'}". Open tabs: ${
          available.length > 0 ? available.join(', ') : 'none (please open ChatGPT, Claude, or Gemini in Chrome)'
        }`,
      );
    }

    const reqId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const startTime = Date.now();

    return new Promise<PromptResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve({
          provider: tab.provider,
          success: false,
          reply: '',
          error: `Timed out waiting for response from ${tab.provider} (${timeoutMs}ms)`,
          durationMs: Date.now() - startTime,
        });
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        id: reqId,
        provider: tab.provider,
        resolve,
        reject,
        timer,
        startTime,
      });

      // Send execution command to the browser content script
      tab.ws.send(
        JSON.stringify({
          type: 'EXECUTE_PROMPT',
          id: reqId,
          prompt,
          provider: tab.provider,
        }),
      );

      console.log(`[TabManager] 🚀 Prompt sent to ${tab.provider.toUpperCase()} (${reqId})`);
    });
  }

  /**
   * Experimental Multi-Tab Mode: Broadcasts prompt to all open AI tabs simultaneously.
   */
  public async broadcastMultiPrompt(
    prompt: string,
    timeoutMs = 180000,
  ): Promise<Record<string, PromptResult>> {
    const activeTabs = Array.from(this.tabs.values()).filter((t) => t.ws.readyState === WebSocket.OPEN);
    if (activeTabs.length === 0) {
      throw new Error('No active browser AI tabs connected to execute multi-prompt.');
    }

    // Deduplicate by provider so we don't send duplicates to 2 ChatGPT tabs
    const uniqueTabs = new Map<string, TabConnection>();
    for (const t of activeTabs) {
      if (!uniqueTabs.has(t.provider)) {
        uniqueTabs.set(t.provider, t);
      }
    }

    console.log(`[TabManager] 🌐 Multi-tab broadcast to: ${Array.from(uniqueTabs.keys()).join(', ')}`);

    const promises = Array.from(uniqueTabs.values()).map(async (tab) => {
      try {
        const result = await this.executePrompt(prompt, tab.provider, timeoutMs);
        return [tab.provider, result] as const;
      } catch (err) {
        return [
          tab.provider,
          {
            provider: tab.provider,
            success: false,
            reply: '',
            error: err instanceof Error ? err.message : String(err),
            durationMs: 0,
          },
        ] as const;
      }
    });

    const entries = await Promise.all(promises);
    return Object.fromEntries(entries);
  }

  /**
   * Resolves a pending prompt when the browser content script finishes.
   */
  public handleMessageFromTab(data: any): void {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'PROMPT_RESULT') {
      const { id, success, reply, error, provider } = data;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        const durationMs = Date.now() - pending.startTime;
        console.log(`[TabManager] ✅ Received reply from ${provider.toUpperCase()} in ${durationMs}ms`);
        pending.resolve({
          provider: provider || pending.provider,
          success: Boolean(success),
          reply: reply || '',
          error: error || undefined,
          durationMs,
        });
      }
    }
  }

  public isApprovalRequired(): boolean {
    return this.requireApproval;
  }

  public setRequireApproval(enabled: boolean): void {
    this.requireApproval = enabled;
    console.log(`[TabManager] 🔒 Human-Approval Gate set to: ${enabled ? 'STRICTLY ENFORCED' : 'OFF'}`);
  }

  public getPendingApprovals(): Array<Omit<PendingApproval, 'resolve'>> {
    return Array.from(this.pendingApprovals.values()).map((a) => ({
      id: a.id,
      timestamp: a.timestamp,
      caller: a.caller,
      task: a.task,
      prompt: a.prompt,
      provider: a.provider,
    }));
  }

  public resolveApproval(id: string, approved: boolean): boolean {
    const item = this.pendingApprovals.get(id);
    if (!item) return false;
    this.pendingApprovals.delete(id);
    item.resolve(approved);
    return true;
  }

  public async requestApproval(data: { caller: string; task: string; prompt: string; provider: string }): Promise<boolean> {
    if (!this.requireApproval) return true;

    const id = `appr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    return new Promise<boolean>((resolve) => {
      // 5-minute timeout for human decision
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(id)) {
          this.pendingApprovals.delete(id);
          resolve(false); // Default to deny on timeout
        }
      }, 300000);

      this.pendingApprovals.set(id, {
        id,
        timestamp: Date.now(),
        caller: data.caller,
        task: data.task,
        prompt: data.prompt,
        provider: data.provider,
        resolve: (approved) => {
          clearTimeout(timer);
          resolve(approved);
        },
      });

      console.log(`[TabManager] ⚠️ Human approval requested for: "${data.task}" (ID: ${id})`);
    });
  }

  /**
   * Emergency Killswitch: Immediately halts all active browser executions and stops web generation.
   */
  public abortAll(): number {
    const count = this.pendingRequests.size;
    console.warn(`[TabManager] 🛑 EMERGENCY KILLSWITCH: Aborting all ${count} active request(s)...`);

    // Signal all open tab WebSockets to click native stop buttons
    for (const tab of this.tabs.values()) {
      if (tab.ws.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({ type: 'ABORT_EXECUTION' }));
      }
    }

    // Cancel all in-flight promises
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.resolve({
        provider: req.provider,
        success: false,
        reply: '',
        error: 'Execution cancelled by User Emergency Stop / Killswitch',
        durationMs: Date.now() - req.startTime,
      });
    }
    this.pendingRequests.clear();

    // Reject all pending approvals
    for (const appr of this.pendingApprovals.values()) {
      appr.resolve(false);
    }
    this.pendingApprovals.clear();

    return count;
  }

  private normalizeProvider(raw: string): 'chatgpt' | 'claude' | 'gemini' | 'unknown' {
    const str = (raw || '').toLowerCase();
    if (str.includes('chatgpt') || str.includes('openai')) return 'chatgpt';
    if (str.includes('claude') || str.includes('anthropic')) return 'claude';
    if (str.includes('gemini') || str.includes('google')) return 'gemini';
    return 'unknown';
  }
}

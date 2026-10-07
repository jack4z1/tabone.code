import * as vscode from 'vscode';

export class MasterPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tabBridge.masterView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _serverBase: string) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlForWebview();

    // Handle messages sent from the Webview HTML UI
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'CHECK_STATUS': {
          await this.syncStatus();
          break;
        }
        case 'GRAB_SELECTION': {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const selection = editor.document.getText(editor.selection);
            const lineCount = selection ? selection.split('\n').length : 0;
            webviewView.webview.postMessage({
              type: 'SET_CODE',
              code: selection,
              lineCount,
              language: editor.document.languageId,
            });
          } else {
            vscode.window.showWarningMessage('No active editor tab found.');
          }
          break;
        }
        case 'CONSULT_ADVISOR': {
          await this.handleConsultAdvisor(data.payload);
          break;
        }
        case 'EMERGENCY_STOP': {
          await this.handleEmergencyStop();
          break;
        }
        case 'TOGGLE_GATE': {
          try {
            await fetch(`${this._serverBase}/api/gate/toggle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requireApproval: Boolean(data.requireApproval) }),
            });
            await this.syncStatus();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update approval gate: ${err.message}`);
          }
          break;
        }
        case 'DECIDE_APPROVAL': {
          try {
            await fetch(`${this._serverBase}/api/approvals/decide`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: data.id, approved: Boolean(data.approved) }),
            });
            await this.syncStatus();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to record approval decision: ${err.message}`);
          }
          break;
        }
        case 'INSERT_CODE': {
          const editor = vscode.window.activeTextEditor;
          if (editor && data.code) {
            editor.edit((editBuilder) => {
              if (editor.selection.isEmpty) {
                editBuilder.insert(editor.selection.active, data.code);
              } else {
                editBuilder.replace(editor.selection, data.code);
              }
            });
            vscode.window.showInformationMessage('Code inserted into active editor!');
          } else {
            vscode.window.showWarningMessage('No active editor to insert code into.');
          }
          break;
        }
      }
    });

    this.syncStatus();
  }

  public async syncStatus() {
    if (!this._view) return;
    try {
      const [resHealth, resApprovals] = await Promise.all([
        fetch(`${this._serverBase}/health`).catch(() => null),
        fetch(`${this._serverBase}/api/approvals`).catch(() => null),
      ]);

      let status = null;
      let approvalsData: any = { requireApproval: true, pendingApprovals: [] };

      if (resHealth && resHealth.ok) {
        status = await resHealth.json();
      }
      if (resApprovals && resApprovals.ok) {
        approvalsData = await resApprovals.json();
      }

      this._view.webview.postMessage({
        type: 'STATUS_UPDATE',
        status,
        approvals: approvalsData,
      });
    } catch {
      this._view.webview.postMessage({ type: 'STATUS_UPDATE', status: null, approvals: null });
    }
  }

  private async handleEmergencyStop() {
    try {
      const res = await fetch(`${this._serverBase}/api/killswitch`, { method: 'POST' });
      const data: any = await res.json();
      vscode.window.showWarningMessage(`🛑 EMERGENCY STOP: ${data.message || 'Halted all browser AI executions.'}`);
      if (this._view) {
        this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: false });
        this._view.webview.postMessage({
          type: 'ADVISOR_RESULT',
          result: { success: false, error: 'Emergency Killswitch triggered. Browser generation halted.' },
        });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Killswitch error: ${err.message}`);
    }
  }

  private async handleConsultAdvisor(payload: {
    task: string;
    code?: string;
    error?: string;
    language?: string;
    provider?: string;
    mode?: string;
    guardrails?: string;
  }) {
    if (!this._view) return;

    this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: true });

    try {
      const res = await fetch(`${this._serverBase}/api/advisor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tab-bridge-source': 'manual-ui' },
        body: JSON.stringify({
          task: payload.task,
          code: payload.code,
          error: payload.error,
          language: payload.language || 'typescript',
          provider: payload.provider || 'auto',
          mode: payload.mode || 'direct',
          guardrails: payload.guardrails || '',
        }),
      });

      const data: any = await res.json();
      this._view.webview.postMessage({ type: 'ADVISOR_RESULT', result: data });
    } catch (err: any) {
      this._view.webview.postMessage({
        type: 'ADVISOR_RESULT',
        result: { success: false, error: err.message || String(err) },
      });
    } finally {
      this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: false });
    }
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Silknet Master Panel</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 10px;
      margin: 0;
      box-sizing: border-box;
    }
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .brand-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 13px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 12px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .badge.online { background: #1b5e20; color: #a5d6a7; }
    .badge.offline { background: #b71c1c; color: #ffcdd2; }
    
    .gate-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px 10px;
      margin-bottom: 10px;
      white-space: nowrap;
    }
    .gate-label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
      white-space: nowrap;
      margin: 0;
    }
    .gate-label span {
      white-space: nowrap;
    }

    .row-flex {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .select-dropdown {
      flex: 1;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }

    .approval-box {
      display: none;
      background: #332200;
      border: 1px solid #ffb300;
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 12px;
    }
    .approval-title {
      font-weight: 700;
      font-size: 11px;
      color: #ffd54f;
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 4px;
    }
    .approval-desc {
      font-size: 11px;
      margin-bottom: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .approval-actions {
      display: flex;
      gap: 6px;
    }

    .shield-badge {
      font-size: 10px;
      color: #81c784;
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 10px;
      opacity: 0.9;
    }
    .field-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    textarea, input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px;
      box-sizing: border-box;
      font-family: inherit;
      font-size: 12px;
      margin-bottom: 10px;
      resize: vertical;
    }
    textarea:focus, input:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .btn {
      width: 100%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-stop {
      background: #c62828 !important;
      color: #ffffff !important;
      margin-top: 6px;
    }
    .btn-stop:hover {
      background: #b71c1c !important;
    }
    .btn-approve {
      background: #2e7d32;
      color: #fff;
      padding: 4px 10px;
      font-size: 11px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-deny {
      background: #c62828;
      color: #fff;
      padding: 4px 10px;
      font-size: 11px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-grab {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-panel-border);
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s ease;
    }
    .btn-grab:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 4px 8px;
      font-size: 11px;
      width: auto;
      cursor: pointer;
    }
    .result-card {
      margin-top: 15px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      background: var(--vscode-editor-background);
    }
    .result-header {
      font-weight: 600;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
    }
    .action-row {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .spinner {
      display: none;
      text-align: center;
      margin: 15px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .toggle-section-btn {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      font-size: 11px;
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <!-- Header with Custom Bridge Logo -->
  <div class="header-bar">
    <div class="brand-title">
      <svg width="18" height="18" viewBox="0 0 100 100" fill="none" style="vertical-align: middle;">
        <path d="M 12 28 L 32 44 L 68 44 L 88 28" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M 12 72 L 32 56 L 68 56 L 88 72" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Silknet</span>
    </div>
    <div id="status-pill" class="badge offline">Server Offline</div>
  </div>

  <!-- Target Model Selector -->
  <div class="row-flex">
    <label for="provider-select" style="font-size: 11px; font-weight: 600; opacity: 0.85; white-space: nowrap;">TARGET AI:</label>
    <select id="provider-select" class="select-dropdown">
      <option value="auto">🤖 Auto (Active Tab)</option>
      <option value="claude">🟣 Claude</option>
      <option value="chatgpt">🟢 ChatGPT</option>
      <option value="gemini">🔵 Gemini</option>
    </select>
  </div>

  <!-- Human Approval Gate (Guaranteed Single Line) -->
  <div class="gate-bar">
    <label class="gate-label" title="When enabled, all automated queries from local AI or scripts must wait for your explicit approval before connecting.">
      <input type="checkbox" id="gate-checkbox" checked>
      <span>🔒 Require My Approval</span>
    </label>
    <span style="opacity: 0.7; font-size: 10px;">Human-in-Loop</span>
  </div>

  <!-- Approval Request Modal Box -->
  <div id="approval-box" class="approval-box">
    <div class="approval-title">
      <span>⚠️ Local AI Requesting Permission</span>
    </div>
    <div id="approval-desc" class="approval-desc">Local AI is requesting browser guidance...</div>
    <div class="approval-actions">
      <button type="button" id="approve-btn" class="btn-approve">✅ Approve & Send</button>
      <button type="button" id="deny-btn" class="btn-deny">❌ Deny</button>
    </div>
  </div>

  <div class="shield-badge">
    <span>🛡️ Privacy Shield Active (Secrets & Local Paths Scrubbed)</span>
  </div>

  <!-- Prompt Mode & Guardrails Setup -->
  <div class="row-flex">
    <label for="mode-select" style="font-size: 11px; font-weight: 600; opacity: 0.85; white-space: nowrap;">MODE:</label>
    <select id="mode-select" class="select-dropdown">
      <option value="direct">🎯 Direct / Clean (Natural Query)</option>
      <option value="code_only">⚡ Code Only (No Explanations / Yap)</option>
      <option value="debug">🛠️ Debug & Architect (Full Diagnosis)</option>
      <option value="custom">🎨 Custom Template & Guardrails</option>
    </select>
  </div>

  <!-- Custom Guardrails Box (Collapsible) -->
  <div id="guardrails-container" style="display: none; margin-bottom: 6px;">
    <div class="field-label" style="font-size: 10px;">
      <span>CUSTOM GUARDRAILS / INSTRUCTIONS:</span>
    </div>
    <textarea id="guardrails-input" rows="2" placeholder="e.g. Do not yap. Keep it under 2 sentences. Use Python 3.12 syntax..."></textarea>
  </div>

  <div>
    <div class="field-label">
      <span>1. What needs solving / guidance?</span>
    </div>
    <textarea id="task-input" rows="3" placeholder="e.g. say hello, or ask a coding question..."></textarea>

    <div class="field-label">
      <span>2. Code Context (Optional)</span>
      <button type="button" id="grab-btn" class="btn-grab" title="Grab currently highlighted code in active editor">
        <span>📋 Grab Editor Selection</span>
      </button>
    </div>
    <textarea id="code-input" rows="3" placeholder="Paste code or click 'Grab Editor Selection'..."></textarea>

    <div class="field-label">
      <span>3. Error / Obstacle (Optional)</span>
    </div>
    <textarea id="error-input" rows="2" placeholder="Paste error stack trace or compiler message..."></textarea>

    <button type="button" id="submit-btn" class="btn">
      <span>🚀 Ask Frontier Browser AI</span>
    </button>

    <button type="button" id="stop-btn" class="btn btn-stop">
      <span>🛑 Emergency Stop / Killswitch</span>
    </button>
  </div>

  <div id="spinner" class="spinner">
    ⏳ Sending to Browser AI & waiting for response...
  </div>

  <div id="result-box" style="display: none;"></div>

  <script>
    const vscode = acquireVsCodeApi();

    const taskInput = document.getElementById('task-input');
    const codeInput = document.getElementById('code-input');
    const errorInput = document.getElementById('error-input');
    const submitBtn = document.getElementById('submit-btn');
    const stopBtn = document.getElementById('stop-btn');
    const grabBtn = document.getElementById('grab-btn');
    const statusPill = document.getElementById('status-pill');
    const spinner = document.getElementById('spinner');
    const resultBox = document.getElementById('result-box');
    const gateCheckbox = document.getElementById('gate-checkbox');
    const providerSelect = document.getElementById('provider-select');
    const modeSelect = document.getElementById('mode-select');
    const guardrailsContainer = document.getElementById('guardrails-container');
    const guardrailsInput = document.getElementById('guardrails-input');

    const approvalBox = document.getElementById('approval-box');
    const approvalDesc = document.getElementById('approval-desc');
    const approveBtn = document.getElementById('approve-btn');
    const denyBtn = document.getElementById('deny-btn');

    let currentLanguage = 'typescript';
    let currentApprovalId = null;

    // Load saved preferences from localStorage
    try {
      const savedMode = localStorage.getItem('tab_bridge_mode');
      if (savedMode) modeSelect.value = savedMode;
      const savedGuardrails = localStorage.getItem('tab_bridge_guardrails');
      if (savedGuardrails) guardrailsInput.value = savedGuardrails;
      const savedProvider = localStorage.getItem('tab_bridge_provider');
      if (savedProvider) providerSelect.value = savedProvider;
      updateGuardrailsVisibility();
    } catch {}

    modeSelect.addEventListener('change', () => {
      updateGuardrailsVisibility();
      try { localStorage.setItem('tab_bridge_mode', modeSelect.value); } catch {}
    });

    guardrailsInput.addEventListener('input', () => {
      try { localStorage.setItem('tab_bridge_guardrails', guardrailsInput.value); } catch {}
    });

    providerSelect.addEventListener('change', () => {
      try { localStorage.setItem('tab_bridge_provider', providerSelect.value); } catch {}
    });

    function updateGuardrailsVisibility() {
      guardrailsContainer.style.display = (modeSelect.value === 'custom') ? 'block' : 'none';
    }

    grabBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'GRAB_SELECTION' });
    });

    submitBtn.addEventListener('click', () => {
      const task = taskInput.value.trim();
      if (!task) {
        alert('Please enter a question or problem description.');
        return;
      }

      vscode.postMessage({
        type: 'CONSULT_ADVISOR',
        payload: {
          task,
          code: codeInput.value.trim(),
          error: errorInput.value.trim(),
          language: currentLanguage,
          provider: providerSelect.value,
          mode: modeSelect.value,
          guardrails: guardrailsInput.value.trim()
        }
      });
    });

    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'EMERGENCY_STOP' });
    });

    gateCheckbox.addEventListener('change', () => {
      vscode.postMessage({
        type: 'TOGGLE_GATE',
        requireApproval: gateCheckbox.checked
      });
    });

    approveBtn.addEventListener('click', () => {
      if (currentApprovalId) {
        vscode.postMessage({ type: 'DECIDE_APPROVAL', id: currentApprovalId, approved: true });
        approvalBox.style.display = 'none';
        currentApprovalId = null;
      }
    });

    denyBtn.addEventListener('click', () => {
      if (currentApprovalId) {
        vscode.postMessage({ type: 'DECIDE_APPROVAL', id: currentApprovalId, approved: false });
        approvalBox.style.display = 'none';
        currentApprovalId = null;
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'STATUS_UPDATE') {
        const s = msg.status;
        if (s && s.connectedTabsCount > 0) {
          const names = s.activeProviders.map(p => p.toUpperCase()).join(', ');
          statusPill.className = 'badge online';
          statusPill.textContent = '🟢 ' + names;
        } else if (s) {
          statusPill.className = 'badge offline';
          statusPill.textContent = 'No Tabs Open';
        } else {
          statusPill.className = 'badge offline';
          statusPill.textContent = 'Server Offline';
        }

        if (msg.approvals) {
          gateCheckbox.checked = Boolean(msg.approvals.requireApproval);

          const list = msg.approvals.pendingApprovals || [];
          if (list.length > 0) {
            const first = list[0];
            currentApprovalId = first.id;
            approvalDesc.textContent = \`[\${first.caller}] wants to ask \${first.provider.toUpperCase()}: "\${first.task}"\`;
            approvalBox.style.display = 'block';
          } else {
            approvalBox.style.display = 'none';
            currentApprovalId = null;
          }
        }
      }

      if (msg.type === 'SET_CODE') {
        codeInput.value = msg.code || '';
        if (msg.language) currentLanguage = msg.language;
        if (msg.code) {
          grabBtn.innerHTML = \`<span>✅ Grabbed (\${msg.lineCount}L)</span>\`;
          setTimeout(() => {
            grabBtn.innerHTML = \`<span>📋 Grab Editor Selection</span>\`;
          }, 2000);
        }
      }

      if (msg.type === 'ADVISOR_LOADING') {
        spinner.style.display = msg.loading ? 'block' : 'none';
        submitBtn.disabled = msg.loading;
        if (msg.loading) resultBox.style.display = 'none';
      }

      if (msg.type === 'ADVISOR_RESULT') {
        const r = msg.result;
        resultBox.style.display = 'block';

        if (!r.success) {
          resultBox.innerHTML = \`<div class="result-card" style="border-color: #f44336;">
            <div class="result-header" style="color: #f44336;">❌ \${r.error || 'Execution Stopped'}</div>
          </div>\`;
          return;
        }

        const scrubbedNotice = (r.redactedSummary && r.redactedSummary.length > 0)
          ? \`<div style="font-size: 10px; color: #81c784; margin-bottom: 6px;">🛡️ Scrubbed for privacy: \${r.redactedSummary.join(', ')}</div>\`
          : '';

        let codeActionHtml = '';
        if (r.extractedCodeBlocks && r.extractedCodeBlocks.length > 0) {
          const primaryCode = r.extractedCodeBlocks[0];
          codeActionHtml = \`
            <div class="action-row">
              <button class="btn btn-secondary" onclick="copyText(decodeURIComponent('\${encodeURIComponent(primaryCode)}'))">📋 Copy Clean Code</button>
              <button class="btn btn-secondary" onclick="insertCode(decodeURIComponent('\${encodeURIComponent(primaryCode)}'))">⚡ Insert into Editor</button>
            </div>
          \`;
        }

        resultBox.innerHTML = \`
          <div class="result-card">
            <div class="result-header">
              <span>💡 Response from \${(r.provider || 'AI').toUpperCase()}</span>
              <span style="font-size: 11px; opacity: 0.7;">\${(r.durationMs / 1000).toFixed(1)}s</span>
            </div>
            \${scrubbedNotice}
            <pre>\${escapeHtml(r.advice)}</pre>
            \${codeActionHtml}
          </div>
        \`;
      }
    });

    window.copyText = (text) => {
      navigator.clipboard.writeText(text);
      alert('Code copied to clipboard!');
    };

    window.insertCode = (code) => {
      vscode.postMessage({ type: 'INSERT_CODE', code });
    };

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Keep webview status pill strictly synchronized
    setInterval(() => {
      vscode.postMessage({ type: 'CHECK_STATUS' });
    }, 2500);
  </script>
</body>
</html>`;
  }
}

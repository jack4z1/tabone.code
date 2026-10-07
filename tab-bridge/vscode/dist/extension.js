"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const master_panel_1 = require("./master-panel");
const SERVER_BASE = 'http://127.0.0.1:4040';
let statusBarItem;
let outputChannel;
let masterPanelProvider;
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Silknet');
    // 0. Register Master Webview Panel
    masterPanelProvider = new master_panel_1.MasterPanelProvider(SERVER_BASE);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(master_panel_1.MasterPanelProvider.viewType, masterPanelProvider));
    // 1. Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'tabBridge.checkStatus';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();
    updateStatusBar();
    const timer = setInterval(() => {
        updateStatusBar();
        masterPanelProvider.syncStatus();
    }, 5000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    // 2. Command: Ask Browser AI
    const askCmd = vscode.commands.registerCommand('tabBridge.askAI', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'Ask your active Browser AI (ChatGPT / Claude / Gemini)',
            placeHolder: 'e.g. Write a TypeScript function to parse URL query strings...',
        });
        if (!prompt)
            return;
        await executeWithProgress(`Asking Browser AI...`, prompt, 'auto');
    });
    // 3. Command: Send Selection to Browser AI
    const selectionCmd = vscode.commands.registerCommand('tabBridge.sendSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active code editor.');
            return;
        }
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('Please select some code first.');
            return;
        }
        const instruction = await vscode.window.showInputBox({
            prompt: 'What would you like the Browser AI to do with this code?',
            value: 'Review this code and optimize or fix any bugs:',
        });
        if (!instruction)
            return;
        const fullPrompt = `${instruction}\n\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``;
        await executeWithProgress(`Processing selected code with Browser AI...`, fullPrompt, 'auto');
    });
    // 4. Command: Broadcast to All Browser AIs (Multi-Tab Experimental)
    const broadcastCmd = vscode.commands.registerCommand('tabBridge.broadcastAI', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: '[Multi-Tab Broadcast] Send prompt to ALL connected AI tabs simultaneously',
            placeHolder: 'e.g. Compare approaches to implement rate limiting in Node.js',
        });
        if (!prompt)
            return;
        await executeBroadcastWithProgress(prompt);
    });
    // 5. Command: Check Status
    const statusCmd = vscode.commands.registerCommand('tabBridge.checkStatus', async () => {
        try {
            const status = await fetchStatus();
            if (!status) {
                vscode.window.showErrorMessage('Tab Bridge Server is offline. Please run "npm start" in the server folder.');
                return;
            }
            const tabs = status.connectedTabs || [];
            if (tabs.length === 0) {
                vscode.window.showInformationMessage('Tab Bridge Server is ON, but no browser tabs are connected. Open ChatGPT, Claude, or Gemini in Chrome!');
            }
            else {
                const list = tabs.map((t) => `• ${t.provider.toUpperCase()} (${t.title || 'Tab'})`).join('\n');
                vscode.window.showInformationMessage(`🟢 Connected Browser AI Tabs (${tabs.length}):\n${list}`);
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error checking status: ${err.message}`);
        }
    });
    context.subscriptions.push(askCmd, selectionCmd, broadcastCmd, statusCmd);
}
function deactivate() { }
async function updateStatusBar() {
    try {
        const status = await fetchStatus();
        if (!status) {
            statusBarItem.text = `$(circle-slash) Browser AI: Offline`;
            statusBarItem.tooltip = `Silknet server is not running on ${SERVER_BASE}`;
            return;
        }
        const count = status.connectedTabsCount || 0;
        const providers = status.activeProviders || [];
        if (count === 0) {
            statusBarItem.text = `$(warning) Browser AI: No Tabs`;
            statusBarItem.tooltip = `Server running, but no ChatGPT/Claude/Gemini tab detected in Chrome.`;
        }
        else {
            const names = providers.map((p) => capitalize(p)).join(', ');
            statusBarItem.text = `$(globe) Browser AI: ${names}`;
            statusBarItem.tooltip = `Active browser tabs: ${names}. Click to view details.`;
        }
    }
    catch {
        statusBarItem.text = `$(circle-slash) Browser AI: Offline`;
    }
}
async function fetchStatus() {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${SERVER_BASE}/health`, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok)
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
}
async function executeWithProgress(title, prompt, provider = 'auto') {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
    }, async () => {
        try {
            const res = await fetch(`${SERVER_BASE}/api/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, provider }),
            });
            const data = await res.json();
            if (!data.success) {
                vscode.window.showErrorMessage(`Browser AI failed: ${data.error || 'Unknown error'}`);
                return;
            }
            outputChannel.clear();
            outputChannel.appendLine(`=== Response from ${data.provider.toUpperCase()} (${(data.durationMs / 1000).toFixed(1)}s) ===\n`);
            outputChannel.appendLine(data.reply);
            outputChannel.show(true);
            const choice = await vscode.window.showInformationMessage(`Received response from ${data.provider.toUpperCase()}!`, 'Insert at Cursor', 'Open Output Window');
            if (choice === 'Insert at Cursor') {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit((editBuilder) => {
                        editBuilder.insert(editor.selection.active, data.reply);
                    });
                }
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to communicate with Tab Bridge: ${err.message}`);
        }
    });
}
async function executeBroadcastWithProgress(prompt) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Broadcasting to all open Browser AI tabs...',
        cancellable: false,
    }, async () => {
        try {
            const res = await fetch(`${SERVER_BASE}/api/multi-prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
            });
            const data = await res.json();
            if (!data.success) {
                vscode.window.showErrorMessage(`Multi-tab execution failed: ${data.error}`);
                return;
            }
            outputChannel.clear();
            outputChannel.appendLine(`=== Multi-Tab AI Comparison Results ===\n`);
            for (const [provider, result] of Object.entries(data.results || {})) {
                const r = result;
                outputChannel.appendLine(`\n--------------------------------------------------`);
                outputChannel.appendLine(`🤖 [${provider.toUpperCase()}] ${r.success ? `(${((r.durationMs || 0) / 1000).toFixed(1)}s)` : 'FAILED'}`);
                outputChannel.appendLine(`--------------------------------------------------`);
                outputChannel.appendLine(r.reply || `Error: ${r.error}`);
            }
            outputChannel.show(true);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Broadcast failed: ${err.message}`);
        }
    });
}
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
//# sourceMappingURL=extension.js.map
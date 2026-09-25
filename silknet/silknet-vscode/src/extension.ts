// Silknet — VS Code extension entry point.
//
// Wires the bridge broker, grounding pipeline, and egress gate together behind
// commands and a status-bar presence. Everything runs on 127.0.0.1; no cloud
// component, no telemetry.
//
// Multi-root workspaces: if more than one folder is open, the user MUST
// explicitly designate a single primary folder for the run's scope — the
// extension never silently guesses.

import * as vscode from 'vscode';
import { startBroker, type BrokerHandle } from './bridge/broker-server';
import { BRIDGE_PROTOCOL_VERSION, type BridgeMessage } from './bridge/message-schema';
import {
  applyDecision,
  cancelPendingGate,
  openGate,
  type EgressDecision,
} from './egress/egress-gate';
import { probeOllama } from './grounding/ollama-client';
import { buildGroundingReport } from './grounding/report-builder';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type BridgeState = 'disconnected' | 'listening' | 'connected';

let broker: BrokerHandle | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let output: vscode.OutputChannel | null = null;
let primaryFolder: vscode.WorkspaceFolder | null = null;
/** SecretStorage pattern, wired now for future credentials. */
let secrets: vscode.SecretStorage | null = null;
/** Debate id currently holding the single debate slot, if any. */
let activeDebateRequestId: string | null = null;

const SECRET_KEY = 'silknet/credential-placeholder';

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatusBar(state: BridgeState): void {
  if (statusBarItem === null) return;
  statusBarItem.name = 'Silknet Bridge';
  statusBarItem.command = 'silknet.startBridge';
  switch (state) {
    case 'disconnected':
      statusBarItem.text = '$(circle-slash) Silknet: disconnected';
      statusBarItem.tooltip = 'Click to start the Silknet bridge';
      break;
    case 'listening':
      statusBarItem.text = '$(broadcast) Silknet: listening';
      statusBarItem.tooltip = 'Bridge is listening — waiting for the Chrome extension to connect';
      break;
    case 'connected':
      statusBarItem.text = '$(check) Silknet: connected';
      statusBarItem.tooltip = 'Silknet bridge has an authenticated Chrome client';
      break;
  }
}

// ---------------------------------------------------------------------------
// Primary folder designation
// ---------------------------------------------------------------------------

function pickPrimaryFolder(): Promise<vscode.WorkspaceFolder | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return new Promise((resolve) => {
    if (folders.length === 0) {
      void vscode.window.showErrorMessage('Silknet: open a workspace folder first.');
      resolve(null);
      return;
    }
    if (folders.length === 1) {
      const only = folders[0];
      if (only !== undefined) {
        primaryFolder = only;
        resolve(only);
        return;
      }
      resolve(null);
      return;
    }
    void vscode.window
      .showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { placeHolder: 'Silknet: designate the PRIMARY workspace folder for this run (read scope)' },
      )
      .then((picked) => {
        if (picked) {
          primaryFolder = picked.folder;
          void vscode.window.showInformationMessage(`Silknet: primary folder is now "${picked.label}"`);
        }
        resolve(picked ? picked.folder : null);
      });
  });
}

/** Resolves the folder whose scope governs file reads; never silently guesses. */
async function requireRootFolder(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const only = folders.length === 1 ? folders[0] : undefined;
  if (only !== undefined) return only.uri.fsPath;
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Silknet: no workspace folder is open.');
    return null;
  }
  if (primaryFolder !== null) return primaryFolder.uri.fsPath;
  const designated = await pickPrimaryFolder();
  return designated !== null ? designated.uri.fsPath : null;
}

// ---------------------------------------------------------------------------
// Bridge wiring
// ---------------------------------------------------------------------------

function log(line: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function handleBridgeMessage(message: BridgeMessage): void {
  switch (message.type) {
    case 'CONTEXT_REQUEST':
      onContextRequest(message);
      return;
    case 'EGRESS_APPROVED':
      if (message.mode === 'none') {
        finishGate({ kind: 'denied' });
      } else {
        finishGate({
          kind: 'approved',
          mode: message.mode,
          ...(message.selectedFiles !== undefined ? { selectedFiles: message.selectedFiles } : {}),
        });
      }
      return;
    case 'EGRESS_DENIED':
      finishGate({ kind: 'denied' });
      return;
    case 'REDACTION_DECISION':
      // redact → apply redactions and ship the report; cancel → nothing crosses.
      finishGate(
        message.decision === 'cancel' ? { kind: 'denied' } : { kind: 'approved', mode: 'report-only' },
      );
      return;
    default:
      return;
  }
}

function finishGate(decision: EgressDecision): void {
  const outcome = applyDecision(decision);
  if (outcome.report !== null && broker !== null) {
    if (!broker.sendToClient(outcome.report)) {
      log('gate decision ready but no authenticated bridge client — report dropped');
    }
  }
  if (outcome.consumed && activeDebateRequestId !== null && broker !== null) {
    broker.debateSlot.release(activeDebateRequestId);
    activeDebateRequestId = null;
  }
  log(outcome.note ?? 'gate decision applied');
}

function onContextRequest(message: Extract<BridgeMessage, { type: 'CONTEXT_REQUEST' }>): void {
  void (async () => {
    const root = await requireRootFolder();
    if (root === null) {
      log('context request ignored: no workspace folder available');
      return;
    }
    activeDebateRequestId = message.debateId;
    const cfg = vscode.workspace.getConfiguration('silknet');
    const { manifest, redaction } = await openGate(
      {
        debateId: message.debateId,
        round: message.round,
        ...(message.workspaceHint !== undefined ? { workspaceHint: message.workspaceHint } : {}),
        ...(message.targetProviders !== undefined ? { targetProviders: message.targetProviders } : {}),
      },
      root,
      {
        ollamaUrl: cfg.get<string>('ollamaUrl') ?? 'http://localhost:11434',
        ollamaModel: cfg.get<string>('ollamaModel') ?? 'llama3.2',
      },
    );
    if (broker === null) return;
    broker.sendToClient(manifest);
    if (redaction !== null) broker.sendToClient(redaction);
    log(`context requested for debate ${message.debateId} — manifest sent`);
  })();
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
  output = vscode.window.createOutputChannel('Silknet');
  context.subscriptions.push(output);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  updateStatusBar('disconnected');

  const startBridge = async (): Promise<void> => {
    if (broker !== null) {
      void vscode.window.showInformationMessage('Silknet bridge is already running.');
      return;
    }
    // SecretStorage pattern: prove the API works without needing a credential.
    try {
      await secrets?.store(SECRET_KEY, 'unused-pattern-only');
      await secrets?.delete(SECRET_KEY);
    } catch {
      log('SecretStorage unavailable — pattern not exercised');
    }

    const port = vscode.workspace.getConfiguration('silknet').get<number>('bridgePort') ?? 8712;
    try {
      broker = startBroker({
        port,
        onToken: (token) => {
          // Displayed ONCE, here. Never logged, never persisted in plaintext.
          void vscode.window
            .showInformationMessage(
              `Silknet bridge session token: ${token}`,
              'Copy Token',
            )
            .then((choice) => {
              if (choice === 'Copy Token') {
                void vscode.env.clipboard.writeText(token);
              }
            });
        },
        onClientConnected: () => {
          updateStatusBar('connected');
          log('Chrome client authenticated');
        },
        onClientDisconnected: () => {
          cancelPendingGate();
          updateStatusBar('listening');
          log('Chrome client disconnected');
        },
        onClientMessage: handleBridgeMessage,
        log,
      });
      updateStatusBar('listening');
      void vscode.window.showInformationMessage(`Silknet bridge listening on 127.0.0.1:${port}`);
    } catch (err) {
      broker = null;
      updateStatusBar('disconnected');
      void vscode.window.showErrorMessage(
        `Silknet bridge failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const stopBridge = async (): Promise<void> => {
    if (broker === null) {
      void vscode.window.showInformationMessage('Silknet bridge is not running.');
      return;
    }
    cancelPendingGate();
    const closing = broker;
    broker = null;
    await closing.close();
    updateStatusBar('disconnected');
    void vscode.window.showInformationMessage('Silknet bridge stopped.');
  };

  const checkOllama = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('silknet');
    const url = cfg.get<string>('ollamaUrl') ?? 'http://localhost:11434';
    const status = await probeOllama(url);
    if (status.ready) {
      void vscode.window.showInformationMessage(
        `Ollama ready at ${url} — models: ${status.models.slice(0, 5).join(', ') || '(none installed)'}`,
      );
    } else {
      void vscode.window.showWarningMessage(`Ollama not ready: ${status.reason ?? 'unknown reason'}`);
    }
  };

  const generateReport = async (): Promise<void> => {
    const root = await requireRootFolder();
    if (root === null) return;
    const cfg = vscode.workspace.getConfiguration('silknet');
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Silknet: building grounding report…' },
      () =>
        buildGroundingReport(root, {
          ollamaUrl: cfg.get<string>('ollamaUrl') ?? undefined,
          ollamaModel: cfg.get<string>('ollamaModel') ?? undefined,
          useModelSummary: false, // local preview stays deterministic and instant
        }),
    );
    const doc = await vscode.workspace.openTextDocument({
      content: report.reportText,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(
      `Silknet report ready — ${report.files.length} files, ~${report.approxLines} lines${report.truncated ? ' (truncated)' : ''}`,
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('silknet.startBridge', () => void startBridge()),
    vscode.commands.registerCommand('silknet.stopBridge', () => void stopBridge()),
    vscode.commands.registerCommand('silknet.checkOllama', () => void checkOllama()),
    vscode.commands.registerCommand('silknet.generateReport', () => void generateReport()),
    vscode.commands.registerCommand('silknet.designatePrimaryFolder', () => void pickPrimaryFolder()),
  );

  log(`Silknet VS Code extension active (bridge protocol ${BRIDGE_PROTOCOL_VERSION})`);
}

export function deactivate(): void {
  cancelPendingGate();
  const closing = broker;
  broker = null;
  if (closing !== null) void closing.close();
}

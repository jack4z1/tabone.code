// Silknet — Claude content script (Phase 2, dynamically injected).
//
// Injected on demand via chrome.scripting.executeScript() only into tabs bound
// to a run, so ordinary browsing carries none of this code's cost.
//
// World: ISOLATED (the default content-script world).

import { createAdapter, type AdapterEnv } from './shared/adapter-core';
import {
  isCmdMessage,
  NS,
  parseSubmitArgs,
  parseTabIdArg,
  parseWaitArgs,
  type CmdResultMessage,
} from './shared/messaging';
import { validateSelectorConfig, type ProviderSelectorConfig } from './shared/selectors';
import type { AdapterCapabilities, ProbeResult } from './shared/types';

const PROVIDER = 'claude';
const INSTALL_FLAG = '__silknet_adapter_claude__';

type SilknetGlobal = typeof globalThis & { 
  [INSTALL_FLAG]?: boolean;
  __silknet_document_id?: string;
};

const g = globalThis as SilknetGlobal;

const env: AdapterEnv = {
  document,
  location: { href: location.href, origin: location.origin },
  isTopFrame: window.top === window,
  provider: PROVIDER,
  tabId: -1,
  frameId: -1,
  documentId: g.__silknet_document_id ?? crypto.randomUUID(),
  now: () => Date.now(),
  randomId: () => crypto.randomUUID(),
};

const EMPTY_CONFIG: ProviderSelectorConfig = {
  provider: PROVIDER,
  configVersion: 0,
  match: { origins: ['https://claude.ai'], topFrameOnly: true },
  selectors: {
    composer: [{ by: 'css', value: '[data-silknet-unconfigured-composer]' }],
    sendButton: [{ by: 'css', value: '[data-silknet-unconfigured-send]' }],
    stopButton: [{ by: 'css', value: '[data-silknet-unconfigured-stop]' }],
    assistantTurn: [{ by: 'css', value: '[data-silknet-unconfigured-assistant]' }],
    assistantMessageBody: [{ by: 'css', value: '[data-silknet-unconfigured-assistant-body]' }],
    userTurn: [{ by: 'css', value: '[data-silknet-unconfigured-user]' }],
    responseContainer: [{ by: 'css', value: '[data-silknet-unconfigured-main]' }],
    replyActionControls: [{ by: 'css', value: '[data-silknet-unconfigured-actions]' }],
  },
  behavior: {
    inputType: 'contenteditable',
    injectionMethod: 'execCommand',
    stabilityMs: 1800,
    watchdogMs: 180000,
    assistantTurnMarkerAttribute: 'data-message-author',
    assistantTurnMarkerValue: 'assistant',
  },
};

if (g[INSTALL_FLAG]) {
  void Promise.resolve();
} else {
  g[INSTALL_FLAG] = true;

  let adapter = createAdapter(env, EMPTY_CONFIG);
  let configured = false;

  const reply = (msg: CmdResultMessage): void => {
    try {
      void chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch {
      /* extension context invalidated */
    }
  };

  const announce = (probe: ProbeResult, capabilities: AdapterCapabilities): void => {
    try {
      void chrome.runtime
        .sendMessage({
          ns: NS,
          kind: 'ADAPTER_READY',
          provider: PROVIDER,
          documentId: env.documentId,
          href: location.href,
          probe,
          capabilities,
        })
        .catch(() => undefined);
    } catch {
      /* extension context invalidated */
    }
  };

  type HandlerResult = { ok: true; result: unknown } | { ok: false; error: string };

  async function handle(op: string, args: unknown): Promise<HandlerResult> {
    try {
      switch (op) {
        case 'configure': {
          const parsed = parseConfigureArgs(args);
          if (!parsed) return { ok: false, error: 'configure: invalid args' };
          const validation = validateSelectorConfig(parsed.config);
          if (!validation.ok) {
            return { ok: false, error: `configure: selector config rejected — ${validation.reason}` };
          }
          adapter.configure(validation.config);
          env.tabId = parsed.tabId ?? env.tabId;
          env.frameId = parsed.frameId ?? env.frameId;
          configured = true;
          const probe = await adapter.probe();
          const capabilities = adapter.capabilities();
          announce(probe, capabilities);
          return { ok: true, result: { probe, capabilities, documentId: env.documentId } };
        }
        case 'probe':
          return { ok: true, result: await adapter.probe() };
        case 'getState':
          return { ok: true, result: await adapter.getState() };
        case 'capabilities':
          return { ok: true, result: adapter.capabilities() };
        case 'recover':
          await adapter.recover();
          return { ok: true, result: { recovered: true, documentId: env.documentId } };
        case 'submit': {
          if (!configured) return { ok: false, error: 'submit: adapter not configured' };
          const parsed = parseSubmitArgs(args);
          if (!parsed) return { ok: false, error: 'submit: invalid args' };
          return { ok: true, result: await adapter.submit(parsed.text, { autoSend: parsed.autoSend }) };
        }
        case 'waitForCompletion': {
          const parsed = parseWaitArgs(args);
          if (!parsed) return { ok: false, error: 'waitForCompletion: invalid args' };
          const opts = parsed.timeoutMs === undefined ? undefined : { timeoutMs: parsed.timeoutMs };
          return { ok: true, result: await adapter.waitForCompletion(parsed.submissionId, opts) };
        }
        case 'readReply': {
          const submissionId = parseSubmissionId(args);
          if (!submissionId) return { ok: false, error: 'readReply: invalid args' };
          return { ok: true, result: await adapter.readReply(submissionId) };
        }
        default:
          return { ok: false, error: `unhandled op ${op}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isCmdMessage(message)) return false;
    if (message.provider !== PROVIDER) return false;

    const identityMismatch =
      message.expect.documentId !== env.documentId ||
      (message.expect.origin !== '' && message.expect.origin !== env.location.origin);
    if (identityMismatch) {
      reply({
        ns: NS,
        kind: 'CMD_RESULT',
        provider: PROVIDER,
        opId: message.opId,
        ok: false,
        error: 'document-identity-mismatch: bound document changed (TOCTOU guard)',
        documentId: env.documentId,
      });
      return false;
    }

    void handle(message.op, message.args).then((outcome) => {
      reply(
        outcome.ok
          ? {
              ns: NS,
              kind: 'CMD_RESULT',
              provider: PROVIDER,
              opId: message.opId,
              ok: true,
              result: outcome.result,
              documentId: env.documentId,
            }
          : {
              ns: NS,
              kind: 'CMD_RESULT',
              provider: PROVIDER,
              opId: message.opId,
              ok: false,
              error: outcome.error,
              documentId: env.documentId,
            },
      );
    });

    return false;
  });
}

function parseSubmissionId(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)['submissionId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseConfigureArgs(
  args: unknown,
): { config: unknown; tabId?: number; frameId?: number } | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  if (!('config' in record)) return null;
  const out: { config: unknown; tabId?: number; frameId?: number } = { config: record['config'] };
  const tabId = parseTabIdArg({ tabId: record['tabId'] });
  if (tabId !== null) out.tabId = tabId;
  const frameId = parseTabIdArg({ tabId: record['frameId'] });
  if (frameId !== null) out.frameId = frameId;
  return out;
}

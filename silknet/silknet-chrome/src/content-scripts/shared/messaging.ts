// Silknet — cross-context message envelopes + schema validation.
//
// SECURITY RULE (from the build brief): every cross-context message
// (content script -> service worker, service worker -> side panel/console) must
// be validated against an explicit schema before being acted upon. Nothing in
// this extension acts on an unvalidated message.
//
// The complements to this rule, enforced elsewhere:
//   - page-sourced text is only ever rendered via textContent, never innerHTML;
//   - only typed, extension-generated protocol messages, hardcoded provider
//     config, validated event-log records, and explicit human UI actions are
//     trusted and may control state transitions or trigger actions.

import { NS } from './constants';
import type { AdapterCapabilities, AdapterState, CompletionResult, ProbeResult } from './types';

export { NS };

export type AdapterOp =
  | 'configure'
  | 'probe'
  | 'getState'
  | 'submit'
  | 'waitForCompletion'
  | 'readReply'
  | 'recover'
  | 'capabilities';

export type UiOp =
  | 'listCandidates'
  | 'bindRun'
  | 'startFlow'
  | 'getRunState'
  | 'readLog'
  | 'clearLog'
  | 'probeBoundTabs';

/** content-script(probe) -> service worker: "I am a valid provider tab." */
export interface ProbeHelloMessage {
  ns: typeof NS;
  kind: 'PROBE_HELLO';
  provider: string;
  probe: ProbeResult;
  documentId: string;
  href: string;
  origin: string;
  topFrame: boolean;
}

/** content-script(adapter) -> service worker: heavier adapter is live. */
export interface AdapterReadyMessage {
  ns: typeof NS;
  kind: 'ADAPTER_READY';
  provider: string;
  documentId: string;
  href: string;
  probe: ProbeResult;
  capabilities: AdapterCapabilities;
}

/** service worker -> content script: one adapter operation. */
export interface CmdMessage {
  ns: typeof NS;
  kind: 'CMD';
  provider: string;
  opId: string;
  /** TOCTOU guard: the document the caller believes it is talking to. */
  expect: { documentId: string; origin: string };
  op: AdapterOp;
  args?: unknown;
}

export interface CmdResultMessage {
  ns: typeof NS;
  kind: 'CMD_RESULT';
  provider: string;
  opId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Present on every result so the worker can detect a mid-flight navigation. */
  documentId: string;
}

/** side panel / test console -> service worker. */
export interface UiMessage {
  ns: typeof NS;
  kind: 'UI';
  op: UiOp;
  requestId: string;
  args?: unknown;
}

export interface UiResultMessage {
  ns: typeof NS;
  kind: 'UI_RESULT';
  op: UiOp;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** service worker -> side panel / test console: unsolicited state push. */
export interface PushMessage {
  ns: typeof NS;
  kind: 'PUSH';
  topic: 'run' | 'log' | 'provider';
  payload: unknown;
}

export type AnyMessage =
  | ProbeHelloMessage
  | AdapterReadyMessage
  | CmdMessage
  | CmdResultMessage
  | UiMessage
  | UiResultMessage
  | PushMessage;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const isProbeResult = (v: unknown): v is ProbeResult => {
  if (!isRecord(v)) return false;
  if (!isBool(v['recognized'])) return false;
  const reason = v['reason'];
  return reason === undefined || isStr(reason);
};

const isAdapterCapabilities = (v: unknown): v is AdapterCapabilities => {
  if (!isRecord(v)) return false;
  return (
    isBool(v['autoSend']) &&
    isBool(v['manualSend']) &&
    isBool(v['readReply']) &&
    Array.isArray(v['completionDetectionMethods']) &&
    (v['completionDetectionMethods'] as unknown[]).every(isStr) &&
    (v['inputType'] === 'textarea' || v['inputType'] === 'contenteditable')
  );
};

const ADAPTER_OPS: readonly AdapterOp[] = [
  'configure',
  'probe',
  'getState',
  'submit',
  'waitForCompletion',
  'readReply',
  'recover',
  'capabilities',
];

const UI_OPS: readonly UiOp[] = [
  'listCandidates',
  'bindRun',
  'startFlow',
  'getRunState',
  'readLog',
  'clearLog',
  'probeBoundTabs',
];

export function isProbeHelloMessage(v: unknown): v is ProbeHelloMessage {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === NS &&
    v['kind'] === 'PROBE_HELLO' &&
    isNonEmptyStr(v['provider']) &&
    isProbeResult(v['probe']) &&
    isNonEmptyStr(v['documentId']) &&
    isStr(v['href']) &&
    isStr(v['origin']) &&
    isBool(v['topFrame'])
  );
}

export function isAdapterReadyMessage(v: unknown): v is AdapterReadyMessage {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === NS &&
    v['kind'] === 'ADAPTER_READY' &&
    isNonEmptyStr(v['provider']) &&
    isNonEmptyStr(v['documentId']) &&
    isStr(v['href']) &&
    isProbeResult(v['probe']) &&
    isAdapterCapabilities(v['capabilities'])
  );
}

export function isCmdMessage(v: unknown): v is CmdMessage {
  if (!isRecord(v)) return false;
  const expect = v['expect'];
  return (
    v['ns'] === NS &&
    v['kind'] === 'CMD' &&
    isNonEmptyStr(v['provider']) &&
    isNonEmptyStr(v['opId']) &&
    isRecord(expect) &&
    isNonEmptyStr(expect['documentId']) &&
    isStr(expect['origin']) &&
    isStr(v['op']) &&
    ADAPTER_OPS.includes(v['op'] as AdapterOp)
  );
}

export function isCmdResultMessage(v: unknown): v is CmdResultMessage {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === NS &&
    v['kind'] === 'CMD_RESULT' &&
    isNonEmptyStr(v['provider']) &&
    isNonEmptyStr(v['opId']) &&
    isBool(v['ok']) &&
    isStr(v['documentId']) &&
    (v['error'] === undefined || isStr(v['error']))
  );
}

export function isUiMessage(v: unknown): v is UiMessage {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === NS &&
    v['kind'] === 'UI' &&
    isNonEmptyStr(v['requestId']) &&
    isStr(v['op']) &&
    UI_OPS.includes(v['op'] as UiOp)
  );
}

export function isUiResultMessage(v: unknown): v is UiResultMessage {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === NS &&
    v['kind'] === 'UI_RESULT' &&
    isNonEmptyStr(v['requestId']) &&
    isBool(v['ok']) &&
    (v['error'] === undefined || isStr(v['error']))
  );
}

export function isPushMessage(v: unknown): v is PushMessage {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === NS &&
    v['kind'] === 'PUSH' &&
    (v['topic'] === 'run' || v['topic'] === 'log' || v['topic'] === 'provider')
  );
}

// ---------------------------------------------------------------------------
// Typed argument parsers (narrowing only, after a message already validated)
// ---------------------------------------------------------------------------

export interface SubmitArgs {
  text: string;
  autoSend: boolean;
}

export function parseSubmitArgs(args: unknown): SubmitArgs | null {
  if (!isRecord(args)) return null;
  if (!isStr(args['text'])) return null;
  const autoSend = args['autoSend'];
  return { text: args['text'], autoSend: isBool(autoSend) ? autoSend : false };
}

export function parseWaitArgs(args: unknown): { submissionId: string; timeoutMs?: number } | null {
  if (!isRecord(args)) return null;
  const submissionId = args['submissionId'];
  if (!isNonEmptyStr(submissionId)) return null;
  const timeoutMs = args['timeoutMs'];
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))) {
    return null;
  }
  const out: { submissionId: string; timeoutMs?: number } = { submissionId };
  if (typeof timeoutMs === 'number') out.timeoutMs = timeoutMs;
  return out;
}

export function parseTextArg(args: unknown): string | null {
  if (!isRecord(args)) return null;
  const text = args['text'];
  return isStr(text) ? text : null;
}

export function parseTabIdArg(args: unknown): number | null {
  if (!isRecord(args)) return null;
  const tabId = args['tabId'];
  return typeof tabId === 'number' && Number.isInteger(tabId) ? tabId : null;
}

export function parseCompletionResult(v: unknown): CompletionResult | null {
  if (!isRecord(v)) return null;
  if (!isBool(v['complete']) || !Array.isArray(v['reason'])) return null;
  if (!(v['reason'] as unknown[]).every(isStr)) return null;
  return { complete: v['complete'], reason: v['reason'] as string[] };
}

export function parseAdapterState(v: unknown): AdapterState | null {
  return v === 'idle' || v === 'generating' || v === 'done' || v === 'blocked' || v === 'unknown'
    ? v
    : null;
}

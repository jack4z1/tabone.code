// Silknet — INTERNAL panel ⇄ worker bridge messaging.
//
// THIRD messaging system, deliberately distinct:
//   1. `ns: "silknet/v0.1"`  — content-script/worker/panel RPC (messaging.ts);
//   2. the WebSocket BridgeMessage union — VS Code ⇄ Chrome over the wire;
//   3. THIS namespace — side panel ⇄ service worker for bridge/grounding UI.
//
// Every message is validated before use, mirroring messaging.ts's discipline.

import type { BridgeClientState } from './bridge-client';

export const BRIDGE_INTERNAL_NS = 'silknet/bridge/v0.1' as const;

export type BridgeInternalTopic = 'state' | 'message';

export interface BridgePushMessage {
  ns: typeof BRIDGE_INTERNAL_NS;
  kind: 'BRIDGE_PUSH';
  topic: BridgeInternalTopic;
  payload: unknown;
}

export interface BridgeStatePayload {
  state: BridgeClientState;
  detail?: string;
}

export interface BridgeUiRequest {
  ns: typeof BRIDGE_INTERNAL_NS;
  kind: 'BRIDGE_UI';
  op: 'connect' | 'disconnect' | 'getState' | 'requestContext' | 'egressDecision' | 'getReport';
  requestId: string;
  args?: unknown;
}

export interface BridgeUiResponse {
  ns: typeof BRIDGE_INTERNAL_NS;
  kind: 'BRIDGE_UI_RESULT';
  op: BridgeUiRequest['op'];
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type AnyBridgeInternalMessage = BridgePushMessage | BridgeUiRequest | BridgeUiResponse;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const BRIDGE_UI_OPS: readonly BridgeUiRequest['op'][] = [
  'connect',
  'disconnect',
  'getState',
  'requestContext',
  'egressDecision',
  'getReport',
];

export function isBridgeInternalMessage(v: unknown): v is BridgeUiRequest {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === BRIDGE_INTERNAL_NS &&
    v['kind'] === 'BRIDGE_UI' &&
    nonEmpty(v['requestId']) &&
    typeof v['op'] === 'string' &&
    (BRIDGE_UI_OPS as readonly string[]).includes(v['op'])
  );
}

export function isBridgePushMessage(v: unknown): v is BridgePushMessage {
  if (!isRecord(v)) return false;
  return (
    v['ns'] === BRIDGE_INTERNAL_NS &&
    v['kind'] === 'BRIDGE_PUSH' &&
    (v['topic'] === 'state' || v['topic'] === 'message')
  );
}

export function isBridgeStatePayload(v: unknown): v is BridgeStatePayload {
  if (!isRecord(v)) return false;
  const state = v['state'];
  return (
    (state === 'disconnected' || state === 'connecting' || state === 'connected') &&
    (v['detail'] === undefined || typeof v['detail'] === 'string')
  );
}

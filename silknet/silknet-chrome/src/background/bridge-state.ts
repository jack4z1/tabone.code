// Silknet — bridge runtime state (Chrome side).
//
// Holds connection state, the pending grounding request, and the report after
// the user approves egress. Backed by chrome.storage.session so a suspended/
// restarted service worker and a reopened side panel stay consistent. The side
// panel drives connection/auth UI state via these keys; the service worker owns
// the socket itself.

import type { BridgeClientState } from './bridge-client';
import type { BridgeMessage } from './bridge-protocol';

export const BRIDGE_SESSION_KEY = 'silknet/v0.1/bridge-state';
export const PENDING_GROUNDING_KEY = 'silknet/v0.1/pending-grounding';
export const GROUNDING_REPORT_KEY = 'silknet/v0.1/grounding-report';

export interface BridgeSessionState {
  state: BridgeClientState;
  /** Human-readable status detail for the panel (e.g. 'token rejected …'). */
  detail?: string;
  /** The port the client should dial (mirrors the VS Code setting). */
  port: number;
  /** True after the user entered a token this session. */
  tokenEntered: boolean;
}

export interface PendingGrounding {
  runId: string;
  debateId: string;
  round: number;
  /** Providers targeted by the debate (echoed into the manifest). */
  targetProviders: string[];
  requestedAt: number;
}

export interface StoredGroundingReport {
  debateId: string;
  runId: string;
  reportText: string;
  approxLines: number;
  truncated: boolean;
  approvedAt: number;
  mode: 'report-only' | 'selected-files';
}

/** Reads the bridge session state (defaults when absent). */
export async function readBridgeSessionState(): Promise<BridgeSessionState> {
  const bag = await chrome.storage.session.get(BRIDGE_SESSION_KEY);
  const raw = bag[BRIDGE_SESSION_KEY] as BridgeSessionState | undefined;
  if (
    raw !== undefined &&
    typeof raw === 'object' &&
    typeof raw.state === 'string' &&
    typeof raw.port === 'number'
  ) {
    return raw;
  }
  return { state: 'disconnected', port: 8712, tokenEntered: false };
}

export async function writeBridgeSessionState(state: BridgeSessionState): Promise<void> {
  await chrome.storage.session.set({ [BRIDGE_SESSION_KEY]: state });
}

export async function readPendingGrounding(): Promise<PendingGrounding | null> {
  const bag = await chrome.storage.session.get(PENDING_GROUNDING_KEY);
  const raw = bag[PENDING_GROUNDING_KEY] as PendingGrounding | undefined;
  return raw !== undefined && typeof raw === 'object' ? raw : null;
}

export async function writePendingGrounding(pending: PendingGrounding | null): Promise<void> {
  await chrome.storage.session.set({ [PENDING_GROUNDING_KEY]: pending });
}

export async function readGroundingReport(): Promise<StoredGroundingReport | null> {
  const bag = await chrome.storage.session.get(GROUNDING_REPORT_KEY);
  const raw = bag[GROUNDING_REPORT_KEY] as StoredGroundingReport | undefined;
  return raw !== undefined && typeof raw === 'object' ? raw : null;
}

export async function writeGroundingReport(report: StoredGroundingReport | null): Promise<void> {
  await chrome.storage.session.set({ [GROUNDING_REPORT_KEY]: report });
}

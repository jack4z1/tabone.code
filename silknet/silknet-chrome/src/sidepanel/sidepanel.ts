// Silknet — Chrome Side Panel Controller (Phase v0.5).
//
// Drives multi-round cross-model debates between ChatGPT, Claude, and Gemini
// from Chrome's persistent sidebar.

import { isUiResultMessage, NS, type UiOp } from '../content-scripts/shared/messaging';
import type { ProbeResult } from '../content-scripts/shared/types';
import type { StoredEvent } from '../background/event-log';
import {
  BRIDGE_INTERNAL_NS,
  isBridgePushMessage,
  isBridgeStatePayload,
  type BridgeStatePayload,
} from '../background/bridge-internal';
import {
  parseBridgeMessage,
  type BridgeMessage,
  type ContextReportMessage,
  type EgressManifestMessage,
  type RedactionFoundMessage,
} from '../background/bridge-protocol';
import { formatGroundingBlock, buildOpeningPrompt } from '../background/bridge-grounding';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`Side panel markup missing #${id}`);
  return elem as T;
}

async function ui<T>(op: UiOp, args?: unknown): Promise<T> {
  const requestId = crypto.randomUUID();
  const response = await chrome.runtime.sendMessage({ ns: NS, kind: 'UI', op, requestId, args });
  if (!isUiResultMessage(response)) throw new Error(`Malformed UI response for ${op}`);
  if (response.requestId !== requestId) throw new Error(`Correlation mismatch for ${op}`);
  if (!response.ok) throw new Error(response.error ?? `${op} failed`);
  return response.result as T;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CandidateView {
  provider: 'chatgpt' | 'claude' | 'gemini';
  tabId: number;
  frameId: number;
  documentId: string;
  href: string;
  origin: string;
  probe: ProbeResult;
  seenAt: number;
  tabTitle?: string;
  tabFavIconUrl?: string;
}

interface DebateTurn {
  round: number;
  provider: 'chatgpt' | 'claude' | 'gemini';
  prompt: string;
  reply: string;
  timestamp: number;
}

export type ClaimStatus = 'agreed' | 'disputed' | 'unresolved';

export interface LedgerClaim {
  id: string;
  claim: string;
  supportingModels: string[];
  opposingModels: string[];
  evidence?: string;
  status: ClaimStatus;
}

let candidates: CandidateView[] = [];
let currentRunId: string | null = null;
let boundTabs: Partial<Record<'chatgpt' | 'claude' | 'gemini', CandidateView>> = {};
let debateHistory: DebateTurn[] = [];
let disagreementLedger: LedgerClaim[] = [];
let nextClaimIndex = 1;
let isDebating = false;
let abortRequested = false;
let queuedInterjection: string | null = null;

// --- bridge / grounding state (Phase B0.x) --------------------------------
type BridgeUiState = 'disconnected' | 'connecting' | 'connected';
let bridgeState: BridgeUiState = 'disconnected';
interface PendingEgress {
  debateId: string;
  manifest: EgressManifestMessage;
  redaction: RedactionFoundMessage | null;
}
let pendingEgress: PendingEgress | null = null;
let latestReport: ContextReportMessage | null = null;
let lastInjectedDebateId: string | null = null;
let injectedGroundingThisRun = false;

// ---------------------------------------------------------------------------
// Candidate Detection & Provider Chips
// ---------------------------------------------------------------------------

async function refreshCandidates(): Promise<void> {
  try {
    const result = await ui<{ candidates: CandidateView[] }>('listCandidates');
    candidates = result.candidates;
    updateChips();
  } catch (err) {
    console.error('Failed listing candidates:', err);
  }
}

function updateChips(): void {
  const providers: Array<'chatgpt' | 'claude' | 'gemini'> = ['chatgpt', 'claude', 'gemini'];

  for (const p of providers) {
    const chip = el<HTMLElement>(`chip-${p}`);
    const tabLabel = chip.querySelector<HTMLElement>('.tab-id')!;
    const cleanBadge = chip.querySelector<HTMLElement>('.clean-badge')!;
    const titleLabel = chip.querySelector<HTMLElement>('.tab-title')!;
    const dot = chip.querySelector<HTMLElement>('.dot')!;
    const bound = boundTabs[p];
    const candidate = bound ?? candidates.find((c) => c.provider === p && c.probe.recognized);

    if (bound) {
      chip.className = 'chip bound';
      tabLabel.textContent = `Tab #${bound.tabId}`;
      titleLabel.textContent = bound.tabTitle ?? '';
      titleLabel.title = bound.tabTitle ?? '';
      dot.title = bound.probe.reason ?? 'Bound & ready';
      if (bound.probe.isClean === true) {
        cleanBadge.textContent = 'Fresh Chat';
        cleanBadge.className = 'clean-badge clean';
        cleanBadge.title = 'Pre-run check: Zero conversation turns detected (Round 0 peer-blind)';
      } else if (bound.probe.isClean === false) {
        cleanBadge.textContent = 'Has History';
        cleanBadge.className = 'clean-badge history';
        cleanBadge.title = 'Pre-run check: Conversation has prior history which may influence debate';
      } else {
        cleanBadge.textContent = 'Ready';
        cleanBadge.className = 'clean-badge';
      }
    } else if (candidate) {
      chip.className = 'chip detected';
      tabLabel.textContent = `Tab #${candidate.tabId}`;
      titleLabel.textContent = candidate.tabTitle ?? '';
      titleLabel.title = candidate.tabTitle ?? '';
      dot.title = candidate.probe.reason ?? 'Detected & healthy';
      if (candidate.probe.isClean === true) {
        cleanBadge.textContent = 'Fresh Chat';
        cleanBadge.className = 'clean-badge clean';
        cleanBadge.title = 'Pre-run check: Zero conversation turns detected (Round 0 peer-blind)';
      } else if (candidate.probe.isClean === false) {
        cleanBadge.textContent = 'Has History';
        cleanBadge.className = 'clean-badge history';
        cleanBadge.title = 'Pre-run check: Conversation has prior history which may influence debate';
      } else {
        cleanBadge.textContent = 'Ready';
        cleanBadge.className = 'clean-badge';
      }
    } else {
      chip.className = 'chip missing';
      tabLabel.textContent = '—';
      titleLabel.textContent = '';
      cleanBadge.textContent = '—';
      cleanBadge.className = 'clean-badge';
      dot.title = 'Tab not detected';
    }
  }
}

async function bindProvider(provider: 'chatgpt' | 'claude' | 'gemini', runId: string, objective: string): Promise<boolean> {
  const candidate = candidates.find((c) => c.provider === provider && c.probe.recognized);
  if (!candidate) return false;

  await ui('bindRun', {
    runId,
    objective,
    provider: candidate.provider,
    tabId: candidate.tabId,
    documentId: candidate.documentId,
  });

  boundTabs[provider] = candidate;
  updateChips();
  return true;
}

// ---------------------------------------------------------------------------
// Transcript Rendering (Safe DOM — zero innerHTML)
// ---------------------------------------------------------------------------

function clearFeed(): void {
  debateHistory = [];
  disagreementLedger = [];
  nextClaimIndex = 1;
  const feed = el<HTMLElement>('transcript-feed');
  feed.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'feed-empty';
  empty.textContent = 'Select at least two providers, configure your topic, and click Start Multi-Round Debate.';
  feed.appendChild(empty);
  renderLedgerTable();
  chrome.storage.session.remove('silknet/v0.1/debate-backup').catch(() => undefined);
}

function appendRoundDivider(round: number, title: string): void {
  const feed = el<HTMLElement>('transcript-feed');
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const divider = document.createElement('div');
  divider.className = 'round-divider';
  const pill = document.createElement('span');
  pill.className = 'round-pill';
  pill.textContent = `Round ${round}: ${title}`;
  divider.appendChild(pill);
  feed.appendChild(divider);
  feed.scrollTop = feed.scrollHeight;
}

function appendTurn(turn: DebateTurn): void {
  const feed = el<HTMLElement>('transcript-feed');
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const bubble = document.createElement('div');
  bubble.className = 'turn-bubble';
  bubble.dataset.provider = turn.provider;

  const header = document.createElement('div');
  header.className = 'turn-header';

  const badge = document.createElement('span');
  badge.className = 'model-badge';
  badge.textContent = turn.provider.toUpperCase();

  const meta = document.createElement('span');
  meta.className = 'turn-meta';
  const timeStr = new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `${timeStr} · ${turn.reply.length} chars`;

  header.appendChild(badge);
  header.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'turn-body';
  body.textContent = turn.reply;

  bubble.appendChild(header);
  bubble.appendChild(body);
  feed.appendChild(bubble);
  feed.scrollTop = feed.scrollHeight;
}

function appendNotice(text: string): void {
  const feed = el<HTMLElement>('transcript-feed');
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const notice = document.createElement('div');
  notice.className = 'feed-notice';
  notice.textContent = text;
  feed.appendChild(notice);
  feed.scrollTop = feed.scrollHeight;
}

function showSemiBanner(provider: string, tabId: number): void {
  const banner = el<HTMLElement>('semi-banner');
  const text = el<HTMLElement>('semi-instruction');
  text.textContent = `Text staged in ${provider.toUpperCase()} (Tab #${tabId})! Click Send in that tab.`;
  banner.classList.remove('hidden');
  chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
}

function hideSemiBanner(): void {
  el<HTMLElement>('semi-banner').classList.add('hidden');
}

let tamperTimer: ReturnType<typeof setTimeout> | null = null;
function showTamperBanner(provider: string): void {
  const banner = el<HTMLElement>('tamper-banner');
  const text = el<HTMLElement>('tamper-instruction');
  text.textContent = `Send blocked in ${provider.toUpperCase()} — composer text was modified! Please do not alter the staged prompt.`;
  banner.classList.remove('hidden');
  if (tamperTimer) clearTimeout(tamperTimer);
  tamperTimer = setTimeout(() => {
    banner.classList.add('hidden');
    tamperTimer = null;
  }, 7000);
}

function parseLedgerFromTurn(reply: string, modelLabel: string): void {
  const lines = reply.split('\n');
  let currentCategory: 'AGREE' | 'DISAGREE' | 'UNRESOLVED' | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^AGREE\s*:/i.test(line)) {
      currentCategory = 'AGREE';
      const text = line.replace(/^AGREE\s*:\s*/i, '').trim();
      if (text) addClaimToLedger(text, 'AGREE', modelLabel);
      continue;
    }
    if (/^DISAGREE\s*:/i.test(line)) {
      currentCategory = 'DISAGREE';
      const text = line.replace(/^DISAGREE\s*:\s*/i, '').trim();
      if (text) addClaimToLedger(text, 'DISAGREE', modelLabel);
      continue;
    }
    if (/^UNRESOLVED\s*:/i.test(line)) {
      currentCategory = 'UNRESOLVED';
      const text = line.replace(/^UNRESOLVED\s*:\s*/i, '').trim();
      if (text) addClaimToLedger(text, 'UNRESOLVED', modelLabel);
      continue;
    }

    if (currentCategory && /^[-*•\d.]+\s+/.test(line)) {
      const text = line.replace(/^[-*•\d.]+\s+/, '').trim();
      if (text) addClaimToLedger(text, currentCategory, modelLabel);
    }
  }

  renderLedgerTable();
}

function addClaimToLedger(claimText: string, category: 'AGREE' | 'DISAGREE' | 'UNRESOLVED', modelLabel: string): void {
  const clean = claimText.replace(/^\[|\]$/g, '').trim();
  const norm = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm.length < 5) return;

  const existing = disagreementLedger.find((c) => {
    const cNorm = c.claim.toLowerCase().replace(/[^a-z0-9]/g, '');
    return cNorm.includes(norm) || norm.includes(cNorm);
  });

  if (existing) {
    if (category === 'AGREE' && !existing.supportingModels.includes(modelLabel)) {
      existing.supportingModels.push(modelLabel);
    } else if (category === 'DISAGREE' && !existing.opposingModels.includes(modelLabel)) {
      existing.opposingModels.push(modelLabel);
    }
    if (existing.opposingModels.length > 0 && existing.supportingModels.length > 0) {
      existing.status = 'disputed';
    } else if (category === 'UNRESOLVED') {
      existing.status = 'unresolved';
    } else if (existing.supportingModels.length > 0 && existing.opposingModels.length === 0) {
      existing.status = 'agreed';
    }
    return;
  }

  const id = `CLAIM-${String(nextClaimIndex++).padStart(2, '0')}`;
  const claim: LedgerClaim = {
    id,
    claim: clean,
    supportingModels: category === 'AGREE' ? [modelLabel] : [],
    opposingModels: category === 'DISAGREE' ? [modelLabel] : [],
    status: category === 'UNRESOLVED' ? 'unresolved' : category === 'DISAGREE' ? 'disputed' : 'agreed',
  };
  disagreementLedger.push(claim);
}

function renderLedgerTable(): void {
  const container = el<HTMLElement>('ledger-table-container');
  const stats = el<HTMLElement>('ledger-stats');
  stats.textContent = `${disagreementLedger.length} claims tracked`;

  container.textContent = '';

  if (disagreementLedger.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ledger-empty text-muted';
    empty.textContent = 'No claims recorded yet. The ledger extracts AGREE / DISAGREE / UNRESOLVED claims during Round 2 & Round 3.';
    container.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'ledger-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  ['ID', 'Claim', 'Status', 'Supporting', 'Opposing'].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const claim of disagreementLedger) {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    tdId.style.fontWeight = '700';
    tdId.textContent = claim.id;

    const tdClaim = document.createElement('td');
    tdClaim.textContent = claim.claim;

    const tdStatus = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `claim-pill ${claim.status}`;
    pill.textContent = claim.status.toUpperCase();
    tdStatus.appendChild(pill);

    const tdSupp = document.createElement('td');
    tdSupp.textContent = claim.supportingModels.length ? claim.supportingModels.join(', ') : '—';

    const tdOpp = document.createElement('td');
    tdOpp.textContent = claim.opposingModels.length ? claim.opposingModels.join(', ') : '—';

    tr.appendChild(tdId);
    tr.appendChild(tdClaim);
    tr.appendChild(tdStatus);
    tr.appendChild(tdSupp);
    tr.appendChild(tdOpp);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// ---------------------------------------------------------------------------
// Bridge / grounding UI (Phase B0.x) — helpers
// ---------------------------------------------------------------------------

/**
 * Awaits the grounding outcome for a debate: resolves with the approved
 * CONTEXT_REPORT, or null on cancel/deny/timeout. Driven by the push listener,
 * which resolves the waiter below.
 */
function waitForGroundingReport(debateId: string, timeoutMs: number): Promise<ContextReportMessage | null> {
  // If the report already arrived (fast broker), resolve immediately.
  if (latestReport !== null && latestReport.debateId === debateId) {
    const report = latestReport;
    latestReport = null;
    return Promise.resolve(report);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      groundingWaiter = null;
      resolve(null);
    }, timeoutMs);
    groundingWaiter = (report: ContextReportMessage | null) => {
      clearTimeout(timeout);
      groundingWaiter = null;
      resolve(report);
    };
  });
}

let groundingWaiter: ((report: ContextReportMessage | null) => void) | null = null;

/** Renders the approved report as the injected Round 0 context block. */
// formatGroundingBlock is imported from bridge-grounding.ts (shared, testable).

// ---------------------------------------------------------------------------
// Bridge / grounding UI (Phase B0.x)
// ---------------------------------------------------------------------------

/** Sends a bridge UI op to the service worker and awaits its typed result. */
async function bridgeUi<T>(op: string, args?: unknown): Promise<T> {
  const requestId = crypto.randomUUID();
  const response = await chrome.runtime.sendMessage({
    ns: BRIDGE_INTERNAL_NS,
    kind: 'BRIDGE_UI',
    op,
    requestId,
    ...(args !== undefined ? { args } : {}),
  });
  if (
    typeof response !== 'object' ||
    response === null ||
    (response as Record<string, unknown>)['ns'] !== BRIDGE_INTERNAL_NS ||
    (response as Record<string, unknown>)['kind'] !== 'BRIDGE_UI_RESULT' ||
    (response as Record<string, unknown>)['requestId'] !== requestId
  ) {
    throw new Error(`Malformed bridge UI response for ${op}`);
  }
  const rec = response as Record<string, unknown>;
  if (rec['ok'] !== true) throw new Error(String(rec['error'] ?? `${op} failed`));
  return rec['result'] as T;
}

function renderBridgeState(state: BridgeUiState, detail?: string): void {
  const dot = el<HTMLElement>('bridge-dot');
  const label = el<HTMLElement>('bridge-state-label');
  const connectRow = el<HTMLElement>('bridge-connect-row');
  const disconnectBtn = el<HTMLButtonElement>('bridge-disconnect-btn');
  const tokenInput = el<HTMLInputElement>('bridge-token');
  const check = el<HTMLInputElement>('bridge-grounding-check');
  const error = el<HTMLElement>('bridge-error');

  dot.className = `bridge-dot ${state}`;
  label.textContent = state;
  connectRow.classList.toggle('hidden', state === 'connected');
  disconnectBtn.classList.toggle('hidden', state !== 'connected');
  check.disabled = state !== 'connected';
  if (state !== 'connected') {
    check.checked = false;
    error.textContent = detail ?? '';
    error.classList.toggle('hidden', !detail);
  }
}

async function connectBridge(): Promise<void> {
  const tokenInput = el<HTMLInputElement>('bridge-token');
  const token = tokenInput.value.trim();
  const error = el<HTMLElement>('bridge-error');
  if (token.length < 32) {
    error.textContent = 'Enter the 64-character session token shown by the VS Code extension.';
    error.classList.remove('hidden');
    return;
  }
  try {
    await bridgeUi<{ connecting: boolean }>('connect', { token, port: 8712 });
    tokenInput.value = '';
    renderBridgeState('connecting');
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    error.classList.remove('hidden');
  }
}

async function disconnectBridge(): Promise<void> {
  try {
    await bridgeUi('disconnect');
  } finally {
    renderBridgeState('disconnected');
    el<HTMLInputElement>('bridge-grounding-check').checked = false;
  }
}

function showEgressDialog(pending: PendingEgress): void {
  pendingEgress = pending;
  const dialog = el<HTMLElement>('egress-dialog');
  const { manifest, redaction } = pending;

  const providers = manifest.targetProviders.length > 0
    ? manifest.targetProviders.map((p) => p.toUpperCase()).join(', ')
    : 'the selected debate participants';
  el<HTMLElement>('egress-manifest-line').textContent =
    `Local project context will be sent to: ${providers}. Files referenced: ${manifest.fileCount}. Approx. size: ${manifest.approxLines} lines.`;

  // Checkbox list over EXACTLY the files the report already selected — the
  // user refines the report, they do not browse the whole workspace.
  const filesBox = el<HTMLElement>('egress-files');
  filesBox.textContent = '';
  const paths = manifest.paths ?? [];
  for (const path of paths) {
    const label = document.createElement('label');
    label.className = 'egress-file-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true; // all pre-ticked; deselect to withhold
    cb.dataset.path = path;
    const text = document.createElement('span');
    text.textContent = path;
    label.appendChild(cb);
    label.appendChild(text);
    filesBox.appendChild(label);
  }
  filesBox.classList.toggle('hidden', paths.length === 0);

  const redactionBox = el<HTMLElement>('egress-redaction-box');
  if (redaction !== null && redaction.matches.length > 0) {
    const list = el<HTMLElement>('egress-redaction-list');
    list.textContent = '';
    for (const match of redaction.matches.slice(0, 12)) {
      const li = document.createElement('li');
      li.textContent = `${match.pattern} — ${match.location}`;
      list.appendChild(li);
    }
    if (redaction.matches.length > 12) {
      const li = document.createElement('li');
      li.textContent = `… and ${redaction.matches.length - 12} more matches`;
      list.appendChild(li);
    }
    redactionBox.classList.remove('hidden');
  } else {
    redactionBox.classList.add('hidden');
  }

  const selectedBtn = el<HTMLButtonElement>('egress-selected-btn');
  selectedBtn.classList.toggle('hidden', paths.length === 0);

  dialog.classList.remove('hidden');
}

function hideEgressDialog(): void {
  el<HTMLElement>('egress-dialog').classList.add('hidden');
  pendingEgress = null;
}

async function decideEgress(
  decision: 'approve-report' | 'approve-selected' | 'redact' | 'cancel',
): Promise<void> {
  const pending = pendingEgress;
  if (pending === null) return;
  const { manifest } = pending;
  const debateId = manifest.debateId;
  const runId = currentRunId ?? 'unknown-run';

  const send = async (payload: Record<string, unknown>): Promise<void> => {
    try {
      await bridgeUi('egressDecision', { runId, debateId, ...payload });
    } catch (err) {
      appendNotice(`⚠️ Egress decision failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (decision === 'approve-report') {
    await send({ decision: 'approve', mode: 'report-only' });
  } else if (decision === 'approve-selected') {
    const checkboxes = [...el<HTMLElement>('egress-files').querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    const selectedFiles = checkboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.path ?? '');
    if (selectedFiles.length === 0) {
      alert('Select at least one file, or choose "No local context".');
      return;
    }
    await send({ decision: 'approve', mode: 'selected-files', selectedFiles });
  } else if (decision === 'redact') {
    await send({ decision: 'redact' });
  } else {
    await send({ decision: 'cancel' });
  }
  hideEgressDialog();
}

function setupBridgeUi(): void {
  el('bridge-connect-btn').addEventListener('click', () => void connectBridge());
  el('bridge-disconnect-btn').addEventListener('click', () => void disconnectBridge());
  el('egress-none-btn').addEventListener('click', () => void decideEgress('cancel'));
  el('egress-report-btn').addEventListener('click', () => void decideEgress('approve-report'));
  el('egress-selected-btn').addEventListener('click', () => void decideEgress('approve-selected'));
  el('egress-redact-btn').addEventListener('click', () => void decideEgress('redact')); // may be absent
  el('egress-cancel-btn').addEventListener('click', () => void decideEgress('cancel'));

  void bridgeUi<{ state: BridgeUiState; clientState: BridgeUiState }>('getState')
    .then((s) => renderBridgeState(s.clientState))
  .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Debate Protocol Engine (Multi-Round)
// ---------------------------------------------------------------------------

async function runDebate(): Promise<void> {
  if (isDebating) return;

  const topic = el<HTMLTextAreaElement>('debate-topic').value.trim();
  if (!topic) {
    alert('Please enter a debate topic.');
    return;
  }

  const roundsCount = parseInt(el<HTMLSelectElement>('debate-rounds').value, 10);
  const sendMode = el<HTMLSelectElement>('send-mode').value;
  const autoSend = sendMode === 'auto';

  // Check selected models
  const selected: Array<'chatgpt' | 'claude' | 'gemini'> = [];
  if (el<HTMLInputElement>('chk-chatgpt').checked) selected.push('chatgpt');
  if (el<HTMLInputElement>('chk-claude').checked) selected.push('claude');
  if (el<HTMLInputElement>('chk-gemini').checked) selected.push('gemini');

  if (selected.length < 2) {
    alert('Please select at least 2 models to debate.');
    return;
  }

  // Ensure candidate tabs are fresh
  await refreshCandidates();
  if (candidates.length < selected.length) {
    // Give background scanner time to receive PROBE_HELLO from newly probed tabs
    await new Promise((r) => setTimeout(r, 600));
    await refreshCandidates();
  }

  const runId = `debate-${Date.now().toString(36)}`;
  currentRunId = runId;
  boundTabs = {};

  // Bind each selected model
  const activeProviders: Array<'chatgpt' | 'claude' | 'gemini'> = [];
  for (const p of selected) {
    const bound = await bindProvider(p, runId, topic);
    if (bound) {
      activeProviders.push(p);
    }
  }

  if (activeProviders.length < 2) {
    const missing = selected.filter((p) => !activeProviders.includes(p));
    alert(`Could not detect open tab(s) for: ${missing.map(m => m.toUpperCase()).join(', ')}.\n\nPlease ensure you have open, logged-in tabs for them and try again.`);
    return;
  }

  // Start Debate State
  isDebating = true;
  abortRequested = false;
  el<HTMLElement>('debate-status').className = 'status-pill active';
  el<HTMLElement>('debate-status').textContent = 'DEBATING';
  el<HTMLButtonElement>('start-debate').disabled = true;
  el<HTMLButtonElement>('stop-debate').disabled = false;

  // Map providers to anonymized labels (Model A, Model B, Model C)
  const providerToModel = new Map<string, string>();
  activeProviders.forEach((p, idx) => {
    providerToModel.set(p, `Model ${String.fromCharCode(65 + idx)}`);
  });

  try {
    const round1Replies: Record<string, string> = {};

    // -------------------------------------------------------------------------
    // LOCAL GROUNDING (optional, before Round 0): request real-workspace
    // context from the VS Code extension over the bridge. The human approves
    // what crosses the egress gate; approved content is injected into EVERY
    // participant's Round 0 prompt so the debate reasons about the real
    // project rather than a vacuum.
    // -------------------------------------------------------------------------
    let groundingBlock: string | null = null;
    injectedGroundingThisRun = false;
    lastInjectedDebateId = null;
    const groundingWanted = el<HTMLInputElement>('bridge-grounding-check').checked && bridgeState === 'connected';
    if (groundingWanted) {
      appendNotice('⏳ Requesting local grounding context from the VS Code extension…');
      try {
        const targetProviders = [...activeProviders];
        const result = await bridgeUi<{ requested: boolean; debateId: string }>('requestContext', {
          runId,
          round: 0,
          targetProviders,
        });
        // The egress dialog flow completes as a push (EGRESS_MANIFEST → human
        // decision → CONTEXT_REPORT). Resolve when the report lands, the user
        // cancels/denies, or the watchdog elapses.
        const report = await waitForGroundingReport(result.debateId, 180_000);
        if (report === null) {
          appendNotice('ℹ️ Continuing without local grounding context (denied, cancelled, or timed out).');
        } else {
          groundingBlock = formatGroundingBlock(report);
          lastInjectedDebateId = report.debateId;
          injectedGroundingThisRun = true;
          void bridgeUi('getReport'); // local mirror for diagnostics
          appendNotice(
            `✅ Local grounding context included (~${report.approxLines} lines${report.truncated ? ', truncated' : ''}).`,
          );
        }
      } catch (err) {
        appendNotice(`⚠️ Grounding context unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // -------------------------------------------------------------------------
    // ROUND 1: Opening Arguments
    // -------------------------------------------------------------------------
    appendRoundDivider(1, 'Opening Arguments');
    for (const provider of activeProviders) {
      if (abortRequested) break;

      const openingPrompt = buildOpeningPrompt(topic, groundingBlock);

      if (!autoSend) {
        showSemiBanner(provider, boundTabs[provider]!.tabId);
      }

      const { results } = await ui<{ results: Array<{ provider: string; status: string; reply?: string; detail?: string }> }>('startFlow', {
        runId,
        text: openingPrompt,
        autoSend,
        round: 1,
        provider,
      });

      hideSemiBanner();

      const result = results?.[0];
      if (!result || result.status !== 'reply-captured') {
        const detail = result?.detail ?? 'No response or timed out';
        appendNotice(`⚠️ ${provider.toUpperCase()} failed (${detail}) — dropping from subsequent rounds.`);
        const idx = activeProviders.indexOf(provider);
        if (idx !== -1) activeProviders.splice(idx, 1);
        continue;
      }

      const reply = result.reply ?? `[No response captured]`;
      round1Replies[provider] = reply;

      const turn: DebateTurn = {
        round: 1,
        provider,
        prompt: openingPrompt,
        reply,
        timestamp: Date.now(),
      };
      debateHistory.push(turn);
      appendTurn(turn);
      void saveDebateSessionState();
    }

    // -------------------------------------------------------------------------
    // ROUND 2: Cross-Examination & Critique (if >= 2 rounds)
    // -------------------------------------------------------------------------
    const round2Critiques: Record<string, string> = {};

    if (roundsCount >= 2 && !abortRequested && activeProviders.length >= 2) {
      appendRoundDivider(2, 'Cross-Examination & Critique');

      for (const provider of [...activeProviders]) {
        if (abortRequested) break;

        const modelLabel = providerToModel.get(provider)!;
        // Anonymized peer positions (Model A, Model B, etc.)
        const otherArguments = activeProviders
          .filter((p) => p !== provider)
          .map((p) => `=== Position from ${providerToModel.get(p)} ===\n${round1Replies[p] ?? ''}`)
          .join('\n\n');

        let critiquePrompt = `We are debating: "${topic}"

Here are the positions stated by your peers:

${otherArguments}

CRITICAL REVIEW INSTRUCTIONS (Anti-Sycophancy Rule):
You are strictly forbidden from mere agreement. If you agree completely with a peer, you have failed this task.
Evaluate your peers' arguments rigorously. For each peer argument, provide:
1. Strongest claim to keep (concede what is genuinely robust)
2. Strongest objection (identify logical fallacies, weak evidence, or fatal flaws)
3. Missing evidence or overlooked variables
4. A concrete failure case or counter-example
5. Self-doubt: identify the weakest point in your OWN initial argument

REQUIRED FORMAT:
You MUST structure your response using these exact category headers:
AGREE: [State specific claims from peers you concede, with brief reasoning]
DISAGREE: [State specific claims you dispute, with counterarguments and failure cases]
UNRESOLVED: [State questions that cannot be settled without empirical evidence]`;

        if (queuedInterjection) {
          appendNotice(`💬 User Interjection applied: "${queuedInterjection}"`);
          critiquePrompt += `\n\nUSER INTERJECTION:\n"${queuedInterjection}"\nAddress this specific question or challenge in your critique.`;
          queuedInterjection = null;
          el<HTMLElement>('interject-status').classList.add('hidden');
        }

        if (!autoSend) {
          showSemiBanner(provider, boundTabs[provider]!.tabId);
        }

        const { results } = await ui<{ results: Array<{ provider: string; status: string; reply?: string; detail?: string }> }>('startFlow', {
          runId,
          text: critiquePrompt,
          autoSend,
          round: 2,
          provider,
        });

        hideSemiBanner();

        const result = results?.[0];
        if (!result || result.status !== 'reply-captured') {
          const detail = result?.detail ?? 'No critique captured';
          appendNotice(`⚠️ ${provider.toUpperCase()} failed (${detail}) — dropping from subsequent rounds.`);
          const idx = activeProviders.indexOf(provider);
          if (idx !== -1) activeProviders.splice(idx, 1);
          continue;
        }

        const reply = result.reply ?? `[No critique captured]`;
        round2Critiques[provider] = reply;

        const turn: DebateTurn = {
          round: 2,
          provider,
          prompt: critiquePrompt,
          reply,
          timestamp: Date.now(),
        };
        debateHistory.push(turn);
        appendTurn(turn);
        parseLedgerFromTurn(reply, `${modelLabel} (${provider})`);
        void saveDebateSessionState();
      }
    }

    // -------------------------------------------------------------------------
    // ROUND 3: Rebuttal & Persistent Disagreement (if >= 3 rounds)
    // -------------------------------------------------------------------------
    if (roundsCount >= 3 && !abortRequested && activeProviders.length >= 2) {
      appendRoundDivider(3, 'Rebuttal & Persistent Disagreement');

      for (const provider of [...activeProviders]) {
        if (abortRequested) break;

        const modelLabel = providerToModel.get(provider)!;
        const opponentCritiques = activeProviders
          .filter((p) => p !== provider)
          .map((p) => `=== Critique from ${providerToModel.get(p)} ===\n${round2Critiques[p] ?? ''}`)
          .join('\n\n');

        let rebuttalPrompt = `We are concluding the debate on: "${topic}"

Here are the peer critiques directed at your positions:

${opponentCritiques}

FINAL REBUTTAL & LEDGER INSTRUCTIONS:
Defend your strongest points against these critiques and acknowledge any valid criticisms.
IMPORTANT: Do NOT force artificial consensus. If fundamental differences or trade-offs remain, preserve and articulate them clearly. Unresolved disagreement with explicit trade-offs is a valid and preferred outcome.

REQUIRED FORMAT:
You MUST conclude your statement with these exact category headers:
AGREE: [Claims where consensus has genuinely been reached]
DISAGREE: [Points of persistent, irreconcilable disagreement and the core trade-offs]
UNRESOLVED: [Key empirical questions or unknowns that remain open]`;

        if (queuedInterjection) {
          appendNotice(`💬 User Interjection applied: "${queuedInterjection}"`);
          rebuttalPrompt += `\n\nUSER INTERJECTION:\n"${queuedInterjection}"\nAddress this specific question or challenge in your final statement.`;
          queuedInterjection = null;
          el<HTMLElement>('interject-status').classList.add('hidden');
        }

        if (!autoSend) {
          showSemiBanner(provider, boundTabs[provider]!.tabId);
        }

        const { results } = await ui<{ results: Array<{ provider: string; status: string; reply?: string; detail?: string }> }>('startFlow', {
          runId,
          text: rebuttalPrompt,
          autoSend,
          round: 3,
          provider,
        });

        hideSemiBanner();

        const result = results?.[0];
        if (!result || result.status !== 'reply-captured') {
          const detail = result?.detail ?? 'No final statement captured';
          appendNotice(`⚠️ ${provider.toUpperCase()} failed (${detail}).`);
          continue;
        }

        const reply = result.reply ?? `[No final statement captured]`;

        const turn: DebateTurn = {
          round: 3,
          provider,
          prompt: rebuttalPrompt,
          reply,
          timestamp: Date.now(),
        };
        debateHistory.push(turn);
        appendTurn(turn);
        parseLedgerFromTurn(reply, `${modelLabel} (${provider})`);
        void saveDebateSessionState();
      }
    }
  } catch (err) {
    console.error('Debate error:', err);
    alert(`Debate error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    hideSemiBanner();
    isDebating = false;
    el<HTMLElement>('debate-status').className = 'status-pill idle';
    el<HTMLElement>('debate-status').textContent = abortRequested ? 'STOPPED' : 'FINISHED';
    el<HTMLButtonElement>('start-debate').disabled = false;
    el<HTMLButtonElement>('stop-debate').disabled = true;
    void saveDebateSessionState();
  }
}

// ---------------------------------------------------------------------------
// Exporting & Persistence
// ---------------------------------------------------------------------------

async function saveDebateSessionState(): Promise<void> {
  try {
    await chrome.storage.session.set({
      'silknet/v0.1/debate-backup': {
        runId: currentRunId,
        topic: el<HTMLTextAreaElement>('debate-topic').value,
        roundsCount: parseInt(el<HTMLSelectElement>('debate-rounds').value, 10),
        debateHistory,
        disagreementLedger,
        boundTabs,
        isDebating,
        savedAt: Date.now(),
      },
    });
  } catch {
    /* session storage best-effort */
  }
}

async function checkReopenRecovery(): Promise<void> {
  try {
    const bag = await chrome.storage.session.get('silknet/v0.1/debate-backup');
    const backup = bag['silknet/v0.1/debate-backup'] as
      | {
          runId: string;
          topic: string;
          roundsCount: number;
          debateHistory: DebateTurn[];
          disagreementLedger: LedgerClaim[];
          boundTabs: typeof boundTabs;
          isDebating: boolean;
        }
      | undefined;

    if (!backup || !backup.runId || (!backup.isDebating && (!backup.debateHistory || backup.debateHistory.length === 0))) {
      return;
    }

    const banner = el<HTMLElement>('recovery-banner');
    const title = el<HTMLElement>('recovery-title');
    const desc = el<HTMLElement>('recovery-desc');
    title.textContent = `Debate Session Found (${backup.runId})`;
    desc.textContent = `Topic: "${backup.topic.slice(0, 36)}..." · ${backup.debateHistory.length} turns recorded.`;
    banner.classList.remove('hidden');

    el('recovery-resume-btn').onclick = () => {
      currentRunId = backup.runId;
      debateHistory = backup.debateHistory ?? [];
      disagreementLedger = backup.disagreementLedger ?? [];
      boundTabs = backup.boundTabs ?? {};
      el<HTMLTextAreaElement>('debate-topic').value = backup.topic ?? '';
      el<HTMLSelectElement>('debate-rounds').value = String(backup.roundsCount ?? 2);

      const feed = el<HTMLElement>('transcript-feed');
      feed.textContent = '';
      let curRound = -1;
      for (const turn of debateHistory) {
        if (turn.round !== curRound) {
          curRound = turn.round;
          const roundTitle =
            curRound === 1
              ? 'Opening Arguments'
              : curRound === 2
                ? 'Cross-Examination & Critique'
                : 'Rebuttal & Persistent Disagreement';
          appendRoundDivider(curRound, roundTitle);
        }
        appendTurn(turn);
      }
      renderLedgerTable();
      updateChips();
      banner.classList.add('hidden');
    };

    el('recovery-dismiss-btn').onclick = () => {
      banner.classList.add('hidden');
      chrome.storage.session.remove('silknet/v0.1/debate-backup').catch(() => undefined);
    };
  } catch {
    /* ignore session errors */
  }
}

function setupInterject(): void {
  const btn = el<HTMLButtonElement>('interject-btn');
  const input = el<HTMLInputElement>('interject-input');
  const status = el<HTMLElement>('interject-status');
  const preview = el<HTMLElement>('interject-preview');
  const cancelBtn = el<HTMLButtonElement>('interject-cancel');

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    queuedInterjection = text;
    preview.textContent = text.length > 40 ? `${text.slice(0, 40)}...` : text;
    status.classList.remove('hidden');
    input.value = '';

    if (currentRunId) {
      await ui('interject', { runId: currentRunId, text }).catch(() => undefined);
    }
  });

  cancelBtn.addEventListener('click', () => {
    queuedInterjection = null;
    status.classList.add('hidden');
  });
}

function copyTranscriptAsMarkdown(): void {
  if (debateHistory.length === 0) {
    alert('No debate transcript to copy.');
    return;
  }

  const topic = el<HTMLTextAreaElement>('debate-topic').value.trim();
  const lines: string[] = [
    `# Silknet Multi-Model AI Debate`,
    `**Topic:** ${topic}`,
    `**Date:** ${new Date().toLocaleString()}`,
    `\n---\n`,
  ];

  if (disagreementLedger.length > 0) {
    lines.push(`## Disagreement Ledger\n`);
    lines.push(`| ID | Claim | Status | Supporting Models | Opposing Models |`);
    lines.push(`| :--- | :--- | :---: | :--- | :--- |`);
    for (const c of disagreementLedger) {
      lines.push(
        `| **${c.id}** | ${c.claim.replace(/\|/g, '-')} | \`${c.status.toUpperCase()}\` | ${c.supportingModels.join(', ') || '—'} | ${c.opposingModels.join(', ') || '—'} |`,
      );
    }
    lines.push(`\n---\n`);
  }

  let currentRound = -1;
  for (const turn of debateHistory) {
    if (turn.round !== currentRound) {
      currentRound = turn.round;
      const title =
        currentRound === 1
          ? 'Opening Arguments'
          : currentRound === 2
            ? 'Cross-Critique'
            : 'Rebuttal & Persistent Disagreement';
      lines.push(`\n## Round ${currentRound}: ${title}\n`);
    }
    lines.push(`### ${turn.provider.toUpperCase()}`);
    lines.push(turn.reply);
    lines.push('');
  }

  const md = lines.join('\n');
  void navigator.clipboard.writeText(md).then(() => {
    const btn = el<HTMLButtonElement>('copy-transcript');
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => {
      btn.textContent = orig;
    }, 2000);
  });
}

function exportDebateAsJson(): void {
  if (debateHistory.length === 0) {
    alert('No debate transcript to export.');
    return;
  }

  const topic = el<HTMLTextAreaElement>('debate-topic').value.trim();
  const data = {
    runId: currentRunId ?? `export-${Date.now().toString(36)}`,
    topic,
    exportedAt: new Date().toISOString(),
    ledger: disagreementLedger,
    turns: debateHistory,
  };

  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `silknet-debate-${data.runId}.json`;
  a.click();
  URL.revokeObjectURL(url);

  const btn = el<HTMLButtonElement>('export-json');
  const orig = btn.textContent;
  btn.textContent = '✅ Exported!';
  setTimeout(() => {
    btn.textContent = orig;
  }, 2000);
}

// ---------------------------------------------------------------------------
// Initialization & Event Wiring
// ---------------------------------------------------------------------------

function init(): void {
  el('refresh-tabs').addEventListener('click', () => void refreshCandidates());
  el('start-debate').addEventListener('click', () => void runDebate());
  el('stop-debate').addEventListener('click', () => {
    abortRequested = true;
  });
  el('copy-transcript').addEventListener('click', copyTranscriptAsMarkdown);
  el('export-json').addEventListener('click', exportDebateAsJson);
  el('clear-feed').addEventListener('click', clearFeed);

  setupInterject();
  setupBridgeUi();
  void checkReopenRecovery();

  // Listen for background push notifications (TAMPER_BLOCKED + bridge pushes).
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const msg = message as Record<string, unknown>;

    if (msg['kind'] === 'PUSH' && msg['topic'] === 'run') {
      const payload = msg['payload'] as Record<string, unknown> | undefined;
      if (payload?.['type'] === 'TAMPER_BLOCKED') {
        showTamperBanner(String(payload['provider']));
      }
      return;
    }

    // Bridge pushes: state chip + egress dialog + report capture.
    if (isBridgePushMessage(message)) {
      if (message.topic === 'state') {
        if (isBridgeStatePayload(message.payload)) {
          renderBridgeState(message.payload.state, message.payload.detail);
        }
        return;
      }
      const parsed = parseBridgeMessage(message.payload);
      if (parsed === null) return;
      switch (parsed.type) {
        case 'EGRESS_MANIFEST':
          showEgressDialog({
            debateId: parsed.debateId,
            manifest: parsed,
            redaction: null,
          });
          return;
        case 'REDACTION_FOUND':
          if (pendingEgress !== null && pendingEgress.debateId === parsed.debateId) {
            pendingEgress.redaction = parsed;
            showEgressDialog(pendingEgress); // re-render with redaction info
          }
          return;
        case 'CONTEXT_REPORT':
          latestReport = parsed;
          groundingWaiter?.(parsed);
          return;
        default:
          return;
      }
    }
  });

  // Poll candidates on start and every 4 seconds
  void refreshCandidates();
  setInterval(() => {
    if (!isDebating) void refreshCandidates();
  }, 4000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

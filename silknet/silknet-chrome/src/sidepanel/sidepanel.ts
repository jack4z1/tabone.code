// Silknet — Chrome Side Panel Controller (Phase v0.5).
//
// Drives multi-round cross-model debates between ChatGPT, Claude, and Gemini
// from Chrome's persistent sidebar.

import { isUiResultMessage, NS, type UiOp } from '../content-scripts/shared/messaging';
import type { ProbeResult } from '../content-scripts/shared/types';
import type { StoredEvent } from '../background/event-log';

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
}

interface DebateTurn {
  round: number;
  provider: 'chatgpt' | 'claude' | 'gemini';
  prompt: string;
  reply: string;
  timestamp: number;
}

let candidates: CandidateView[] = [];
let currentRunId: string | null = null;
let boundTabs: Partial<Record<'chatgpt' | 'claude' | 'gemini', CandidateView>> = {};
let debateHistory: DebateTurn[] = [];
let isDebating = false;
let abortRequested = false;

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
    const found = candidates.find((c) => c.provider === p && c.probe.recognized);

    if (boundTabs[p]) {
      chip.className = 'chip bound';
      tabLabel.textContent = `Tab #${boundTabs[p]!.tabId}`;
    } else if (found) {
      chip.className = 'chip detected';
      tabLabel.textContent = `Tab #${found.tabId}`;
    } else {
      chip.className = 'chip missing';
      tabLabel.textContent = '—';
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
// Transcript Rendering
// ---------------------------------------------------------------------------

function clearFeed(): void {
  debateHistory = [];
  const feed = el<HTMLElement>('transcript-feed');
  feed.innerHTML = `
    <div class="feed-empty">
      Select at least two providers, configure your topic, and click <strong>Start Multi-Round Debate</strong>.
    </div>
  `;
}

function appendRoundDivider(round: number, title: string): void {
  const feed = el<HTMLElement>('transcript-feed');
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const divider = document.createElement('div');
  divider.className = 'round-divider';
  divider.innerHTML = `<span class="round-pill">Round ${round}: ${escapeHtml(title)}</span>`;
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

  const timeStr = new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const charsStr = `${turn.reply.length} chars`;

  bubble.innerHTML = `
    <div class="turn-header">
      <span class="model-badge">${turn.provider}</span>
      <span class="turn-meta">${timeStr} · ${charsStr}</span>
    </div>
    <div class="turn-body">${escapeHtml(turn.reply)}</div>
  `;

  feed.appendChild(bubble);
  feed.scrollTop = feed.scrollHeight;
}

function showSemiBanner(provider: string, tabId: number): void {
  const banner = el<HTMLElement>('semi-banner');
  const text = el<HTMLElement>('semi-instruction');
  text.textContent = `Text staged in ${provider.toUpperCase()} (Tab #${tabId})! Switch to it and click Send.`;
  banner.classList.remove('hidden');
}

function hideSemiBanner(): void {
  el<HTMLElement>('semi-banner').classList.add('hidden');
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
    alert(`Could not bind enough tabs. Make sure at least 2 selected providers have tabs open and logged in.`);
    return;
  }

  // Start Debate State
  isDebating = true;
  abortRequested = false;
  el<HTMLElement>('debate-status').className = 'status-pill active';
  el<HTMLElement>('debate-status').textContent = 'DEBATING';
  el<HTMLButtonElement>('start-debate').disabled = true;
  el<HTMLButtonElement>('stop-debate').disabled = false;

  try {
    const round1Replies: Record<string, string> = {};

    // -------------------------------------------------------------------------
    // ROUND 1: Opening Arguments
    // -------------------------------------------------------------------------
    appendRoundDivider(1, 'Opening Arguments');
    for (const provider of activeProviders) {
      if (abortRequested) break;

      const openingPrompt = `${topic}\n\nPlease state your position clearly, provide your core arguments, and highlight key trade-offs in under 200 words.`;

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
      const reply = result?.reply ?? `[No response captured: ${result?.detail ?? 'unknown'}]`;
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
    }

    // -------------------------------------------------------------------------
    // ROUND 2: Cross-Examination & Critique (if >= 2 rounds)
    // -------------------------------------------------------------------------
    const round2Critiques: Record<string, string> = {};

    if (roundsCount >= 2 && !abortRequested) {
      appendRoundDivider(2, 'Cross-Examination & Critique');

      for (const provider of activeProviders) {
        if (abortRequested) break;

        // Collect other participants' opening arguments
        const otherArguments = activeProviders
          .filter((p) => p !== provider)
          .map((p) => `--- Argument from ${p.toUpperCase()} ---\n${round1Replies[p] ?? ''}`)
          .join('\n\n');

        const critiquePrompt = `We are debating the question: "${topic}".\n\nHere is what your debate opponent(s) argued:\n\n${otherArguments}\n\nCritique these positions. Identify logical fallacies, unrealistic assumptions, or critical weaknesses. Present strong counterarguments in under 200 words.`;

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
        const reply = result?.reply ?? `[No critique captured: ${result?.detail ?? 'unknown'}]`;
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
      }
    }

    // -------------------------------------------------------------------------
    // ROUND 3: Rebuttal & Consensus (if >= 3 rounds)
    // -------------------------------------------------------------------------
    if (roundsCount >= 3 && !abortRequested) {
      appendRoundDivider(3, 'Rebuttal & Consensus');

      for (const provider of activeProviders) {
        if (abortRequested) break;

        const opponentCritiques = activeProviders
          .filter((p) => p !== provider)
          .map((p) => `--- Critique from ${p.toUpperCase()} ---\n${round2Critiques[p] ?? ''}`)
          .join('\n\n');

        const rebuttalPrompt = `Your opponent(s) critiqued your stance:\n\n${opponentCritiques}\n\nDeliver your final rebuttal. Defend your strongest points, acknowledge any valid criticisms, and provide a balanced final verdict or synthesis in under 200 words.`;

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
        const reply = result?.reply ?? `[No final statement captured: ${result?.detail ?? 'unknown'}]`;

        const turn: DebateTurn = {
          round: 3,
          provider,
          prompt: rebuttalPrompt,
          reply,
          timestamp: Date.now(),
        };
        debateHistory.push(turn);
        appendTurn(turn);
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
  }
}

// ---------------------------------------------------------------------------
// Exporting
// ---------------------------------------------------------------------------

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

  let currentRound = -1;
  for (const turn of debateHistory) {
    if (turn.round !== currentRound) {
      currentRound = turn.round;
      const title = currentRound === 1 ? 'Opening Arguments' : currentRound === 2 ? 'Cross-Critique' : 'Rebuttal & Consensus';
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
  el('clear-feed').addEventListener('click', clearFeed);

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

// Silknet — cloud-egress gate (VS Code side).
//
// This is a first-class UI decision point, not an implementation detail. Before
// ANY local file content crosses into a browser AI tab, the Chrome extension
// shows the user a specific manifest (EGRESS_MANIFEST) with three choices:
// none / report-only (recommended default) / selected-files.
//
// THIS extension's job is to hold the report hostage until a decision arrives,
// and to interpret the decision exactly: 'none' and 'denied' mean nothing ever
// crosses; 'report-only' releases the report text only; 'selected-files'
// releases ONLY the files the user explicitly ticked, re-clipped to budget.
// The extension — never a model — decides what is allowed to cross.

import { buildGroundingReport, type GroundingReport } from '../grounding/report-builder';
import { applyRedactions, scanForSecrets } from '../grounding/redaction';
import type { BridgeMessage, FileExcerpt } from '../bridge/message-schema';

export type EgressMode = 'none' | 'report-only' | 'selected-files';
export type EgressDecision =
  | { kind: 'approved'; mode: 'report-only' | 'selected-files'; selectedFiles?: string[] }
  | { kind: 'denied' };

export interface EgressManifestData {
  debateId: string;
  targetProviders: string[];
  fileCount: number;
  approxLines: number;
  paths: string[];
}

export interface GateOutcome {
  /** What to send as CONTEXT_REPORT (null = send nothing further). */
  report: BridgeMessage | null;
  /** What to send as REDACTION_FOUND (null = no matches / already decided). */
  redaction: BridgeMessage | null;
  /** Whether the gate consumed the debate slot (release it when false). */
  consumed: boolean;
  note?: string;
}

interface PendingGate {
  debateId: string;
  report: GroundingReport;
  targetProviders: string[];
}

/** One pending gate at a time (max 1 concurrent debate). */
let pending: PendingGate | null = null;

export function hasPendingGate(): boolean {
  return pending !== null;
}

export function cancelPendingGate(): void {
  pending = null;
}

export interface RequestContext {
  debateId: string;
  round: number;
  workspaceHint?: string;
  targetProviders?: string[];
}

/**
 * Handles a CONTEXT_REQUEST end-to-end on the VS Code side: builds the report,
 * runs the redaction scan, and returns the exact message(s) to put on the wire
 * (manifest + optional REDACTION_FOUND) while holding the report itself until
 * the user's decision crosses back over the bridge.
 */
export async function openGate(
  request: RequestContext,
  workspaceRoot: string,
  options: { ollamaUrl?: string; ollamaModel?: string } = {},
): Promise<{ manifest: BridgeMessage; redaction: BridgeMessage | null }> {
  const report = await buildGroundingReport(workspaceRoot, {
    ollamaUrl: options.ollamaUrl,
    ollamaModel: options.ollamaModel,
  });

  const scan = scanForSecrets(report.reportText, 'grounding-report');

  pending = { debateId: request.debateId, report, targetProviders: request.targetProviders ?? [] };

  const manifest: BridgeMessage = {
    type: 'EGRESS_MANIFEST',
    debateId: request.debateId,
    targetProviders: pending.targetProviders,
    fileCount: report.files.length,
    approxLines: report.approxLines,
    paths: report.selectedPaths,
  };

  const redaction: BridgeMessage | null =
    scan.matches.length > 0
      ? { type: 'REDACTION_FOUND', debateId: request.debateId, matches: scan.matches }
      : null;

  // Keep the labels for the redact-and-continue path.
  redactionLabels = scan.labels;
  return { manifest, redaction };
}

let redactionLabels: Map<string, string> | null = null;

/**
 * Applies the user's egress decision (arriving as EGRESS_APPROVED /
 * EGRESS_DENIED / REDACTION_DECISION) and produces the outgoing CONTEXT_REPORT,
 * if any. The decision comes from the HUMAN via the Chrome UI — never from
 * model output.
 */
export function applyDecision(decision: EgressDecision): GateOutcome {
  const current = pending;
  if (current === null) {
    return { report: null, redaction: null, consumed: false, note: 'no pending context request' };
  }

  if (decision.kind === 'denied') {
    pending = null;
    return { report: null, redaction: null, consumed: false, note: 'user denied egress' };
  }

  if (decision.kind === 'approved' && decision.mode === 'report-only') {
    let text = current.report.reportText;
    if (redactionLabels !== null) {
      text = applyRedactions(text, 'grounding-report', redactionLabels);
    }
    const files: FileExcerpt[] = [{ path: '(grounding report)', lines: text }];
    const approxLines = text.split('\n').length;
    pending = null;
    redactionLabels = null;
    return {
      report: {
        type: 'CONTEXT_REPORT',
        debateId: current.debateId,
        files,
        approxLines,
        truncated: current.report.truncated,
      },
      redaction: null,
      consumed: true,
    };
  }

  // selected-files: release ONLY the files the user explicitly ticked.
  const selected = new Set(decision.kind === 'approved' ? (decision.selectedFiles ?? []) : []);
  if (decision.kind === 'approved' && selected.size === 0) {
    pending = null;
    return { report: null, redaction: null, consumed: false, note: 'selected-files mode with empty selection' };
  }
  const files: FileExcerpt[] = current.report.files.filter((f) => selected.has(f.path));
  if (decision.kind === 'approved' && files.length === 0) {
    pending = null;
    return { report: null, redaction: null, consumed: false, note: 'no selected files matched the report' };
  }
  const outgoingFiles: FileExcerpt[] = redactionLabels !== null
    ? files.map((f) => ({
        path: f.path,
        lines: applyRedactions(f.lines, f.path, redactionLabels),
        ...(f.truncatedAt !== undefined ? { truncatedAt: f.truncatedAt } : {}),
      }))
    : files;
  const text = outgoingFiles
    .map((f) => `--- ${f.path} ---\n${f.lines}`)
    .join('\n\n');
  const approxLines = text.split('\n').length;
  const truncated = files.length < current.report.files.length || current.report.truncated;
  pending = null;
  redactionLabels = null;
  return {
    report: {
      type: 'CONTEXT_REPORT',
      debateId: current.debateId,
      files: outgoingFiles,
      approxLines,
      truncated,
    },
    redaction: null,
    consumed: true,
  };
}

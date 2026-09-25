// Silknet — bounded grounding report builder (v1.0).
//
// Given a workspace root, produces a bounded, human-and-model-readable report:
// relevant file excerpts, a structure summary, and key symbols/constraints —
// NOT a raw dump of entire files. The context budget from the brief is
// enforced exactly; overflow is marked with explicit, visible truncation
// markers rather than silently cut or silently exceeded.
//
// The Ollama call is best-effort: when no model is available the report
// degrades to the deterministic structure summary and still ships. Model output
// is untrusted DATA folded into the report's prose — it never selects files,
// never changes the budget, and is never interpreted as an instruction.

import path from 'node:path';
import {
  CONTEXT_BUDGET,
  readExcerpt,
  resolveRootRealPath,
  scanWorkspace,
} from './file-read-pipeline';
import { generate, hasModel, probeOllama } from './ollama-client';
import type { FileExcerpt } from '../bridge/message-schema';

export interface ReportOptions {
  ollamaUrl?: string;
  ollamaModel?: string;
  /** Ask the model for a narrative summary (best-effort). Default true. */
  useModelSummary?: boolean;
}

export interface GroundingReport {
  /** The full report text as injected into Round 0. */
  reportText: string;
  /** Per-file excerpts carried by CONTEXT_REPORT. */
  files: FileExcerpt[];
  /** Paths of the files behind this report (for the egress manifest). */
  selectedPaths: string[];
  approxLines: number;
  truncated: boolean;
  /** Deterministic + model structure summary. */
  structureSummary: string;
  /** Files the scan found but the budget excluded. */
  omittedFiles: string[];
  /** Human-readable note when the model summary was skipped. */
  modelNote?: string;
}

/** Ranks scanned files by how much grounding value they likely carry. */
function rankFiles(relPaths: string[]): string[] {
  const score = (relPath: string): number => {
    let s = 0;
    const base = path.posix.basename(relPath).toLowerCase();
    if (base === 'readme.md') s += 40;
    else if (base === 'package.json') s += 30;
    else if (base.startsWith('readme')) s += 25;
    const depth = relPath.split('/').length;
    s += Math.max(0, 12 - depth * 2);
    if (relPath.startsWith('src/')) s += 10;
    if (/\.(ts|tsx|js|mjs)$/.test(relPath)) s += 6;
    if (relPath.includes('test') || relPath.includes('spec')) s -= 8;
    return s;
  };
  return [...relPaths].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

/** Deterministic key-symbol extraction (no model involvement). */
export function extractKeySymbols(lines: string[]): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^export\s+class\s+([A-Za-z_$][\w$]*)/,
    /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^export\s+interface\s+([A-Za-z_$][\w$]*)/,
    /^export\s+type\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
    /^\s*class\s+([A-Za-z_][\w]*)/,
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match?.[1] && !seen.has(match[1])) {
        seen.add(match[1]);
        symbols.push(match[1]);
      }
    }
  }
  return symbols;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

/** Clips a text block to a max character budget on a line boundary. */
function clipToChars(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  return { text: lastNewline > 0 ? cut.slice(0, lastNewline) : cut, clipped: true };
}

// ---------------------------------------------------------------------------

export async function buildGroundingReport(
  workspaceRoot: string,
  options: ReportOptions = {},
): Promise<GroundingReport> {
  const rootRealPath = resolveRootRealPath(workspaceRoot);
  const workspaceName = path.basename(rootRealPath);

  const scan = await scanWorkspace(rootRealPath);
  const ranked = rankFiles(scan.files.map((f) => f.relPath));

  // ---- select files within budget -----------------------------------------
  const chosen: Array<{ relPath: string; lines: string[]; truncatedAt?: number }> = [];
  const omitted: string[] = [];
  let totalLines = 0;

  for (const relPath of ranked) {
    if (chosen.length >= CONTEXT_BUDGET.maxFiles) {
      omitted.push(relPath);
      continue;
    }
    const remainingLines = CONTEXT_BUDGET.maxTotalLines - totalLines;
    if (remainingLines <= 0) {
      omitted.push(relPath);
      continue;
    }
    const read = await readExcerpt(rootRealPath, relPath, Math.min(CONTEXT_BUDGET.maxLinesPerFile, remainingLines));
    if (!read.ok || read.lines === undefined || read.path === undefined) {
      continue; // unreadable/unsafe: skip silently from the digest
    }
    chosen.push({ relPath: read.path, lines: read.lines, truncatedAt: read.truncatedAt });
    totalLines += read.lines.length;
  }

  const truncated = omitted.length > 0 || scan.incomplete;

  // ---- excerpts as FileExcerpt, honoring the global char budget ------------
  const files: FileExcerpt[] = [];
  let charsUsed = workspaceName.length + 256; // rough allowance for headers
  for (const entry of chosen) {
    const excerptText = entry.lines.join('\n');
    const remainingChars = CONTEXT_BUDGET.maxTotalChars - charsUsed;
    if (remainingChars <= 200) {
      omitted.push(entry.relPath);
      continue;
    }
    const clipped = clipToChars(excerptText, Math.min(remainingChars, CONTEXT_BUDGET.maxTotalChars));
    const lines = clipped.text.length === excerptText.length ? entry.lines : clipped.text.split('\n');
    const truncatedAt =
      clipped.clipped || entry.truncatedAt !== undefined ? (entry.truncatedAt ?? lines.length) : undefined;
    files.push({ path: entry.relPath, lines: clipped.text, ...(truncatedAt !== undefined ? { truncatedAt } : {}) });
    charsUsed += clipped.text.length + entry.relPath.length + 32;
  }

  const finalPaths = files.map((f) => f.path);
  const reallyOmitted = omitted.filter((p) => !finalPaths.includes(p));

  // ---- deterministic structure summary --------------------------------------
  const symbolLines: string[] = [];
  for (const file of files) {
    const symbols = extractKeySymbols(file.lines.split('\n'));
    if (symbols.length > 0) {
      symbolLines.push(`- ${file.path}: ${symbols.slice(0, 8).join(', ')}`);
    }
  }

  // ---- best-effort model narrative ------------------------------------------
  let modelNote: string | undefined;
  let modelSummary = '';
  const useModel = options.useModelSummary !== false;
  if (useModel && options.ollamaUrl !== undefined && options.ollamaModel !== undefined) {
    const status = await probeOllama(options.ollamaUrl);
    if (!status.ready) {
      modelNote = `Ollama unavailable — deterministic summary only (${status.reason ?? 'not ready'})`;
    } else if (!hasModel(status, options.ollamaModel)) {
      modelNote = `Ollama model "${options.ollamaModel}" not installed — deterministic summary only (have: ${status.models.slice(0, 5).join(', ') || 'none'})`;
    } else {
      const prompt = [
        `You are summarizing a software project for engineers. Below are excerpts from the workspace "${workspaceName}".`,
        `In at most 120 words, describe: what the project appears to be, its main components, and any constraints visible in the code.`,
        `Do not invent files, symbols, or features that are not visible in the excerpts. Plain text only.`,
        ``,
        ...files.map((f) => `--- ${f.path} ---\n${f.lines}`),
      ].join('\n');
      const result = await generate(options.ollamaUrl, { model: options.ollamaModel, prompt });
      if (result.ok) {
        modelSummary = result.text.trim();
      } else {
        modelNote = `Ollama generation failed — deterministic summary only (${result.reason ?? 'unknown error'})`;
      }
    }
  } else if (useModel) {
    modelNote = 'Ollama not configured — deterministic summary only';
  }

  // ---- assemble the report ----------------------------------------------------
  const sections: string[] = [];
  sections.push(`# Local Grounding Report — ${workspaceName}`);
  sections.push(`Generated: ${new Date().toISOString()} | Files shown: ${files.length}${truncated ? ' | TRUNCATED' : ''}`);
  if (modelSummary) {
    sections.push(`## Overview\n${modelSummary}`);
  }
  sections.push(`## Structure & Key Symbols\n${symbolLines.length > 0 ? symbolLines.join('\n') : '(no exported symbols found in excerpts)'}`);
  for (const file of files) {
    const marker =
      file.truncatedAt !== undefined ? `\n… [truncated at line ${file.truncatedAt}]` : '';
    sections.push(`## File: ${file.path}\n\`\`\`\n${file.lines}${marker}\n\`\`\``);
  }
  if (reallyOmitted.length > 0) {
    sections.push(`[+${reallyOmitted.length} more files not shown, ask to include them: ${reallyOmitted.slice(0, 5).join(', ')}${reallyOmitted.length > 5 ? ', …' : ''}]`);
  }
  if (modelNote !== undefined) {
    sections.push(`(note: ${modelNote})`);
  }

  let reportText = sections.join('\n\n');
  if (reportText.length > CONTEXT_BUDGET.maxTotalChars) {
    const clipped = clipToChars(reportText, CONTEXT_BUDGET.maxTotalChars);
    reportText = `${clipped.text}\n… [report clipped to the ${CONTEXT_BUDGET.maxTotalChars} character budget]`;
  }

  return {
    reportText,
    files,
    selectedPaths: finalPaths,
    approxLines: countLines(reportText),
    truncated,
    structureSummary: modelSummary || symbolLines.join('\n'),
    omittedFiles: reallyOmitted,
    ...(modelNote !== undefined ? { modelNote } : {}),
  };
}

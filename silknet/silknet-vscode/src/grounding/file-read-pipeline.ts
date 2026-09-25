// Silknet — bounded, path-safe file read pipeline (read-only, v1.0).
//
// SECURITY RULES (from the brief):
//   - the local model gets READ access scoped strictly to the workspace root
//     (or the single explicitly designated primary folder for multi-root);
//   - every path is resolved (symlink-safe, fs.realpathSync) and verified
//     INSIDE the root's real path BEFORE opening anything — an arbitrary
//     absolute path from a prompt or from model output is never honored;
//   - size caps per file and per report, binary rejection, recursion depth cap;
//   - filename sanitization: any basename containing control characters
//     (U+0000–U+001F, U+007F, U+0080–U+009F) or path separators is rejected
//     before it can appear in a report or a prompt.
//
// This pipeline never writes, never deletes, never executes anything.

import { promises as fsp, realpathSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// v1.0 context budget (starting values from the brief; tune empirically later)
// ---------------------------------------------------------------------------

export const CONTEXT_BUDGET = {
  /** Files included per report. */
  maxFiles: 6,
  /** Lines per file excerpt. */
  maxLinesPerFile: 150,
  /** Total lines across the report. */
  maxTotalLines: 2_000,
  /** Total characters across the report. */
  maxTotalChars: 12_000,
  /** Max single-file size read. */
  maxFileBytes: 256 * 1024,
  /** Max total bytes read per report. */
  maxTotalBytes: 512 * 1024,
  /** Directory recursion depth limit. */
  maxDepth: 8,
} as const;

const BINARY_SNIFF_BYTES = 8_192;

/** Extension allowlist for ordinary text/source files worth excerpting. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.yml', '.yaml',
  '.toml', '.html', '.css', '.scss', '.vue', '.svelte', '.proto', '.graphql',
]);

/** Hard-deny regardless of workspace scope (mirrors the brief's denylist). */
const DENYLIST_BASENAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

const DENYLIST_SUFFIXES = ['.pem', '.key'];

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

// U+0000–U+001F, U+007F, U+0080–U+009F control ranges, plus path separators.
// (Written without \s so identifiers stay ASCII-clean; ranges are explicit.)
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u0080-\u009F]/;
const PATH_SEPARATOR = /[\\/]/;

/**
 * True when the basename is safe to include in a report or prompt: no control
 * characters, no path separators, not empty.
 */
export function isSafeBasename(basename: string): boolean {
  if (basename.length === 0) return false;
  if (CONTROL_CHARS.test(basename)) return false;
  if (PATH_SEPARATOR.test(basename)) return false;
  // Names that are only dots are path trickery, not files.
  return !/^\.+$/.test(basename);
}

/** Rejects a relative path whose any-segment basename fails sanitization. */
export function isSafeRelativePath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (path.isAbsolute(relPath)) return false;
  const segments = relPath.split(/[\\/]+/);
  return segments.every((seg) => seg === '.' || seg === '..' ? false : isSafeBasename(seg));
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** Resolves the workspace root to its REAL on-disk path (symlink-safe). */
export function resolveRootRealPath(root: string): string {
  return realpathSync(root);
}

export interface PathCheckResult {
  ok: boolean;
  /** The resolved real path, when the check passed. */
  realPath?: string;
  reason?: string;
}

/**
 * Resolves `relativePath` against `rootRealPath` with symlink resolution and
 * verifies the result is strictly INSIDE the root. This is the only door
 * through which a file is opened: model output and prompts never influence
 * which files are read except by naming paths that pass this check.
 */
export function checkPathInsideRoot(rootRealPath: string, relativePath: string): PathCheckResult {
  if (!isSafeRelativePath(relativePath)) {
    return { ok: false, reason: 'path rejected by filename sanitization' };
  }
  const joined = path.resolve(rootRealPath, relativePath);
  let real: string;
  try {
    real = realpathSync(joined);
  } catch {
    return { ok: false, reason: `path does not exist or cannot be resolved: ${relativePath}` };
  }
  const rootWithSep = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
  if (!real.startsWith(rootWithSep)) {
    return { ok: false, reason: 'resolved path escapes the workspace root' };
  }
  return { ok: true, realPath: real };
}

/** True when a directory name should never be descended into. */
export function isDenylistedDirName(name: string): boolean {
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === '.vscode' ||
    name === '.idea' ||
    name === 'dist' ||
    name === 'build' ||
    name === '.next' ||
    name === '.cargo' ||
    name === '__pycache__' ||
    name === 'venv' ||
    name === '.venv'
  );
}

function isDenylistedFile(relPath: string): boolean {
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((seg) => seg === '.env' || seg.startsWith('.env.'))) return true;
  const basename = segments[segments.length - 1] ?? '';
  if (DENYLIST_BASENAMES.has(basename)) return true;
  if (DENYLIST_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true;
  return false;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / Math.max(1, sample.length) > 0.1;
}

// ---------------------------------------------------------------------------
// Workspace scan
// ---------------------------------------------------------------------------

export interface ScannedFile {
  /** Workspace-relative path (forward slashes). */
  relPath: string;
  sizeBytes: number;
}

export interface ScanResult {
  files: ScannedFile[];
  /** True when the scan hit the file budget before exhausting the tree. */
  incomplete: boolean;
}

/**
 * Walks the workspace root up to `maxFiles` candidates, honoring the denylist,
 * depth cap, and text-extension allowlist. Read-only: never follows symlinks
 * out of the root (realpath verification happens again at open time).
 */
export async function scanWorkspace(
  rootRealPath: string,
  maxFiles: number = 200,
): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  let incomplete = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > CONTEXT_BUDGET.maxDepth) return;
    if (files.length >= maxFiles) {
      incomplete = true;
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return; // unreadable directory: skip, never crash the report
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        incomplete = true;
        return;
      }
      if (!isSafeBasename(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (isDenylistedDirName(entry.name)) continue;
        if (entry.isFile()) continue; // dotfiles are rarely wanted in a digest
      }
      if (entry.isDirectory()) {
        if (isDenylistedDirName(entry.name)) continue;
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // ignore sockets/fifos/etc.
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootRealPath, abs).split(path.sep).join('/');
      if (isDenylistedFile(rel)) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > CONTEXT_BUDGET.maxFileBytes) continue;
      files.push({ relPath: rel, sizeBytes: stat.size });
    }
  };

  await walk(rootRealPath, 0);
  return { files, incomplete };
}

// ---------------------------------------------------------------------------
// Excerpting
// ---------------------------------------------------------------------------

export interface ReadFileResult {
  ok: boolean;
  /** Workspace-relative path as included in the report. */
  path?: string;
  lines?: string[];
  truncatedAt?: number;
  reason?: string;
}

/**
 * Reads up to `maxLines` lines from one file. The path is re-verified inside
 * the root immediately before opening (TOCTOU guard), mirroring the v1.1 write
 * pipeline's discipline even though this is a read.
 */
export async function readExcerpt(
  rootRealPath: string,
  relPath: string,
  maxLines: number = CONTEXT_BUDGET.maxLinesPerFile,
): Promise<ReadFileResult> {
  const check = checkPathInsideRoot(rootRealPath, relPath);
  if (!check.ok) return { ok: false, reason: check.reason };

  try {
    const handle = await fsp.open(check.realPath as string, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > CONTEXT_BUDGET.maxFileBytes) {
        return { ok: false, reason: `file exceeds the ${CONTEXT_BUDGET.maxFileBytes} byte cap` };
      }
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      if (looksBinary(buffer)) return { ok: false, reason: 'binary file rejected' };
      const text = buffer.toString('utf8');
      const allLines = text.split('\n');
      if (allLines.length > maxLines) {
        return {
          ok: true,
          path: relPath,
          lines: allLines.slice(0, maxLines),
          truncatedAt: maxLines,
        };
      }
      return { ok: true, path: relPath, lines: allLines };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return { ok: false, reason: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Silknet VS Code — grounding pipeline tests (Phase B0.2).
//
// Exercises the REAL file-read pipeline against a real temp workspace: path
// safety, sanitization, binary rejection, budget enforcement, report building.
//
// Run: npm test (from silknet-vscode)

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const buildDir = join(root, '.test-build-grounding');

let scratch;
let mod;
let ollamaMod;

before(async () => {
  const esbuild = (entry, outfile) =>
    `npx esbuild ${entry} --outfile=${JSON.stringify(outfile)} --bundle --format=esm --platform=node --target=node20 --packages=external --log-level=silent`;
  execSync(esbuild('src/grounding/file-read-pipeline.ts', join(buildDir, 'file-read-pipeline.js')), { cwd: root, stdio: 'pipe' });
  execSync(esbuild('src/grounding/report-builder.ts', join(buildDir, 'report-builder.js')), { cwd: root, stdio: 'pipe' });
  execSync(esbuild('src/grounding/ollama-client.ts', join(buildDir, 'ollama-client.js')), { cwd: root, stdio: 'pipe' });
  execSync(esbuild('src/egress/egress-gate.ts', join(buildDir, 'egress-gate.js')), { cwd: root, stdio: 'pipe' });
  mod = await import(pathToFileURL(join(buildDir, 'file-read-pipeline.js')).href);
  ollamaMod = await import(pathToFileURL(join(buildDir, 'ollama-client.js')).href);
});

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function makeWorkspace(files) {
  scratch = mkdtempSync(join(tmpdir(), 'silknet-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(scratch, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return scratch;
}

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

describe('filename sanitization', () => {
  it('accepts ordinary basenames', () => {
    assert.equal(mod.isSafeBasename('index.ts'), true);
    assert.equal(mod.isSafeBasename('my-file_v2.test.js'), true);
  });

  it('rejects control characters (U+0000–U+001F, U+007F, U+0080–U+009F)', () => {
    assert.equal(mod.isSafeBasename('bad\u0000name'), false);
    assert.equal(mod.isSafeBasename('bad\u001B[31mname'), false);
    assert.equal(mod.isSafeBasename('bad\u007Fname'), false);
    assert.equal(mod.isSafeBasename('bad\u0085name'), false);
    assert.equal(mod.isSafeBasename('bad\u009Fname'), false);
  });

  it('rejects path separators inside basenames', () => {
    assert.equal(mod.isSafeBasename('a/b'), false);
    assert.equal(mod.isSafeBasename('a\\b'), false);
  });

  it('rejects dot-trickery and empty names', () => {
    assert.equal(mod.isSafeBasename('..'), false);
    assert.equal(mod.isSafeBasename('.'), false);
    assert.equal(mod.isSafeBasename(''), false);
  });

  it('rejects absolute paths and traversals as relative paths', () => {
    assert.equal(mod.isSafeRelativePath('/etc/passwd'), false);
    assert.equal(mod.isSafeRelativePath('a/../../b'), false);
    assert.equal(mod.isSafeRelativePath('src/index.ts'), true);
  });
});

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

describe('path confinement', () => {
  it('resolves the root to its real path', () => {
    const ws = makeWorkspace({ 'a.txt': 'hi' });
    const real = mod.resolveRootRealPath(ws);
    assert.ok(real.length > 0);
  });

  it('accepts a file inside the root', () => {
    const ws = makeWorkspace({ 'src/a.ts': 'export const x = 1;' });
    const rootReal = mod.resolveRootRealPath(ws);
    const check = mod.checkPathInsideRoot(rootReal, 'src/a.ts');
    assert.equal(check.ok, true);
  });

  it('rejects traversal escaping the root', () => {
    const ws = makeWorkspace({ 'a.ts': 'x' });
    const rootReal = mod.resolveRootRealPath(ws);
    const outside = makeWorkspace({ 'secret.txt': 'top secret' });
    const rel = join('..', '..', '..', '..', '..');
    const check = mod.checkPathInsideRoot(rootReal, `${rel}/secret.txt`);
    assert.equal(check.ok, false);
    assert.match(String(check.reason), /sanitization|escapes|does not exist/);
  });

  it('rejects symlinked files pointing outside the root (realpath)', () => {
    const ws = makeWorkspace({ 'inside.ts': 'export const a = 1;' });
    const outside = makeWorkspace({ 'outside.ts': 'export const secret = true;' });
    const linkPath = join(ws, 'link.ts');
    try {
      symlinkSync(join(outside, 'outside.ts'), linkPath);
    } catch {
      // Windows without privileges: skip — the check is still exercised on CI.
      return;
    }
    const rootReal = mod.resolveRootRealPath(ws);
    const check = mod.checkPathInsideRoot(rootReal, 'link.ts');
    assert.equal(check.ok, false, 'symlink escaping the root must be refused');
    assert.match(String(check.reason), /escapes/);
  });
});

// ---------------------------------------------------------------------------
// Reading + budget
// ---------------------------------------------------------------------------

describe('reading and budgets', () => {
  it('reads an excerpt up to the line cap and marks truncation', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const ws = makeWorkspace({ 'big.ts': lines.join('\n') });
    const rootReal = mod.resolveRootRealPath(ws);
    const read = await mod.readExcerpt(rootReal, 'big.ts', 150);
    assert.equal(read.ok, true);
    assert.equal(read.lines.length, 150);
    assert.equal(read.truncatedAt, 150);
  });

  it('rejects binary content', async () => {
    const ws = makeWorkspace({});
    writeFileSync(join(ws, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03]));
    const rootReal = mod.resolveRootRealPath(ws);
    const read = await mod.readExcerpt(rootReal, 'blob.bin');
    assert.equal(read.ok, false);
    assert.match(String(read.reason), /binary/);
  });

  it('rejects files over the per-file byte cap', async () => {
    const ws = makeWorkspace({ 'huge.ts': 'x'.repeat(300 * 1024) });
    const rootReal = mod.resolveRootRealPath(ws);
    const read = await mod.readExcerpt(rootReal, 'huge.ts');
    assert.equal(read.ok, false);
    assert.match(String(read.reason), /cap/);
  });

  it('scanWorkspace honors the denylist and depth cap', async () => {
    const ws = makeWorkspace({
      'src/deep/a/b/c/d/e/f/g/deep.ts': 'export const deep = 1;',
      'node_modules/pkg/index.js': 'module.exports = 1;',
      '.env': 'SECRET=topsecretvalue123456',
      '.git/HEAD': 'ref: refs/heads/main',
      'readme.md': '# Project',
      'dist/out.js': 'var x=1;',
    });
    const rootReal = mod.resolveRootRealPath(ws);
    const scan = await mod.scanWorkspace(rootReal);
    const paths = scan.files.map((f) => f.relPath);
    assert.ok(paths.includes('readme.md'));
    assert.ok(!paths.some((p) => p.startsWith('node_modules')));
    assert.ok(!paths.includes('.env'));
    assert.ok(!paths.some((p) => p.startsWith('.git')));
    assert.ok(!paths.some((p) => p.startsWith('dist/')));
    // The deep path exceeds maxDepth=8: either absent or scan flagged incomplete.
    assert.ok(
      !paths.includes('src/deep/a/b/c/d/e/f/g/deep.ts') || scan.incomplete,
      'depth cap respected',
    );
  });
});

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

describe('report builder', () => {
  it('builds a bounded report with explicit truncation markers', async () => {
    const ws = makeWorkspace({
      'readme.md': '# Demo project\n\nDoes demo things.\n',
      'src/index.ts': `export function main(): void {\n  console.log('demo');\n}\n`,
      'src/util.ts': `export class Helper {\n  run(): string {\n    return 'ok';\n  }\n}\n`,
      'src/a.ts': `${Array.from({ length: 300 }, (_, i) => `// pad ${i}`).join('\n')}\n`,
      'src/b.ts': `${Array.from({ length: 300 }, (_, i) => `// pad ${i}`).join('\n')}\n`,
      'src/c.ts': `${Array.from({ length: 300 }, (_, i) => `// pad ${i}`).join('\n')}\n`,
      'src/d.ts': `${Array.from({ length: 300 }, (_, i) => `// pad ${i}`).join('\n')}\n`,
      'src/e.ts': `${Array.from({ length: 300 }, (_, i) => `// pad ${i}`).join('\n')}\n`,
      'src/f.ts': `${Array.from({ length: 300 }, (_, i) => `// pad ${i}`).join('\n')}\n`,
      'src/g.ts': `${Array.from({ length: 300 }, (_, i) => `// pad ${i}`).join('\n')}\n`,
    });
    const built = await import(pathToFileURL(join(buildDir, 'report-builder.js')).href);
    const result = await built.buildGroundingReport(ws, { useModelSummary: false });
    assert.ok(result.files.length >= 4 && result.files.length <= 6, `file count ${result.files.length} within 4-6`);
    assert.equal(result.truncated, true, 'overflow must be visible, not silent');
    assert.match(result.reportText, /more files not shown/);
    assert.ok(result.reportText.length <= 12_000 + 200, `char budget respected (${result.reportText.length})`);
    assert.ok(result.approxLines <= 2_000 + 50, `line budget respected (${result.approxLines})`);
    assert.deepEqual(result.selectedPaths, result.files.map((f) => f.path));
  });

  it('deterministic symbol extraction finds exported functions and classes', async () => {
    const lines = [
      'export function alpha() {}',
      'export class Beta {}',
      'export interface Gamma {}',
      'export type Delta = string;',
      'const hidden = 1;',
    ];
    const built = await import(pathToFileURL(join(buildDir, 'report-builder.js')).href);
    const symbols = built.extractKeySymbols(lines);
    assert.ok(symbols.includes('alpha'));
    assert.ok(symbols.includes('Beta'));
    assert.ok(symbols.includes('Gamma'));
    assert.ok(symbols.includes('Delta'));
    assert.ok(!symbols.includes('hidden'));
  });
});

// ---------------------------------------------------------------------------
// Ollama client (offline: probe against a dead port)
// ---------------------------------------------------------------------------

describe('ollama client', () => {
  it('reports not-ready against a closed port', async () => {
    const status = await ollamaMod.probeOllama('http://127.0.0.1:9', async () => {
      throw new Error('connection refused');
    });
    assert.equal(status.ready, false);
    assert.match(String(status.reason), /no Ollama server|connection refused/);
  });

  it('parses a healthy /api/tags response', async () => {
    const status = await ollamaMod.probeOllama('http://127.0.0.1:11434', async () => {
      return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), { status: 200 });
    });
    assert.equal(status.ready, true);
    assert.deepEqual(status.models, ['llama3.2:latest']);
    assert.equal(ollamaMod.hasModel(status, 'llama3.2'), true);
  });
});

// Silknet build — Phase v0.1.
//
// esbuild bundles TS entry points; static assets (manifest, selectors, mocks,
// test-console HTML/CSS) are copied verbatim into dist/ so dist/ is directly
// loadable unpacked via chrome://extensions -> Load unpacked.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, watchDirectories } from './scripts/fs-utils.mjs';

const watch = process.argv.includes('--watch');

mkdirSync('dist');

/**
 * TS entry points.
 *
 * `sourcemap: false` on the probe is deliberate: it is the one script injected
 * into every matching page load by the manifest, so its size is a cost paid on
 * ordinary browsing rather than only during a run. The heavier adapter keeps an
 * inline map because it is injected on demand, into bound tabs only.
 */
const bundles = [
  // Service worker: ESM module worker.
  {
    entry: 'src/background/service-worker.ts',
    outdir: 'dist/background',
    format: 'esm',
    sourcemap: 'inline',
  },
  // Phase-1 probe: always injected, must stay tiny.
  {
    entry: 'src/content-scripts/probe-chatgpt.ts',
    outdir: 'dist/content-scripts',
    format: 'iife',
    sourcemap: false,
  },
  // Phase-2 adapter: dynamically injected into bound tabs only.
  {
    entry: 'src/content-scripts/adapter-chatgpt.ts',
    outdir: 'dist/content-scripts',
    format: 'iife',
    sourcemap: 'inline',
  },
  // Phase-1 probe for Claude: always injected on claude.ai, must stay tiny.
  {
    entry: 'src/content-scripts/probe-claude.ts',
    outdir: 'dist/content-scripts',
    format: 'iife',
    sourcemap: false,
  },
  // Phase-2 adapter for Claude: dynamically injected into bound Claude tabs only.
  {
    entry: 'src/content-scripts/adapter-claude.ts',
    outdir: 'dist/content-scripts',
    format: 'iife',
    sourcemap: 'inline',
  },
  // Phase-1 probe for Gemini: always injected on gemini.google.com, must stay tiny.
  {
    entry: 'src/content-scripts/probe-gemini.ts',
    outdir: 'dist/content-scripts',
    format: 'iife',
    sourcemap: false,
  },
  // Phase-2 adapter for Gemini: dynamically injected into bound Gemini tabs only.
  {
    entry: 'src/content-scripts/adapter-gemini.ts',
    outdir: 'dist/content-scripts',
    format: 'iife',
    sourcemap: 'inline',
  },
  // Dev-only test console.
  {
    entry: 'src/test-console/test-console.ts',
    outdir: 'dist/test-console',
    format: 'esm',
    sourcemap: 'inline',
  },
];

/** Static assets copied verbatim into the loadable extension root. */
const assets = [
  ['manifest.json', 'dist/manifest.json'],
  ['src/selectors', 'dist/selectors'],
  ['mocks', 'dist/mocks'],
  ['src/test-console/test-console.html', 'dist/test-console/test-console.html'],
  ['src/test-console/test-console.css', 'dist/test-console/test-console.css'],
];

async function build({ entry, outdir, format, sourcemap }, quiet = false) {
  const outfile = `${outdir}/${entry.split('/').pop().replace(/\.ts$/, '.js')}`;
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format,
    target: ['chrome116'],
    sourcemap,
    logLevel: quiet ? 'silent' : 'info',
    // Selector JSON is bundled into whatever imports it (service worker, tests).
    loader: { '.json': 'json' },
  });
}

async function buildAll(quiet = false) {
  for (const bundle of bundles) {
    await build(bundle, quiet);
  }
  for (const [src, dest] of assets) {
    cpSync(src, dest);
  }
}

await buildAll();
console.log('Build complete → dist/');

if (watch) {
  watchDirectories(['src', 'mocks'], async () => {
    await buildAll(true);
    console.log('Rebuilt → dist/');
  });
}

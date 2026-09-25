// Silknet VS Code extension build.
//
// esbuild bundles the single extension entry point for the VS Code extension
// host. 'vscode' is provided at runtime by the host and must stay external;
// everything else (including 'ws') is bundled so dist/extension.js is
// self-contained.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node20'],
  external: ['vscode'],
  sourcemap: 'inline',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching…');
} else {
  await esbuild.build(options);
  console.log('Build complete → dist/extension.js');
}

import { cpSync as nodeCpSync, existsSync, mkdirSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const abs = (p) => join(root, p);

export function cpSync(src, dest) {
  const srcAbs = abs(src);
  const destAbs = abs(dest);
  if (!existsSync(srcAbs)) {
    console.warn(`[build] skip missing: ${src}`);
    return;
  }
  nodeCpSync(srcAbs, destAbs, { recursive: true });
}

export function mkdirSyncSafe(p) {
  mkdirSync(abs(p), { recursive: true });
}

export { mkdirSyncSafe as mkdirSync };

export function watchDirectories(dirs, onChange) {
  let debounce = null;
  for (const dir of dirs) {
    watch(abs(dir), { recursive: true }, (_event, filename) => {
      if (!filename || String(filename).endsWith('~')) return;
      clearTimeout(debounce);
      debounce = setTimeout(onChange, 120);
    });
  }
  console.log(`[build] watching ${dirs.join(', ')} for changes...`);
}

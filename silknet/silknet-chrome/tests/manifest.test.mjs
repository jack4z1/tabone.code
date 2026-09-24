// Silknet — manifest / build integrity tests.
//
// The manifest is where this extension's security posture is actually enforced,
// and each of those decisions is the kind that silently rots during a refactor
// (someone widens a match pattern, adds a permission, or re-exports a resource).
// These assertions pin them down. They also guard the two-phase loading promise:
// the always-injected probe must stay tiny.
//
// Requires dist/ to exist — `npm test` runs the build first via pretest.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

let manifest;

before(() => {
  assert.ok(
    existsSync(join(dist, 'manifest.json')),
    'dist/manifest.json is missing — run `npm run build` (npm test does this via pretest)',
  );
  manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
});

const providerOrigins = ['https://chatgpt.com', 'https://claude.ai', 'https://gemini.google.com'];

test('is a Manifest V3 extension', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.version, 'string');
  assert.ok(Number(manifest.minimum_chrome_version) >= 116, 'Chrome 116+ is required for the planned MAIN-world path');
});

test('permissions are minimal and contain no credential/debug access', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'scripting', 'sidePanel', 'storage', 'tabs']);
  for (const forbidden of ['debugger', 'cookies', 'webRequest', 'management', 'downloads', 'nativeMessaging']) {
    assert.ok(!manifest.permissions.includes(forbidden), `permission "${forbidden}" must never be requested`);
  }
});

test('host permissions are exact provider origins, never <all_urls>', () => {
  assert.deepEqual(manifest.host_permissions, providerOrigins.map((o) => `${o}/*`));
  for (const pattern of manifest.host_permissions) {
    assert.ok(!pattern.includes('<all_urls>'), 'no <all_urls> host permission');
    assert.ok(!pattern.includes('file://'), 'no file:// host permission');
    // A wildcard in the host position would let a lookalike domain be treated as
    // a legitimate provider tab.
    assert.match(pattern, /^https:\/\/[a-z0-9.-]+\/\*$/);
  }
});

test('content script matches are exact provider origins only', () => {
  for (const entry of manifest.content_scripts) {
    for (const match of entry.matches) {
      assert.ok(!match.includes('<all_urls>'), 'content scripts must not match <all_urls>');
      assert.ok(!match.includes('file://'), 'content scripts must not be declared for file:// URLs');
      const bare = match.replace(/\/\*$/, '');
      assert.ok(
        providerOrigins.includes(bare),
        `content script match "${match}" is not an exact declared provider origin`,
      );
    }
    // The passive probe only: the heavy adapter is injected on demand, into bound
    // tabs, by the service worker.
    assert.equal(entry.all_frames, false, 'provider content scripts are top-frame only');
    assert.ok(
      entry.js.every((js) => !js.includes('adapter-')),
      'the manifest must not permanently inject the heavy adapter',
    );
  }
});

test('CSP on extension pages forbids inline and remote script', () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes('unsafe-inline'), 'inline script must not be allowed');
  assert.ok(!csp.includes('unsafe-eval'), 'eval must not be allowed');
  assert.ok(!/https?:\/\//.test(csp), 'no remote script origins');
  assert.match(csp, /object-src 'self'/);
});

test('no web_accessible_resources leak internal assets to pages', () => {
  const war = manifest.web_accessible_resources ?? [];
  assert.deepEqual(war, [], 'nothing needs to be exposed to page contexts');
});

test('the toolbar action has no popup, so the worker owns the click', () => {
  assert.ok(manifest.action, 'an action is required to open the side panel');
  assert.equal(manifest.action.default_popup, undefined);
});

test('every manifest-referenced file exists in dist/', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.side_panel?.default_path,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...manifest.content_scripts.flatMap((entry) => entry.css ?? []),
  ].filter(Boolean);
  for (const rel of referenced) {
    assert.ok(existsSync(join(dist, rel)), `manifest references missing file dist/${rel}`);
  }

  const assets = [
    'selectors/chatgpt.json',
    'selectors/claude.json',
    'selectors/gemini.json',
    'mocks/mock-chatgpt.html',
    'mocks/mock-chatgpt.js',
    'mocks/mock-claude.html',
    'mocks/mock-claude.js',
    'test-console/test-console.html',
    'test-console/test-console.js',
    'sidepanel/sidepanel.html',
    'sidepanel/sidepanel.js',
  ];
  for (const rel of assets) {
    assert.ok(existsSync(join(dist, rel)), `expected asset missing: dist/${rel}`);
  }
});

test('the always-injected probe stays tiny and free of adapter machinery', () => {
  for (const provider of ['chatgpt', 'claude', 'gemini']) {
    const probePath = join(dist, `content-scripts/probe-${provider}.js`);
    const size = statSync(probePath).size;
    const source = readFileSync(probePath, 'utf8');

    // Two-phase loading exists so ordinary browsing pays essentially nothing. If
    // this grows, someone has imported the validator set or the adapter into it.
    assert.ok(size < 8000, `probe-${provider}.js is ${size} bytes; the passive probe must stay small`);
    assert.ok(!source.includes('MutationObserver'), 'the probe must not carry observer/detection logic');
    assert.ok(!source.includes('execCommand'), 'the probe must not carry injection logic');
    assert.ok(source.includes('PROBE_HELLO'), 'the probe must still announce itself');
  }
});

test('the on-demand adapter bundle does contain the detection machinery', () => {
  for (const provider of ['chatgpt', 'claude', 'gemini']) {
    const adapter = readFileSync(join(dist, `content-scripts/adapter-${provider}.js`), 'utf8');
    assert.ok(adapter.includes('MutationObserver'), `${provider} adapter should own the stability observer`);
    assert.ok(adapter.includes('stop-control-absent'), `${provider} completion signals should be reported by name`);
  }
});

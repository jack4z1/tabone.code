// Silknet — Phase 1 passive probe (always injected, deliberately tiny).
//
// Two-phase loading, "probe first, inject later": this file is the only thing
// declared in the manifest's content_scripts, so ordinary browsing pays
// essentially nothing. Its whole job is to tell the service worker "a valid
// ChatGPT tab exists here, here is my probe result". The heavier adapter
// (observers, injection, detection) is injected by the worker only into the
// specific tabs bound to a run.
//
// It validates IDENTITY only — exact origin and top frame. DOM-structure
// validation belongs to the full adapter's probe(), which runs after injection,
// because doing it here would mean shipping the selector logic to every page
// load, which is exactly what two-phase loading exists to avoid.

// Type-only imports (erased at build time) plus the dependency-free NS constant:
// this script must stay tiny, because it runs on every page load.
import { NS } from './shared/constants';
import type { ProbeHelloMessage } from './shared/messaging';
import type { ProbeResult } from './shared/types';

const PROVIDER = 'chatgpt';
const ALLOWED_ORIGINS = ['https://chatgpt.com'];

const topFrame = window.top === window;
const originOk = ALLOWED_ORIGINS.includes(location.origin);

const probe: ProbeResult = originOk
  ? topFrame
    ? {
        recognized: true,
        reason: 'passive probe: origin + top frame ok; DOM structure checked after injection',
      }
    : { recognized: false, reason: 'not the top frame (iframe ignored by design)' }
  : { recognized: false, reason: `origin ${location.origin} is not a declared ${PROVIDER} origin` };

const g = globalThis as typeof globalThis & { __silknet_document_id?: string };
g.__silknet_document_id ??= crypto.randomUUID();

const hello: ProbeHelloMessage = {
  ns: NS,
  kind: 'PROBE_HELLO',
  provider: PROVIDER,
  probe,
  documentId: g.__silknet_document_id,
  href: location.href,
  origin: location.origin,
  topFrame,
};

// Best effort only: the service worker may not be listening yet, and a failed
// announcement must never break the page.
try {
  void chrome.runtime.sendMessage(hello).catch(() => undefined);
} catch {
  /* extension context invalidated */
}

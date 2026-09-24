// Silknet — Phase 1 passive probe for Gemini (always injected, deliberately tiny).
//
// Injected on gemini.google.com via manifest content_scripts.
// Reports IDENTITY to the service worker via PROBE_HELLO.

import { NS } from './shared/constants';
import type { ProbeHelloMessage } from './shared/messaging';
import type { ProbeResult } from './shared/types';

const PROVIDER = 'gemini';
const ALLOWED_ORIGINS = ['https://gemini.google.com'];

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

try {
  void chrome.runtime.sendMessage(hello).catch(() => undefined);
} catch {
  /* extension context invalidated */
}

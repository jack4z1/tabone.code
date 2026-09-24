// Silknet — selector config schema, validator, and resolver.
//
// Selectors are NEVER hardcoded in adapter logic. They arrive as a per-provider
// JSON document (selectors/<provider>.json), are validated against the schema
// below, and are resolved through this module at runtime. A changed UI therefore
// degrades into a red diagnostic dot with a reason string instead of a crash.
//
// Targeting is by ARIA role and accessible label wherever possible: CSS class
// names are obfuscated and regenerated on redesigns, while accessibility
// attributes are comparatively stable (and serve real screen-reader users, so
// they are less likely to be silently renamed).

export type SelectorKind = 'css' | 'aria-label' | 'role' | 'data-testid';

export interface SelectorSpec {
  by: SelectorKind;
  /** For `role` this is the role token (e.g. "textbox"); otherwise the
   *  attribute value to match exactly. */
  value: string;
  /** Only meaningful for `by: "role"`: the required accessible name. */
  name?: string;
}

export type SelectorKey =
  | 'composer'
  | 'sendButton'
  | 'stopButton'
  | 'assistantTurn'
  /** The turn's actual message text. A turn element also contains UI chrome
   *  (turn labels, Copy/Regenerate buttons), so reading the turn itself would
   *  splice that chrome into the reply. */
  | 'assistantMessageBody'
  | 'userTurn'
  | 'responseContainer'
  | 'replyActionControls';

export interface ProviderBehavior {
  inputType: 'textarea' | 'contenteditable';
  injectionMethod: 'native-setter' | 'execCommand';
  /** Response-stability window for completion detection (signal B). */
  stabilityMs: number;
  /** Per-provider watchdog budget (spec: roughly 2-3 minutes). */
  watchdogMs: number;
  assistantTurnMarkerAttribute: string;
  assistantTurnMarkerValue: string;
}

export interface ProviderSelectorConfig {
  provider: string;
  configVersion: number;
  match: { origins: string[]; topFrameOnly: boolean };
  selectors: Record<SelectorKey, SelectorSpec[]>;
  behavior: ProviderBehavior;
}

export type ConfigValidation =
  | { ok: true; config: ProviderSelectorConfig }
  | { ok: false; reason: string };

const SELECTOR_KEYS: readonly SelectorKey[] = [
  'composer',
  'sendButton',
  'stopButton',
  'assistantTurn',
  'assistantMessageBody',
  'userTurn',
  'responseContainer',
  'replyActionControls',
];

const SELECTOR_KINDS: readonly SelectorKind[] = ['css', 'aria-label', 'role', 'data-testid'];
const INPUT_TYPES = ['textarea', 'contenteditable'] as const;
const INJECTION_METHODS = ['native-setter', 'execCommand'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseSpec(raw: unknown, where: string): SelectorSpec | string {
  if (!isRecord(raw)) return `${where}: selector spec must be an object`;
  const by = raw['by'];
  const value = raw['value'];
  if (typeof by !== 'string' || !SELECTOR_KINDS.includes(by as SelectorKind)) {
    return `${where}: unknown selector kind ${JSON.stringify(by)}`;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return `${where}: selector spec needs a non-empty "value"`;
  }
  const name = raw['name'];
  if (name !== undefined && typeof name !== 'string') {
    return `${where}: "name" must be a string when present`;
  }
  if (by !== 'role' && name !== undefined) {
    return `${where}: "name" is only valid for by:"role"`;
  }
  const spec: SelectorSpec = { by: by as SelectorKind, value };
  if (typeof name === 'string') spec.name = name;
  return spec;
}

/**
 * Validates a raw parsed-JSON value against the selector-config schema.
 * Nothing reads a selector document without passing through here first.
 */
export function validateSelectorConfig(raw: unknown): ConfigValidation {
  if (!isRecord(raw)) return { ok: false, reason: 'selector config is not an object' };

  const provider = raw['provider'];
  const configVersion = raw['configVersion'];
  if (typeof provider !== 'string' || !provider) {
    return { ok: false, reason: 'selector config missing "provider"' };
  }
  if (typeof configVersion !== 'number' || !Number.isFinite(configVersion)) {
    return { ok: false, reason: 'selector config missing numeric "configVersion"' };
  }

  const match = raw['match'];
  if (!isRecord(match)) return { ok: false, reason: 'selector config missing "match"' };
  const origins = match['origins'];
  if (!Array.isArray(origins) || origins.length === 0 || !origins.every((o) => typeof o === 'string')) {
    return { ok: false, reason: '"match.origins" must be a non-empty array of strings' };
  }
  const topFrameOnly = match['topFrameOnly'];
  if (typeof topFrameOnly !== 'boolean') {
    return { ok: false, reason: '"match.topFrameOnly" must be a boolean' };
  }

  const selectorsRaw = raw['selectors'];
  if (!isRecord(selectorsRaw)) return { ok: false, reason: 'selector config missing "selectors"' };
  const selectors = {} as Record<SelectorKey, SelectorSpec[]>;
  for (const key of SELECTOR_KEYS) {
    const list = selectorsRaw[key];
    if (!Array.isArray(list) || list.length === 0) {
      return { ok: false, reason: `selectors.${key} must be a non-empty array` };
    }
    const specs: SelectorSpec[] = [];
    for (let i = 0; i < list.length; i++) {
      const parsed = parseSpec(list[i], `selectors.${key}[${i}]`);
      if (typeof parsed === 'string') return { ok: false, reason: parsed };
      specs.push(parsed);
    }
    selectors[key] = specs;
  }

  const behaviorRaw = raw['behavior'];
  if (!isRecord(behaviorRaw)) return { ok: false, reason: 'selector config missing "behavior"' };
  const inputType = behaviorRaw['inputType'];
  if (typeof inputType !== 'string' || !INPUT_TYPES.includes(inputType as ProviderBehavior['inputType'])) {
    return { ok: false, reason: 'behavior.inputType must be "textarea" or "contenteditable"' };
  }
  const injectionMethod = behaviorRaw['injectionMethod'];
  if (
    typeof injectionMethod !== 'string' ||
    !INJECTION_METHODS.includes(injectionMethod as ProviderBehavior['injectionMethod'])
  ) {
    return { ok: false, reason: 'behavior.injectionMethod must be "native-setter" or "execCommand"' };
  }
  const stabilityMs = behaviorRaw['stabilityMs'];
  if (typeof stabilityMs !== 'number' || !Number.isFinite(stabilityMs) || stabilityMs < 200) {
    return { ok: false, reason: 'behavior.stabilityMs must be a number >= 200' };
  }
  const watchdogMs = behaviorRaw['watchdogMs'];
  if (typeof watchdogMs !== 'number' || !Number.isFinite(watchdogMs) || watchdogMs < 1000) {
    return { ok: false, reason: 'behavior.watchdogMs must be a number >= 1000' };
  }
  const markerAttr = behaviorRaw['assistantTurnMarkerAttribute'];
  const markerVal = behaviorRaw['assistantTurnMarkerValue'];
  if (typeof markerAttr !== 'string' || !markerAttr) {
    return { ok: false, reason: 'behavior.assistantTurnMarkerAttribute must be a non-empty string' };
  }
  if (typeof markerVal !== 'string' || !markerVal) {
    return { ok: false, reason: 'behavior.assistantTurnMarkerValue must be a non-empty string' };
  }

  return {
    ok: true,
    config: {
      provider,
      configVersion,
      match: { origins: origins as string[], topFrameOnly },
      selectors,
      behavior: {
        inputType: inputType as ProviderBehavior['inputType'],
        injectionMethod: injectionMethod as ProviderBehavior['injectionMethod'],
        stabilityMs,
        watchdogMs,
        assistantTurnMarkerAttribute: markerAttr,
        assistantTurnMarkerValue: markerVal,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Accessible-name + resolution
// ---------------------------------------------------------------------------

/**
 * Best-effort accessible-name computation. Deliberately small: aria-label, then
 * aria-labelledby targets, then a placeholder fallback for composers. This is
 * enough to disambiguate "the composer" from other textboxes without pulling in
 * a full accname implementation.
 */
export function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      if (!id) continue;
      const ref = el.ownerDocument.getElementById(id);
      const text = ref?.textContent?.trim();
      if (text) parts.push(text);
    }
    if (parts.length) return parts.join(' ').trim();
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();

  return '';
}

function matchesSpec(el: Element, spec: SelectorSpec): boolean {
  switch (spec.by) {
    case 'css': {
      // For css specs the element has already been produced by the selector
      // engine; re-checking containment is the correctness guard.
      try {
        return el.matches(spec.value);
      } catch {
        return false;
      }
    }
    case 'aria-label':
      return el.getAttribute('aria-label') === spec.value;
    case 'data-testid':
      return el.getAttribute('data-testid') === spec.value;
    case 'role': {
      const role = el.getAttribute('role');
      if (role !== spec.value) return false;
      if (spec.name === undefined) return true;
      return accessibleName(el) === spec.name;
    }
  }
}

function candidateElements(spec: SelectorSpec, root: ParentNode): Element[] {
  let selector: string;
  switch (spec.by) {
    case 'css':
      selector = spec.value;
      break;
    case 'aria-label':
      selector = `[aria-label=${JSON.stringify(spec.value)}]`;
      break;
    case 'data-testid':
      selector = `[data-testid=${JSON.stringify(spec.value)}]`;
      break;
    case 'role':
      selector = `[role=${JSON.stringify(spec.value)}]`;
      break;
  }
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export interface Resolved<T extends Element> {
  el: T;
  spec: SelectorSpec;
}

/**
 * Resolves the first spec in the list that matches, in declaration order
 * (primary method first, fallbacks after). Always called fresh — callers must
 * never retain the returned element across time, because providers routinely
 * detach and recreate message nodes mid-stream.
 */
export function queryFirst<T extends Element = Element>(
  specs: readonly SelectorSpec[],
  root: ParentNode = document,
): Resolved<T> | null {
  for (const spec of specs) {
    for (const el of candidateElements(spec, root)) {
      if (matchesSpec(el, spec)) return { el: el as T, spec };
    }
  }
  return null;
}

export function queryAll<T extends Element = Element>(
  specs: readonly SelectorSpec[],
  root: ParentNode = document,
): T[] {
  for (const spec of specs) {
    const found = candidateElements(spec, root).filter((el) => matchesSpec(el, spec));
    if (found.length) return found as T[];
  }
  return [];
}

/**
 * True when an element is actually rendered.
 *
 * This matters more than it looks: providers commonly keep controls in the DOM
 * permanently and merely hide them. The mock models exactly that (the stop
 * control carries `hidden` at idle), and treating bare presence as "generating"
 * made every completion check report a phantom in-flight generation.
 */
export function isElementVisible(el: Element): boolean {
  if ((el as HTMLElement).hidden === true) return false;
  if (el.getAttribute('hidden') !== null) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;

  const inline = el.getAttribute('style');
  if (inline && /display\s*:\s*none/i.test(inline)) return false;
  if (inline && /visibility\s*:\s*hidden/i.test(inline)) return false;

  const view = el.ownerDocument.defaultView;
  if (view) {
    const computed = view.getComputedStyle(el);
    if (computed.display === 'none' || computed.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * Like queryFirst, but skips elements that are present in the DOM yet not
 * rendered. Use for controls that a provider hides rather than removes.
 */
export function queryFirstVisible<T extends Element = Element>(
  specs: readonly SelectorSpec[],
  root: ParentNode = document,
): Resolved<T> | null {
  for (const spec of specs) {
    for (const el of candidateElements(spec, root)) {
      if (matchesSpec(el, spec) && isElementVisible(el)) return { el: el as T, spec };
    }
  }
  return null;
}

/** Human-readable description of a spec list, for ProbeResult.reason strings. */
export function describeSpecs(specs: readonly SelectorSpec[]): string {
  return specs
    .map((s) => (s.by === 'role' ? `role=${s.value}[name="${s.name ?? ''}"]` : `${s.by}=${s.value}`))
    .join(' | ');
}

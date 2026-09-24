// Silknet — composer text injection.
//
// Each provider uses a fundamentally different editor technology and therefore
// needs its OWN primary injection method. One shared technique does NOT work for
// both, so this module dispatches on the provider's declared
// `behavior.injectionMethod` rather than pretending a single approach suffices.

import type { ProviderBehavior } from './selectors';

export type InjectionOutcome =
  | { ok: true; readBack: string }
  | { ok: false; reason: string };

/**
 * Reads the composer's current text as inert text.
 * Used to confirm injection actually landed (and, from Phase v0.5, as the
 * comparison side of tamper detection).
 */
export function readComposerText(el: Element): string {
  if (isTextAreaLike(el) || isInputLike(el)) return el.value;
  // contenteditable / ProseMirror: textContent, never innerHTML.
  return el.textContent ?? '';
}

// NOTE ON REALMS: these checks use tagName rather than `instanceof`. The adapter
// also runs against an iframe document in the conformance harness, and an element
// from another realm fails `instanceof HTMLTextAreaElement` even though it is one
// — which would silently route composer reads down the contenteditable path and
// return '' instead of the real value.
function isTextAreaLike(el: Element): el is HTMLTextAreaElement {
  return el.tagName === 'TEXTAREA';
}

function isInputLike(el: Element): el is HTMLInputElement {
  return el.tagName === 'INPUT';
}

function isEditable(el: Element): boolean {
  return isTextAreaLike(el) || isInputLike(el) || el.tagName === 'DIV' || el.tagName === 'P';
}

function isDisabledLike(el: Element): boolean {
  return ('disabled' in el && (el as HTMLInputElement).disabled) || el.getAttribute('aria-disabled') === 'true';
}

export { isDisabledLike, isTextAreaLike, isInputLike };

/**
 * PRIMARY method for React-based <textarea>/<input> composers (ChatGPT).
 *
 * A raw `element.value = text` assignment is invisible to React: React installs
 * its own value tracker on the prototype, and only a setter called through the
 * native prototype descriptor followed by a real `input` event makes the
 * framework's state update. Hence the native-setter dance below.
 */
export function injectTextNativeSetter(element: Element, text: string): void {
  const isTextArea = isTextAreaLike(element);
  const isInput = isInputLike(element);
  if (!isTextArea && !isInput) {
    throw new Error('injectTextNativeSetter: element is neither <textarea> nor <input>');
  }

  element.focus();

  // Dispatch into the element's OWN realm: an element inside an iframe must have
  // events created by that iframe's constructors.
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error('injectTextNativeSetter: element has no owner window');

  element.dispatchEvent(
    new view.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }),
  );

  const proto = isTextArea ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const nativeSetter = descriptor?.set;
  if (!nativeSetter) {
    throw new Error('injectTextNativeSetter: native value setter unavailable');
  }
  // NB: must be the prototype's own setter. A direct `element.value = text`
  // assignment goes through React's installed instance tracker and is invisible
  // to the framework's state update, so the composer would appear filled while
  // React still believes it is empty.
  nativeSetter.call(element, text);

  element.dispatchEvent(new view.Event('input', { bubbles: true }));
  element.dispatchEvent(new view.Event('change', { bubbles: true }));
}

export function injectTextExecCommand(element: Element, text: string): void {
  (element as HTMLElement).focus?.();
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error('injectTextExecCommand: element has no owner window');
  
  if (typeof element.ownerDocument.execCommand === 'function') {
    const success = element.ownerDocument.execCommand('insertText', false, text);
    if (success) return;
  }
  // Ultimate fallback (e.g. environments without full execCommand support)
  element.textContent = text;
  element.dispatchEvent(new view.Event('input', { bubbles: true }));
}

/**
 * Injects text using the provider's declared primary method, then reads the
 * composer back so the caller can confirm the text actually landed.
 */
export function injectComposerText(
  element: Element,
  text: string,
  behavior: Pick<ProviderBehavior, 'injectionMethod' | 'inputType'>,
): InjectionOutcome {
  if (!isEditable(element)) {
    return { ok: false, reason: 'composer element is not an editable HTMLElement' };
  }
  try {
    if (isTextAreaLike(element) || isInputLike(element)) {
      injectTextNativeSetter(element, text);
    } else {
      injectTextExecCommand(element, text);
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'injection threw' };
  }

  const readBack = readComposerText(element);
  if (readBack !== text) {
    return {
      ok: false,
      reason: `injection read-back mismatch (expected ${text.length} chars, composer holds ${readBack.length})`,
    };
  }
  // Success: `lastInjectedText` is what tamper detection (Phase v0.5) compares
  // against at send time, so an exact match here is the precondition for that
  // guarantee to hold.
  return { ok: true, readBack };
}

/**
 * Reads a message node's text WITHOUT touching the live DOM.
 *
 * A cloneNode(true) is used so reading a reply cannot accidentally trigger event
 * listeners attached to the original element, and `textContent` (never
 * `innerHTML`) is used so page-sourced content is treated as inert text.
 *
 * Block-level elements (p, div, li, headings, br, pre) get a newline prepended
 * in the clone so that `textContent` preserves the paragraph structure that
 * `innerText` would have given us on a live (attached) node. Without this,
 * `<p>First</p><p>Second</p>` reads as "FirstSecond" instead of
 * "First\nSecond".
 */
const BLOCK_SELECTOR = 'p, br, div, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr';

export function extractInertText(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  const doc = node.ownerDocument;
  for (const block of clone.querySelectorAll(BLOCK_SELECTOR)) {
    block.parentNode?.insertBefore(doc.createTextNode('\n'), block);
  }
  return (clone.textContent ?? '').replace(/^\n+/, '').trim();
}

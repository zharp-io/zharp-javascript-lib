// A browser for the replay fixtures: jsdom's window, document and DOM classes as globals.
import { JSDOM } from 'jsdom';

export function installDom(url) {
  const dom = new JSDOM('<!doctype html><html><body><p>replay</p></body></html>', { url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'zharp-test' } });
  // rrweb reaches for DOM classes (Element, Node, MutationObserver …) as globals.
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (!(name in globalThis) && /^[A-Z]/.test(name)) globalThis[name] = dom.window[name];
  }
  return dom;
}

// A jsdom page for the @zharp/browser fixtures: DOM globals, a Chrome user agent, and a
// stand-in fetch that answers the application's requests itself and passes the SDK's own
// requests (to ZHARP_TEST_ENDPOINT) through to the fake backend.
import { JSDOM } from 'jsdom';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const endpoint = process.env.ZHARP_TEST_ENDPOINT;

export function installPage(url = 'http://localhost:5173/start', { storage } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><button id="go">Save changes</button></body></html>', { url, pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window.navigator, 'userAgent', { value: UA });
  if (storage) for (const [k, v] of Object.entries(storage)) window.sessionStorage.setItem(k, v);
  for (const name of ['window', 'document', 'location', 'history', 'sessionStorage', 'localStorage', 'navigator']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
  }
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!(name in globalThis) && /^[A-Z]/.test(name)) globalThis[name] = window[name];
  }
  // The application's requests: answered here, with the headers they carried recorded.
  const appRequests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(endpoint)) return realFetch(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    appRequests.push({ url, traceparent: headers.get('traceparent'), baggage: headers.get('baggage') });
    return new Response(url.includes('/fail') ? 'no' : '{}', { status: url.includes('/fail') ? 500 : 200 });
  };
  return { dom, window, appRequests };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const result = (value) => console.log(`RESULT ${JSON.stringify(value)}`);

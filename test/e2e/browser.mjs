// The browser half of the end-to-end run: @zharp/browser in jsdom, calling the instrumented
// Node server. Prints `RESULT {…}` with what it sent, for run.mjs to look up in ClickHouse.
import { gunzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';

const [, , api] = process.argv;
const run = process.env.ZHARP_E2E_RUN;
const endpoint = process.env.ZHARP_E2E_ENDPOINT;

// ── a page ────────────────────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><head></head><body><h1>Checkout</h1><button id="pay" class="btn primary">Pay now</button><input name="card" value="4242"></body></html>', {
  url: 'http://localhost:5173/checkout',
  pretendToBeVisual: true,
});
const { window } = dom;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
Object.defineProperty(window.navigator, 'userAgent', { value: UA });
for (const name of ['window', 'document', 'location', 'history', 'sessionStorage', 'localStorage', 'navigator']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
// rrweb and the SDK reach for DOM classes as globals; Node's own fetch, Blob and Response stay.
for (const name of Object.getOwnPropertyNames(window)) {
  if (!(name in globalThis) && /^[A-Z]/.test(name)) globalThis[name] = window[name];
}

// ── what reaches Zharp, seen from the page's side ─────────────────────────────
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const response = await realFetch(url, init);
  if (String(url).startsWith(endpoint)) {
    const headers = init.headers ?? {};
    let text = typeof init.body === 'string' ? init.body : '';
    if (init.body instanceof ArrayBuffer) text = gunzipSync(Buffer.from(init.body)).toString('utf8');
    sent.push({
      path: String(url).slice(endpoint.length),
      status: response.status,
      gzip: headers['Content-Encoding'] === 'gzip',
      auth: (headers.Authorization ?? '').replace(/zpk_\w+/, 'zpk_…'),
      keepalive: !!init.keepalive,
      body: JSON.parse(text || '{}'),
      response: await response.clone().text(),
    });
  }
  return response;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the SDK, as the dashboard tells people to start it ───────────────────────
const { Zharp } = await import('@zharp/browser');
Zharp.init({
  key: process.env.ZHARP_E2E_BROWSER_KEY,
  service: 'checkout-web',
  environment: 'e2e',
  endpoint,
  release: 'web@e2e',
  tracingOrigins: [new URL(api).host],
  replay: { onErrorSampleRate: 1.0 },
});
Zharp.setUser({ id: `e2e-user-${run}`, email: `e2e-${run}@example.com` });
Zharp.setTag('e2e.run', run);
await wait(300);

// A click that leads to a request: an interaction span, a fetch span, the server's spans.
const button = document.getElementById('pay');
let checkout;
button.addEventListener('click', () => {
  checkout = fetch(`${api}/api/checkout`).then((r) => r.json());
});
button.click();
const checkoutBody = await checkout;

Zharp.log.info(`browser log ${run}`, { step: 'after checkout' });
Zharp.log.warn(`browser warning ${run}`);

// An SPA navigation, then an XHR that fails on the server.
history.pushState({}, '', '/orders');
await new Promise((resolve) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `${api}/api/fail`);
  xhr.addEventListener('loadend', resolve);
  xhr.send();
});

Zharp.captureError(new Error(`handled browser error ${run}`), { where: 'e2e' });
// Uncaught: what a throw in an event handler looks like to window.onerror.
const uncaught = new TypeError(`Cannot read properties of undefined (reading 'total') ${run}`);
window.dispatchEvent(new window.ErrorEvent('error', { error: uncaught, message: uncaught.message }));

// Let the idle spans end and the recorder load and upload the buffer.
await wait(2_500);
await Zharp.flush();
await wait(500);
await Zharp.flush();

const spans = sent
  .filter((s) => s.path === '/v1/traces')
  .flatMap((s) => s.body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((x) => x.spans)));
const fetchSpan = spans.find((s) => s.name === 'GET /api/checkout');
const xhrSpan = spans.find((s) => s.name === 'GET /api/fail');
const result = {
  sessionId: Zharp.sessionId,
  checkoutBody,
  spans: spans.map((s) => ({ name: s.name, kind: s.kind, traceId: s.traceId, spanId: s.spanId, parent: s.parentSpanId ?? '' })),
  checkoutTrace: fetchSpan?.traceId,
  failTrace: xhrSpan?.traceId,
  requests: sent.map(({ path, status, gzip, auth, keepalive, response, body }) => ({
    path,
    status,
    gzip,
    auth,
    keepalive,
    response: response.slice(0, 120),
    ...(path === '/v1/replays' ? { sequence: body.sequence, events: body.events.length, hasError: body.hasError, traceIds: body.traceIds.length } : {}),
  })),
};
console.log(`RESULT ${JSON.stringify(result)}`);
await Zharp.close();
process.exit(0);

// @zharp/browser with tracing: false — logs, errors and the session, and nothing else.
import { installPage, endpoint, wait, result } from './page.mjs';

const { window, appRequests } = installPage('http://localhost:5173/start');
const xhrHeaders = [];
const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  xhrHeaders.push([name.toLowerCase(), value]);
  return setRequestHeader.call(this, name, value);
};
const fetchBefore = globalThis.fetch;

const { Zharp } = await import('@zharp/browser');
Zharp.init({ key: 'browser-logs-only', service: 'web-test', endpoint, tracing: false, tracingOrigins: ['api.allowed.test'] });
Zharp.setUser({ id: 'user 2' });
Zharp.setTag('plan', 'pro');
const fetchPatched = globalThis.fetch !== fetchBefore;

document.getElementById('go').addEventListener('click', () => fetch('/api/same-origin'));
document.getElementById('go').click();
await fetch('https://api.allowed.test/v1/orders');
await new Promise((resolve) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/xhr');
  xhr.addEventListener('loadend', resolve);
  xhr.send();
});
history.pushState({}, '', '/next');

Zharp.log.info('logs only hello', { orderId: 8 });
Zharp.captureError(new RangeError('captured without tracing'));
window.dispatchEvent(new window.ErrorEvent('error', { error: new TypeError('uncaught without tracing'), message: 'uncaught without tracing' }));
const spanResult = Zharp.startSpan('manual work', (span) => {
  Zharp.log.debug('inside manual, no span');
  return `ran:${typeof span.setAttribute}`;
});

await wait(1_800);
await Zharp.flush();
result({ fetchPatched, spanResult, sessionId: Zharp.sessionId, appRequests, xhrHeaders });
process.exit(0);

// Propagation, spans, logs, errors and sessions in @zharp/browser.
import { installPage, endpoint, wait, result } from './page.mjs';

const { window, appRequests } = installPage('http://localhost:5173/start', {
  storage: {
    'zharp.session': JSON.stringify({ id: 'stored-session', started: Date.now() - 1000, lastActive: Date.now() - 1000, user: { id: 'u-from-storage' } }),
  },
});
// XHR headers are write-only: spy on them below the SDK's patch.
const xhrHeaders = [];
const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  xhrHeaders.push([name.toLowerCase(), value]);
  return setRequestHeader.call(this, name, value);
};

const { Zharp } = await import('@zharp/browser');
Zharp.init({ key: 'browser-key', service: 'web-test', environment: 'test', release: 'web@1', endpoint, tracingOrigins: ['api.allowed.test'] });
const resumedSession = Zharp.sessionId;
const resumedUser = JSON.parse(sessionStorage.getItem('zharp.session')).user?.id;
Zharp.setUser({ id: 'user 1', email: 'u1@example.com' });

document.getElementById('go').addEventListener('click', () => {
  fetch('/api/same-origin');
});
document.getElementById('go').click();
await fetch('https://api.allowed.test/v1/orders?x=1', { headers: { baggage: 'caller=1' } });
await fetch('https://third-party.test/pixel');
await fetch('/api/fail');
await new Promise((resolve) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/xhr');
  xhr.addEventListener('loadend', resolve);
  xhr.send();
});

Zharp.log.info('hello', { orderId: 7 });
const err = new RangeError('captured once');
Zharp.captureError(err);
Zharp.captureError(err); // the same error again: not sent twice
window.dispatchEvent(new window.ErrorEvent('error', { error: new TypeError('uncaught one'), message: 'uncaught one' }));
const rejection = new window.Event('unhandledrejection');
rejection.reason = 'a string reason';
window.dispatchEvent(rejection);
history.pushState({}, '', '/next');
Zharp.startSpan('manual work', () => Zharp.log.debug('inside manual'));

await wait(1_800);
await Zharp.flush();
const beforeClear = Zharp.sessionId;
Zharp.clearUser();
result({ resumedSession, resumedUser, beforeClear, afterClear: Zharp.sessionId, appRequests, xhrHeaders });
process.exit(0);

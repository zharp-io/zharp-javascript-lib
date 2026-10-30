// @zharp/browser with an injected bundle on the page: errors from it carry its debug ID.
// The bundles run as a browser would load them from their URLs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installPage, endpoint, wait, result } from '../unified/page.mjs';

const { window } = installPage('http://localhost:5173/');
const { Zharp } = await import('@zharp/browser');
Zharp.init({ key: 'debug-ids-browser', service: 'web-test', endpoint, tracing: false });

const dir = process.env.BUNDLE_DIR;
vm.runInThisContext(readFileSync(`${dir}/app.js`, 'utf8'), { filename: 'http://localhost:5173/assets/app.js' });
// Both bundles are IIFEs assigning the global `App`: keep the first one's.
const App = globalThis.App;
vm.runInThisContext(readFileSync(`${dir}/other.js`, 'utf8'), { filename: 'https://cdn.example.com/other.js' });

const fail = () => {
  try {
    App.checkout();
  } catch (error) {
    return error;
  }
};
const captured = fail();
Zharp.captureError(captured);
Zharp.log.error('checkout failed', { error: fail() });
window.dispatchEvent(new window.ErrorEvent('error', { error: fail(), message: 'uncaught' }));
Zharp.captureError(new Error('not from a bundle'));

await wait(200);
await Zharp.flush();
result({ stack: captured.stack, registered: Object.values(globalThis.__zharpDebugIds ?? {}) });

// The test app's main process: Zharp started first, two ordinary windows (sandboxed, isolated,
// strict CSP, no preload of their own), and one that can crash its renderer with process.crash().
const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { Zharp } = require('@zharp/electron/main');

const port = process.env.STANDIN_PORT || '8787';
if (process.env.TEST_USER_DATA) app.setPath('userData', process.env.TEST_USER_DATA);

Zharp.init({
  key: 'zpk_electron_test',
  endpoint: `http://127.0.0.1:${port}/api/v1/otlp`,
  renderer: { tracingOrigins: ['127.0.0.1'] },
  debug: !!process.env.ZHARP_DEBUG,
});
Zharp.setUser({ id: 'user-7', email: 'ana@example.com' });

globalThis.test = {
  zharp: Zharp,
  mainError() {
    Zharp.captureError(new Error('main handled boom'));
  },
  mainThrow() {
    setTimeout(() => {
      throw new TypeError('main uncaught boom');
    });
  },
  mainCrash() {
    setTimeout(() => process.crash(), 50);
  },
  crashWindow() {
    const w = new BrowserWindow({ title: 'crasher', webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    return w.loadFile(join(__dirname, 'crash.html'));
  },
};

app.whenReady().then(async () => {
  for (const n of [1, 2]) {
    const w = new BrowserWindow({ width: 600, height: 400, title: `window ${n}`, webPreferences: { sandbox: true, contextIsolation: true } });
    await w.loadFile(join(__dirname, 'index.html'), { query: { w: String(n), port } });
  }
});
app.on('window-all-closed', () => app.quit());

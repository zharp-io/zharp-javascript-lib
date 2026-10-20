// Just enough of a browser to drive the unload path: window, document, and a sendBeacon that
// records what it was given and refuses its second call, as a browser over its quota would.
const beacons = [];
let calls = 0;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'zharp-test',
    sendBeacon(url, blob) {
      calls += 1;
      const accepted = calls !== 2;
      beacons.push({ url, size: blob.size, accepted, text: blob.text() });
      return accepted;
    },
  },
});
const win = new EventTarget();
win.location = { href: 'http://localhost/page', pathname: '/page' };
win.screen = { width: 1280, height: 720 };
win.onerror = null;
globalThis.window = win;
globalThis.document = { visibilityState: 'hidden' };

// Imported after the globals exist: the SDK decides "browser or Node" when it loads.
const { ZharpLogger } = await import('@zharp/logs');

ZharpLogger.init({
  apiKey: 'test-key-beacon',
  service: 'browser-app',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  flushInterval: 60_000,
  autoCapture: { errors: false, unhandledRejections: false },
});

// ~200 KB queued: more than three beacons' worth.
const blob = 'y'.repeat(5_000);
for (let i = 0; i < 40; i++) ZharpLogger.info(`unload-${i}`, { blob });

win.dispatchEvent(new Event('visibilitychange'));
// Let the keepalive fallback reach the server.
await new Promise((resolve) => setTimeout(resolve, 500));

const report = [];
for (const beacon of beacons) {
  const body = JSON.parse(await beacon.text);
  report.push({ url: beacon.url, size: beacon.size, accepted: beacon.accepted, messages: body.logs.map((l) => l.message), keys: Object.keys(body), environment: body.logs[0].environment ?? null });
}
console.log(`RESULT ${JSON.stringify({ beacons: report })}`);
process.exit(0);

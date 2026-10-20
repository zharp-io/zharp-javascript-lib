// The replay recorder under jsdom, against a backend that fails on purpose (see run.mjs):
// sequence 0 fails once, sequence 1 always fails, everything else succeeds.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><p>replay</p></body></html>', { url: 'http://localhost/replay' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'zharp-test' } });
// rrweb reaches for DOM classes (Element, Node, MutationObserver …) as globals.
for (const name of Object.getOwnPropertyNames(dom.window)) {
  if (!(name in globalThis) && /^[A-Z]/.test(name)) globalThis[name] = dom.window[name];
}

const { ZharpReplay } = await import('../../dist/replay.mjs');

ZharpReplay.start({
  apiKey: 'replay-flaky',
  service: 'replay-app',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  flushInterval: 3_600_000,
});

let t = Date.now();
const event = (i) => ({ type: 3, data: { source: 0, i }, timestamp: t++ });
// `buffer` is private in TypeScript only; feeding it directly keeps the test independent of
// what rrweb manages to observe in jsdom.
const feed = (...ids) => ZharpReplay.buffer.push(...ids.map(event));

feed(1, 2);
const first = ZharpReplay.flush(); // cuts sequence 0, which fails
feed(3);
const second = ZharpReplay.flush(); // started while the first is running: must wait
await Promise.all([first, second]); // second: retries 0 (ok), cuts and sends 1 (fails)
await ZharpReplay.flush(); // 1 fails again
feed(4);
await ZharpReplay.flush(); // 1 fails a third time and is dropped; 2 is cut and sent
await ZharpReplay.stop();

console.log(`RESULT ${JSON.stringify({ recording: ZharpReplay.isRecording })}`);
process.exit(0);

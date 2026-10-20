// The replay recorder under jsdom, against a backend that fails on purpose (see run.mjs):
// sequence 0 fails once, sequence 1 always fails, everything else succeeds.
import { installDom } from './jsdom-globals.mjs';

installDom('http://localhost/replay');

const { ZharpAPM } = await import('@zharp/apm');

ZharpAPM.init({
  apiKey: 'replay-flaky',
  service: 'replay-app',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  fetch: false,
  breadcrumbs: false,
  replay: { flushInterval: 3_600_000 },
});
await ZharpAPM.startReplay(); // joins the start init() began

// `replay`, `buffer` and `flush` are private in TypeScript only; feeding the buffer directly
// keeps the test independent of what rrweb manages to observe in jsdom.
const recorder = ZharpAPM.replay;
let t = Date.now();
const event = (i) => ({ type: 3, data: { source: 0, i }, timestamp: t++ });
const feed = (...ids) => recorder.buffer.push(...ids.map(event));

feed(1, 2);
const first = recorder.flush(); // cuts sequence 0, which fails
feed(3);
const second = recorder.flush(); // started while the first is running: must wait
await Promise.all([first, second]); // second: retries 0 (ok), cuts and sends 1 (fails)
await recorder.flush(); // 1 fails again
feed(4);
await recorder.flush(); // 1 fails a third time and is dropped; 2 is cut and sent
await ZharpAPM.stopReplay();

console.log(`RESULT ${JSON.stringify({ recording: ZharpAPM.isReplaying })}`);
process.exit(0);

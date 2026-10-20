// rrweb is not loaded until replay starts — and never, for a session that is sampled out.
import { registerHooks } from 'node:module';
import { installDom } from './jsdom-globals.mjs';

// Every module resolved from here on, by specifier. Covers both import() and require().
const resolved = [];
registerHooks({
  resolve(specifier, context, next) {
    resolved.push(specifier);
    return next(specifier, context);
  },
});
const rrwebLoaded = () => resolved.some((s) => s === 'rrweb' || s.startsWith('rrweb/'));

installDom('http://localhost/lazy');
const mode = process.argv[2];
// Decides sampling: 0.1 is inside a 50% sample, 0.9 is outside it.
Math.random = () => (mode === 'sampled-out' ? 0.9 : 0.1);

const { ZharpAPM } = await import('@zharp/apm');
const base = {
  apiKey: 'replay-lazy',
  service: 'lazy-app',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  fetch: false,
  breadcrumbs: false,
};

ZharpAPM.init(base);
await new Promise((resolve) => setTimeout(resolve, 50));
const afterPlainInit = rrwebLoaded();

ZharpAPM.init({ ...base, replay: { sampleRate: 0.5, flushInterval: 3_600_000 } });
const recording = await ZharpAPM.startReplay(); // joins the start init() began
const afterReplayInit = rrwebLoaded();
const isReplaying = ZharpAPM.isReplaying;

await ZharpAPM.destroy();
console.log(`RESULT ${JSON.stringify({ afterPlainInit, afterReplayInit, recording, isReplaying })}`);
process.exit(0);

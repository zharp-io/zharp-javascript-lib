// Replay modes: off (rrweb never loaded), buffer (nothing until an error), session (everything).
import { registerHooks } from 'node:module';
import { installPage, endpoint, wait, result } from './page.mjs';

const resolved = [];
registerHooks({
  resolve(specifier, context, next) {
    resolved.push(specifier);
    return next(specifier, context);
  },
});
const rrwebLoaded = () => resolved.some((s) => s === 'rrweb' || s.startsWith('rrweb/'));

const mode = process.argv[2];
installPage(`http://localhost:5173/${mode}`);
const { Zharp } = await import('@zharp/browser');
const replay = { off: undefined, buffer: { onErrorSampleRate: 1 }, session: { sampleRate: 1 } }[mode];
Zharp.init({ key: `replay-${mode}`, service: 'web-replay', endpoint, replay });
await wait(400);
const loadedAtStart = rrwebLoaded();
document.body.appendChild(document.createElement('p')).textContent = 'before the error';
await wait(100);
await Zharp.flush();
const decided = JSON.parse(sessionStorage.getItem('zharp.session')).replay;
if (mode === 'buffer') Zharp.captureError(new Error('trigger'));
await wait(300);
document.body.appendChild(document.createElement('p')).textContent = 'after the error';
await wait(100);
await Zharp.flush();
document.body.appendChild(document.createElement('p')).textContent = 'later still';
await wait(100);
await Zharp.flush();
const stored = JSON.parse(sessionStorage.getItem('zharp.session'));
result({ loadedAtStart, sessionId: Zharp.sessionId, decided, modeAfter: stored.replay, seq: stored.seq });
process.exit(0);

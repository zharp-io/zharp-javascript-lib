// `node --import @zharp/apm/init app.js` — start tracing from the environment before the
// application loads, so `http` is patched before anything imports it. See README.md.
import { ZharpAPM } from './dist/index.mjs';

ZharpAPM.init();

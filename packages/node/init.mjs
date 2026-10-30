// `node --import @zharp/node/init app.js` — start from the environment (ZHARP_API_KEY,
// ZHARP_SERVICE, ZHARP_ENV, ZHARP_RELEASE, ZHARP_ENDPOINT) before the application loads.
import { Zharp } from './dist/index.mjs';

Zharp.init();

// `node --import @zharp/logs/init app.js` — start logging from the environment before the
// application loads. See README.md, "Starting without code changes".
import { ZharpLogger } from './dist/index.mjs';

ZharpLogger.init();

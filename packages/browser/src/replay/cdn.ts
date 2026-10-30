// The recorder for the script-tag build, as its own file (zharp-replay.min.js): zharp.min.js
// adds it to the page only when a session records.
import { createRecorder } from './recorder';

(globalThis as any).__ZHARP_REPLAY__ = { createRecorder };

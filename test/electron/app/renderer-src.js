// Bundled to dist/renderer.js with esbuild (run.mjs), with debug IDs injected like a release build.
import { Zharp } from '@zharp/electron/renderer';

Zharp.init();

const params = new URLSearchParams(location.search);
window.test = {
  zharp: Zharp,
  sessionId: () => Zharp.sessionId,
  throwLater(message) {
    setTimeout(() => {
      throw new RangeError(message);
    });
  },
  async failedFetch() {
    try {
      await fetch(`http://127.0.0.1:${params.get('port')}/api/app/fail`);
    } catch {}
  },
  flush: () => Zharp.flush(),
};

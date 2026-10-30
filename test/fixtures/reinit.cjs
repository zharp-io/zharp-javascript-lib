// init() twice: the second replaces the first — no refusal, no doubled handlers, and what the
// first had queued still goes out under the first key.
const { ZharpLogger } = require('@zharp/logs');
const endpoint = process.env.ZHARP_TEST_ENDPOINT;

const listeners = () => ({
  uncaught: process.listeners('uncaughtException').length,
  rejection: process.listeners('unhandledRejection').length,
  beforeExit: process.listeners('beforeExit').length,
});
const initial = listeners();

ZharpLogger.init({ apiKey: 'reinit-a', service: 'reinit-a', endpoint, flushInterval: 60_000 });
const afterFirst = listeners();
ZharpLogger.info('reinit before');

ZharpLogger.init({ apiKey: 'reinit-b', service: 'reinit-b', endpoint, flushInterval: 60_000 });
const afterSecond = listeners();
ZharpLogger.info('reinit after');

ZharpLogger.destroy()
  // The first setup's queue is sent in the background; give it a moment to land.
  .then(() => new Promise((resolve) => setTimeout(resolve, 300)))
  .then(() => {
    console.log(`RESULT ${JSON.stringify({ initial, afterFirst, afterSecond, final: listeners() })}`);
  });

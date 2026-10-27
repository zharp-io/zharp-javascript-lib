// A key the backend rejects (see run.mjs): argv[2] is the key. The wait before trying again is
// shortened by ZHARP_TEST_KEY_RETRY_MS.
const { ZharpLogger } = require('@zharp/logs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  ZharpLogger.init({ apiKey: process.argv[2], service: 'key-app', endpoint: process.env.ZHARP_TEST_ENDPOINT });
  ZharpLogger.info('first');
  await ZharpLogger.flush(); // rejected: one warning, then nothing is sent
  ZharpLogger.info('while-backed-off');
  await ZharpLogger.flush(); // dropped without a request
  await wait(Number(process.env.ZHARP_TEST_KEY_RETRY_MS) + 50);
  ZharpLogger.info('after-wait');
  await ZharpLogger.flush(); // the one try after the wait
  ZharpLogger.info('last');
  await ZharpLogger.destroy();
  console.log(`RESULT ${JSON.stringify({ ok: true })}`);
})();

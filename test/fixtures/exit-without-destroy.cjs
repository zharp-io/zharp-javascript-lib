// A short script that logs and never calls destroy(): it must still exit, with its logs sent.
const { ZharpLogger } = require('../../dist/index.js');

ZharpLogger.init({
  apiKey: 'test-key-exit',
  service: 'one-shot-script',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  flushInterval: 60_000,
  autoCapture: { errors: false, unhandledRejections: false },
});
for (let i = 0; i < 3; i++) ZharpLogger.info(`exit-check ${i}`);
console.log('RESULT {}');

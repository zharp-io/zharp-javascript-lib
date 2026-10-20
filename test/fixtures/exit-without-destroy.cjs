// A short script that logs and never calls destroy(): it must still exit, with its logs and
// spans sent.
const { ZharpLogger } = require('@zharp/logs');
const { ZharpAPM } = require('@zharp/apm');

ZharpLogger.init({
  apiKey: 'test-key-exit',
  service: 'one-shot-script',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  flushInterval: 60_000,
  autoCapture: { errors: false, unhandledRejections: false },
});
ZharpAPM.init({ flushInterval: 60_000 });
for (let i = 0; i < 3; i++) ZharpLogger.info(`exit-check ${i}`);
ZharpAPM.startActiveSpan('exit-span', () => ZharpLogger.info('exit-check in span'));
console.log('RESULT {}');

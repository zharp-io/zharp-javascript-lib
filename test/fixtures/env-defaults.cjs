// init() without service, environment or appVersion: whatever the environment variables give.
const { ZharpLogger } = require('@zharp/logs');

ZharpLogger.init({
  apiKey: 'test-key-env',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  autoCapture: { errors: false, unhandledRejections: false },
});
ZharpLogger.info(`env-check ${process.argv[2]}`);
ZharpLogger.destroy().then(() => console.log('RESULT {}'));

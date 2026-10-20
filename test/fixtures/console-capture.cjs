// captureConsole: argv[2] is "all" | "list" | "env" | "off". The key is per scenario.
const { ZharpLogger } = require('@zharp/logs');

const mode = process.argv[2];
const options = { apiKey: `test-key-console-${mode}`, service: 'console-app', endpoint: process.env.ZHARP_TEST_ENDPOINT, flushInterval: 60_000 };
if (mode === 'all') Object.assign(options, { captureConsole: 'all', autoCapture: { consoleErrors: true } });
if (mode === 'list') options.captureConsole = ['warn', 'error'];
if (mode === 'env') delete options.apiKey; // ZHARP_API_KEY and ZHARP_CAPTURE_CONSOLE come from the environment

ZharpLogger.init(options);
console.log('plain line', { a: 1 });
console.info('info line');
console.warn('careful');
console.error(new TypeError('bad thing'), 'while saving');
console.debug('debug line');
ZharpLogger.destroy().then(() => {
  console.log('after destroy');
  return ZharpLogger.flush();
}).then(() => console.log('RESULT {}'));

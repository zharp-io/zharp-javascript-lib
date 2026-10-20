// An app that crashes. argv[2]: "throw" | "reject" | "own-handler"; the key is per scenario.
const { ZharpLogger } = require('@zharp/logs');

const mode = process.argv[2];
ZharpLogger.init({
  apiKey: `test-key-crash-${mode}`,
  service: 'crashing-app',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  flushInterval: 60_000,
});
if (mode === 'own-handler') {
  // The app decides: it logs the error itself and keeps running a little, then exits cleanly.
  process.on('uncaughtException', () => {
    setTimeout(() => { console.log('RESULT {"survived":true}'); process.exit(0); }, 200);
  });
}
ZharpLogger.info('before the crash');
setTimeout(() => {
  if (mode === 'reject') Promise.reject(new Error(`boom (${mode})`));
  else throw new Error(`boom (${mode})`);
}, 10);
// Without the crash fix the process would stay alive on this timer.
setTimeout(() => { console.log('RESULT {"survived":true}'); }, 5_000);

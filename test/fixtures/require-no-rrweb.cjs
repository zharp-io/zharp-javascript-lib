// Requiring both CommonJS builds, and starting APM without replay, must not load rrweb.
const { ZharpLogger } = require('@zharp/logs');
const { ZharpAPM } = require('@zharp/apm');

ZharpLogger.init({ apiKey: 'cjs-lazy', service: 'cjs-lazy', endpoint: process.env.ZHARP_TEST_ENDPOINT });
ZharpAPM.init();
const loaded = Object.keys(require.cache).some((file) => /[\\/]rrweb[\\/]/.test(file));
Promise.all([ZharpAPM.destroy(), ZharpLogger.destroy()]).then(() => console.log(`RESULT ${JSON.stringify({ loaded })}`));

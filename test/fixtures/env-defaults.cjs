// init() without service, environment or appVersion: whatever the environment variables give.
// argv[2]: "vars" | "pkg" (the app has a package.json) | "bare" (it has none).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ZharpLogger } = require('@zharp/logs');

const mode = process.argv[2];
if (mode === 'pkg' || mode === 'bare') {
  // Pretend the app was started from its own directory, as `node app.js` would be.
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'zharp-app-'));
  if (mode === 'pkg') fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@acme/checkout-api' }));
  process.argv[1] = path.join(app, 'app.js');
  process.chdir(app);
}

ZharpLogger.init({
  apiKey: 'test-key-env',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  autoCapture: { errors: false, unhandledRejections: false },
});
ZharpLogger.info(`env-check ${mode}`);
ZharpLogger.destroy().then(() => console.log('RESULT {}'));

// A CommonJS application: requires the CJS builds, by package name.
const http = require('http');
const { ZharpLogger } = require('@zharp/logs');
const { ZharpAPM } = require('@zharp/apm');

import('./scenario.mjs').then(async ({ scenario }) => {
  const result = await scenario({ ZharpLogger, ZharpAPM, http, label: 'cjs' });
  console.log(`RESULT ${JSON.stringify(result)}`);
});

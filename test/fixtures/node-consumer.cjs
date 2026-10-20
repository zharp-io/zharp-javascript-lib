// A CommonJS application: requires the CJS build.
const http = require('http');
const { ZharpLogger } = require('../../dist/index.js');

import('./scenario.mjs').then(async ({ scenario }) => {
  const result = await scenario({ ZharpLogger, http, label: 'cjs' });
  console.log(`RESULT ${JSON.stringify(result)}`);
});

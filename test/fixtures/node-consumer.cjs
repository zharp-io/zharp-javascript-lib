// A CommonJS application: requires the CJS build, by package name.
const { ZharpLogger } = require('@zharp/logs');

import('./scenario.mjs').then(async ({ scenario }) => {
  const result = await scenario({ ZharpLogger, label: 'cjs' });
  console.log(`RESULT ${JSON.stringify(result)}`);
});

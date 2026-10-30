// A native ES-module application: imports the ESM build directly, no bundler, no require.
import { ZharpLogger } from '@zharp/logs';
import { scenario } from './scenario.mjs';

const result = await scenario({ ZharpLogger, label: 'esm' });
console.log(`RESULT ${JSON.stringify(result)}`);

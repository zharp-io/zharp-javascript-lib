// A native ES-module application: imports the ESM build directly, no bundler, no require.
import http, { get as namedGet } from 'node:http';
import { ZharpLogger } from '../../dist/index.mjs';
import { scenario } from './scenario.mjs';

// Wrapped so the live binding is read when the request is made, after init() patched it —
// passing `namedGet` itself would hand over the value it had before init().
const result = await scenario({ ZharpLogger, http, label: 'esm', namedGet: (...args) => namedGet(...args) });
console.log(`RESULT ${JSON.stringify(result)}`);

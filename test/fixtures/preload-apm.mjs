// The ES-module version: a named import of `get`, made after `--import @zharp/apm/init` patched it.
import { createServer, get } from 'node:http';
import { ZharpAPM } from '@zharp/apm';

const server = createServer((req, res) => res.end('ok'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await new Promise((resolve, reject) => {
  get({ hostname: '127.0.0.1', port: server.address().port, path: `/preloaded-${process.argv[2]}` }, (res) => {
    res.resume();
    res.on('end', resolve);
  }).on('error', reject);
});
server.close();
const active = ZharpAPM.isActive;
await ZharpAPM.destroy();
console.log(`RESULT ${JSON.stringify({ active })}`);

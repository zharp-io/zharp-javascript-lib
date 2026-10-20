// @zharp/apm without @zharp/logs: init() with argv[2] as options, or from the environment alone.
const http = require('http');
const { ZharpAPM } = require('@zharp/apm');

ZharpAPM.init(process.argv[2] ? JSON.parse(process.argv[2]) : undefined);

const server = http.createServer((req, res) => res.end('ok'));
server.listen(0, '127.0.0.1', () => {
  http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/alone' }, (res) => {
    res.resume();
    res.on('end', async () => {
      server.close();
      const active = ZharpAPM.isActive;
      await ZharpAPM.destroy();
      const logsLoaded = Object.keys(require.cache).some((file) => /[\\/]packages[\\/]logs[\\/]/.test(file));
      console.log(`RESULT ${JSON.stringify({ active, logsLoaded, handleLogs: !!globalThis.__ZHARP__?.logs })}`);
    });
  });
});

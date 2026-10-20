// An application started with `node --require @zharp/apm/init`: http was patched before this
// file loaded, so its server and client calls are traced without any code here.
const http = require('http');
const { ZharpAPM } = require('@zharp/apm');

const server = http.createServer((req, res) => res.end('ok'));
server.listen(0, '127.0.0.1', () => {
  http.get({ hostname: '127.0.0.1', port: server.address().port, path: `/preloaded-${process.argv[2]}` }, (res) => {
    res.resume();
    res.on('end', async () => {
      server.close();
      const active = ZharpAPM.isActive;
      await ZharpAPM.destroy();
      console.log(`RESULT ${JSON.stringify({ active })}`);
    });
  });
});

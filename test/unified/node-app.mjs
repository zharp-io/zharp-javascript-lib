// An instrumented http server, called with the headers @zharp/browser sends, and without.
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { Zharp } from '@zharp/node';

const server = http.createServer((req, res) => {
  if (req.url === '/me') {
    // A back end that knows the user itself.
    Zharp.setUser({ id: 'server-set-user' });
    Zharp.log.info('after setUser');
  } else {
    Zharp.log.info('from the browser', { cart: 3 });
    console.log('console in handler');
    Zharp.captureError(new TypeError('caught in handler'));
  }
  res.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// What a page running @zharp/browser sends — over a bare socket, because an instrumented client
// (fetch, http.request) would replace the traceparent with its own.
await new Promise((resolve) => {
  const socket = net.connect(server.address().port, '127.0.0.1', () => {
    socket.end(
      [
        'GET /checkout HTTP/1.1',
        'Host: localhost',
        'Connection: close',
        'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        'baggage: session.id=browser-session-1,enduser.id=user%201',
        '',
        '',
      ].join('\r\n'),
    );
  });
  socket.on('data', () => {});
  socket.on('close', resolve);
});
await fetch(`${base}/me`);
await Zharp.startSpan('job', async () => Zharp.log.warn('inside job'));

await Zharp.flush();
server.close();
const required = createRequire(import.meta.url)('@zharp/node').Zharp;
console.log(`RESULT ${JSON.stringify({ sameInstance: required === Zharp, active: Zharp.isActive })}`);
await Zharp.shutdown();

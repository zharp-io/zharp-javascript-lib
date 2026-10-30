// @zharp/node with ZHARP_TRACING=false: a server called with the browser's headers, which itself
// calls another server. Logs and errors go out; no spans, and nothing is propagated onward.
import http from 'node:http';
import net from 'node:net';
import { Zharp } from '@zharp/node';

// The downstream service: records what headers reached it.
const downstreamHeaders = [];
const downstream = http.createServer((req, res) => {
  downstreamHeaders.push({ traceparent: req.headers.traceparent ?? null, baggage: req.headers.baggage ?? null });
  res.end('ok');
});
await new Promise((resolve) => downstream.listen(0, '127.0.0.1', resolve));
const downstreamUrl = `http://127.0.0.1:${downstream.address().port}/`;

const get = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => res.resume().on('end', resolve)).on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  if (req.url === '/me') {
    Zharp.setUser({ id: 'logs-only-user' });
    Zharp.log.info('after setUser, logs only');
  } else {
    Zharp.log.info('logs only from the browser');
    console.log('logs only console');
    Zharp.captureError(new TypeError('logs only caught'));
  }
  await get(downstreamUrl);
  await fetch(downstreamUrl);
  res.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

await new Promise((resolve) => {
  const socket = net.connect(server.address().port, '127.0.0.1', () => {
    socket.end(
      [
        'GET /checkout HTTP/1.1',
        'Host: localhost',
        'Connection: close',
        'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'baggage: session.id=logs-only-session,enduser.id=user%203',
        '',
        '',
      ].join('\r\n'),
    );
  });
  socket.on('data', () => {});
  socket.on('close', resolve);
});
await get(`http://127.0.0.1:${server.address().port}/me`);
// Outside any request: setUser is the process's, and must not have leaked from /me.
Zharp.log.info('outside any request');
const spanResult = await Zharp.startSpan('job', async () => {
  Zharp.log.warn('inside job, logs only');
  return 42;
});

await Zharp.flush();
server.close();
downstream.close();
console.log(`RESULT ${JSON.stringify({ spanResult, downstreamHeaders, active: Zharp.isActive })}`);
await Zharp.shutdown();

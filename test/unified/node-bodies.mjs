// captureBodies in @zharp/node, set through ZHARP_CAPTURE_BODIES: an http server whose handlers
// read their bodies in different ways, and outgoing http.request calls to a downstream service.
import http from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Zharp } from '@zharp/node';

// A downstream service: a gzipped JSON failure, and a success.
const downstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url === '/charge') {
      res.writeHead(502, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ error: 'card declined', cardNumber: '4242424242424242' })));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"fine":true}');
    }
  });
});
await new Promise((resolve) => downstream.listen(0, '127.0.0.1', resolve));
const down = `http://127.0.0.1:${downstream.address().port}`;

function call(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = (res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/signup') {
    // Read with listeners, as body-parser does.
    let raw = '';
    req.on('data', (c) => (raw += c));
    await new Promise((r) => req.on('end', r));
    const input = JSON.parse(raw);
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `email ${input.email} taken`, sessionToken: 'srv-token' }));
  } else if (req.url === '/later') {
    // Read only after an await, with async iteration: nothing may be lost.
    await new Promise((r) => setTimeout(r, 30));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.write('failed for ');
    res.end(raw.length + ' bytes');
  } else if (req.url === '/pay') {
    const out = await call(`${down}/charge`, JSON.stringify({ amount: 5, cvv: '123' }));
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(out.text);
  } else if (req.url === '/upload') {
    // A form upload, read in full by the app.
    let size = 0;
    for await (const chunk of req) size += chunk.length;
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too large', received: size }));
  } else if (req.url.startsWith('/thumb')) {
    req.resume();
    res.writeHead(500, { 'content-type': 'image/png' });
    res.end(Buffer.alloc(3000, 7));
  } else {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"listed":true}');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const results = {};
results.signup = await (await fetch(`${base}/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@x.test', password: 'pw-secret' }) })).text();
results.later = await (await fetch(`${base}/later`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'late-body-' + 'y'.repeat(50) })).text();
results.pay = await (await fetch(`${base}/pay`, { method: 'POST' })).text();
results.list = await (await fetch(`${base}/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"page":"ok-request-body"}' })).text();
results.fine = await call(`${down}/fine`, '{"outgoing":"ok-outgoing-body"}');

const boundary = 'zharpBoundary42';
const upload = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHoliday\r\n`),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\nupload-secret\r\n`),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`),
  Buffer.alloc(100 * 1024, 1),
  Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="after"\r\n\r\nstill-here\r\n--${boundary}--\r\n`),
]);
results.upload = await (await fetch(`${base}/upload`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: upload })).text();
results.thumb = (await (await fetch(`${base}/thumb?token=query-secret-1&size=2`)).arrayBuffer()).byteLength;

await Zharp.flush();
server.close();
downstream.close();
console.log(`RESULT ${JSON.stringify(results)}`);
await Zharp.shutdown();

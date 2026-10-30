// A plain Node http server, instrumented only by the preloaded instrument.mjs.
import http from 'node:http';
import { Zharp } from '@zharp/node';

const runId = process.env.ZHARP_E2E_RUN;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // The page calls cross-origin, so CORS: the preflight must allow the trace headers.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'traceparent, baggage, content-type');
  if (req.method === 'OPTIONS') return res.end();

  if (url.pathname === '/api/checkout') {
    Zharp.log.info('checkout requested', { 'e2e.run': runId, cart: { items: 2 } });
    console.log(`console line from the handler ${runId}`);
    await Zharp.startSpan('price cart', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/fail') {
    try {
      throw new TypeError(`card declined ${runId}`);
    } catch (error) {
      Zharp.captureError(error, { 'e2e.run': runId });
    }
    res.statusCode = 500;
    return res.end('failed');
  }
  if (url.pathname === '/flush') {
    await Zharp.flush();
    return res.end('flushed');
  }
  res.statusCode = 404;
  res.end();
});

server.listen(0, '127.0.0.1', () => console.log(`LISTENING ${server.address().port}`));

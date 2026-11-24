/**
 * A stand-in for Zharp: takes OTLP (JSON from the windows, protobuf from main's @zharp/node) and
 * minidumps (Electron's crash reporter), unzips them and keeps them for run.mjs to check.
 * `mode = 'offline'` answers 503 to OTLP, as a server that can't be reached would make the SDK
 * keep its batches.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export function standIn(port, dumpDir) {
  const state = { mode: 'ok', otlp: [], minidumps: [] };
  mkdirSync(dumpDir, { recursive: true });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      if (req.headers['content-encoding'] === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b)) {
        try {
          body = gunzipSync(body);
        } catch {}
      }
      if (url.pathname.startsWith('/api/v1/otlp/')) {
        if (state.mode === 'offline') return res.writeHead(503).end();
        state.otlp.push({ path: url.pathname, type: req.headers['content-type'], auth: req.headers.authorization, text: body.toString('latin1'), json: tryJson(body) });
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      }
      if (url.pathname === '/api/v1/minidump') {
        const annotations = {};
        const re = /name="([^"]+)"(?:; filename="[^"]*")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n/g;
        let m;
        let dump = null;
        const text = body.toString('latin1');
        while ((m = re.exec(text))) {
          const start = m.index + m[0].length;
          const end = text.indexOf('\r\n--', start);
          if (m[1] === 'upload_file_minidump') dump = body.subarray(start, end);
          else annotations[m[1]] = text.slice(start, end);
        }
        const file = `${dumpDir}/${state.minidumps.length}.dmp`;
        if (dump) writeFileSync(file, dump);
        // Zharp answers with the crash's ID, which Electron lists in getUploadedReports.
        const id = `11111111-2222-4333-8444-${String(state.minidumps.length).padStart(12, '0')}`;
        state.minidumps.push({ id, key: url.searchParams.get('key'), annotations, file: dump ? file : null, size: dump?.length ?? 0 });
        return res.writeHead(200, { 'content-type': 'text/plain' }).end(id);
      }
      if (req.method === 'OPTIONS') return res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }).end();
      if (url.pathname === '/api/app/fail') return res.writeHead(500, { 'access-control-allow-origin': '*' }).end('nope');
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ state, close: () => server.close() })));
}

function tryJson(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

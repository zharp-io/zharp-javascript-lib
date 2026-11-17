// @zharp/node's output capture: whatever the app prints to stdout/stderr without going through
// console — NestJS's Logger, JSON loggers, raw process.stdout.write — arrives as logs, in the
// request it was printed in, and no line is sent twice.
import http from 'node:http';
import net from 'node:net';
import { Zharp } from '@zharp/node';

const ESC = '\u001b';
const server = http.createServer((req, res) => {
  // NestJS's ConsoleLogger: coloured, written straight to process.stdout.
  process.stdout.write(`${ESC}[32m[Nest] 61  - ${ESC}[39m11/17/2026, 8:33:00 AM ${ESC}[32m    LOG${ESC}[39m ${ESC}[38;5;3m[OrdersService] ${ESC}[39m${ESC}[32mnest-marker order placed${ESC}[39m\n`);
  process.stdout.write(`[Nest] 61  - 11/17/2026, 8:33:01 AM   ERROR [OrdersService] nest-error-marker payment failed\n`);
  // A JSON logger writing its own records.
  process.stdout.write(JSON.stringify({ level: 50, time: Date.now(), msg: 'json-marker from a JSON logger' }) + '\n');
  // A line written in pieces.
  process.stdout.write('split-');
  process.stdout.write('marker joined\n');
  // stderr with no level word.
  process.stderr.write('stderr-marker something odd\n');
  // console: sent by the console capture, not a second time by the output capture.
  console.log('console-marker once');
  // A stack trace in one write: one record, stamped once at its end.
  console.error('stack-marker boom\n    at handler (app.js:1:1)\n    at next (app.js:2:2)');
  res.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

await new Promise((resolve) => {
  const socket = net.connect(server.address().port, '127.0.0.1', () => {
    socket.end(['GET /orders HTTP/1.1', 'Host: localhost', 'Connection: close',
      'traceparent: 00-5bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', '', ''].join('\r\n'));
  });
  socket.on('data', () => {});
  socket.on('close', resolve);
});
// Outside any request, with a line still unfinished when the flush timer fires.
process.stdout.write('outside-marker no newline');
await new Promise((resolve) => setTimeout(resolve, 400));
process.stdout.write('\n');

await Zharp.flush();
server.close();
console.log(`RESULT ${JSON.stringify({ ok: true })}`);
await Zharp.shutdown();

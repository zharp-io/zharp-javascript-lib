// captureBodies in @zharp/browser: `node browser-bodies.mjs errors|all|off`.
import { installPage, endpoint, wait, result } from './page.mjs';

const mode = process.argv[2] ?? 'errors';
installPage('http://localhost:5173/start');

// The application's server: JSON answers, a failure that leaks a token, a large body, a stream.
const realFetch = globalThis.fetch;
const consumed = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(endpoint)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req-7', 'set-cookie': 'sid=secret' } });
  if (url.includes('/api/login')) return json({ error: 'bad credentials', token: 'leaked-token', user: { email: 'a@b.test', apiKey: 'k-123' } }, 401);
  if (url.includes('/api/ok')) return json({ saved: true });
  if (url.includes('/api/big')) return new Response('x'.repeat(20000), { status: 200, headers: { 'content-type': 'text/plain' } });
  if (url.includes('/api/events')) return new Response('data: 1\n\n', { status: 500, headers: { 'content-type': 'text/event-stream' } });
  if (url.includes('/api/image')) return new Response(new Uint8Array([1, 2, 3]), { status: 500, headers: { 'content-type': 'image/png' } });
  return json({ ok: false }, 500);
};

const { Zharp } = await import('@zharp/browser');
Zharp.init({
  key: `bodies-${mode}`,
  service: 'web-bodies',
  endpoint,
  tracingOrigins: ['api.allowed.test'],
  captureBodies: mode === 'off' ? undefined : { mode, maxSize: 1000, redactKeys: ['dateOfBirth'] },
});

const login = await fetch('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer user-token', 'x-client': 'web' },
  body: JSON.stringify({ email: 'a@b.test', password: 'hunter2', dateOfBirth: '1990-01-01', remember: true }),
});
consumed.push((await login.json()).error); // the app still reads its own response
await fetch('/api/ok', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"name":"Ada"}' });
await fetch('/api/form', { method: 'POST', body: new URLSearchParams({ user: 'ada', password: 'p4ss' }) });
await fetch('/api/big');
await fetch('https://api.allowed.test/v1/fail', { method: 'POST', body: '{"n":1}' });
await fetch('https://third-party.test/fail', { method: 'POST', body: '{"secretless":"but third party"}' });
await fetch('/api/events');
await fetch('/api/image');
// A form upload with a file, inline images in JSON, a nested secret, and a token in the URL.
const form = new FormData();
form.append('title', 'Holiday');
form.append('password', 'form-secret');
form.append('photo', new File([new Uint8Array(2048)], 'photo.png', { type: 'image/png' }));
await fetch('/api/upload', { method: 'POST', body: form });
const pixel = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(4000);
await fetch('/api/profile?token=url-secret&page=2', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ avatar: pixel, blob: 'QUJD'.repeat(500) + '1', card: { brand: 'visa', last4: '4242' }, name: 'Ada' }),
});

await wait(1_800);
await Zharp.flush();
result({ consumed });
process.exit(0);

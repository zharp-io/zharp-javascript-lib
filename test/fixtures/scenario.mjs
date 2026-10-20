/**
 * The Node scenario, shared by the ESM and CJS consumers so both builds are held to the same
 * checks. Everything observable over the wire is asserted by test/run.mjs; what can only be
 * seen from inside the process (the active trace before and after an await) is returned.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function get(http, port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

export async function scenario({ ZharpLogger, http, label, namedGet }) {
  ZharpLogger.init({
    apiKey: 'test-key-123',
    service: `${label}-app`,
    environment: 'staging',
    appVersion: '2.0.0',
    source: 'worker',
    endpoint: process.env.ZHARP_TEST_ENDPOINT,
    flushInterval: 60_000,
    maxBatchSize: 500,
    autoCapture: { errors: false, unhandledRejections: false },
    tracing: { enabled: true, breadcrumbs: false },
  });

  // ── a server whose handler awaits, to see whether the request's context survives ──
  const server = http.createServer(async (req, res) => {
    const before = ZharpLogger.currentTraceId();
    await sleep(25);
    await Promise.resolve();
    const after = ZharpLogger.currentTraceId();
    ZharpLogger.info(`inside request ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ before, after }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Two at once: if context were a single shared variable, one would see the other's trace.
  const [a, b] = await Promise.all([get(http, port, '/a'), get(http, port, '/b')]);

  // ESM only: a named import of `get` made before init() must still be traced.
  let named = null;
  if (namedGet) {
    named = await new Promise((resolve, reject) => {
      namedGet({ hostname: '127.0.0.1', port, path: '/named' }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }).on('error', reject);
    });
  }

  // ── messages of every shape ──
  ZharpLogger.info('plain');
  ZharpLogger.info({ order: 1 });
  ZharpLogger.info('');
  ZharpLogger.log('warn', undefined);
  ZharpLogger.info(42);
  ZharpLogger.info(new Error('boom-object'));

  // ── ~3 MB of logs, to be split into requests of at most 1 MB ──
  const blob = 'x'.repeat(100_000);
  for (let i = 0; i < 30; i++) ZharpLogger.info(`big-${i}`, { blob });

  // ── continueTrace ──
  const tp = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
  const inner = ZharpLogger.continueTrace(tp, () => ZharpLogger.currentTraceId(), 'process-job');
  const plain = ZharpLogger.continueTrace(`00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`, () => ZharpLogger.currentTraceId());
  await ZharpLogger.continueTrace(
    `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01`,
    async () => {
      await sleep(10);
      ZharpLogger.info('in async job');
    },
    'async-job',
  );

  server.close();
  await ZharpLogger.destroy();

  return { a, b, named, inner, plain };
}

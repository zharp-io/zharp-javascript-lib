/**
 * The Node scenario, shared by the ESM and CJS consumers so both builds are held to the same
 * checks. Everything is observed over the wire and asserted by test/run.mjs.
 */

export async function scenario({ ZharpLogger, label }) {
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
  });

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

  await ZharpLogger.destroy();
  return {};
}

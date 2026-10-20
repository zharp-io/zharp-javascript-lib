// Logs carry a trace only while @zharp/apm is running, and both packages agree on the session.
const { ZharpLogger, getSessionId: logsSession } = require('@zharp/logs');
const { ZharpAPM, getSessionId: apmSession } = require('@zharp/apm');

ZharpLogger.init({
  apiKey: 'test-key-corr',
  service: 'corr-app',
  environment: 'corr-env',
  appVersion: '3.1.4',
  source: 'corr-src',
  endpoint: process.env.ZHARP_TEST_ENDPOINT,
  flushInterval: 60_000,
  autoCapture: { errors: false, unhandledRejections: false },
});
ZharpLogger.info('corr no apm');

// No options: everything comes from the logger.
ZharpAPM.init({ flushInterval: 60_000 });
let spanTrace = null;
ZharpAPM.startActiveSpan('corr-span', (span) => {
  spanTrace = span.context.traceId;
  ZharpLogger.warn('corr with apm');
});
const crumbs = ZharpAPM.breadcrumbs().map((c) => `${c.kind}:${c.message}`);

ZharpAPM.destroy()
  .then(() => {
    // APM stopped: its span API still runs the work, but logs are no longer attached to a trace.
    ZharpAPM.startActiveSpan('after', () => ZharpLogger.info('corr after apm'));
    return ZharpLogger.destroy();
  })
  .then(() => {
    console.log(`RESULT ${JSON.stringify({ spanTrace, crumbs, sessions: [logsSession(), apmSession()] })}`);
  });

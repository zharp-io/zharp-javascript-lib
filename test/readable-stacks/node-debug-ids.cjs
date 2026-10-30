// @zharp/node with an injected server bundle: captureError, an error log, and an exception
// recorded on a span all carry the bundle's debug ID.
const { Zharp } = require('@zharp/node');
// The application's own OpenTelemetry API: the copy @zharp/node uses.
const { trace } = require(require.resolve('@opentelemetry/api', { paths: [require.resolve('@zharp/node')] }));

Zharp.init({ key: 'debug-ids-node', service: 'node-test', endpoint: `${process.env.ZHARP_TEST_ENDPOINT}/otlp` });

const app = require(process.env.BUNDLE);
const fail = () => {
  try {
    app.checkout();
  } catch (error) {
    return error;
  }
};

(async () => {
  const captured = fail();
  Zharp.captureError(captured);
  Zharp.log.error('checkout failed', { error: fail() });
  trace.getTracer('test').startActiveSpan('work', (span) => {
    span.recordException(fail());
    span.end();
  });
  Zharp.captureError(new Error('not from a bundle'));
  await Zharp.flush();
  console.log(`RESULT ${JSON.stringify({ stack: captured.stack })}`);
  await Zharp.shutdown();
})();

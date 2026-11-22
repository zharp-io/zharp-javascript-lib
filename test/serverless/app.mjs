// @zharp/node in serverless functions. Zharp.init() runs at import, as at a cold start; each
// "invocation" calls the wrapped handler the way the platform would, then asks the test runner
// (over IPC) what it has received — so "flushed before the handler returned" is checked, not
// assumed.
//
//     node test/serverless/app.mjs lambda|azure|gcf   (run by test/serverless.mjs)
import http from 'node:http';
import { Zharp } from '@zharp/node';

const mode = process.argv[2];

Zharp.init({
  key: process.env.TEST_KEY,
  service: 'fn-test',
  endpoint: `${process.env.ZHARP_TEST_ENDPOINT}/otlp`,
  captureSourceContext: false,
});

/** What the endpoint has received for this key so far: invocation ids on spans, log bodies. */
let asked = 0;
const received = () =>
  new Promise((resolve) => {
    const id = ++asked;
    const onMessage = (m) => {
      if (m?.id !== id) return;
      process.off('message', onMessage);
      resolve(m.received);
    };
    process.on('message', onMessage);
    process.send({ id, key: process.env.TEST_KEY });
  });

const out = { invocations: [] };
const note = async (label, extra = {}) => out.invocations.push({ label, ...extra, received: await received() });

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const PARENT = 'b7ad6b7169203331';

if (mode === 'lambda') {
  const lambdaContext = (id) => ({
    awsRequestId: id,
    functionName: 'orders-fn',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:orders-fn',
    getRemainingTimeInMillis: () => 30_000,
  });
  const handler = Zharp.lambda(async (event, context) => {
    Zharp.log.info(`lambda ran ${context.awsRequestId}`);
    if (event.fail) throw new TypeError('lambda boom');
    return event.Records ? { batchItemFailures: [] } : { statusCode: 201, body: JSON.stringify({ ok: true }) };
  });
  out.arity = handler.length;

  // 1. API Gateway HTTP API (payload 2.0), called with a traceparent.
  const apiEvent = {
    version: '2.0',
    routeKey: 'GET /items/{id}',
    rawPath: '/items/42',
    rawQueryString: '',
    headers: { traceparent: `00-${TRACE}-${PARENT}-01`, 'user-agent': 'curl/8', host: 'abc.execute-api.eu-west-1.amazonaws.com' },
    requestContext: { http: { method: 'GET', path: '/items/42', sourceIp: '203.0.113.9', userAgent: 'curl/8' }, routeKey: 'GET /items/{id}' },
    isBase64Encoded: false,
  };
  out.apiResult = await handler(apiEvent, lambdaContext('req-api'));
  await note('api');

  // 2. SQS: not HTTP, nothing to continue.
  out.sqsResult = await handler({ Records: [{ eventSource: 'aws:sqs', body: '{}' }] }, lambdaContext('req-sqs'));
  await note('sqs');

  // 3. The handler throws: the same error comes back out.
  const boom = await handler({ fail: true, Records: [{ eventSource: 'aws:sqs' }] }, lambdaContext('req-fail')).then(
    () => null,
    (error) => error,
  );
  out.thrown = boom && { type: boom.constructor.name, message: boom.message };
  await note('fail');

  // 4. A callback handler keeps its arity and gets its result through the callback.
  const cb = Zharp.lambda((event, context, callback) => {
    Zharp.log.info(`lambda ran ${context.awsRequestId}`);
    setTimeout(() => callback(null, { statusCode: 204 }), 5);
  });
  out.callbackArity = cb.length;
  out.callbackResult = await new Promise((resolve) => cb(apiEvent, lambdaContext('req-cb'), (err, value) => resolve({ err, value })));
  await note('callback');
} else if (mode === 'azure') {
  const context = (id, type, functionName) => ({ invocationId: id, functionName, options: { trigger: { type } }, log() {} });
  const handler = Zharp.azureFunction(async (request, context) => {
    Zharp.log.info(`azure ran ${context.invocationId}`);
    if (request?.query?.get?.('fail')) throw new RangeError('azure boom');
    return { status: 202, jsonBody: { ok: true } };
  });
  out.arity = handler.length;
  const request = (url) => ({
    method: 'POST',
    url,
    headers: new Headers({ traceparent: `00-${TRACE}-${PARENT}-01`, 'user-agent': 'azure-test' }),
    query: new URL(url).searchParams,
  });
  out.httpResult = await handler(request('https://fn.azurewebsites.net/api/orders'), context('az-http', 'httpTrigger', 'orders'));
  await note('http');
  out.timerResult = await handler({ isPastDue: false }, context('az-timer', 'timerTrigger', 'nightly'));
  await note('timer');
  const boom = await handler(request('https://fn.azurewebsites.net/api/orders?fail=1'), context('az-fail', 'httpTrigger', 'orders')).then(
    () => null,
    (error) => error,
  );
  out.thrown = boom && { type: boom.constructor.name, message: boom.message };
  await note('fail');
} else if (mode === 'gcf') {
  // A real http server, as the Functions Framework runs one: the wrapper makes the span, and the
  // http instrumentation must not make a second.
  const fn = Zharp.cloudFunction((req, res) => {
    Zharp.log.info(`gcf ran ${req.url}`);
    if (req.url.startsWith('/fail')) throw new SyntaxError('gcf boom');
    setTimeout(() => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }, 5);
  });
  out.arity = fn.length;
  const server = http.createServer((req, res) => {
    // The Functions Framework answers a throw with a 500.
    try {
      fn(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.end('crash');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.address().port, path, headers }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode, body }));
        })
        .on('error', reject);
    });
  out.first = await call('/orders?x=1', { traceparent: `00-${TRACE}-${PARENT}-01`, 'function-execution-id': 'gcf-exec-1' });
  await note('http');
  out.failed = await call('/fail', { 'function-execution-id': 'gcf-exec-2' });
  await note('fail');
  server.close();

  // A CloudEvent function, with the distributed tracing extension.
  const onEvent = Zharp.cloudFunction(async (cloudEvent) => {
    Zharp.log.info(`event ran ${cloudEvent.id}`);
    return 'handled';
  });
  out.eventResult = await onEvent({
    specversion: '1.0',
    id: 'ce-1',
    type: 'google.cloud.pubsub.topic.v1.messagePublished',
    source: '//pubsub.googleapis.com/projects/p/topics/t',
    traceparent: `00-${TRACE}-${PARENT}-01`,
    data: {},
  });
  await note('event');
}

if (mode === 'slow') {
  // The endpoint never answers: each invocation waits for the flush no longer than it is allowed.
  const timed = async (fn, ...args) => {
    const start = performance.now();
    const value = await fn(...args);
    return { value, ms: Math.round(performance.now() - start) };
  };
  const context = { awsRequestId: 'slow-1', functionName: 'slow-fn', getRemainingTimeInMillis: () => 60_000 };
  out.custom = await timed(Zharp.lambda(async () => 'done', { flushTimeout: 300 }), {}, context);
  out.byDefault = await timed(Zharp.lambda(async () => 'done'), {}, { ...context, awsRequestId: 'slow-2' });
  // Close to the function's own timeout: the flush keeps inside what is left.
  out.nearTimeout = await timed(Zharp.lambda(async () => 'done'), {}, { ...context, awsRequestId: 'slow-3', getRemainingTimeInMillis: () => 400 });
}

console.log(`RESULT ${JSON.stringify(out)}`);
await Zharp.shutdown();
process.disconnect?.();

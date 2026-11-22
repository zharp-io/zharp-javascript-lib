# @zharp/node

Application Monitoring for Node.js, for [Zharp](https://zharp.io): traces of every request your server handles and makes, its logs, and its errors — joined to the browser session and user that caused them.

It is the official [OpenTelemetry Node SDK](https://opentelemetry.io/docs/languages/js/) and its auto-instrumentations, configured for Zharp. Every span comes from OpenTelemetry's instrumentation of `http`, Express, Fastify, Koa, NestJS, pg, mysql, mongodb, redis, undici/fetch, gRPC, GraphQL, AWS SDK and the rest; this package adds the configuration, the user and session on every record, a console bridge, error capture and a small API.

Requires Node 22.15 or later (as OpenTelemetry does).

## Install

```bash
npm install @zharp/node
```

Create `instrument.js`:

```javascript
import { Zharp } from '@zharp/node';

Zharp.init({
  key: process.env.ZHARP_KEY,      // the app key from the dashboard
  service: 'checkout-api',
  environment: 'production',
  release: process.env.GIT_SHA,    // optional
});
```

and load it before your application:

```bash
node --import ./instrument.js server.js
```

```
[Zharp] Application monitoring active — service "checkout-api", environment "production"
```

Loading it first is what makes it work: the instrumentations patch `http`, your framework and your database driver as they are first imported, so `init()` has to run before any of them are. With CommonJS, `node --require ./instrument.js server.js` does the same.

With nothing but environment variables: `ZHARP_API_KEY=… ZHARP_SERVICE=checkout-api node --import @zharp/node/init server.js` (also `ZHARP_ENV`, `ZHARP_RELEASE`, `ZHARP_LOGS`; `ZHARP_DISABLED=true` turns it off).

### Next.js

`instrumentation.ts` in the project root (or `src/`):

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { Zharp } = await import('@zharp/node');
    Zharp.init({ key: process.env.ZHARP_KEY!, service: 'checkout-web-server', environment: process.env.NODE_ENV });
  }
}
```

The Edge runtime is not supported. If the build complains about OpenTelemetry modules, add `serverExternalPackages: ['@zharp/node']` to `next.config`.

## What is captured

| | |
|---|---|
| **Requests** | A SERVER span per incoming request (`http.request.method`, `http.route` where the framework knows it, `http.response.status_code`; 5xx are errors), CLIENT spans for outgoing HTTP, and spans for database and cache calls. `dns`, `net` and `fs` are off — one span per lookup or file read is noise. |
| **Traces from the browser** | The `traceparent` header continues the browser's trace; `session.id` and `enduser.id` from the `baggage` header are copied onto every span and log of that request. |
| **Logs** | Every line the app prints during a request is stamped `trace_id=… span_id=…` (fields in JSON records), so the Zharp agent's copy of the app's output is linked to its request. With `logs: true` (`ZHARP_LOGS=true`) — for serverless or a host without the agent — the SDK sends them itself: `console.*`, pino, winston, bunyan and anything else printed, each with its trace and span. `Zharp.log.*` is always sent. |
| **Errors** | `Zharp.captureError(err)` (handled), uncaught exceptions and unhandled rejections (unhandled). Sent as error logs with `exception.type`, `exception.message` and `exception.stacktrace`, grouped into issues. |

### Uncaught exceptions

Listening for `uncaughtException` / `unhandledRejection` stops Node from exiting, so when Zharp's listener is the only one it does what Node would have: prints the error to stderr and exits with code 1 — after the error has been sent (at most 2 seconds). If your application has its own listeners, they decide what happens and Zharp only reports. `--unhandled-rejections=warn|none|warn-with-error-code` are respected.

### Exit

What is waiting is sent when the event loop empties, and on SIGTERM/SIGINT (after which the signal is raised again if nothing else is listening for it). In serverless functions, wrap the handler (below) — or `await Zharp.flush()` before returning.

### Serverless functions

A function's process is frozen as soon as the handler returns, so wrap the handler. Each invocation becomes one SERVER span with the FaaS attributes (`faas.trigger`, `faas.invocation_id`, `faas.coldstart`, `faas.name`, `cloud.provider`), continuing the caller's trace when the trigger carries a `traceparent` (API Gateway, HTTP triggers, a CloudEvent's tracing extension). An error the handler throws is reported once and thrown on unchanged. Everything is flushed before the result goes back — for at most `flushTimeout` (2 s by default; on Lambda never past the invocation's remaining time). The wrapped handler has the same arguments and result as yours. Call `Zharp.init()` at the top of the handler's module, with `logs: true` if the function's console output should be sent too (nothing else collects it there).

```typescript
// AWS Lambda (async, callback or streamifyResponse handlers)
export const handler = Zharp.lambda(async (event, context) => ({ statusCode: 200, body: 'ok' }));

// Azure Functions, v4 programming model (any trigger)
app.http('orders', { handler: Zharp.azureFunction(async (request, context) => ({ status: 200 })) });

// Google Cloud Functions: HTTP, CloudEvent or background functions
functions.http('orders', Zharp.cloudFunction((req, res) => res.send('ok')));
functions.cloudEvent('onMessage', Zharp.cloudFunction(async (cloudEvent) => { /* … */ }));
```

On Cloud Functions the response is held until the flush is done (the CPU may be stopped once it is out), and the wrapper makes the request's span itself, so the http instrumentation leaves incoming requests alone from the moment a function is wrapped. On Lambda, OpenTelemetry's own `aws-lambda` instrumentation is off (it would make a second span); `Zharp.lambda` replaces it. Running on Lambda, Azure Functions or Cloud Functions also puts `cloud.provider`, `cloud.platform`, `cloud.region` and `faas.*` on the resource, and the function's name is the default `service.name`.

### Logs only

```typescript
Zharp.init({ tracing: false });   // or ZHARP_TRACING=false
```

Logs (`Zharp.log.*`, and with `logs: true` the console, pino, winston, bunyan), errors (with `exception.*` and the handled flag), the user, the session and tags are sent as usual. No spans are exported, nothing is instrumented except the log bridges and the incoming side of `http`, and no `traceparent` or `baggage` is added to outgoing requests. An incoming `traceparent` and `baggage` are still read, so a request's logs carry the caller's trace id, session and user (and `setUser()` inside a request stays with that request) — at the cost of one never-exported in-memory span per request. `Zharp.startSpan(name, fn)` just runs `fn`.

## API

| | |
|---|---|
| `Zharp.init(options)` | Start. Once per process; a second call is ignored with a warning. |
| `Zharp.setUser({ id, email?, name? })` | Inside a request: `enduser.id` (email, name) on every span and log of that request from here on, and on the request's span. Outside one: on everything the process sends — for a script or worker. Requests from `@zharp/browser` already carry the user. |
| `Zharp.clearUser()` | |
| `Zharp.setTag(key, value)` | An attribute on every span and log from now on. |
| `Zharp.captureError(err, attrs?)` | |
| `Zharp.log.<level>(message, attrs?)` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`. An `Error` among the attributes of an error log is sent as its exception. |
| `Zharp.startSpan(name, fn, options?)` | Run `fn` in a span, ending when it returns or its promise settles. |
| `Zharp.lambda(handler, { flushTimeout? })` | An AWS Lambda handler, traced and flushed per invocation. See [Serverless functions](#serverless-functions). |
| `Zharp.azureFunction(handler, { flushTimeout? })` | The same for an Azure Functions handler. |
| `Zharp.cloudFunction(handler, { flushTimeout? })` | The same for a Google Cloud Function (HTTP, CloudEvent or background). |
| `Zharp.flush(timeoutMs?)` | Send everything waiting. |
| `Zharp.shutdown()` | Flush and stop. |

Everything else is plain OpenTelemetry: `trace.getActiveSpan()`, `trace.getTracer('my-lib')` and the rest of `@opentelemetry/api` work as usual.

## Options

| Option | Default | |
|---|---|---|
| `key` | `ZHARP_API_KEY` | The app key (`zpk_…`) or a workspace API key with ingest scope. |
| `service` | `ZHARP_SERVICE`, `OTEL_SERVICE_NAME`, package.json name | `service.name` |
| `environment` | `ZHARP_ENV`, `NODE_ENV` | `deployment.environment.name` |
| `release` | `ZHARP_RELEASE` | `service.version` |
| `tracing` | `ZHARP_TRACING`, else `true` | `false` for logs only (see above). |
| `sampleRate` | `1` | Fraction of new traces kept. A trace that arrives with a decision (from the browser) keeps it. Errors and logs are always sent. |
| `logs` | `ZHARP_LOGS`, else `false` | Send what the app logs and prints. Off by default: where the Zharp agent reads the app's output it brings those lines in, linked by `logCorrelation`. Turn on for serverless or hosts without the agent. Errors, `Zharp.log` and traces are sent either way. |
| `logCorrelation` | `ZHARP_LOG_CORRELATION`, else `true` | Stamps `trace_id=… span_id=…` on each line printed during a request (fields in JSON records), so Zharp links it to the request. |
| `captureConsole` | `true` | With `logs` on. |
| `captureOutput` | `ZHARP_CAPTURE_OUTPUT`, else `true` | With `logs` on: everything else printed to stdout/stderr: NestJS's Logger, debug, log4js, anything writing to `process.stdout`. Level read from the line; keeps the request it was printed in; never sends a line twice. |
| `captureUncaught` | `true` | |
| `instrumentations` | | Per-instrumentation config for `getNodeAutoInstrumentations`, e.g. `{ '@opentelemetry/instrumentation-fs': { enabled: true } }`. |
| `extraInstrumentations` | `[]` | More OpenTelemetry instrumentations. |
| `debug` | `false` | Print what OpenTelemetry is doing. |

Traces, errors and logs go straight to Zharp as OTLP/protobuf, gzipped.

## Readable stack traces

Bundled or minified server code (a Next.js server build, an esbuild or webpack bundle) becomes original files, lines and code once its source maps are uploaded with a [Zharp bundler plugin](../bundler-plugins/README.md) or [`@zharp/cli`](../cli/README.md). Every error this SDK sends — `captureError`, error logs with an error, uncaught errors, exceptions recorded on spans by the instrumentations, and error logs from pino and winston — carries the debug IDs of the bundled files in its stack as `zharp.debug_ids`. Nothing to configure here.

## License

MIT

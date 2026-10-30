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

With nothing but environment variables: `ZHARP_API_KEY=… ZHARP_SERVICE=checkout-api node --import @zharp/node/init server.js` (also `ZHARP_ENV`, `ZHARP_RELEASE`, `ZHARP_ENDPOINT`; `ZHARP_DISABLED=true` turns it off).

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
| **Logs** | `Zharp.log.*`, `console.*` (default on), and pino, winston and bunyan through OpenTelemetry's log bridges — each with the trace and span it was written in. |
| **Errors** | `Zharp.captureError(err)` (handled), uncaught exceptions and unhandled rejections (unhandled). Sent as error logs with `exception.type`, `exception.message` and `exception.stacktrace`, grouped into issues. |

### Uncaught exceptions

Listening for `uncaughtException` / `unhandledRejection` stops Node from exiting, so when Zharp's listener is the only one it does what Node would have: prints the error to stderr and exits with code 1 — after the error has been sent (at most 2 seconds). If your application has its own listeners, they decide what happens and Zharp only reports. `--unhandled-rejections=warn|none|warn-with-error-code` are respected.

### Exit

What is waiting is sent when the event loop empties, and on SIGTERM/SIGINT (after which the signal is raised again if nothing else is listening for it). In serverless functions, `await Zharp.flush()` before returning.

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
| `endpoint` | `https://api.zharp.io/api/v1/otlp` | |
| `sampleRate` | `1` | Fraction of new traces kept. A trace that arrives with a decision (from the browser) keeps it. Errors and logs are always sent. |
| `captureConsole` | `true` | |
| `captureUncaught` | `true` | |
| `instrumentations` | | Per-instrumentation config for `getNodeAutoInstrumentations`, e.g. `{ '@opentelemetry/instrumentation-fs': { enabled: true } }`. |
| `extraInstrumentations` | `[]` | More OpenTelemetry instrumentations. |
| `debug` | `false` | Print what OpenTelemetry is doing. |

Traces and logs go as OTLP/protobuf, gzipped, to `{endpoint}/v1/traces` and `/v1/logs` with `Authorization: Bearer <key>`.

## License

MIT

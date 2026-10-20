# @zharp/logs

The official JavaScript SDK for [Zharp](https://zharp.io). Drop it into any JavaScript or TypeScript project and start streaming logs to your Zharp dashboard in minutes — use it standalone or plug it straight into your existing Winston, Pino, or NestJS logger as a transport. No log pipeline to manage, no infrastructure to set up — just your logs, live on your Zharp dashboard.

---

## Installation

```bash
npm install @zharp/logs
# or
pnpm add @zharp/logs
# or
yarn add @zharp/logs
```

---

## API key

Create an **Ingest only** key in Zharp for this SDK. Browser code ships the key to every visitor, and
a server's environment variables leak more often than anyone plans for — a key that can only send
data, never read it, is the one to hand out.

---

## Quick start

### Browser / React / Vue / Next.js

```typescript
import { ZharpLogger } from '@zharp/logs';

// Call once at app startup (e.g. main.ts, _app.tsx, index.js)
ZharpLogger.init({
  apiKey: 'your-api-key',
  service: 'my-frontend',
  environment: 'production',
  appVersion: '1.4.2',
});

// Log anywhere in your app
ZharpLogger.info('User signed in', { userId: 42 });
ZharpLogger.warn('Slow network detected', { latencyMs: 3200 });
ZharpLogger.error('Payment failed', { orderId: 99, reason: 'insufficient_funds' });
```

### Node.js / NestJS

```typescript
import { ZharpLogger } from '@zharp/logs';

// In main.ts or app bootstrap
ZharpLogger.init({
  apiKey: process.env.ZHARP_API_KEY,
  service: 'user-service',        // or set ZHARP_SERVICE
  // environment and appVersion fall back to ZHARP_ENV / NODE_ENV and ZHARP_VERSION
});

// In any service or controller
ZharpLogger.info('User created', { userId: user.id });
ZharpLogger.error('Database query failed', { table: 'orders', error: err.message });
```

---

## Configuration

```typescript
ZharpLogger.init({
  // Required
  apiKey: 'your-api-key',       // An "Ingest only" Zharp API key
  service: 'my-service',        // Service name shown in the log viewer (Node: see fallbacks below)

  // Optional
  environment: 'production',    // `environment` tag on every log and span. No default
  appVersion: '1.4.2',          // `version` tag on every log, service.version on spans
  source: 'web',                // `source` tag on every log, zharp.source on spans
  endpoint: 'https://api.zharp.io/api/v1', // Zharp API base URL. Default shown
  flushInterval: 5000,          // How often to flush the queue (ms). Default: 5000
  maxBatchSize: 50,             // Max logs taken from the queue per flush. Default: 50

  // Auto-capture (all enabled by default except consoleErrors)
  autoCapture: {
    errors: true,               // window.onerror / process.uncaughtException
    unhandledRejections: true,  // unhandledrejection / process.unhandledRejection
    consoleErrors: false,       // Wrap console.error (opt-in)
  },

  // Distributed tracing — off unless enabled
  tracing: {
    enabled: true,
    sampleRate: 1,                     // Fraction of traces to record. Default: 1
    fetch: true,                       // Trace fetch and XHR. Default: true
    http: true,                        // Trace Node http/https, in and out. Default: true
    breadcrumbs: true,                 // Trail of clicks/requests before an error. Default: true
    propagateTo: [/api\.myapp\.com/],  // Which hosts get the traceparent header
    ignore: ['/health'],               // Paths never traced
  },
});
```

### Tags and environment-variable fallbacks

`environment`, `version` (from `appVersion`) and `source` are sent as top-level tags on every log —
the fields the log viewer filters by — and as `deployment.environment.name` (plus the older
`deployment.environment`), `service.version` and `zharp.source` on every span. A tag that is not
configured is not sent; nothing defaults to `'production'`.

In Node, anything not passed to `init()` is read from the environment:

| Option | Falls back to |
|---|---|
| `service` | `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME` |
| `environment` | `ZHARP_ENV`, then `NODE_ENV` |
| `appVersion` | `ZHARP_VERSION` |

In the browser there are no fallbacks: set `service` and `environment` explicitly. If no service name
is found at all, the SDK logs a warning and files everything under `unknown-service` rather than
throwing.

---

## Tracing

Tracing answers a different question from logging: not *what happened*, but *where the time went
and what caused what*. Turn it on with `tracing: { enabled: true }` and the SDK traces your HTTP
traffic on its own.

**In the browser**, every `fetch` and `XMLHttpRequest` becomes a span, carrying a W3C
`traceparent` header so the backend request it triggers joins the same trace.

**In Node**, every incoming request becomes a server span — Express, Fastify, Nest and Koa all
build on `http.Server`, so no framework-specific setup is needed — and every outgoing
`http`/`https`/`fetch` call becomes a client span beneath it. Work inside a request stays
attached to that request across `await` boundaries, so concurrent requests never mix.

Logs emitted inside a trace carry its `traceId` and `spanId` in their metadata, so you can search
the logs for the trace you are looking at.

**Native ES modules in Node** (`"type": "module"`, `.mjs`) need **Node 20.16+ or 22.3+** for HTTP
tracing and for keeping the active span across `await`: the ESM build loads `node:http` and
`node:async_hooks` through `process.getBuiltinModule`, because an ES module has no `require`. On older
Node the ESM build still logs and records manual spans, but does not patch `http`. The CommonJS
build works on any supported Node.

### Timing your own code

```typescript
const order = await ZharpLogger.startActiveSpan('createOrder', async (span) => {
  span.setAttribute('cart.items', items.length);
  return db.orders.create(input);   // nested calls attach automatically
});
```

The span ends when the function settles, including when it returns a promise. A thrown error is
recorded on the span with its stack, then re-thrown unchanged.

### Crossing a boundary the SDK does not patch

Queues, WebSocket messages and workers break the chain. Carry the trace across by hand:

```typescript
// Producer
await queue.add('sendEmail', { orderId, trace: ZharpLogger.traceHeaders() });

// Consumer — the third argument names the work
worker.process((job) =>
  ZharpLogger.continueTrace(job.data.trace?.traceparent, () => sendEmail(job.data), 'sendEmail'));
```

With a name, `continueTrace` runs the function inside a `CONSUMER` span of that name, so each job
gets its own duration and error status the way an HTTP request does. Without a name it only makes
the caller's trace active, and creates no span of its own. A missing or malformed `traceparent`
starts a new trace.

### Showing a trace ID to a user

```typescript
res.status(500).json({ error: 'Something went wrong', traceId: ZharpLogger.currentTraceId() });
```

A support ticket quoting that ID becomes the exact trace, with every span and error in it.

### A note on `propagateTo`

By default, browsers send the `traceparent` header **same-origin only**. Adding a header to a
cross-origin request turns it into a CORS preflight, and a third party that does not allow the
header will reject the request outright — so widening this is a decision about someone else's
server, and you make it explicitly. In Node there is no such penalty, and all requests are
propagated by default.

### Sampling

`sampleRate` is decided once at the start of a trace and inherited by every span in it, so a
recorded trace is always whole. A half-recorded trace is worse than none — its gaps look like
latency that never happened.

---

## What an error carries

A stack trace says where the code was. It does not say what was on that line, or how the code
got there. Both are attached automatically when an exception is recorded on a span.

### Source context

In Node, the lines around each frame of the stack are read at the moment of the throw and travel
with the error — so the code is there in the incident, even when the file is on a machine nobody
can reach or a deploy behind. Frames inside `node_modules` and Node's internals are skipped: the
frame you want is the last one in your own code.

Not captured in the browser, where the stack points at bundled output whose line numbers mean
nothing without a source map.

### Breadcrumbs

A short trail of what happened before the failure — clicks, navigations, requests, and warning
or error logs — capped at the last 20 entries and attached to the next exception.

```typescript
ZharpLogger.addBreadcrumb('Applied discount code', { code: 'SUMMER' });
```

**Nothing typed is captured** — only that typing happened, and into which field. A password
field is not even named, because its `id` can identify an account. Recording input values would
mean shipping passwords, card numbers and private messages to a monitoring service, and no
amount of masking makes that a safe default.

Turn it off with `tracing: { breadcrumbs: false }`.

---

## Session replay

Records the page and plays it back, so you can watch what happened instead of reconstructing it
from logs. The recording itself is [rrweb](https://github.com/rrweb-io/rrweb) — it handles the
parts that make DOM recording hard, and there are many: shadow DOM, canvas, iframes,
cross-origin stylesheets, web components, media.

It lives behind its own import, because rrweb is an order of magnitude larger than the rest of
this SDK and an app that only wants logging should never pay for it:

```typescript
import { ZharpLogger } from '@zharp/logs';
import { ZharpReplay } from '@zharp/logs/replay';

ZharpLogger.init({ apiKey: 'YOUR_KEY', service: 'checkout-web', tracing: { enabled: true } });

// Record one session in ten.
ZharpReplay.start({ sampleRate: 0.1 });
```

Recordings and logs from the same page load share a session id, and a recording lists the traces
started during it, so from a replay you can open the requests it made. A session where the SDK
records an error is flagged, which is how you find the ones worth watching — nobody watches a
recording of a session that went fine.

### Privacy

**Every input is masked by default** — `maskAllInputs` is `true` unless you turn it off, and
turning it off ships whatever people type to a monitoring service.

```typescript
ZharpReplay.start({
  sampleRate: 0.1,
  // Never recorded at all — their space is kept, their contents never captured.
  blockSelector: '.payment-iframe, .document-preview',
  // Recorded, but with the text masked.
  maskTextSelector: '.customer-name',
  // The blunt option: mask every piece of text on the page.
  maskAllText: false,
});
```

`blockSelector` is the stronger of the two and the right one for anything genuinely sensitive:
masked text is still recorded as a shape of the right length, while a blocked element is never
serialised.

### Sampling and cost

`sampleRate` is decided once, when recording starts. A session recorded for half its length is a
video that cuts out mid-sentence, so the decision is never revisited.

Recordings are the largest thing this SDK sends. Frames are batched and shipped every 10 seconds
(or every 500 events), stored compressed, and kept for at most 7 days.

Each batch is numbered when it is cut. A batch that fails with a network error or a 5xx is retried,
unchanged and under the same number, on the next flush — up to 3 attempts — and then dropped; a 4xx
drops it at once. Only one flush runs at a time.

### Controlling it by hand

```typescript
ZharpReplay.markError();                    // flag this session as one worth watching
ZharpReplay.linkTrace(traceId);             // associate a trace you started yourself
await ZharpReplay.stop();                   // stop and send what is left
ZharpReplay.isRecording;                    // whether this session was sampled in
```

---

## Logging methods

```typescript
ZharpLogger.debug('Cache miss', { key: 'user:42' });
ZharpLogger.info('Request received', { method: 'POST', path: '/checkout' });
ZharpLogger.warn('Rate limit approaching', { remaining: 5 });
ZharpLogger.error('Stripe webhook failed', { eventId: 'evt_123' });
ZharpLogger.fatal('Database connection lost');
```

### With an explicit service name

Override the default service for a specific log:

```typescript
ZharpLogger.log('payment-service', 'error', 'Charge declined', { amount: 5000 });
```

---

## What each log looks like

Every log entry sent to Zharp includes:

```json
{
  "service": "my-frontend",
  "level": "error",
  "message": "Payment failed",
  "timestamp": "2026-06-14T09:14:32.041Z",
  "environment": "production",
  "version": "1.4.2",
  "source": "web",
  "metadata": {
    "orderId": 99,
    "sessionId": "a3f8c2d1-...",
    "environment": "production",
    "context": {
      "url": "https://app.zharp.io/checkout",
      "route": "/checkout",
      "userAgent": "Mozilla/5.0 ...",
      "screen": "1920x1080",
      "appVersion": "1.4.2"
    }
  }
}
```

In Node.js, `context` contains server info instead:

```json
"context": {
  "hostname": "pod-abc-123",
  "pid": "42",
  "nodeVersion": "v20.11.0",
  "platform": "linux",
  "appVersion": "1.4.2"
}
```

`environment`, `version` and `source` appear only when configured (or, in Node, found in the environment). `environment` is also repeated in `metadata` for older Zharp backends.

Your custom metadata fields (`orderId: 99`) sit at the top level of `metadata` alongside `sessionId` and `environment`. The auto-captured browser/Node context lives under a separate `context` key so it never collides with your own fields. Inside a trace, `traceId` and `spanId` are added too.

`message` is always a non-empty string: objects are sent as JSON, an `Error` as its message, anything else through `String()`, and an empty message as `(empty message)`.

---

## Auto-capture

Auto-capture is enabled by default. It hooks into global error handlers so unhandled errors are automatically sent to Zharp without any extra code.

| Event | Browser | Node.js |
|---|---|---|
| Unhandled JS errors | `window.onerror` | `process.uncaughtException` |
| Unhandled promise rejections | `unhandledrejection` | `process.unhandledRejection` |
| `console.error` calls | opt-in | opt-in |

To disable specific captures:

```typescript
ZharpLogger.init({
  apiKey: '...',
  service: '...',
  autoCapture: {
    errors: false,               // Don't capture uncaught errors
    unhandledRejections: false,  // Don't capture promise rejections
    consoleErrors: true,         // Do capture console.error calls
  },
});
```

---

## SPA route tracking

In single-page apps, call `refreshContext()` after each route change so that `context.url` and `context.route` stay accurate for subsequent logs.

**React Router:**
```typescript
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ZharpLogger } from '@zharp/logs';

function RouteTracker() {
  const location = useLocation();
  useEffect(() => ZharpLogger.refreshContext(), [location.pathname]);
  return null;
}
```

**Vue Router:**
```typescript
router.afterEach(() => ZharpLogger.refreshContext());
```

**Next.js (App Router):**
```typescript
// In your root layout component
'use client';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

export default function Layout({ children }) {
  const pathname = usePathname();
  useEffect(() => ZharpLogger.refreshContext(), [pathname]);
  return children;
}
```

---

## Manual flush and teardown

```typescript
// Flush the queue immediately (normally handled automatically)
await ZharpLogger.flush();

// Tear down cleanly — flushes remaining logs, removes all event listeners
// Useful before hot-reloads in development
await ZharpLogger.destroy();
```

---

## Integrations

Use `@zharp/logs` as a transport layer alongside your existing logger so logs flow to Zharp without replacing your current setup.

### Winston

Install `winston-transport` — it's bundled with Winston but pnpm's strict module resolution requires it to be declared explicitly:

```bash
pnpm add winston-transport
```

```typescript
import Transport from 'winston-transport';
import { ZharpLogger } from '@zharp/logs';

export class ZharpTransport extends Transport {
  log(info: any, callback: () => void) {
    const { level, message, ...meta } = info;
    ZharpLogger.log(level, String(message), Object.keys(meta).length ? meta : undefined);

    // Required — tells Winston this transport has finished processing the log.
    // Without this, Winston can't track delivery and may stall under high volume.
    setImmediate(() => this.emit('logged', info));

    callback();
  }
}
```

```typescript
import winston from 'winston';
import { ZharpTransport } from './zharp-transport';

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new ZharpTransport(), // logs go to console AND Zharp
  ],
});
```

### Pino

```typescript
import pino from 'pino';
import { Writable } from 'stream';
import { ZharpLogger } from '@zharp/logs';

// Pino uses numeric levels — map them to Zharp level strings
const PINO_LEVELS: Record<number, string> = {
  10: 'debug', // trace → debug
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const zharpStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const { level, msg, ...meta } = JSON.parse(chunk.toString());
      // `pino.info({ orderId })` writes a line with no `msg` at all.
      const message = msg ?? (meta.err?.message || JSON.stringify(meta));
      ZharpLogger.log(PINO_LEVELS[level] ?? 'info', String(message), meta);
    } catch {}
    callback();
  },
});

const logger = pino(
  pino.multistream([
    { stream: process.stdout },     // keep existing output
    { stream: zharpStream },        // also send to Zharp
  ])
);
```

### NestJS built-in logger

NestJS exposes a `LoggerService` interface. Implement it to route all NestJS framework logs (bootstrap messages, request logs, errors) through Zharp:

```typescript
// zharp-nest-logger.ts
import { LoggerService } from '@nestjs/common';
import { ZharpLogger } from '@zharp/logs';

// Named ZharpNestLogger so it does not shadow the ZharpLogger it forwards to.
export class ZharpNestLogger implements LoggerService {
  log(message: any, context?: string) {
    ZharpLogger.info(String(message), { context });
  }
  error(message: any, trace?: string, context?: string) {
    ZharpLogger.error(String(message), { trace, context });
  }
  warn(message: any, context?: string) {
    ZharpLogger.warn(String(message), { context });
  }
  debug(message: any, context?: string) {
    ZharpLogger.debug(String(message), { context });
  }
  verbose(message: any, context?: string) {
    ZharpLogger.debug(String(message), { context });
  }
}
```

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZharpLogger } from '@zharp/logs';
import { ZharpNestLogger } from './zharp-nest-logger';

async function bootstrap() {
  ZharpLogger.init({
    apiKey: process.env.ZHARP_API_KEY,
    service: 'my-api',
    environment: process.env.NODE_ENV,
  });

  const app = await NestFactory.create(AppModule, {
    logger: new ZharpNestLogger(),
  });

  await app.listen(3000);
}
bootstrap();
```

### Express / Morgan

```typescript
import express from 'express';
import morgan from 'morgan';
import { ZharpLogger } from '@zharp/logs';

const app = express();

// Pipe morgan HTTP logs into Zharp
app.use(
  morgan('combined', {
    stream: {
      write: (message: string) => {
        ZharpLogger.info(message.trim(), { source: 'http' });
      },
    },
  })
);
```

---

## TypeScript

All methods are fully typed. No additional `@types/` package required.

```typescript
import { ZharpLogger, ZharpConfig, LogLevel, LogEntry } from '@zharp/logs';
```

---

## How it works

**Batching** — Calling `ZharpLogger.info(...)` never makes an immediate network request (except `error` and `fatal`, which flush straight away). Logs go into an in-memory queue of up to 500 entries and are flushed every 5 seconds, up to `maxBatchSize` at a time. Each request is capped at about 1 MB; a larger batch is split across several requests.

**Authentication** — Requests send the key in an `X-API-KEY` header to `/agent/logs`, `/agent/traces` or `/agent/replay`. The only exception is `sendBeacon`, which cannot set headers and so puts the key in the path (`/agent/logs/<key>`).

**Retry** — A log request that fails with a network error or a 5xx is tried 3 times in all: once, then again after 2 s, then after 4 s. Spans get 2 attempts, 1 s apart. 4xx responses are not retried, since those indicate a problem with the request itself that won't be fixed by retrying.

**Delivery on page close** — When a browser tab closes, in-flight `fetch` requests can be cancelled. On `visibilitychange` (hidden) and `beforeunload` the SDK sends everything still queued with `navigator.sendBeacon`, in chunks under 60 KB (browsers cap beacons at 64 KB). If the browser refuses a beacon, that chunk is sent with a `keepalive` fetch, and failing that with an ordinary request — best effort, but nothing still sendable is dropped.

**Automatic context** — The SDK captures environment details once at startup and attaches them to every log under a `context` field so you never have to pass them manually:

- Browser: `url`, `route`, `userAgent`, `screen` resolution
- Node.js: `hostname` (the pod name in Docker/k8s), `pid`, `nodeVersion`, `platform`

**Session tracking** — A `sessionId` is generated once per page load and attached to every log, letting you trace all events from a single user session across your entire stack.

**Size** — The main entry is about 28 KB minified (about 9 KB gzipped) in the 1.4.0 ESM build. Session replay is a separate entry point (`@zharp/logs/replay`, about 6 KB minified plus `rrweb`), so it is only bundled if you import it.

**Scope** — This package sends logs, traces and recordings. It does not manage monitors, alerts or incidents.

---

## License

MIT © [Zharp](https://zharp.io)

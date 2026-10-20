# @zharp/logs

The official JavaScript logging SDK for [Zharp](https://zharp.io). Start it with one call — or none, in Node — and every uncaught error and unhandled promise rejection in your app lands on your Zharp dashboard without another line of code. Log anything else from anywhere, standalone or by plugging it straight into your existing Winston, Pino, or NestJS logger as a transport. No log pipeline to manage, no infrastructure to set up — just your logs, live on your Zharp dashboard.

For distributed tracing and session replay, add [`@zharp/apm`](https://www.npmjs.com/package/@zharp/apm). The two work alone or together; together, every log carries the trace it was written in.

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

### Node.js — zero config

Set the key and a service name in the environment:

```bash
ZHARP_API_KEY=your-api-key
ZHARP_SERVICE=checkout-api
ZHARP_ENV=production            # or leave it to NODE_ENV
```

Then start the SDK without touching your code:

```bash
node --require @zharp/logs/init app.js     # CommonJS
node --import @zharp/logs/init app.js      # ES modules
```

…or with one line at the top of your entry file:

```typescript
import { ZharpLogger } from '@zharp/logs';

ZharpLogger.init();   // reads ZHARP_* from the environment
```

Either way the SDK says so on startup:

```
[Zharp] Logging active — service "checkout-api", environment "production"
```

From here on, uncaught exceptions and unhandled promise rejections are sent to Zharp — nothing
else to write. Importing the package on its own starts nothing; it is `init()`, or the `/init`
entry, that does.

### Browser / React / Vue / Next.js

A browser has no environment variables, so pass the settings:

```typescript
import { ZharpLogger } from '@zharp/logs';

// Call once at app startup (e.g. main.ts, _app.tsx, index.js)
ZharpLogger.init({
  apiKey: 'your-api-key',
  service: 'my-frontend',
  environment: 'production',
  appVersion: '1.4.2',
});
```

Uncaught errors (`window.onerror`) and unhandled rejections are captured from this point.

### Log anywhere

```typescript
ZharpLogger.info('User signed in', { userId: 42 });
ZharpLogger.warn('Slow network detected', { latencyMs: 3200 });
ZharpLogger.error('Payment failed', { orderId: 99, reason: 'insufficient_funds' });
```

---

## Starting up

`init()` works the way dd-trace's does:

- **Importing starts nothing.** Only `init()` — or `@zharp/logs/init` — hooks error handlers and
  starts the flush timer.
- **No arguments in Node** reads the environment (table below). Anything passed to `init()`
  overrides it, setting by setting.
- **One line on success**, in Node and in the browser (via `console.info`):
  `[Zharp] Logging active — service "checkout-api", environment "production"`.
- **No API key, nothing starts.** Instead of throwing, it prints
  `[Zharp] No API key found — set ZHARP_API_KEY or call ZharpLogger.init({ apiKey })` and every
  logging call is a no-op — so a missing key in a test or a preview environment never stops the app.
- **`ZHARP_DISABLED=true`** turns `init()` off whatever the code says, and prints that it did.
- **Calling `init()` again replaces the running setup.** The old one is torn down — error handlers
  removed, its queued logs still sent with its own key — and the new configuration takes over.
  There is no "already initialized" refusal.

### Environment variables (Node)

| Variable | Option | Notes |
|---|---|---|
| `ZHARP_API_KEY` | `apiKey` | |
| `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME` | `service` | Without any, logs are filed under `unknown-service`, with a warning |
| `ZHARP_ENV`, then `NODE_ENV` | `environment` | No default — unset means no tag |
| `ZHARP_VERSION` | `appVersion` | |
| `ZHARP_SOURCE` | `source` | |
| `ZHARP_ENDPOINT` | `endpoint` | Default `https://api.zharp.io/api/v1` |
| `ZHARP_DISABLED` | — | `true` or `1`: start nothing |

A browser reads none of them — bundles often carry a `process.env` baked in at build time, which
would tag a page with the build machine's settings.

### Preloading with `--require` / `--import`

`@zharp/logs/init` is a tiny module that calls `ZharpLogger.init()` from the environment, and
nothing else. It ships as both CommonJS and ESM:

```bash
node --require @zharp/logs/init dist/main.js
node --import @zharp/logs/init dist/main.mjs
NODE_OPTIONS="--require @zharp/logs/init" npm start
```

The application then uses `ZharpLogger` as usual — it gets the logger that was started, whether it
`require`s the package or `import`s it.

---

## Configuration

Everything is optional in Node; in the browser, `apiKey` and `service` are needed.

```typescript
ZharpLogger.init({
  apiKey: 'your-api-key',       // An "Ingest only" Zharp API key
  service: 'my-service',        // Service name shown in the log viewer
  environment: 'production',    // `environment` tag on every log. No default
  appVersion: '1.4.2',          // `version` tag on every log
  source: 'web',                // `source` tag on every log
  endpoint: 'https://api.zharp.io/api/v1', // Zharp API base URL. Default shown
  flushInterval: 5000,          // How often to flush the queue (ms). Default: 5000
  maxBatchSize: 50,             // Max logs taken from the queue per flush. Default: 50

  // Auto-capture (all enabled by default except consoleErrors)
  autoCapture: {
    errors: true,               // window.onerror / process.uncaughtException
    unhandledRejections: true,  // unhandledrejection / process.unhandledRejection
    consoleErrors: false,       // Wrap console.error (opt-in)
  },
});
```

### Tags

`environment`, `version` (from `appVersion`) and `source` are sent as top-level tags on every log —
the fields the log viewer filters by. A tag that is not configured is not sent; nothing defaults to
`'production'`.

---

## Auto-capture

Auto-capture is on as soon as `init()` succeeds. It hooks into global error handlers so unhandled errors are automatically sent to Zharp without any extra code.

| Event | Browser | Node.js |
|---|---|---|
| Unhandled JS errors | `window.onerror` | `process.uncaughtException` |
| Unhandled promise rejections | `unhandledrejection` | `process.unhandledRejection` |
| `console.error` calls | opt-in | opt-in |

Existing handlers keep working: a previous `window.onerror` is still called, and Node's own
handlers still run.

To change what is captured:

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

## Logging methods

```typescript
ZharpLogger.debug('Cache miss', { key: 'user:42' });
ZharpLogger.info('Request received', { method: 'POST', path: '/checkout' });
ZharpLogger.warn('Rate limit approaching', { remaining: 5 });
ZharpLogger.error('Stripe webhook failed', { eventId: 'evt_123' });
ZharpLogger.fatal('Database connection lost');
```

`error` and `fatal` are sent straight away; everything else is batched.

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

Your custom metadata fields (`orderId: 99`) sit at the top level of `metadata` alongside `sessionId` and `environment`. The auto-captured browser/Node context lives under a separate `context` key so it never collides with your own fields.

`message` is always a non-empty string: objects are sent as JSON, an `Error` as its message, anything else through `String()`, and an empty message as `(empty message)`.

### With @zharp/apm

When [`@zharp/apm`](https://www.npmjs.com/package/@zharp/apm) is running in the same process or page, every log written
inside a trace also carries `metadata.traceId` and `metadata.spanId` — search the logs for the
trace you are looking at, or open the trace from the log. Both packages use the same `sessionId`,
warnings and errors join APM's breadcrumb trail, and an error flags the session recording when
replay is on. Without APM none of this applies, and nothing of it is bundled.

Start the logger first and `ZharpAPM.init()` needs no options: it reuses the logger's key,
service, environment, version, source and endpoint.

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
// Useful before hot-reloads in development, or at the end of a test
await ZharpLogger.destroy();

// Whether init() succeeded and logs are being sent
ZharpLogger.isActive;
```

A Node script that never calls `destroy()` still exits on its own: the flush timer does not keep
the process alive, and whatever is still queued is sent on `beforeExit`.

---

## Integrations

Use `@zharp/logs` as a transport layer alongside your existing logger so logs flow to Zharp without replacing your current setup. Each recipe assumes the SDK was started — by `ZharpLogger.init()` or `--require @zharp/logs/init`.

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
  // Key, service and environment from ZHARP_API_KEY / ZHARP_SERVICE / ZHARP_ENV.
  // Or pass them: ZharpLogger.init({ apiKey, service: 'my-api', environment: process.env.NODE_ENV })
  ZharpLogger.init();

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

**Authentication** — Requests send the key in an `X-API-KEY` header to `/agent/logs`, with `X-Zharp-SDK: js-logs/1.1.0`. The only exception is `sendBeacon`, which cannot set headers and so puts the key in the path (`/agent/logs/<key>`).

**Retry** — A request that fails with a network error or a 5xx is tried 3 times in all: once, then again after 2 s, then after 4 s. 4xx responses are not retried, since those indicate a problem with the request itself that won't be fixed by retrying.

**Delivery on page close** — When a browser tab closes, in-flight `fetch` requests can be cancelled. On `visibilitychange` (hidden) and `beforeunload` the SDK sends everything still queued with `navigator.sendBeacon`, in chunks under 60 KB (browsers cap beacons at 64 KB). If the browser refuses a beacon, that chunk is sent with a `keepalive` fetch, and failing that with an ordinary request — best effort, but nothing still sendable is dropped.

**Automatic context** — The SDK captures environment details once at startup and attaches them to every log under a `context` field so you never have to pass them manually:

- Browser: `url`, `route`, `userAgent`, `screen` resolution
- Node.js: `hostname` (the pod name in Docker/k8s), `pid`, `nodeVersion`, `platform`

**Session tracking** — A `sessionId` is generated once per page load and attached to every log, letting you trace all events from a single user session across your entire stack.

**Size** — About 10 KB minified (about 4 KB gzipped) in the 1.1.0 ESM build, with no dependencies. No tracing or replay code is in this package.

**Scope** — This package sends logs. Tracing and session replay are [`@zharp/apm`](https://www.npmjs.com/package/@zharp/apm). Neither manages monitors, alerts or incidents.

---

## License

MIT © [Zharp](https://zharp.io)

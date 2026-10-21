# @zharp/logs

Send your app's logs to [Zharp](https://zharp.io). Uncaught errors and unhandled promise
rejections are sent automatically; everything else you log yourself, from anywhere in your code.
Works in Node.js and in the browser.

Full documentation: [zharp.io/docs/sdks/logs](https://zharp.io/docs/sdks/logs)

---

## 1. Install

```bash
npm install @zharp/logs
```

## 2. Get an API key

1. In Zharp, open **Integrations & API** and choose **Main API keys**.
2. Click **Create API key**, give it a name, and tick **Ingest only**. That key can send logs but
   can't read anything, so it's safe in a server's environment or a browser bundle.
3. Click **Create key** and copy the key — it's shown only once.

<p>
  <img src="https://www.zharp.io/images/docs/api-key-create.png" alt="Create API key, with Ingest only ticked" width="48%">
  <img src="https://www.zharp.io/images/docs/api-key-created.png" alt="The new key, shown once with a Copy button" width="48%">
</p>

## 3. Start it

**Node.js** — set the key in the environment:

```bash
ZHARP_API_KEY=your-ingest-only-key
ZHARP_SERVICE=checkout-api        # optional — defaults to the name in your package.json
ZHARP_ENV=production              # optional — defaults to NODE_ENV
```

then call `init()` once, as early as possible in your app:

```typescript
import { ZharpLogger } from '@zharp/logs';

ZharpLogger.init();
```

or, without touching your code, start Node with:

```bash
node --import @zharp/logs/init app.js
```

**Browser** (React, Vue, Next.js, …) — there is no environment to read, so pass the key and a
service name:

```typescript
import { ZharpLogger } from '@zharp/logs';

ZharpLogger.init({ apiKey: 'your-ingest-only-key', service: 'checkout-web' });
```

When it starts, it prints one line so you know it's working:

```
[Zharp] Logging active — service "checkout-api", environment "production"
```

With no API key it prints how to give it one and sends nothing.

## 4. Log

```typescript
ZharpLogger.info('User signed in', { userId: 42 });
ZharpLogger.warn('Slow network detected', { latencyMs: 3200 });
ZharpLogger.error('Payment failed', { orderId: 99, reason: 'insufficient_funds' });
```

`debug` and `fatal` are there too. The object is optional and is kept with the log.

## 5. See your logs

Sign in at [zharp.io](https://zharp.io/login), open **Logs**, and pick your service in the
service dropdown.

![The Logs page on zharp.io, showing lines from the zharp-backend service](https://www.zharp.io/images/docs/logs-dashboard.png)

New lines appear as they arrive. Click one to see everything it carried. To be told when
something shows up, add a [log monitor](https://zharp.io/docs/monitors/logs).

---

## Options

Everything is optional in Node; in the browser, `apiKey` and `service` are needed.

| Option | Environment variable | Default |
|---|---|---|
| `apiKey` | `ZHARP_API_KEY` | — |
| `service` | `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME` | the `name` in your app's `package.json` (without its scope), else `unknown-service` |
| `environment` | `ZHARP_ENV`, then `NODE_ENV` | none |
| `appVersion` | `ZHARP_VERSION` | none |
| `source` | `ZHARP_SOURCE` | none |
| `captureConsole` | `ZHARP_CAPTURE_CONSOLE` | off — see below |
| `autoCapture` | — | `{ errors: true, unhandledRejections: true }` |
| `flushInterval` | — | `5000` ms |
| `maxBatchSize` | — | `50` |
| `endpoint` | `ZHARP_ENDPOINT` | `https://api.zharp.io/api/v1` |

An option passed to `init()` wins over the environment. `ZHARP_DISABLED=true` turns the SDK off.

## What's sent automatically

- **Uncaught errors and unhandled promise rejections**, as `error` logs with their stack. In Node, a
  crash is still a crash: when your app has no handler of its own, the error is sent first, then the
  process exits as Node would. Turn either off with `autoCapture: { errors: false }` or
  `{ unhandledRejections: false }`.
- **Console output — only if you ask.** `captureConsole: 'all'` (or `['warn', 'error']`) also sends
  what your app writes to the console; the console still prints as before. Use it where nothing
  else collects your app's output — a browser, a serverless function. Where the
  [Zharp agent](https://zharp.io/docs/agent/setup) already collects it, leave it off, or every line
  arrives twice.

## Already using a logger?

Keep it, and add one transport that forwards to Zharp.

**Winston** (`npm install winston-transport`):

```typescript
import Transport from 'winston-transport';
import { ZharpLogger } from '@zharp/logs';

export class ZharpTransport extends Transport {
  log(info: any, callback: () => void) {
    const { level, message, ...meta } = info;
    ZharpLogger.log(level, String(message), meta);
    setImmediate(() => this.emit('logged', info));
    callback();
  }
}

// winston.createLogger({ transports: [new winston.transports.Console(), new ZharpTransport()] })
```

**Pino:**

```typescript
import pino from 'pino';
import { Writable } from 'stream';
import { ZharpLogger } from '@zharp/logs';

const LEVELS: Record<number, string> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

const zharp = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const { level, msg, ...meta } = JSON.parse(chunk.toString());
      ZharpLogger.log((LEVELS[level] ?? 'info') as any, String(msg ?? JSON.stringify(meta)), meta);
    } catch {}
    callback();
  },
});

const logger = pino(pino.multistream([{ stream: process.stdout }, { stream: zharp }]));
```

**NestJS** — give Nest a logger that forwards to Zharp:

```typescript
import { LoggerService } from '@nestjs/common';
import { ZharpLogger } from '@zharp/logs';

export class ZharpNestLogger implements LoggerService {
  log(message: any, context?: string) { ZharpLogger.info(String(message), { context }); }
  error(message: any, trace?: string, context?: string) { ZharpLogger.error(String(message), { trace, context }); }
  warn(message: any, context?: string) { ZharpLogger.warn(String(message), { context }); }
  debug(message: any, context?: string) { ZharpLogger.debug(String(message), { context }); }
  verbose(message: any, context?: string) { ZharpLogger.debug(String(message), { context }); }
}

// main.ts: ZharpLogger.init(); then NestFactory.create(AppModule, { logger: new ZharpNestLogger() })
```

## Tracing and session replay

Add [`@zharp/apm`](https://www.npmjs.com/package/@zharp/apm). Started together, every log carries
the trace it was written in.

## License

MIT © [Zharp](https://zharp.io)

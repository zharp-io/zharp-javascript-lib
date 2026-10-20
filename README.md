# Zharp JavaScript SDKs

The official JavaScript and TypeScript SDKs for [Zharp](https://zharp.io). Two packages, each
useful alone, better together:

| Package | What it does |
|---|---|
| [`@zharp/logs`](packages/logs/README.md) | Logging. Captures uncaught errors and unhandled rejections with zero config, and gives you `info`/`warn`/`error`/… to log anywhere — standalone or as a Winston, Pino or NestJS transport. |
| [`@zharp/apm`](packages/apm/README.md) | Distributed tracing (fetch/XHR, Node http in and out, manual spans, queue workers) and session replay. |

```bash
npm install @zharp/logs            # logs and error capture
npm install @zharp/apm             # tracing and session replay
```

In Node, both start from the environment with no code changes:

```bash
ZHARP_API_KEY=your-api-key ZHARP_SERVICE=checkout-api \
  node --require @zharp/logs/init --require @zharp/apm/init app.js
```

```
[Zharp] Logging active — service "checkout-api", environment "production"
[Zharp] APM active — service "checkout-api", environment "production"
```

In the browser, call `ZharpLogger.init({ apiKey, service })` and then `ZharpAPM.init()`, which
reuses the logger's settings. Used together, every log carries the trace it was written in and both
share one session id; neither package imports the other, so an app that uses only one never bundles
the other.

---

## Repository

A pnpm workspace:

```
packages/logs   @zharp/logs
packages/apm    @zharp/apm
internal        delivery, session id, message coercion, environment reading — bundled into
                each package at build time, never published on its own
test            end-to-end checks against the built packages and a fake backend
```

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm test
```

## License

MIT © [Zharp](https://zharp.io)

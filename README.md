# Zharp JavaScript SDKs

The official JavaScript and TypeScript SDKs for [Zharp](https://zharp.io) Application Monitoring. One package per runtime:

| Package | What it does |
|---|---|
| [`@zharp/browser`](packages/browser/README.md) | Errors, logs, page load / navigation / click spans, fetch and XHR tracing into your back end, sessions and session replay. Also a script tag (`dist/zharp.min.js`). |
| [`@zharp/node`](packages/node/README.md) | The OpenTelemetry Node SDK configured for Zharp: request, HTTP and database spans, logs (console, pino, winston, bunyan), errors — with the browser's session and user on every record. |

```bash
npm install @zharp/browser   # in the web app
npm install @zharp/node      # in the server
```

Both send OpenTelemetry (OTLP) to the same endpoint with the app's key. A request from a page to your API carries `traceparent` and `baggage`, so the page's spans and the server's are one trace, and the server's logs and errors are filed under the user and session that caused them.

`@zharp/logs` and `@zharp/apm` are the previous generation and will be deprecated.

---

## Repository

A pnpm workspace:

```
packages/browser  @zharp/browser
packages/node     @zharp/node
packages/logs     @zharp/logs (to be deprecated)
packages/apm      @zharp/apm (to be deprecated)
internal          environment reading and other internals, bundled into each package at build time
test              checks against the built packages and a fake backend (run.mjs: logs/apm,
                  unified.mjs: browser/node); e2e/ runs browser → node against a real stack
```

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm test
```

End to end against a running Zharp stack (keys from the environment, never from a file):

```bash
ZHARP_E2E_BROWSER_KEY=zpk_… ZHARP_E2E_NODE_KEY=zpk_… \
ZHARP_E2E_CLICKHOUSE='http://localhost:8123/?user=…&password=…&database=zharp' \
  pnpm test:e2e
```

## License

MIT © [Zharp](https://zharp.io)

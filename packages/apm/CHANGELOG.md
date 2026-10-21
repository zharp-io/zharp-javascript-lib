# Changelog

## 1.0.1

- **The service name defaults to your app's name.** In Node, with no `service` option, a
  started `@zharp/logs`, `ZHARP_SERVICE` or `OTEL_SERVICE_NAME`, it is the `name` in the app's
  package.json (without its scope) instead of `'unknown-service'`.

## 1.0.0

First release. Tracing and session replay used to be part of `@zharp/logs` in builds that were
never published (1.1.0 to 1.4.0); they now have a package of their own, so an app that only logs
never ships a tracer, and one that traces never ships a log queue.

### Tracing

- `ZharpAPM.init()` traces `fetch` and `XMLHttpRequest` in the browser and `http`/`https` in and out
  in Node, propagating W3C `traceparent` (same-origin only in the browser unless `propagateTo` says
  otherwise).
- `startActiveSpan`, `startSpan`, `traceHeaders`, `currentTraceId`, and
  `continueTrace(traceparent, fn, name)` — with a name, `fn` runs inside a `CONSUMER` span, so queue
  workers get request-like spans. The span API works before `init()` too: the work runs, nothing is
  recorded, and `startSpan` always returns a span.
- Spans carry the resource attributes `service.name`, `deployment.environment.name` (and the older
  `deployment.environment`), `service.version` and `zharp.source`.
- Breadcrumbs (clicks, navigations, requests, and warning/error logs from `@zharp/logs`) and, in
  Node, source context are attached to recorded exceptions. Nothing typed is captured.
- **Native ESM in Node** (Node 20.16+ / 22.3+): built-ins are loaded with
  `process.getBuiltinModule`, so the ESM build patches `http` and keeps the active span per request
  across `await`. The CJS build falls back to `require`.
- Requests send `X-API-KEY` to `/agent/traces` with `X-Zharp-SDK: js-apm/1.0.0`, are capped at about
  1 MB, and are cut under 60 KB for unload beacons, with a `keepalive` fetch fallback.
- A Node script that never shuts down still exits; buffered spans are sent on `beforeExit`.

### Session replay

- Part of this package, off unless asked for: `ZharpAPM.init({ replay: { sampleRate, ... } })` or
  `ZharpAPM.startReplay(options)`. The recorder and rrweb are loaded with a dynamic `import()`, so
  bundlers split them into a chunk fetched only when replay starts. A session sampled out never
  loads it.
- Privacy defaults: every input masked; `blockSelector`, `maskTextSelector`, `maskAllText` and
  `beforeSend` for the rest.
- Each batch is numbered when it is cut and retried unchanged under that number (up to 3 attempts,
  5xx and network errors only); a dropped batch's number is never reused, and only one flush runs at
  a time. Numbering carries on across `init()` calls.
- A session is flagged when an uncaught error happens or `@zharp/logs` records an error.

### Startup

- Importing starts nothing. `init()` with no arguments uses the settings `@zharp/logs` was started
  with, then (Node) `ZHARP_API_KEY`, `ZHARP_SERVICE`/`OTEL_SERVICE_NAME`, `ZHARP_ENV`/`NODE_ENV`,
  `ZHARP_VERSION`, `ZHARP_SOURCE`, `ZHARP_ENDPOINT`. Options passed to `init()` override them.
- `@zharp/apm/init` for `node --require` / `node --import`, so `http` is patched before the
  application loads.
- Prints `[Zharp] APM active — service "…", environment "…"` (with the replay sample rate when
  replay is on), a hint when no API key is found, and that it is disabled when
  `ZHARP_DISABLED=true`. Calling `init()` again replaces the running setup.

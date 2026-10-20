# Changelog

## 1.2.0

### Added

- **`captureConsole`** — also send what the app writes to the console: `'all'`, or the methods to
  copy, e.g. `['warn', 'error']`. Off by default; the console output is unchanged. In Node,
  `ZHARP_CAPTURE_CONSOLE` (`all` or `warn,error`) turns it on without code. `log`/`info` become
  `info` logs, `warn` `warn`, `error` `error`, `debug` `debug`; an Error argument's stack is kept
  in the metadata. The SDK's own `[Zharp]` lines are never sent, and the activation line says when
  the console is captured.

## 1.1.0

Everything since 1.0.9, the last published release. Versions 1.1.0 to 1.4.0 of this package were
built but never published; they also carried tracing and session replay, which now live in their
own package, [`@zharp/apm`](https://www.npmjs.com/package/@zharp/apm). This release is logging only.

Existing 1.0.x code keeps working unchanged: `ZharpLogger.init({ apiKey, service, environment,
appVersion, autoCapture, flushInterval, maxBatchSize })` and every logging method.

### Added

- **Zero-config startup in Node.** `ZharpLogger.init()` with no arguments reads `ZHARP_API_KEY`,
  `ZHARP_SERVICE` (then `OTEL_SERVICE_NAME`), `ZHARP_ENV` (then `NODE_ENV`), `ZHARP_VERSION`,
  `ZHARP_SOURCE` and `ZHARP_ENDPOINT`. Options passed to `init()` override them one by one. In the
  browser nothing is read from the environment.
- **`@zharp/logs/init`**, for starting without code changes: `node --require @zharp/logs/init app.js`
  (CommonJS) or `node --import @zharp/logs/init app.js` (ES modules). An app that `require`s the
  package after an `--import` preload gets the same, already started logger.
- **An activation line.** A successful `init()` prints
  `[Zharp] Logging active — service "…", environment "…"` (with `console.info` in the browser).
- `ZHARP_DISABLED=true` turns `init()` off and says so.
- `isActive`, whether `init()` succeeded.
- Top-level `environment`, `version` (from `appVersion`) and `source` tags on every log entry.
  `metadata.environment` is kept for older backends.
- `source` option, sent as the log `source` tag.
- `endpoint` option (default `https://api.zharp.io/api/v1`).
- When `@zharp/apm` is running, logs carry `traceId`/`spanId` and share its `sessionId`, and
  `ZharpAPM.init()` with no options reuses the logger's settings. Nothing of APM is bundled here.

### Changed

- **No API key no longer means a broken setup.** `apiKey` is optional in the types; without one
  (from the options or `ZHARP_API_KEY`) `init()` starts nothing and prints
  `[Zharp] No API key found — set ZHARP_API_KEY or call ZharpLogger.init({ apiKey })`.
- **Calling `init()` again replaces the running setup** instead of warning "Already initialized".
  Handlers and timers are torn down first, and logs the old setup had queued are still sent with
  the old key.
- **No default environment.** `environment` used to default to `'production'`, which put development
  traffic on production dashboards. In Node it now falls back to `ZHARP_ENV`, then `NODE_ENV`; in the
  browser it is unset unless configured.
- **`service` is optional in Node.** It falls back to `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME`. With
  no service at all the SDK warns and uses `'unknown-service'` instead of failing. `appVersion` falls
  back to `ZHARP_VERSION`.
- **API key in a header.** Requests send `X-API-KEY` to `/agent/logs`. Only `sendBeacon`, which
  cannot set headers, still uses `/agent/logs/<key>`. Use an "Ingest only" key.
- **Log request body is `{ logs }` only.** The `hostname`, `os` and `version` fields made every app
  using the SDK show up as an agent host. Requests are identified by the `X-Zharp-SDK: js-logs/1.1.0`
  header.

### Fixed

- **A crashing Node app still crashes.** Listening for `uncaughtException` and
  `unhandledRejection` stopped Node exiting, so an app kept running in whatever state the error left
  it. When the app has no handler of its own, the SDK now sends the error and what is queued (up to
  2 seconds), prints it and exits with code 1, as Node would have.
- **A Node script that never calls `destroy()` now exits.** The flush timer kept the process alive;
  it no longer does, and what is still queued is sent on `beforeExit`.
- Messages are always non-empty strings, on every path (logging methods, `log()`, auto-capture,
  `console.error()` with no arguments). A non-string message used to get the whole batch rejected.
- Requests are capped at about 1 MB and large batches are split. Unload beacons are cut under 60 KB;
  a refused beacon falls back to a `keepalive` fetch, then an ordinary request. Unload now sends the
  whole queue, not one batch.
- `destroy()` flushes the entire queue rather than a single batch.

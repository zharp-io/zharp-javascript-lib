# Changelog

## 1.4.0

The first published release since 1.0.9. Versions 1.1.0 to 1.3.0 were never published to npm, so
**1.4.0 is the first release with distributed tracing, breadcrumbs, source context and session
replay** (`@zharp/logs/replay`), in addition to the changes below.

### Changed

- **No default environment.** `environment` used to default to `'production'`, which put development
  traffic on production dashboards. In Node it now falls back to `ZHARP_ENV`, then `NODE_ENV`; in the
  browser it is unset unless configured.
- **`service` is optional in Node.** It falls back to `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME`. With
  no service at all the SDK warns and uses `'unknown-service'` instead of failing. `appVersion` falls
  back to `ZHARP_VERSION`.
- **API key in a header.** Requests send `X-API-KEY` to `/agent/logs`, `/agent/traces` and
  `/agent/replay`. Only `sendBeacon`, which cannot set headers, still uses `/agent/<type>/<key>`.
  Use an "Ingest only" key.
- **Log request body is `{ logs }` only.** The `hostname`, `os` and `version` fields made every app
  using the SDK show up as an agent host. Requests are identified by the `X-Zharp-SDK: js/1.4.0`
  header, now sent with the same version by logs, traces and replay.

### Added

- Top-level `environment`, `version` (from `appVersion`) and `source` tags on every log entry.
  `metadata.environment` is kept for older backends.
- `source` option, sent as the log `source` tag and the span resource attribute `zharp.source`.
- `endpoint` option (default `https://api.zharp.io/api/v1`), used by logs, traces and replay.
- Span resource now carries `deployment.environment.name` (alongside `deployment.environment`) and
  `service.version`.
- `continueTrace(traceparent, fn, name)`: with a name, `fn` runs inside a `CONSUMER` span, so queue
  workers get request-like spans.

### Fixed

- **A Node script that never calls `destroy()` now exits.** The log flush timer kept the process
  alive; it no longer does, and what is still queued is sent on `beforeExit`.
- **Native ESM in Node** (Node 20.16+ / 22.3+): the ESM build could not `require`, so HTTP tracing was
  silently off and the active span was a single variable shared by every concurrent request. Built-ins
  are now loaded with `process.getBuiltinModule`, falling back to `require` in the CJS build.
- Messages are always non-empty strings, on every path (logging methods, `log()`, auto-capture,
  `console.error()` with no arguments). A non-string message used to get the whole batch rejected.
- Requests are capped at about 1 MB and large batches are split. Unload beacons are cut under 60 KB;
  a refused beacon falls back to a `keepalive` fetch, then an ordinary request. Unload now sends the
  whole queue, not one batch.
- Session replay retry: each batch gets its sequence number when it is cut and is retried unchanged
  (the backend discards a repeated sequence, so reusing numbers lost events). Only one flush runs at
  a time, and a batch that fails 3 times is dropped without its number being reused.
- `destroy()` flushes the entire queue rather than a single batch.

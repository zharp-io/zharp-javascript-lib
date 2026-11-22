# Changelog

## 0.1.0

First release.

- `withZharp` for Workers (`fetch`, `scheduled`, `queue`, and `WorkerEntrypoint` classes), Hono included
  (route names, errors Hono turns into a 500).
- `instrumentDurableObject`: `fetch`, RPC methods, `alarm`, WebSocket messages.
- `zharpPagesPlugin` for Pages Functions middleware.
- Errors counted once (what a handler throws, `captureError`, failed `waitUntil` work).
- Request and response headers with secrets filtered; Cloudflare's ray ID, colo and country.
- `traceparent` in and out: outgoing `fetch`, service bindings and Durable Object stubs.
- D1 spans, and failed queries reported with their SQL and the app's line; KV, R2 and Queue spans.
- `ZHARP_LOGS=true` sends `console.*` lines with their trace.
- Settings from vars and secrets (`ZHARP_KEY`, `ZHARP_RELEASE`, …); the release defaults to the
  deployed version.

# @zharp/apm

Distributed tracing and session replay for [Zharp](https://zharp.io). Start it and every request your app makes or serves becomes a span — `fetch` and `XMLHttpRequest` in the browser, `http`/`https` in and out in Node — joined into one trace across the browser, your services and your queue workers. Errors arrive with the code around each frame and the trail of clicks that led to them, and in the browser you can record the session and watch what happened instead of reconstructing it.

For logs and zero-config error capture, add [`@zharp/logs`](https://www.npmjs.com/package/@zharp/logs). The two work alone or together; together, every log carries the trace it was written in.

---

## Installation

```bash
npm install @zharp/apm
# or
pnpm add @zharp/apm
# or
yarn add @zharp/apm
```

Use an **Ingest only** API key — one that can send data but never read it.

---

## Quick start

### Node.js — zero config

```bash
ZHARP_API_KEY=your-api-key ZHARP_SERVICE=checkout-api ZHARP_ENV=production \
  node --import @zharp/apm/init app.js
```

```
[Zharp] APM active — service "checkout-api", environment "production"
```

Preloading is the surest way to trace a Node app: `http` is patched before your code — or any
library — loads, so nothing holds on to an unpatched copy. Calling `init()` at the top of your
entry file works too:

```typescript
import { ZharpAPM } from '@zharp/apm';

ZharpAPM.init();   // reads ZHARP_* from the environment
```

### Browser

```typescript
import { ZharpAPM } from '@zharp/apm';

ZharpAPM.init({
  apiKey: 'your-api-key',
  service: 'checkout-web',
  environment: 'production',
  replay: { sampleRate: 0.1 },   // optional: record one session in ten
});
```

### With @zharp/logs

Start the logger first and APM needs no options — it reuses the logger's key, service,
environment, version, source and endpoint:

```typescript
import { ZharpLogger } from '@zharp/logs';
import { ZharpAPM } from '@zharp/apm';

ZharpLogger.init({ apiKey: 'your-api-key', service: 'checkout-web', environment: 'production' });
ZharpAPM.init();
```

In Node, preload both: `node --import @zharp/logs/init --import @zharp/apm/init app.js`.

From then on, a log written inside a trace carries its `traceId` and `spanId`, both packages share
one `sessionId`, warnings and errors join the breadcrumb trail, and a logged error flags the
session recording. Neither package imports the other — they meet through a small shared global —
so each works alone, and an app using only one never bundles the other.

---

## Starting up

`init()` follows the same rules as `ZharpLogger.init()`:

- **Importing starts nothing.** Only `init()` — or `@zharp/apm/init` — patches anything.
- **Configuration**, setting by setting: the options passed to `init()`, then the settings
  `@zharp/logs` was started with, then (Node only) the environment:

  | Variable | Option |
  |---|---|
  | `ZHARP_API_KEY` | `apiKey` |
  | `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME` | `service` |
  | `ZHARP_ENV`, then `NODE_ENV` | `environment` |
  | `ZHARP_VERSION` | `version` |
  | `ZHARP_SOURCE` | `source` |
  | `ZHARP_ENDPOINT` | `endpoint` |
  | `ZHARP_DISABLED=true` | start nothing |

- **One line on success**: `[Zharp] APM active — service "…", environment "…"`, plus
  `, session replay at 10% of sessions` when replay is on.
- **No API key, nothing starts**: `[Zharp] No API key found — set ZHARP_API_KEY or call ZharpAPM.init({ apiKey })`.
  The span API keeps working — the work runs, nothing is recorded.
- **Calling `init()` again replaces the running setup**: everything is unpatched and patched
  again with the new configuration; spans already finished go out under the old key.

---

## Configuration

```typescript
ZharpAPM.init({
  apiKey: 'your-api-key',            // "Ingest only" key
  service: 'checkout-web',           // Service the spans are filed under
  environment: 'production',         // deployment.environment.name on every span. No default
  version: '1.4.2',                  // service.version (`appVersion` is accepted too)
  source: 'web',                     // zharp.source
  endpoint: 'https://api.zharp.io/api/v1', // Default shown
  flushInterval: 5000,               // How often spans are sent (ms). Default: 5000

  sampleRate: 1,                     // Fraction of traces to record. Default: 1
  fetch: true,                       // Trace fetch and XHR. Default: true
  http: true,                        // Trace Node http/https, in and out. Default: true
  breadcrumbs: true,                 // Trail of clicks, navigations and fetch calls before an error. Default: true
  propagateTo: [/api\.myapp\.com/],  // Which hosts get the traceparent header
  ignore: ['/health'],               // Paths never traced

  replay: {                          // Session replay, browser only. Off unless given
    sampleRate: 0.1,
    blockSelector: '.payment-iframe',
  },
});
```

Every span carries the resource attributes `service.name`, `deployment.environment.name` (plus the
older `deployment.environment`), `service.version` and `zharp.source`. One that is not configured
is not sent; nothing defaults to `'production'`.

---

## Tracing

Tracing answers a different question from logging: not *what happened*, but *where the time went
and what caused what*.

**In the browser**, every `fetch` and `XMLHttpRequest` becomes a span, carrying a W3C
`traceparent` header so the backend request it triggers joins the same trace.

**In Node**, every incoming request becomes a server span — Express, Fastify, Nest and Koa all
build on `http.Server`, so no framework-specific setup is needed — and every outgoing
`http`/`https`/`fetch` call becomes a client span beneath it. Work inside a request stays
attached to that request across `await` boundaries, so concurrent requests never mix.

**Native ES modules in Node** (`"type": "module"`, `.mjs`) need **Node 20.16+ or 22.3+** for HTTP
tracing and for keeping the active span across `await`: the ESM build loads `node:http` and
`node:async_hooks` through `process.getBuiltinModule`, because an ES module has no `require`. On older
Node the ESM build still records manual spans, but does not patch `http`. The CommonJS build works
on any supported Node.

A Node script that never shuts the SDK down still exits on its own; spans still buffered are sent
on `beforeExit`. A page sends them with `sendBeacon` when it is hidden or closed.

### Timing your own code

```typescript
const order = await ZharpAPM.startActiveSpan('createOrder', async (span) => {
  span.setAttribute('cart.items', items.length);
  return db.orders.create(input);   // nested calls attach automatically
});
```

The span ends when the function settles, including when it returns a promise. A thrown error is
recorded on the span with its stack, then re-thrown unchanged.

For work that does not nest — a span that outlives the function that opened it — use
`ZharpAPM.startSpan(name)` and call `span.end()` yourself.

### Crossing a boundary the SDK does not patch

Queues, WebSocket messages and workers break the chain. Carry the trace across by hand:

```typescript
// Producer
await queue.add('sendEmail', { orderId, trace: ZharpAPM.traceHeaders() });

// Consumer — the third argument names the work
worker.process((job) =>
  ZharpAPM.continueTrace(job.data.trace?.traceparent, () => sendEmail(job.data), 'sendEmail'));
```

With a name, `continueTrace` runs the function inside a `CONSUMER` span of that name, so each job
gets its own duration and error status the way an HTTP request does. Without a name it only makes
the caller's trace active, and creates no span of its own. A missing or malformed `traceparent`
starts a new trace.

### Showing a trace ID to a user

```typescript
res.status(500).json({ error: 'Something went wrong', traceId: ZharpAPM.currentTraceId() });
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

A short trail of what happened before the failure — clicks, navigations, requests, and (with
`@zharp/logs`) warning and error logs — capped at the last 20 entries and attached to the next
exception.

```typescript
ZharpAPM.addBreadcrumb('Applied discount code', { code: 'SUMMER' });
```

**Nothing typed is captured** — only that typing happened, and into which field. A password
field is not even named, because its `id` can identify an account. Recording input values would
mean shipping passwords, card numbers and private messages to a monitoring service, and no
amount of masking makes that a safe default.

Turn it off with `breadcrumbs: false`.

---

## Session replay

Records the page and plays it back, so you can watch what happened instead of reconstructing it
from logs. The recording itself is [rrweb](https://github.com/rrweb-io/rrweb) — it handles the
parts that make DOM recording hard, and there are many: shadow DOM, canvas, iframes,
cross-origin stylesheets, web components, media.

Turn it on with the `replay` option, or later — after consent, say — with `startReplay()`:

```typescript
ZharpAPM.init({ apiKey: 'YOUR_KEY', service: 'checkout-web', replay: { sampleRate: 0.1 } });

// or
ZharpAPM.init({ apiKey: 'YOUR_KEY', service: 'checkout-web' });
if (user.consentedToRecording) await ZharpAPM.startReplay({ sampleRate: 0.1 });
```

### What it costs your bundle

rrweb is an order of magnitude larger than the rest of this SDK, so the recorder is loaded with a
dynamic `import()`. Bundlers (Vite, webpack, esbuild, Rollup, Next.js) put it in a chunk of its
own that is only fetched when replay starts. An app that never turns replay on never downloads
it, and neither does a session that is sampled out — the sampling decision is made before
anything is loaded.

| | Minified | Gzipped |
|---|---|---|
| `@zharp/apm`, loaded up front | ~24 KB | ~8.5 KB |
| Replay chunk, rrweb included, loaded only when recording | ~181 KB | ~58 KB |

### Privacy

**Every input is masked by default** — `maskAllInputs` is `true` unless you turn it off, and
turning it off ships whatever people type to a monitoring service.

```typescript
ZharpAPM.init({
  // ...
  replay: {
    sampleRate: 0.1,
    // Never recorded at all — their space is kept, their contents never captured.
    blockSelector: '.payment-iframe, .document-preview',
    // Recorded, but with the text masked.
    maskTextSelector: '.customer-name',
    // The blunt option: mask every piece of text on the page.
    maskAllText: false,
    // Last look at each batch before it is sent. Return false to drop it.
    beforeSend: (events) => true,
  },
});
```

`blockSelector` is the stronger of the two and the right one for anything genuinely sensitive:
masked text is still recorded as a shape of the right length, while a blocked element is never
serialised.

### Finding the sessions worth watching

Recordings, spans and logs from the same page load share a session id, and a recording lists the
traces started during it, so from a replay you can open the requests it made. A session where an
uncaught error happens — or where `@zharp/logs` records an error — is flagged, which is how you
find the ones worth watching: nobody watches a recording of a session that went fine.

```typescript
ZharpAPM.markError();          // flag this session by hand
await ZharpAPM.stopReplay();   // stop and send what is left
ZharpAPM.isReplaying;          // whether this session is being recorded
```

### Sampling and delivery

`sampleRate` is decided once per page load. A session recorded for half its length is a video
that cuts out mid-sentence, so the decision is never revisited.

Frames are batched and shipped every 10 seconds (or every 500 events), stored compressed, and kept
for at most 7 days. Each batch is numbered when it is cut. A batch that fails with a network error
or a 5xx is retried, unchanged and under the same number, on the next flush — up to 3 attempts —
and then dropped; a 4xx drops it at once. Only one flush runs at a time, and a number is never
reused, even across a call to `init()`. On page hide and unload, what is left goes by
`sendBeacon`.

---

## Flush and teardown

```typescript
await ZharpAPM.flush();     // send finished spans (and recorded replay) now
await ZharpAPM.destroy();   // unpatch everything, stop replay, send what is left
ZharpAPM.isActive;          // whether init() succeeded
```

---

## TypeScript

```typescript
import { ZharpAPM, Span, ZharpAPMConfig, ReplayOptions, SpanOptions } from '@zharp/apm';
```

---

## How it works

**Delivery** — Spans are sent every 5 seconds to `/agent/traces` and recordings to
`/agent/replay`, with the key in an `X-API-KEY` header and `X-Zharp-SDK: js-apm/1.0.0`. Requests
are capped at about 1 MB; unload beacons at 60 KB, with the key in the path because `sendBeacon`
cannot set headers, and a `keepalive` fetch as the fallback when a beacon is refused.

**Retry** — Spans get 2 attempts, 1 s apart; 4xx responses are not retried. Spans are produced
continuously, so trying harder for one batch mostly competes with the next.

**Bounded memory** — At most 1,000 finished spans are held while the network is down, and 30
replay batches; past that the oldest go.

**Scope** — This package sends traces and recordings. Logs are [`@zharp/logs`](https://www.npmjs.com/package/@zharp/logs).

---

## License

MIT © [Zharp](https://zharp.io)

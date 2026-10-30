# @zharp/browser

Application Monitoring for web pages, for [Zharp](https://zharp.io). One `init()` and the page reports its errors, its logs, how long each page load, navigation and click took and which requests it made — joined to your back end's traces — and, if you want, a replay of the session.

Everything is sent as OpenTelemetry (OTLP/JSON) to Zharp. The back-end half is [`@zharp/node`](https://www.npmjs.com/package/@zharp/node) (or any OpenTelemetry SDK).

## Install

```bash
npm install @zharp/browser
```

```typescript
import { Zharp } from '@zharp/browser';

Zharp.init({
  key: 'zpk_…',                        // the app key from the dashboard — safe in a page
  service: 'checkout-web',
  environment: 'production',
  release: 'web@2.3.0',                // optional
  tracingOrigins: ['api.example.com'], // your API, so its spans join the page's trace
  replay: { onErrorSampleRate: 1.0 },  // optional: a replay for every session with an error
});

// After login, and on every page load while logged in:
Zharp.setUser({ id: user.id, email: user.email });
```

Or with a script tag, which gives the page a global `Zharp` with the same API:

```html
<script src="https://cdn.jsdelivr.net/npm/@zharp/browser/dist/zharp.min.js"></script>
<script>
  Zharp.init({ key: 'zpk_…', service: 'checkout-web', environment: 'production' });
</script>
```

`zharp.min.js` is about 24 KB (9 KB gzipped). The recorder is a separate file, `zharp-replay.min.js`, loaded from next to it only when a session records.

## What is captured

| | |
|---|---|
| **Errors** | Uncaught errors and unhandled rejections (as unhandled), and `Zharp.captureError(err)` (as handled). Sent as error logs carrying `exception.type`, `exception.message` and `exception.stacktrace`, in the trace that was active, and grouped into issues. |
| **Page loads** | A root span `pageload /path` from navigation start until the load event and its requests have finished, with time to first byte, DOMContentLoaded and load. |
| **Navigations** | A root span `navigation /path` for each SPA route change: `history.pushState`, `replaceState` (when the path changes), back/forward, and `#/` hash routes. |
| **Interactions** | A root span `click “Pay now”` for a click that leads to requests — clicks that do nothing are not recorded. The label is the element's `data-zharp-name`, `aria-label`, text or title. |
| **Requests** | A CLIENT span for every `fetch` and `XMLHttpRequest`, with `http.request.method`, `url.full`, `http.response.status_code`. 4xx/5xx and network failures are errors. |
| **Context** | `session.id`, `enduser.id`/`email`/`name`, browser and OS (from the user agent), plus your tags, on every span and log. |

### Traces into your back end

Requests to the page's own origin and to anything in `tracingOrigins` carry a W3C `traceparent` header (so the back end continues the trace) and a `baggage` header with `session.id` and `enduser.id` (so the back end's spans and logs are filed under the same session and user). Nothing else gets them: an unknown header on a third-party request can make it fail CORS. Third-party requests still get a span.

`tracingOrigins` entries: a host (`"api.example.com"`, any scheme and port, or `"localhost:3001"` for one port), a URL prefix (`"https://example.com/api"`), or a `RegExp` tested against the full URL. Your API has to allow the two headers in CORS (`Access-Control-Allow-Headers: traceparent, baggage`); `@zharp/node` does not do that for you.

### Sessions

A session is one person's continuous use of one tab. It is kept in `sessionStorage` — it survives reloads and navigations, and each tab has its own — and ends after 30 minutes without clicks, keys or scrolling (`sessionTimeoutMinutes`), or on `Zharp.clearUser()`. Where storage is unavailable (some private modes, sandboxed iframes) the session lasts as long as the page.

### Session replay

```typescript
replay: {
  sampleRate: 0.1,         // record 10% of sessions from start to end
  onErrorSampleRate: 1.0,  // of the rest, keep the last minute in memory and upload it — and the
                           // rest of the session — only if an error happens
}
```

The decision is made once per session. A session that does not record never downloads the recorder ([rrweb](https://www.rrweb.io/)), and one in error mode uploads nothing unless an error happens. Every input is masked by default (`maskAllInputs: false` to change that — then use `blockSelector` for anything sensitive); `maskAllText`, `maskTextSelector` and `blockSelector` cover the rest of the page, and `beforeSend(events)` can drop a batch. Each recording lists the traces that happened during it, so you can go from a replay to the requests and back.

### Logs

```typescript
Zharp.log.info('Checkout started', { cartSize: 3 });   // trace, debug, info, warn, error, fatal
Zharp.log.error('Payment failed', { error });          // an Error here is sent as the exception
```

The console is not copied by default — on most pages it is mostly other people's libraries. `captureConsole: true` copies every level, `captureConsole: ['warn', 'error']` just those.

### Logs only

```typescript
Zharp.init({ key: 'zpk_…', tracing: false });
```

Logs, errors (uncaught and `captureError`, with their stacks), the user, the session and tags are sent as usual; no spans are made, `fetch` and `XMLHttpRequest` are not patched, and no `traceparent` or `baggage` header is added to any request. `Zharp.startSpan(name, fn)` just runs `fn`. Session replay is independent of it: it still follows `replay`, but a recording has no traces to link to.

## API

| | |
|---|---|
| `Zharp.init(options)` | Start. Call once; a second call is ignored with a warning. Does nothing outside a browser (SSR). |
| `Zharp.setUser({ id, email?, name? })` | `enduser.id` (and email, name) on everything from now on, and in `baggage`. |
| `Zharp.clearUser()` | Forget the user and start a new session — on logout. |
| `Zharp.setTag(key, value)` | An attribute on every span and log from now on; `null` removes it. |
| `Zharp.captureError(err, attrs?)` | Report a caught error. |
| `Zharp.log.<level>(message, attrs?)` | A log in the current trace. |
| `Zharp.startSpan(name, fn, attrs?)` | Run `fn` in a span; requests and logs from its synchronous part belong to it, and a returned promise ends it when it settles. |
| `Zharp.flush()` | Send everything waiting now. |
| `Zharp.close()` | Flush, stop recording and undo every patch. |
| `Zharp.sessionId` | The current session's ID. |

## Options

| Option | Default | |
|---|---|---|
| `key` | — | Required. The app key (`zpk_…`). It can only send, and can be limited to your origins in the dashboard. |
| `service` | `"web"` | `service.name`. |
| `environment` | — | `deployment.environment.name`. |
| `release` | — | `service.version`. Use the same value as your source maps' release. |
| `endpoint` | `https://api.zharp.io/api/v1/otlp` | |
| `tracingOrigins` | `[]` | See above. Same-origin requests are always included. |
| `tracing` | `true` | `false` for logs only (see above). |
| `sampleRate` | `1` | Fraction of traces kept. Errors, logs and replays are not sampled by it; the decision travels in `traceparent`, so the back end keeps or drops the same traces. |
| `replay` | off | See above. |
| `captureConsole` | `false` | `true` or a list of levels. |
| `interactions` | `true` | Click spans. |
| `ignoreUrls` | `[]` | URLs never traced, as strings (host or prefix) or RegExps. |
| `sessionTimeoutMinutes` | `30` | |

## Readable stack traces

Minified stacks become original files, lines and code once the build's source maps are uploaded with a [Zharp bundler plugin](../bundler-plugins/README.md) or [`@zharp/cli`](../cli/README.md). Those tools register each emitted file's debug ID at load time; every error this SDK sends carries the IDs of the files in its stack as `zharp.debug_ids`, so the server finds the right map whatever URL the file was served from. Nothing to configure here.

## Delivery

Batches of up to 100 records go out every 5 seconds, gzipped where the browser has `CompressionStream`. 429, 5xx and network failures are retried with backoff; the queue holds at most 1,000 records of each kind and drops the oldest past that. When the page is hidden or closed, what is left goes out with `fetch(…, { keepalive: true })` so it outlives the page. A rejected key (401/403) prints one console warning and stops sending from that page. The SDK never throws into your code.

## License

MIT

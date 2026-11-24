# @zharp/cloudflare

Zharp Application Monitoring for **Cloudflare Workers**, **Durable Objects** and **Pages Functions**:
errors with readable stacks (each counted once), a trace per request continued from the caller's
`traceparent` and carried on to the services it calls, failed D1 queries with their SQL, spans for
D1, KV, R2, Queues, service bindings and Durable Objects, and logs when you ask for them.

Small (about 40 KB minified with `@opentelemetry/api`), sent with `ctx.waitUntil` so responses are
never held up. Needs the `nodejs_compat` flag (AsyncLocalStorage).

```sh
npm init zharp@latest        # finds wrangler.toml / wrangler.jsonc and does all of the below
```

## Workers

```ts
import { withZharp } from '@zharp/cloudflare';

export default withZharp({
  async fetch(request, env, ctx) { … },
  async scheduled(controller, env, ctx) { … },
  async queue(batch, env, ctx) { … },
});
```

```sh
npx wrangler secret put ZHARP_KEY      # the app key from the Zharp dashboard
```

Hono works the same — `export default withZharp(app)` — and spans are named after Hono's matched
route. Settings can also be passed in code: `withZharp((env) => ({ key: env.ZHARP_KEY }), handler)`.

## Durable Objects

```ts
import { instrumentDurableObject } from '@zharp/cloudflare';

class CartObject extends DurableObject { … }
export const Cart = instrumentDurableObject(CartObject);
```

Each `fetch`, RPC method, `alarm` and WebSocket message is a span; what they throw is reported.

## Pages Functions

```ts
// functions/_middleware.ts
import { zharpPagesPlugin } from '@zharp/cloudflare';

export const onRequest = zharpPagesPlugin();
```

## Settings (vars and secrets)

| Variable | |
|---|---|
| `ZHARP_KEY` | The app key (a secret). Without it nothing is sent. |
| `ZHARP_SERVICE` | `service.name`; default `worker` (Pages: `pages`). |
| `ZHARP_ENVIRONMENT` | `deployment.environment.name`. |
| `ZHARP_RELEASE` | The release source maps are matched by; default the deployed version's ID (`version_metadata` binding `CF_VERSION_METADATA`). |
| `ZHARP_LOGS` | `true` sends `console.*` lines with their trace. Off by default: Workers Logs keeps them. |
| `ZHARP_TRACING` | `false`: errors and logs only. |
| `ZHARP_SAMPLE_RATE` | 0–1, default 1. |
| `ZHARP_CAPTURE_HEADERS` | `false` turns request/response headers off (secrets are always `[Filtered]`). |
| `ZHARP_DISABLED` | `true`: send nothing. |

## Readable stacks

Wrangler bundles and minifies; Zharp maps stacks back with the build's source maps, matched by
release:

```sh
wrangler deploy --outdir .wrangler/zharp-dist --var ZHARP_RELEASE:$SHA
ZHARP_AUTH_TOKEN=… npx zharp sourcemaps upload .wrangler/zharp-dist --release $SHA --app <id>
```

(with `upload_source_maps = true` in the Wrangler config, so the build has its maps). Projects built
with Cloudflare's Vite plugin can use `@zharp/vite-plugin` instead.

## API

`Zharp.captureError(error, attributes?)`, `Zharp.setUser({ id, email, name })`,
`Zharp.setTag(key, value)`, `Zharp.log.info(message, attributes?)` (and the other levels),
`Zharp.startSpan(name, fn)`, `Zharp.flush()`. Inside a request, the user and tags belong to that
request only.

Docs: https://zharp.io/docs/sdks/cloudflare

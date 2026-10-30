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

For logs and errors without traces, pass `tracing: false` to either (or set `ZHARP_TRACING=false` for `@zharp/node`).

## Readable stack traces

Production JavaScript is minified, so an error's stack reads `at nt (index-DZTHzAoY.js:5:17640)`. Upload the build's source maps and Zharp shows `at total (src/cart.js:3:40)` instead, with the code around it, and groups errors by the original frames.

Each emitted file gets a **debug ID** — a UUID written into the file (`//# debugId=…`, plus one line that registers it at runtime) and into its `.map`. `@zharp/browser` and `@zharp/node` send the IDs of the files in an error's stack with the error (`zharp.debug_ids`), so the server finds the exact map whatever URL, CDN or path the file was served from. No release names to keep in sync.

Add the plugin for your bundler; on production builds it emits hidden source maps, injects debug IDs, uploads, and deletes the `.map` files from the output so they are not deployed:

| Bundler | Package |
|---|---|
| Vite | [`@zharp/vite-plugin`](packages/bundler-plugins/vite/README.md) |
| webpack | [`@zharp/webpack-plugin`](packages/bundler-plugins/webpack/README.md) |
| Next.js | [`@zharp/nextjs`](packages/bundler-plugins/nextjs/README.md) — `withZharp(nextConfig)`, client and server code |
| Rollup | [`@zharp/rollup-plugin`](packages/bundler-plugins/rollup/README.md) |
| esbuild | [`@zharp/esbuild-plugin`](packages/bundler-plugins/esbuild/README.md) |
| anything else | [`@zharp/cli`](packages/cli/README.md): `zharp sourcemaps inject dist && zharp sourcemaps upload dist --app <id>` |

```js
// vite.config.js
import { zharp } from '@zharp/vite-plugin';
export default { plugins: [zharp({ app: 42 })] };   // with ZHARP_AUTH_TOKEN set in CI
```

Uploading needs a workspace API key with the `artifacts:write` scope in `ZHARP_AUTH_TOKEN` — a secret for CI, not the app key the SDK uses. The same CLI uploads Android (`zharp proguard upload`), Flutter (`zharp dart-symbols upload`) and iOS (`zharp dsym upload`) symbols. See the [bundler plugins overview](packages/bundler-plugins/README.md).

`@zharp/logs` is the previous generation of logging, kept only until `@zharp/node` is published; it is being replaced by `@zharp/node` / `@zharp/browser` with `tracing: false`.

---

## Repository

A pnpm workspace:

```
packages/browser  @zharp/browser
packages/node     @zharp/node
packages/logs     @zharp/logs (to be deprecated)
packages/cli      @zharp/cli — the `zharp` command: source maps and mobile symbol uploads
packages/bundler-plugins/{vite,webpack,rollup,esbuild,nextjs}
                  @zharp/vite-plugin, @zharp/webpack-plugin, @zharp/rollup-plugin,
                  @zharp/esbuild-plugin, @zharp/nextjs — built on @zharp/cli
internal          environment reading and other internals, bundled into each package at build time
test              checks against the built packages and a fake backend (run.mjs: logs,
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

# @zharp/nextjs

Readable stack traces for a Next.js app in [Zharp](https://zharp.io) — browser and server code. On `next build` it turns on source maps, injects debug IDs into the emitted chunks in `.next/static` and `.next/server`, uploads them, and deletes the maps from `.next`.

```bash
npm install --save-dev @zharp/nextjs
```

```js
// next.config.mjs
import { withZharp } from '@zharp/nextjs';

const nextConfig = { reactStrictMode: true };

export default withZharp(nextConfig, { app: 42 });
```

Set `ZHARP_AUTH_TOKEN` (a workspace API key with the `artifacts:write` scope) in CI. Use `@zharp/browser` in the client and `@zharp/node` (loaded from `instrumentation.ts`) on the server; both attach the debug IDs of the chunks in an error's stack.

What it changes in the config: `productionBrowserSourceMaps: true` and `experimental.serverSourceMaps: true`, plus

- **Next.js 15.4 and later** (webpack or Turbopack): a `compiler.runAfterProductionCompile` hook (yours, if any, runs first) that processes `.next` once the build is written;
- **older versions**: `devtool: 'hidden-source-map'` and the [webpack plugin](../webpack/README.md) in each production compiler (client, server, edge). Turbopack needs 15.4+.

`hook: 'webpack' | 'runAfterProductionCompile'` overrides the choice. Both config forms (object and function) work. Other options: see the [bundler plugins overview](../README.md#options).

MIT © [Zharp](https://zharp.io)

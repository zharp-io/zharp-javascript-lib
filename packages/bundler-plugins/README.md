# Zharp bundler plugins

Readable stack traces for JavaScript built with Vite, webpack, Next.js, Rollup or esbuild. On a production build each plugin:

1. turns on source maps if the config has none — *hidden* ones (written, but not referenced from the files);
2. gives each emitted JS file a debug ID, in the file and in its map (see [`@zharp/cli`](../cli/README.md#javascript-source-maps));
3. uploads the files and maps to Zharp, keyed by those IDs;
4. deletes the `.map` files from the output (and any `sourceMappingURL` comment pointing at them), so your source is not deployed.

| Package | Use |
|---|---|
| [`@zharp/vite-plugin`](vite/README.md) | `plugins: [zharp({ app })]` |
| [`@zharp/webpack-plugin`](webpack/README.md) | `plugins: [new ZharpWebpackPlugin({ app })]` |
| [`@zharp/nextjs`](nextjs/README.md) | `export default withZharp(nextConfig, { app })` |
| [`@zharp/rollup-plugin`](rollup/README.md) | `plugins: [zharpRollupPlugin({ app })]` |
| [`@zharp/esbuild-plugin`](esbuild/README.md) | `plugins: [zharpEsbuildPlugin({ app })]` |

Then the errors `@zharp/browser` and `@zharp/node` send carry the debug IDs of the files in their stacks, and Zharp shows them with original names, files, lines and code.

## Options

All plugins take the same options:

| Option | Default | |
|---|---|---|
| `app` | `ZHARP_APP` | The application ID (the number in its dashboard URL). |
| `authToken` | `ZHARP_AUTH_TOKEN` | A workspace API key with the `artifacts:write` scope. Keep it in your CI's secrets. |
| `release` | `ZHARP_RELEASE`, else the commit SHA from Vercel, GitHub Actions, GitLab, Cloudflare Pages, Netlify or Render | Files the upload under a release. Optional: matching is by debug ID. |
| `url` | `ZHARP_URL`, else `https://api.zharp.io` | The Zharp API. |
| `include` / `exclude` | all JS files the build wrote | Globs (relative to the output directory) or regular expressions. |
| `deleteSourcemapsAfterUpload` | `true` | `false` keeps the `.map` files in the output. |
| `dryRun` | `false` | Inject and report what would be uploaded; upload and delete nothing. |
| `force` | `false` | Also run on non-production builds (Vite and webpack modes). |
| `failOnError` | `false` | Fail the build when the upload fails, instead of warning. |
| `disabled` | `false` | Do nothing. |
| `silent` | `false` | No progress output (warnings still print). |

Without an auth token (a local build, say) the plugin still injects debug IDs, warns that nothing was uploaded, and still deletes the maps — a map in the output is your source code, deployed. Set `deleteSourcemapsAfterUpload: false` to keep them locally.

## License

MIT © [Zharp](https://zharp.io)

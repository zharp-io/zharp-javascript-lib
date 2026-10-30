# @zharp/webpack-plugin

Readable stack traces for a webpack build in [Zharp](https://zharp.io): on production builds it emits hidden source maps, injects debug IDs into the emitted JS files and their maps, uploads them, and deletes the maps from the output.

```bash
npm install --save-dev @zharp/webpack-plugin
```

```js
// webpack.config.js
const { ZharpWebpackPlugin } = require('@zharp/webpack-plugin');

module.exports = {
  mode: 'production',
  plugins: [new ZharpWebpackPlugin({ app: 42 })],
};
```

Set `ZHARP_AUTH_TOKEN` (a workspace API key with the `artifacts:write` scope) in CI. An unset (or `false`) `devtool` becomes `hidden-source-map`; a `devtool` you set is kept (pass `keepDevtool: true` to leave even an unset one alone). Runs after webpack writes the output (`afterEmit`), for each compiler — server and client builds alike.

Options (`release`, `include`, `exclude`, `deleteSourcemapsAfterUpload`, `dryRun`, …): see the [bundler plugins overview](../README.md#options).

MIT © [Zharp](https://zharp.io)

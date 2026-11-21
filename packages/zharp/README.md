# zharp

Set up [Zharp](https://zharp.io) in your project:

```sh
npx zharp init
```

It finds your framework (Next.js, React with Vite, NestJS…), connects the project to your Zharp
workspace in the browser, shows every change it will make, and on a yes installs the SDK, wires
it in, writes the keys to an env file git ignores, and sends a test error.

Everything else `zharp` does — uploading source maps, ProGuard mappings, dSYMs and Flutter
symbols — is the same as [`@zharp/cli`](https://www.npmjs.com/package/@zharp/cli):
`npx zharp --help`.

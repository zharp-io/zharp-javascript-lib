# create-zharp

Set up [Zharp](https://zharp.io) in your project:

```sh
npm init zharp@latest
```

(the same as `npm create zharp@latest`; with pnpm, `pnpm create zharp`)

It finds your framework (Next.js, React with Vite, NestJS…), connects the project to your Zharp
workspace in the browser, shows every change it will make, and on a yes installs the SDK, wires
it in, writes the keys to an env file git ignores, and sends a test error.

`npm init zharp@latest -- --yes` applies the changes without asking; `-- --dry-run` only shows
them. It is [`@zharp/cli`](https://www.npmjs.com/package/@zharp/cli)'s `init`.

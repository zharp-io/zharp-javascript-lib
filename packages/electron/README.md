# @zharp/electron

Zharp Application Monitoring for Electron: errors, native crashes, logs and traces from the main
process and every window, in one session.

```sh
npm init zharp@latest      # sets it up: electron-vite, Electron Forge, electron-builder, plain Electron
npm install @zharp/electron
```

## Main

First thing in main — with ES modules, in a file of its own imported on main's first line:

```ts
import { Zharp } from '@zharp/electron/main';

Zharp.init({
  key: 'zpk_…',                                      // the app's key: it can only send
  renderer: { tracingOrigins: ['api.example.com'] }, // every window's settings
});
```

Main runs [`@zharp/node`](https://zharp.io/docs/sdks/node): errors with the code that ran, requests,
failed queries, logs when asked for. It also:

- starts Electron's crash reporter with Zharp's minidump endpoint, so a native crash in any process
  arrives with its stack, read with Electron's own symbols (fetched by Zharp, nothing to upload);
- reports a window or helper process that went away, written to disk first: as a log line naming
  the crash's minidump when it has one (one crash, one issue), else as the error
  (`RendererProcessGone`, `GPUProcessGone`…);
- keeps one session, a device ID per installation and the user for main and every window;
- adds the windows' preload to every session.

## Each window

```ts
import { Zharp } from '@zharp/electron/renderer';

Zharp.init();
```

Without a bundler: `<script src="../node_modules/@zharp/electron/dist/renderer.min.js"></script>`.

Windows send through main over IPC: no outside URL for the page's Content-Security-Policy, one
queue (on disk while offline), one session.

## The preload

Added by main. Only when main is bundled with its dependencies and `node_modules` isn't shipped
(Electron Forge with Vite or webpack), import it in your own preload:

```ts
import '@zharp/electron/preload';
```

## Stacks

Packaged apps run from `app.asar` in a different folder on every computer; stacks are sent as
`app:///dist/renderer.js`, so every install groups into one issue and no one's user folder is
sent. Upload source maps with `@zharp/vite-plugin` or `@zharp/webpack-plugin`.

Electron 43 and later. Docs: https://zharp.io/docs/sdks/electron

# @zharp/cli

The `zharp` command: upload what [Zharp](https://zharp.io) needs to turn minified and obfuscated stack traces back into your source — JavaScript source maps, Android R8/ProGuard mappings, Flutter Dart symbols and iOS dSYMs.

```bash
npm install --save-dev @zharp/cli    # or run it with npx zharp …
```

Requires Node 18.18 or later. No dependencies.

## Authentication

Uploads need a **workspace API key with the `artifacts:write` scope** (Integrations & API → Main API keys, "Build uploads"). It is a secret for your CI, not the app key your SDK sends data with.

| Variable | |
|---|---|
| `ZHARP_AUTH_TOKEN` | The API key. Required to upload. |
| `ZHARP_URL` | The Zharp API. Default `https://api.zharp.io`. |
| `ZHARP_APP` | The application ID, instead of `--app`. |
| `ZHARP_RELEASE` | A release name, instead of `--release`. |

The application ID is the number in the app's dashboard URL.

## JavaScript source maps

If you use Vite, webpack, Next.js, Rollup or esbuild, the [bundler plugins](../bundler-plugins/README.md) do all of this during the build. Otherwise, after your build:

```bash
zharp sourcemaps inject dist
zharp sourcemaps upload dist --app 42 --release "$GIT_SHA" --delete-after
```

**`zharp sourcemaps inject <dir>`** gives every `.js`/`.mjs`/`.cjs` file that has a source map (`file.js.map` next to it, or the file its `sourceMappingURL` names) a *debug ID*:

- appended to the file: one line that registers the file at runtime for the Zharp SDKs, and `//# debugId=<uuid>`. Lines are only added after the code, so the map stays valid;
- written into the map as `"debugId"` (and `"debug_id"`).

The ID is derived from the file's content, so rebuilding identical output gives the same ID, and running `inject` twice changes nothing. A file a bundler already gave a `//# debugId=` comment keeps that ID.

`@zharp/browser` and `@zharp/node` send the IDs of the files in each error's stack, and Zharp finds the matching map by ID — whatever URL, CDN or path the file was served from.

**`zharp sourcemaps upload <dir> --app <id>`** uploads each injected file and its map. Options: `--release <name>`, `--delete-after` (delete the `.map` files once uploaded, so they are not deployed), `--include <glob>` / `--exclude <glob>` (repeatable, relative to `<dir>`), `--dry-run`.

Keep `sourcesContent` in your maps (most bundlers do by default) and Zharp shows the code around each frame, not only the file and line.

## Android (R8 / ProGuard)

```bash
zharp proguard upload app/build/outputs/mapping/release/mapping.txt --app 42 --uuid <build-uuid>
```

`--uuid` is the build's UUID that the Zharp Gradle plugin writes into the app (and that the SDK reports as `zharp.proguard_uuid`). The Gradle plugin runs this for you after `assembleRelease`/`bundleRelease`.

## Flutter

```bash
flutter build apk --obfuscate --split-debug-info=build/symbols \
  --extra-gen-snapshot-options=--save-obfuscation-map=build/obfuscation.json
zharp dart-symbols upload build/symbols --app 42
```

Each `*.symbols` file is uploaded under its ELF GNU build ID — the `build_id` an obfuscated Dart stack trace prints — with its architecture.

The obfuscation map (the JSON array of `[obfuscated, original]` names that `--save-obfuscation-map` writes) lets Zharp restore class and method names in error types and messages too. `obfuscation.json` or `*.obfuscation.json` in the symbols directory or the directory next to it is found and uploaded automatically; pass `--obfuscation-map <file>` for another location. One map covers every architecture of a build, so it is uploaded once per build ID.

## iOS

Add a Run Script build phase as the last phase of the app target (and set *Debug Information Format* to *DWARF with dSYM File* for Release):

```bash
export ZHARP_AUTH_TOKEN=…   # better: from your CI's secrets
npx zharp dsym upload "$DWARF_DSYM_FOLDER_PATH" --app 42
```

Every `.dSYM` in the folder is read; each architecture is uploaded under its Mach-O UUID (the UUID a crash report lists for the binary image).

## Behaviour

- Native symbol files are uploaded gzipped.
- Failed uploads are retried three times with backoff (network errors, 408, 429, 5xx); a rejected key, a missing scope or an unknown app fails at once with what to fix.
- Exit code 1 on any error.

## As a library

```js
import { injectDirectory, uploadSourcemaps, resolveConnection } from '@zharp/cli';

injectDirectory('dist');
await uploadSourcemaps('dist', resolveConnection({ app: 42 }), { release: 'web@1.4.0', deleteAfter: true });
```

## License

MIT © [Zharp](https://zharp.io)

#!/usr/bin/env node
/**
 * `zharp` — upload what Zharp needs to turn minified and obfuscated stacks back into source.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolveConnection, UploadError, type Connection } from './api';
import { consoleLogger } from './log';
import { uploadDartSymbols, uploadDsyms, uploadProguard } from './native';
import { uploadDebugFiles } from './debug-files';
import { uploadReactNative, uploadReactNativeDir } from './react-native';
import { injectDirectory, uploadSourcemaps } from './sourcemaps';
import { VERSION } from './version';
import { runInit } from './init';
import { uploadRustSources } from './rust-sources';

const HELP = `zharp ${VERSION} — readable stack traces for Zharp

Usage:
  zharp init                                            Connect this project to Zharp and set it up
                                                        (also: npm init zharp@latest)
        [--yes] [--dry-run]                             (signs in through the browser)
  zharp sourcemaps inject <dir>                         Add debug IDs to JS files and their maps
  zharp sourcemaps upload <dir> --app <id>              Upload JS files and their maps
        [--release <r>] [--delete-after]                (files without debug IDs, as Wrangler builds
                                                        a Worker, are matched by --release)
  zharp proguard upload <mapping.txt> --app <id> --uuid <uuid>
  zharp dart-symbols upload <dir> --app <id>            Flutter --split-debug-info output
        [--obfuscation-map <file>]                      (and its obfuscation map)
  zharp dsym upload <path> --app <id>                   A .dSYM, or a folder of them
  zharp debug-files upload <path...> --app <id>         C/C++ debug files for minidump crashes: PDBs,
        [--include-sources] [--sources <dir>]           ELF files, dSYMs (made into .sym with dump_syms)
        [--dump-syms <path>]                            or .sym files
  zharp react-native upload --bundle <file> --map <file> --app <id>
                                                        A React Native release bundle's source map
  zharp react-native upload --dir dist --app <id>       Every bundle an \`npx expo export\` wrote (EAS Update)
  zharp sources upload [dir] --app <id>                 A Rust crate's src/ as a source bundle, under the
        [--build-id <id>] [--release <r>]               build ID zharp::build::id() puts in the binary
                                                        (dir: default the nearest folder with Cargo.toml)

Options:
  --app <id>          Application ID (or ZHARP_APP)
  --release <r>       Release name to file the upload under (or ZHARP_RELEASE)
  --include <glob>    Only these files (repeatable; sourcemaps)
  --exclude <glob>    Not these files (repeatable; sourcemaps)
  --sources <dir>     The project whose sources go with the symbols (dart-symbols, dsym; default: found;
                      debug-files: where the sources are now, when built elsewhere)
  --include-sources   Also upload the source files the symbols name (debug-files)
  --dump-syms <path>  Mozilla dump_syms to use (or ZHARP_DUMP_SYMS; default: PATH, else downloaded once)
  --no-sources        Don't upload the app's sources (errors then show code only from a linked repo)
  --build-id <id>     sources upload: this build ID instead of the one computed from src/**/*.rs
  --delete-after      Delete .map files after uploading them
  --dry-run           Show what would happen; change and send nothing
  --url <url>         Zharp API (default ZHARP_URL or https://api.zharp.io)
  -h, --help, -v, --version

Environment:
  ZHARP_AUTH_TOKEN    A workspace API key with the "artifacts:write" scope (required to upload)
  ZHARP_URL           The Zharp API, default https://api.zharp.io
  ZHARP_DUMP_SYMS     dump_syms to use for debug-files upload
`;

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      app: { type: 'string' },
      release: { type: 'string' },
      uuid: { type: 'string' },
      'build-id': { type: 'string' },
      'obfuscation-map': { type: 'string' },
      sources: { type: 'string' },
      bundle: { type: 'string' },
      dir: { type: 'string' },
      map: { type: 'string' },
      'no-sources': { type: 'boolean' },
      'include-sources': { type: 'boolean' },
      'dump-syms': { type: 'string' },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      'delete-after': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      tarballs: { type: 'string' },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const [group, command, target] = positionals;
  if (values.help || !group) {
    console.log(HELP);
    return;
  }
  if (group === 'init') {
    process.exitCode = await runInit({ url: values.url, yes: values.yes === true, dryRun: values['dry-run'] === true, tarballs: values.tarballs, dir: command });
    return;
  }
  const logger = consoleLogger();
  const dryRun = values['dry-run'] === true;
  const release = values.release ?? process.env.ZHARP_RELEASE;
  const needTarget = (what: string) => {
    if (!target) fail(`${group} ${command} needs ${what}. See \`zharp --help\`.`);
    if (!existsSync(target)) fail(`${target} does not exist.`);
    return target;
  };
  const connect = (): Connection | null => (dryRun ? null : resolveConnection({ app: values.app, url: values.url }));

  switch (`${group} ${command}`) {
    case 'sourcemaps inject': {
      const dir = needTarget('a directory');
      const files = injectDirectory(dir, { include: values.include, exclude: values.exclude, dryRun, logger });
      logger.info(`${dryRun ? 'Would inject' : 'Injected'} debug IDs into ${files.filter((f) => f.changed).length} file(s); ${files.filter((f) => !f.changed).length} already had one.`);
      return;
    }
    case 'sourcemaps upload': {
      const dir = needTarget('a directory');
      const connection = connect();
      const result = await uploadSourcemaps(dir, connection, {
        release,
        include: values.include,
        exclude: values.exclude,
        deleteAfter: values['delete-after'] === true,
        dryRun,
        logger,
      });
      if (result.files === 0) process.exitCode = 1;
      return;
    }
    case 'proguard upload': {
      const file = needTarget('the mapping.txt file');
      if (!values.uuid) fail('proguard upload needs --uuid <uuid>: the build UUID the Zharp Gradle plugin put into the app.');
      await uploadProguard(file, values.uuid, connect(), { release, dryRun, logger });
      return;
    }
    case 'dart-symbols upload': {
      const sources = values['no-sources'] ? false : values.sources;
      await uploadDartSymbols(needTarget('the --split-debug-info directory'), connect(), { release, dryRun, logger, obfuscationMap: values['obfuscation-map'], sources });
      return;
    }
    case 'react-native upload': {
      if (values.dir) {
        if (!existsSync(values.dir)) fail(`${values.dir} does not exist.`);
        await uploadReactNativeDir(values.dir, connect(), { release, dryRun, logger });
        return;
      }
      if (!values.bundle || !values.map) fail('react-native upload needs --bundle <index.android.bundle | main.jsbundle> and --map <its source map>, or --dir <expo export output>.');
      for (const file of [values.bundle!, values.map!]) if (!existsSync(file)) fail(`${file} does not exist.`);
      await uploadReactNative(values.bundle!, values.map!, connect(), { release, dryRun, logger });
      return;
    }
    case 'debug-files upload': {
      const paths = positionals.slice(2);
      if (!paths.length) fail('debug-files upload needs a build folder or debug files. See `zharp --help`.');
      for (const path of paths) if (!existsSync(path)) fail(`${path} does not exist.`);
      if (values.sources && !existsSync(values.sources)) fail(`${values.sources} does not exist.`);
      await uploadDebugFiles(paths, connect(), {
        release,
        dryRun,
        logger,
        includeSources: values['include-sources'] === true || !!values.sources,
        sourcesRoot: values.sources,
        dumpSyms: values['dump-syms'],
      });
      return;
    }
    case 'dsym upload': {
      const sources = values['no-sources'] ? false : values.sources;
      await uploadDsyms(needTarget('a .dSYM bundle or a folder of them'), connect(), { release, dryRun, logger, sources });
      return;
    }
    case 'sources upload': {
      if (values['build-id'] !== undefined && !values['build-id'].trim()) fail('--build-id needs a value.');
      await uploadRustSources(target, connect(), { release, dryRun, logger, buildId: values['build-id']?.trim() });
      return;
    }
    default:
      fail(`Unknown command "${positionals.join(' ')}". See \`zharp --help\`.`);
  }
}

// Errors set the exit code rather than calling process.exit(): uploads still in flight finish
// (or fail) cleanly first.
main(process.argv.slice(2)).catch((error) => {
  console.error(`[zharp] error: ${error instanceof UsageError || error instanceof UploadError || error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

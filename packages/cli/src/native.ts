/**
 * Mobile symbol files: R8/ProGuard mappings (Android), Dart symbol files (Flutter
 * `--split-debug-info`) and dSYMs (iOS). Each is uploaded gzipped, keyed by the ID its platform's
 * errors carry.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { eachLimit, uploadArtifact, type Artifact, type Connection } from './api';
import { readElf, isElf } from './elf';
import { formatBytes, walk } from './files';
import { consoleLogger, type Logger } from './log';
import { isMachO, readMachO } from './macho';
import { swiftNames, type XcodeTool } from './swift-names';
import { APPLE_SOURCES, collectSources, FLUTTER_SOURCES, isAppleRoot, isFlutterRoot, projectRoot, sourceBundleArtifacts } from './source-bundle';

export interface NativeUploadOptions {
  release?: string;
  dryRun?: boolean;
  logger?: Logger;
  fetch?: typeof fetch;
  retries?: number;
  /**
   * The app's source files go with the symbols, so errors show the code of the build (default:
   * on). `false` leaves them out; a path is the project folder to read them from (default: found
   * from the working directory — pubspec.yaml for Flutter, the .xcodeproj or $SRCROOT for iOS).
   */
  sources?: string | false;
  /** dsym upload: how Xcode's tools are run (tests); default xcrun on a Mac, none elsewhere. */
  xcodeTool?: XcodeTool | null;
}

/** The source bundle for these build IDs, when sources are on and the project is found. */
function withSources(kind: 'flutter' | 'apple', buildIds: string[], options: NativeUploadOptions, logger: Logger): Artifact[] {
  if (options.sources === false || !buildIds.length) return [];
  const root = typeof options.sources === 'string'
    ? resolve(options.sources)
    : kind === 'apple' && process.env.SRCROOT ? process.env.SRCROOT
      : projectRoot(process.cwd(), kind === 'flutter' ? isFlutterRoot : isAppleRoot);
  if (!root || !existsSync(root)) {
    logger.info(`Sources: no ${kind === 'flutter' ? 'Flutter project (pubspec.yaml)' : 'Xcode project'} found from ${process.cwd()} — pass --sources <project folder>, or --no-sources.`);
    return [];
  }
  const sources = collectSources(root, kind === 'flutter' ? FLUTTER_SOURCES : APPLE_SOURCES);
  if (!sources.count) return [];
  logger.info(`With the app's sources: ${sources.count} file(s), ${formatBytes(sources.bytes)} from ${root}${sources.skipped ? ` (${sources.skipped} over the size caps left out)` : ''} — errors show the code of this build. --no-sources to leave them out.`);
  return sourceBundleArtifacts(sources, buildIds, options.release);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function send(connection: Connection | null, artifacts: Artifact[], options: NativeUploadOptions): Promise<Artifact[]> {
  const logger = options.logger ?? consoleLogger();
  let done = 0;
  await eachLimit(artifacts, 2, async (artifact) => {
    if (!options.dryRun) {
      if (!connection) throw new Error('No connection to upload to.');
      await uploadArtifact(connection, artifact, { fetch: options.fetch, retries: options.retries });
    }
    done += 1;
    const extra = artifact.arch ? ` ${artifact.arch}` : '';
    logger.info(`  [${done}/${artifacts.length}] ${options.dryRun ? 'would upload' : 'uploaded'} ${artifact.kind} ${artifact.name}${extra} (${formatBytes(artifact.data.length)})  ${artifact.debugId}`);
  });
  return artifacts;
}

// ── Android ──────────────────────────────────────────────────────────────────

/** Upload an R8/ProGuard `mapping.txt` under the build's UUID (the one the Gradle plugin put in the app). */
export async function uploadProguard(mappingFile: string, uuid: string, connection: Connection | null, options: NativeUploadOptions = {}) {
  if (!UUID.test(uuid)) throw new Error(`--uuid must be a UUID, got "${uuid}".`);
  const data = readFileSync(mappingFile);
  return send(connection, [{ kind: 'proguard', debugId: uuid.toLowerCase(), name: basename(mappingFile), release: options.release, data, gzip: true }], options);
}

// ── Flutter ──────────────────────────────────────────────────────────────────

export interface DartSymbolFile {
  path: string;
  buildId: string;
  os?: string;
  arch?: string;
}

const DART_ARCH: Record<string, string> = { x86_64: 'x64', x86: 'ia32' };

/**
 * The Dart symbol files in a `--split-debug-info` directory (`app.android-arm64.symbols`, …), or
 * the one file given. The debug ID is the ELF GNU build ID — the `build_id` an obfuscated
 * stack prints.
 */
export function findDartSymbols(path: string, logger: Logger = consoleLogger()): DartSymbolFile[] {
  const files = statSync(path).isDirectory() ? walk(resolve(path)) : [resolve(path)];
  const out: DartSymbolFile[] = [];
  for (const file of files) {
    const named = /\.symbols$/.test(file);
    const data = readFileSync(file);
    if (!isElf(data)) {
      if (named) logger.warn(`Skipped ${basename(file)}: not an ELF file.`);
      continue;
    }
    const elf = readElf(data);
    if (!elf.buildId) {
      logger.warn(`Skipped ${basename(file)}: it has no GNU build ID.`);
      continue;
    }
    const match = /\.([a-z]+)-([a-z0-9_]+)\.symbols$/.exec(basename(file));
    out.push({ path: file, buildId: elf.buildId, os: match?.[1], arch: match?.[2] ?? (elf.arch && (DART_ARCH[elf.arch] ?? elf.arch)) });
  }
  return out;
}

/**
 * The obfuscation map Flutter writes with
 * `--extra-gen-snapshot-options=--save-obfuscation-map=<file>`: `obfuscation.json` or
 * `*.obfuscation.json`, in the symbols directory or the directory next to it.
 */
export function findObfuscationMap(symbolsPath: string): string | undefined {
  const dir = statSync(symbolsPath).isDirectory() ? resolve(symbolsPath) : dirname(resolve(symbolsPath));
  for (const where of [dir, dirname(dir)]) {
    let names: string[];
    try {
      names = readdirSync(where).sort();
    } catch {
      continue;
    }
    const found = names.find((n) => n === 'obfuscation.json') ?? names.find((n) => n.endsWith('.obfuscation.json'));
    if (found && statSync(join(where, found)).isFile()) return join(where, found);
  }
  return undefined;
}

/** The map's contents, checked: a JSON array of obfuscated/original name pairs (flat or nested). */
function readObfuscationMap(file: string): Buffer {
  const data = readFileSync(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}).`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a Dart obfuscation map: expected a JSON array of [obfuscated, original] names.`);
  return data;
}

export interface DartSymbolsUploadOptions extends NativeUploadOptions {
  /** The obfuscation map to upload with the symbols. Default: found next to them (see findObfuscationMap). */
  obfuscationMap?: string;
}

export async function uploadDartSymbols(path: string, connection: Connection | null, options: DartSymbolsUploadOptions = {}) {
  const logger = options.logger ?? consoleLogger();
  const files = findDartSymbols(path, logger);
  if (files.length === 0) throw new Error(`No Dart symbol files in ${path} — build with \`flutter build … --obfuscate --split-debug-info=<dir>\` and pass that directory.`);
  logger.info(`${options.dryRun ? 'Would upload' : 'Uploading'} ${files.length} Dart symbol file(s)`);
  const artifacts: Artifact[] = files.map((f) => ({
    kind: 'dart-symbols',
    debugId: f.buildId,
    name: basename(f.path),
    arch: f.arch,
    release: options.release,
    data: readFileSync(f.path),
    gzip: true,
  }));
  if (options.obfuscationMap && !existsSync(options.obfuscationMap)) throw new Error(`${options.obfuscationMap} does not exist.`);
  const mapFile = options.obfuscationMap ?? findObfuscationMap(path);
  if (mapFile) {
    const data = readObfuscationMap(mapFile);
    // One map serves every architecture of the build: once per build ID.
    const buildIds = [...new Set(files.map((f) => f.buildId))];
    logger.info(`With obfuscation map ${basename(mapFile)} for ${buildIds.length} build ID(s)`);
    for (const debugId of buildIds) {
      artifacts.push({ kind: 'dart-obfuscation-map', debugId, name: basename(mapFile), release: options.release, data, gzip: true });
    }
  } else {
    logger.info('No obfuscation map found (build with --extra-gen-snapshot-options=--save-obfuscation-map=build/obfuscation.json, or pass --obfuscation-map): obfuscated names in error messages stay as they are.');
  }
  artifacts.push(...withSources('flutter', [...new Set(files.map((f) => f.buildId))], options, logger));
  return send(connection, artifacts, options);
}

// ── iOS ──────────────────────────────────────────────────────────────────────

export interface DsymImage {
  /** The DWARF file inside the .dSYM bundle. */
  path: string;
  uuid: string;
  arch: string;
  offset: number;
  size: number;
}

/**
 * The binary images in a .dSYM bundle, a folder of them (Xcode's `$DWARF_DSYM_FOLDER_PATH`), or
 * a DWARF file itself. Universal files give one image per architecture.
 */
export function findDsymImages(path: string): DsymImage[] {
  const root = resolve(path);
  const candidates = statSync(root).isDirectory()
    ? walk(root).filter((f) => /[\\/]Contents[\\/]Resources[\\/]DWARF[\\/][^\\/]+$/.test(f))
    : [root];
  const out: DsymImage[] = [];
  for (const file of candidates) {
    const data = readFileSync(file);
    if (!isMachO(data)) continue;
    for (const image of readMachO(data)) out.push({ path: file, ...image });
  }
  return out;
}

export async function uploadDsyms(path: string, connection: Connection | null, options: NativeUploadOptions = {}) {
  const logger = options.logger ?? consoleLogger();
  const images = findDsymImages(path);
  if (images.length === 0) throw new Error(`No dSYM DWARF files in ${path} — pass a .dSYM bundle or the folder that holds them ($DWARF_DSYM_FOLDER_PATH).`);
  logger.info(`${options.dryRun ? 'Would upload' : 'Uploading'} ${images.length} dSYM image(s)`);
  const cache = new Map<string, Buffer>();
  const artifacts: Artifact[] = images.map((image) => {
    let data = cache.get(image.path);
    if (!data) cache.set(image.path, (data = readFileSync(image.path)));
    return {
      kind: 'dsym',
      debugId: image.uuid,
      name: basename(image.path),
      arch: image.arch,
      release: options.release,
      // One architecture's slice of a universal file is a complete Mach-O file on its own.
      data: data.subarray(image.offset, image.offset + image.size),
      gzip: true,
    };
  });
  // Swift's mangled names, decoded by this Mac's swift-demangle: crashes read "Cart.total() -> Int".
  const names = swiftNames(images.map((image) => image.path), options.xcodeTool === undefined ? undefined : options.xcodeTool);
  if (names && Object.keys(names).length) {
    const data = Buffer.from(JSON.stringify({ names }), 'utf8');
    logger.info(`With readable names for ${Object.keys(names).length} Swift symbol(s)`);
    for (const uuid of new Set(images.map((image) => image.uuid))) {
      artifacts.push({ kind: 'symbol-names', debugId: uuid, name: 'swift-names.json', release: options.release, data, gzip: true });
    }
  } else if (names === null) {
    logger.info('Swift names stay mangled: run the upload on a Mac with Xcode (xcrun swift-demangle) to send readable ones.');
  }
  artifacts.push(...withSources('apple', [...new Set(images.map((image) => image.uuid))], options, logger));
  return send(connection, artifacts, options);
}

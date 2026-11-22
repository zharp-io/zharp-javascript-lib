/**
 * Source maps for JavaScript: inject debug IDs into a build's output, upload each file and its
 * map, and delete the maps so they are not served.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { eachLimit, uploadArtifact, type Connection } from './api';
import { existingDebugId, injectCode, injectMap, sourceMappingUrl, withoutSourceMappingUrl } from './debug-id';
import { formatBytes, pathFilter, relativePath, walk, type Pattern } from './files';
import { consoleLogger, type Logger } from './log';

const JS_FILE = /\.(?:js|mjs|cjs)$/;

export interface SourceFile {
  /** Absolute path of the JavaScript file. */
  file: string;
  /** Absolute path of its source map. */
  map: string;
  /** Path of the file relative to the directory, with forward slashes. */
  name: string;
  mapName: string;
}

export interface FindOptions {
  include?: Pattern;
  exclude?: Pattern;
  /** Only these files (absolute paths) — the bundler plugins pass what the build wrote. */
  files?: string[];
}

/** The source map a JS file has: `<file>.map` next to it, or the file its `sourceMappingURL` names. */
export function mapFor(file: string, code?: string): string | undefined {
  const sibling = `${file}.map`;
  if (existsSync(sibling)) return sibling;
  const url = sourceMappingUrl(code ?? readFileSync(file, 'utf8'));
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined; // data:, http:… are not files here
  let path: string;
  try {
    path = decodeURIComponent(url.split(/[?#]/)[0]);
  } catch {
    return undefined;
  }
  const full = isAbsolute(path) ? path : resolve(dirname(file), path);
  return existsSync(full) ? full : undefined;
}

/** Every JS file under `dir` that has a source map. */
export function findSourceFiles(dir: string, options: FindOptions = {}): SourceFile[] {
  const root = resolve(dir);
  const keep = pathFilter(options.include, options.exclude);
  const candidates = options.files ? options.files.map((f) => resolve(f)) : walk(root);
  const out: SourceFile[] = [];
  for (const file of candidates) {
    if (!JS_FILE.test(file) || !existsSync(file)) continue;
    const name = relativePath(root, file);
    if (!keep(name)) continue;
    const map = mapFor(file);
    if (map) out.push({ file, map, name, mapName: relativePath(root, map) });
  }
  return out;
}

export interface InjectOptions extends FindOptions {
  /** Remove the `sourceMappingURL` comment too — for maps that are deleted after upload. */
  stripSourceMappingUrl?: boolean;
  dryRun?: boolean;
  logger?: Logger;
}

export interface InjectedFile extends SourceFile {
  debugId: string;
  /** False when the file already had this debug ID. */
  changed: boolean;
}

/**
 * Add a debug ID to every JS file under `dir` that has a source map, and to the map. Running it
 * again changes nothing: a file that has a debug ID keeps it.
 */
export function injectDirectory(dir: string, options: InjectOptions = {}): InjectedFile[] {
  const logger = options.logger ?? consoleLogger();
  const files = findSourceFiles(dir, options);
  const out: InjectedFile[] = [];
  const noSourcesContent: string[] = [];
  for (const source of files) {
    const code = readFileSync(source.file, 'utf8');
    const injected = injectCode(code, { stripSourceMappingUrl: options.stripSourceMappingUrl });
    let map;
    try {
      map = injectMap(readFileSync(source.map, "utf8"), injected.debugId, source.map);
    } catch (error) {
      logger.warn(`Skipped ${source.name}: ${source.mapName} is not a readable source map (${(error as Error).message}).`);
      continue;
    }
    if (!options.dryRun) {
      if (injected.changed) writeFileSync(source.file, injected.code);
      if (map.changed) writeFileSync(source.map, map.text);
    }
    if (!map.hasSourcesContent) noSourcesContent.push(source.mapName);
    const changed = injected.changed || map.changed;
    out.push({ ...source, debugId: injected.debugId, changed });
    logger.info(`${changed ? (options.dryRun ? 'would inject' : 'injected') : 'already has'} ${injected.debugId}  ${source.name}`);
  }
  if (noSourcesContent.length) {
    logger.warn(
      `${noSourcesContent.length} source map(s) have no sourcesContent, so Zharp can show original names and lines but not the code around them: ${noSourcesContent.slice(0, 3).join(', ')}${noSourcesContent.length > 3 ? ', …' : ''}`,
    );
  }
  if (out.length === 0) logger.warn(`No JavaScript files with source maps found in ${dir}.`);
  return out;
}

export interface UploadOptions extends FindOptions {
  release?: string;
  /** Delete the .map files once they are uploaded. */
  deleteAfter?: boolean;
  /** Also strip the `sourceMappingURL` comments that pointed at deleted maps. */
  stripSourceMappingUrl?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  logger?: Logger;
  fetch?: typeof fetch;
  retries?: number;
}

export interface UploadResult {
  files: number;
  artifacts: number;
  bytes: number;
  deleted: string[];
  /** Files with a map but no debug ID: run inject first. */
  skipped: string[];
}

/**
 * Upload every JS file under `dir` that has a debug ID, with its source map, keyed by that ID.
 * `connection` may be null in a dry run.
 */
export async function uploadSourcemaps(dir: string, connection: Connection | null, options: UploadOptions = {}): Promise<UploadResult> {
  const logger = options.logger ?? consoleLogger();
  const files = findSourceFiles(dir, options);
  const result: UploadResult = { files: 0, artifacts: 0, bytes: 0, deleted: [], skipped: [] };
  const work: Array<{ source: SourceFile; debugId: string; code: Buffer; map: Buffer }> = [];
  let byRelease = 0;
  for (const source of files) {
    const code = readFileSync(source.file);
    let debugId = existingDebugId(code.toString('utf8'));
    if (!debugId && options.release) {
      // No debug ID (a Worker deployed by Wrangler): filed under the release, and found by it and
      // the file's name. The ID is the file's content, so uploading it again replaces it.
      debugId = contentDebugId(code);
      byRelease++;
    }
    if (!debugId) {
      result.skipped.push(source.name);
      continue;
    }
    work.push({ source, debugId, code, map: readFileSync(source.map) });
  }
  if (result.skipped.length) {
    logger.warn(`${result.skipped.length} file(s) have a source map but no debug ID — run \`zharp sourcemaps inject\` first, or pass --release with the release the app reports: ${result.skipped.slice(0, 3).join(', ')}${result.skipped.length > 3 ? ', …' : ''}`);
  }
  if (byRelease) {
    logger.info(`${byRelease} file(s) have no debug ID: errors from release ${options.release} are matched to them by file name.`);
  }
  if (work.length === 0) {
    logger.warn(`Nothing to upload in ${dir}.`);
    return result;
  }

  const total = work.length;
  logger.info(`${options.dryRun ? 'Would upload' : 'Uploading'} ${total} file(s) and their source maps${options.release ? ` for release ${options.release}` : ''}${connection ? ` to ${connection.url}, app ${connection.app}` : ''}`);
  let done = 0;
  await eachLimit(work, options.concurrency ?? 4, async ({ source, debugId, code, map }) => {
    const size = code.length + map.length;
    if (!options.dryRun) {
      if (!connection) throw new Error('No connection to upload to.');
      const common = { debugId, release: options.release };
      const opts = { fetch: options.fetch, retries: options.retries };
      await uploadArtifact(connection, { ...common, kind: 'minified-source', name: source.name, data: code }, opts);
      await uploadArtifact(connection, { ...common, kind: 'sourcemap', name: source.mapName, data: map }, opts);
    }
    done += 1;
    result.files += 1;
    result.artifacts += 2;
    result.bytes += size;
    logger.info(`  [${done}/${total}] ${options.dryRun ? 'would upload' : 'uploaded'} ${source.name} + ${source.mapName} (${formatBytes(size)})  ${debugId}`);
  });

  if (options.deleteAfter && !options.dryRun) {
    result.deleted = deleteSourcemaps(work.map((w) => w.source), { stripSourceMappingUrl: options.stripSourceMappingUrl });
    logger.info(`Deleted ${result.deleted.length} source map(s) from the output.`);
  }
  logger.info(`${options.dryRun ? 'Dry run: would have uploaded' : 'Uploaded'} ${result.artifacts} artifact(s), ${formatBytes(result.bytes)}.`);
  return result;
}

/** A debug ID made from a file's content: the same file always gets the same one. */
export function contentDebugId(code: Uint8Array): string {
  const hex = createHash('sha256').update(code).digest('hex');
  // A UUID (version 4 bits set) so the server files it like any other debug ID.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Delete these files' source maps (and, if asked, the comments pointing at them). */
export function deleteSourcemaps(files: SourceFile[], options: { stripSourceMappingUrl?: boolean } = {}): string[] {
  const deleted: string[] = [];
  for (const source of files) {
    if (options.stripSourceMappingUrl && existsSync(source.file)) {
      const code = readFileSync(source.file, 'utf8');
      const stripped = withoutSourceMappingUrl(code);
      if (stripped !== code) writeFileSync(source.file, stripped);
    }
    if (existsSync(source.map)) {
      unlinkSync(source.map);
      deleted.push(source.mapName);
    }
  }
  return deleted;
}

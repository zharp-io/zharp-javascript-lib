/**
 * The code around an error's lines, read on the app's own server and sent with the error — and,
 * for built code (TypeScript, a NestJS dist/), each frame turned back into the source it came from
 * through the build's own .js.map next to it, so the stack reads src/users/users.service.ts:42 and
 * the code shown is that TypeScript.
 *
 * Only the app's frames (never node_modules or Node's own), the innermost five, five lines either
 * side, each line capped. Files and maps are read once and kept (a few dozen at most). Off with
 * captureSourceContext: false or ZHARP_CAPTURE_SOURCE_CONTEXT=false.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

export const SOURCE_CONTEXT_ATTRIBUTE = 'zharp.source_context';

const AROUND = 5;
const MAX_FRAMES = 5;
const MAX_LINE = 300;
const MAX_BYTES = 12_000;
const MAX_FILE = 5_000_000;
const MAX_MAP = 30_000_000;
const MAX_CACHED = 50;

let enabled = true;

export function setSourceContext(on: boolean): void {
  enabled = on;
}

interface SourceMapLike {
  findEntry(line: number, column: number): { originalSource?: string; originalLine?: number; originalColumn?: number } | Record<string, never>;
}

interface LoadedMap {
  map: SourceMapLike;
  dir: string;
  sources: string[];
  sourceRoot: string;
  contents: Array<string | null>;
}

const files = new Map<string, string[] | null>();
const maps = new Map<string, LoadedMap | null>();

function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function toPath(file: string): string | null {
  if (file.startsWith('file://')) {
    try {
      return fileURLToPath(file);
    } catch {
      return null;
    }
  }
  return isAbsolute(file) ? file : null;
}

function isApp(path: string): boolean {
  return !/[\\/]node_modules[\\/]/.test(path) && !path.startsWith('node:') && !/[\\/]@zharp[\\/]/.test(path);
}

function linesOf(path: string, text?: string | null): string[] | null {
  if (files.has(path)) return files.get(path)!;
  let content = text ?? null;
  if (content === null) {
    try {
      if (statSync(path).size > MAX_FILE) return remember(files, path, null);
      content = readFileSync(path, 'utf8');
    } catch {
      return remember(files, path, null);
    }
  }
  return remember(files, path, content.split(/\r\n|\n|\r/));
}

/** The source map of a built file: inline, or the file its sourceMappingURL names, or file.map. */
function mapOf(path: string): LoadedMap | null {
  if (maps.has(path)) return maps.get(path)!;
  const SourceMap = (nodeModule as unknown as { SourceMap?: new (payload: unknown) => SourceMapLike }).SourceMap;
  const lines = linesOf(path);
  if (!SourceMap || !lines) return remember(maps, path, null);
  try {
    let payload: any = null;
    let mapPath = `${path}.map`;
    const tail = lines.slice(-5).join('\n');
    const url = /[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(tail)?.[1];
    if (url?.startsWith('data:')) {
      const base64 = /;base64,(.*)$/.exec(url)?.[1];
      payload = base64 ? JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) : null;
      mapPath = path;
    } else {
      if (url) mapPath = resolve(dirname(path), decodeURIComponent(url));
      if (statSync(mapPath).size > MAX_MAP) return remember(maps, path, null);
      payload = JSON.parse(readFileSync(mapPath, 'utf8'));
    }
    if (!payload || !Array.isArray(payload.sources)) return remember(maps, path, null);
    return remember(maps, path, {
      map: new SourceMap(payload),
      dir: dirname(mapPath),
      sources: payload.sources,
      sourceRoot: typeof payload.sourceRoot === 'string' ? payload.sourceRoot : '',
      contents: Array.isArray(payload.sourcesContent) ? payload.sourcesContent : [],
    });
  } catch {
    return remember(maps, path, null);
  }
}

/** Where a built file's line came from: the original file, line and column, and its text if the map has it. */
function original(path: string, line: number, column: number): { file: string; line: number; column: number; text: string | null } | null {
  const loaded = mapOf(path);
  if (!loaded) return null;
  const entry = loaded.map.findEntry(line - 1, Math.max(0, column - 1)) as { originalSource?: string; originalLine?: number; originalColumn?: number };
  if (!entry?.originalSource || entry.originalLine === undefined) return null;
  const index = loaded.sources.findIndex((s) => s === entry.originalSource || entry.originalSource!.endsWith(s));
  const source = entry.originalSource.replace(/^webpack:\/\/[^/]*\//, '').replace(/^file:\/\//, '');
  const file = isAbsolute(source) ? source : resolve(loaded.dir, loaded.sourceRoot, source);
  return { file, line: entry.originalLine + 1, column: (entry.originalColumn ?? 0) + 1, text: index >= 0 ? loaded.contents[index] ?? null : null };
}

const FRAME = /^(\s*at (?:async )?(?:.*? \()?)((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/]).*?):(\d+):(\d+)(\)?)\s*$/;

export interface SourcedStack {
  stack: string;
  context: string | null;
}

/**
 * A V8 stack with the app's built frames turned back into their sources (when a local map says
 * where they came from), and the code around the app's innermost frames.
 */
export function sourced(stack: string): SourcedStack {
  if (!enabled || !stack) return { stack, context: null };
  const out: Array<{ file: string; line: number; pre: string[]; code: string; post: string[] }> = [];
  const seen = new Set<string>();
  let mapped = 0;
  const lines = stack.split('\n').map((text) => {
    const m = FRAME.exec(text);
    if (!m) return text;
    const path = toPath(m[2]);
    if (!path || !isApp(path) || mapped > 40) return text;
    let file = m[2];
    let line = Number(m[3]);
    let column = Number(m[4]);
    let content: string[] | null = null;
    const from = /\.(c|m)?js$/.test(path) ? original(path, line, column) : null;
    mapped++;
    if (from && isApp(from.file)) {
      file = from.file;
      line = from.line;
      column = from.column;
      content = linesOf(from.file, from.text);
      text = `${m[1]}${file}:${line}:${column}${m[5]}`;
    } else if (!from) {
      const built = linesOf(path);
      // A built file whose map isn't here (Next.js deletes them after uploading): its lines are
      // minified output, and the uploaded map will show the real code. Nothing to send.
      const tail = built ? built.slice(-5).join('\n') : '';
      content = /[#@]\s*(?:sourceMappingURL|debugId)=/.test(tail) ? null : built;
    }
    const key = `${file}:${line}`;
    if (content && out.length < MAX_FRAMES && !seen.has(key) && content[line - 1] !== undefined) {
      seen.add(key);
      const cut = (s: string) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
      out.push({
        file,
        line,
        pre: content.slice(Math.max(0, line - 1 - AROUND), line - 1).map(cut),
        code: cut(content[line - 1]),
        post: content.slice(line, line + AROUND).map(cut),
      });
    }
    return text;
  });
  while (out.length) {
    const json = JSON.stringify(out);
    if (Buffer.byteLength(json) <= MAX_BYTES) return { stack: lines.join('\n'), context: json };
    out.pop();
  }
  return { stack: lines.join('\n'), context: null };
}

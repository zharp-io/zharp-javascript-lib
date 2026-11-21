/**
 * Debug IDs for JavaScript, after the TC39 source map "debug ID" proposal: one UUID per emitted
 * file, written into the file (`//# debugId=<uuid>`) and into its source map (`"debugId"`), so an
 * error's frames can be matched to the exact map whatever URL the file was served from.
 *
 * Besides the comment, each file gets one line that registers it at runtime — the SDKs read
 * `globalThis.__zharpDebugIds` to know which build each file in a stack came from.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEBUG_ID_COMMENT = '//# debugId=';
const DEBUG_ID_PATTERN = /^\/\/# debugId=([0-9a-fA-F-]{36})\s*$/m;
const SOURCE_MAPPING_URL = /^\/\/[#@] sourceMappingURL=(.*?)\s*$/;

/**
 * The UUID for a file's content: the first 16 bytes of its SHA-256, with the version and variant
 * bits of a v4 UUID. The same output always gets the same ID, so a rebuild of unchanged code
 * does not need a new upload.
 */
export function debugIdFromContent(content: string | Uint8Array): string {
  const bytes = createHash('sha256').update(content).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The runtime registration: ES5, so it is safe in any bundle whatever its target, and wrapped in
 * a try so it can never break the file it is in. The key is a stack taken inside the file — its
 * top frame is the file's own URL or path, as the runtime names it.
 */
export function registrationSnippet(debugId: string): string {
  return (
    ';!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:' +
    '"undefined"!=typeof window?window:"undefined"!=typeof global?global:{},s=(new Error).stack;' +
    `s&&((g.__zharpDebugIds=g.__zharpDebugIds||{})[s]="${debugId}")}catch(e){}}();`
  );
}

/** The debug ID already in a file, if it has one. */
export function existingDebugId(code: string): string | undefined {
  // Only at the end of the file: a bundle may contain another file's comment in its middle.
  const lines = code.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
    const match = DEBUG_ID_PATTERN.exec(lines[i].trim());
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

/** Whether the file's tail already registers it at runtime. */
export function hasRegistration(code: string): boolean {
  return code.slice(-2000).includes('.__zharpDebugIds=');
}

/** The `sourceMappingURL` the file's last line points at, if any (data: URLs included). */
export function sourceMappingUrl(code: string): string | undefined {
  const lines = code.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
    const match = SOURCE_MAPPING_URL.exec(lines[i].trim());
    if (match) return match[1];
  }
  return undefined;
}

export interface InjectedCode {
  code: string;
  debugId: string;
  /** False when the file already had a debug ID: nothing was changed. */
  changed: boolean;
}

/**
 * The file with its debug ID: the registration line and the comment, appended after the code —
 * before a trailing `sourceMappingURL` comment, if there is one. Appending leaves every existing
 * line and column where it was, so the source map stays valid without being rewritten.
 *
 * A file that already has a debug ID is returned as it is, with that ID.
 */
export function injectCode(code: string, options: { stripSourceMappingUrl?: boolean } = {}): InjectedCode {
  const existing = existingDebugId(code);
  const eol = code.includes('\r\n') ? '\r\n' : '\n';
  if (existing) {
    let out = code;
    // A bundler that writes debug IDs itself (Rollup's sourcemapDebugIds, webpack's
    // `-debugids` devtools, Turbopack) adds the comment but not Zharp's registration.
    if (!hasRegistration(code)) {
      const lines = code.split(/\r?\n/);
      let at = lines.length - 1;
      while (at > 0 && !lines[at].trim().startsWith(DEBUG_ID_COMMENT)) at--;
      lines.splice(at, 0, registrationSnippet(existing));
      out = lines.join(eol);
    }
    if (options.stripSourceMappingUrl) out = withoutSourceMappingUrl(out);
    return { code: out, debugId: existing, changed: out !== code };
  }
  const debugId = debugIdFromContent(code);
  const lines = code.split(/\r?\n/);
  // The trailing sourceMappingURL comment (and the blank lines after it) stays last.
  let tail: string[] = [];
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end > 0 && SOURCE_MAPPING_URL.test(lines[end - 1].trim())) {
    tail = options.stripSourceMappingUrl ? [] : [lines[end - 1]];
    end--;
  }
  const body = lines.slice(0, end);
  const out = [...body, registrationSnippet(debugId), `${DEBUG_ID_COMMENT}${debugId}`, ...tail].join(eol) + eol;
  return { code: out, debugId, changed: true };
}

/** The code without its trailing `sourceMappingURL` comment — for maps that are not shipped. */
export function withoutSourceMappingUrl(code: string): string {
  const lines = code.split(/\r?\n/);
  const eol = code.includes('\r\n') ? '\r\n' : '\n';
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end > 0 && SOURCE_MAPPING_URL.test(lines[end - 1].trim())) return lines.slice(0, end - 1).join(eol) + eol;
  return code;
}

/**
 * The source map with the debug ID in it, under both spellings in use (`debugId` from the TC39
 * proposal, `debug_id` from earlier tooling). Returns the text unchanged when it already matches.
 */
export function injectMap(mapText: string, debugId: string, mapPath?: string): { text: string; changed: boolean; hasSourcesContent: boolean } {
  const map = JSON.parse(mapText);
  if (!map || typeof map !== 'object') throw new Error('not a source map');
  // The build machine has the sources: the app's own files go into the map, so the code shows.
  const filled = mapPath ? fillSourcesContent(map, mapPath) : 0;
  const hasSourcesContent = Array.isArray(map.sourcesContent) && map.sourcesContent.some((s: unknown) => typeof s === 'string');
  if (!filled && map.debugId === debugId && map.debug_id === debugId) return { text: mapText, changed: false, hasSourcesContent };
  map.debugId = debugId;
  map.debug_id = debugId;
  return { text: JSON.stringify(map), changed: true, hasSourcesContent };
}

const MAX_SOURCE_BYTES = 1_000_000;

/** A map source's path on this machine, for the bundlers' ways of naming them. */
export function sourcePathCandidates(source: string, mapPath: string, sourceRoot = ''): string[] {
  const mapDir = dirname(mapPath);
  // turbopack:///[project]/app/page.tsx, webpack://_N_E/./app/page.tsx, webpack:///src/x.ts, file:///abs
  let stripped = source;
  let projectRelative = false;
  if (/^turbopack:\/\/\/\[project\]\//.test(source)) {
    stripped = source.replace(/^turbopack:\/\/\/\[project\]\//, '');
    projectRelative = true;
  } else if (/^webpack:\/\//.test(source)) {
    stripped = source.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\.\//, '');
    projectRelative = true;
  } else if (/^file:\/\//.test(source)) {
    try {
      return [fileURLToPath(source)];
    } catch {
      return [];
    }
  } else if (/^[a-z][\w+.-]*:\/\//i.test(source)) {
    return [];
  }
  if (isAbsolute(stripped)) return [stripped];
  const out = [resolve(mapDir, sourceRoot, stripped)];
  if (projectRelative) {
    // Relative to the project: the nearest folder above the map that has a package.json.
    for (let dir = mapDir, i = 0; i < 12; i++) {
      if (existsSync(join(dir, 'package.json'))) {
        out.unshift(join(dir, stripped));
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return out;
}

/** Fills the app's own sources into a map that left them out. Returns how many it filled. */
export function fillSourcesContent(map: any, mapPath: string): number {
  if (!Array.isArray(map.sources)) return 0;
  const contents: Array<string | null> = Array.isArray(map.sourcesContent) ? [...map.sourcesContent] : [];
  let filled = 0;
  map.sources.forEach((source: unknown, i: number) => {
    if (typeof contents[i] === 'string' || typeof source !== 'string') return;
    if (/node_modules|^\[externals\]|\(ignored\)|^webpack\/runtime/.test(source)) return;
    for (const path of sourcePathCandidates(source, mapPath, typeof map.sourceRoot === 'string' ? map.sourceRoot : '')) {
      if (/[\\/]node_modules[\\/]/.test(path)) continue;
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
        contents[i] = readFileSync(path, 'utf8');
        filled++;
        break;
      } catch {
        // Not here: the next candidate.
      }
    }
  });
  if (filled) {
    while (contents.length < map.sources.length) contents.push(null);
    map.sourcesContent = contents.map((c) => (typeof c === 'string' ? c : null));
  }
  return filled;
}

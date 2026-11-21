/**
 * Source bundles: the app's own source files, uploaded with a build's symbols so an error's
 * frames show the exact code of the build that crashed — without a linked repository.
 *
 * On by default for `dart-symbols upload` and `dsym upload`; `--no-sources` turns it off. The
 * bundle is gzipped JSON, {"files": {"<path from the project root>": "<text>"}}, uploaded once per
 * build ID the errors can carry.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Artifact } from './api';
import { relativePath } from './files';

/** Folders that are never the app's own code: dependencies, build output, tool caches. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'build', '.build', '.dart_tool', '.pub-cache', '.gradle', '.idea', '.vscode',
  'test', 'integration_test', 'Pods', 'Carthage', 'DerivedData', 'xcuserdata', '.swiftpm', 'SourcePackages', 'vendor', '.fvm', '.symlinks', 'ephemeral',
]);

/** Each file at most this big, and the bundle at most this much: an app's code, not its assets. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface CollectedSources {
  root: string;
  files: Record<string, string>;
  count: number;
  bytes: number;
  /** Files left out for being over the caps. */
  skipped: number;
}

/** The source files under `root` with these extensions, by path from `root`. */
export function collectSources(root: string, extensions: string[], skipDirs: string[] = []): CollectedSources {
  const skip = new Set([...SKIP_DIRS, ...skipDirs]);
  const wanted = new Set(extensions.map((e) => e.toLowerCase()));
  const out: CollectedSources = { root, files: {}, count: 0, bytes: 0, skipped: 0 };
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Tests never crash in the shipped app: test/, integration_test/, Xcode's ShopTests/ShopUITests.
        if (!skip.has(entry.name) && !/\.(xcassets|dSYM)$|Tests$/.test(entry.name)) visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0 || !wanted.has(entry.name.slice(dot).toLowerCase())) continue;
      const size = statSync(full).size;
      if (size > MAX_FILE_BYTES || out.bytes + size > MAX_TOTAL_BYTES || out.count >= MAX_FILES) {
        out.skipped += 1;
        continue;
      }
      out.files[relativePath(root, full)] = readFileSync(full, 'utf8');
      out.count += 1;
      out.bytes += size;
    }
  };
  visit(root);
  return out;
}

/** The bundle as uploaded, once per build ID. */
export function sourceBundleArtifacts(sources: CollectedSources, buildIds: string[], release?: string): Artifact[] {
  if (!sources.count) return [];
  const data = Buffer.from(JSON.stringify({ files: sources.files }), 'utf8');
  return [...new Set(buildIds)].map((debugId) => ({ kind: 'source-bundle', debugId, name: 'sources.json', release, data, gzip: true }));
}

/** The nearest folder at or above `from` that has `marker` (pubspec.yaml, an .xcodeproj…). */
export function projectRoot(from: string, marker: (dir: string) => boolean): string | null {
  let dir = resolve(from);
  for (;;) {
    if (marker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const FLUTTER_SOURCES = ['.dart'];
export const APPLE_SOURCES = ['.swift', '.m', '.mm', '.h', '.c', '.cc', '.cpp', '.hpp'];

/** A Flutter app's root: where pubspec.yaml is. */
export const isFlutterRoot = (dir: string) => existsSync(join(dir, 'pubspec.yaml'));

/** An Xcode project's root: the folder with the .xcodeproj / .xcworkspace or Package.swift. */
export const isAppleRoot = (dir: string) => {
  try {
    return existsSync(join(dir, 'Package.swift')) || readdirSync(dir).some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'));
  } catch {
    return false;
  }
};

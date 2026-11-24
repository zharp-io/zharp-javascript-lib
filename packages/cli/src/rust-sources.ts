/**
 * `zharp sources upload`: a Rust crate's code, uploaded as a source bundle under the build ID its
 * `build.rs` puts into the binary (`zharp::build::id()`), so errors show the code that ran
 * without a linked repository.
 *
 * The build ID is the crate's own hash of its `src/**\/*.rs` files, computed the same way here:
 * - every `*.rs` file under `<crate>/src/`, by its path from the crate's folder with forward
 *   slashes (`src/main.rs`, `src/cart/mod.rs`);
 * - sorted by path, comparing the UTF-8 bytes;
 * - SHA-256 over, for each file: the path's bytes, 0x00, the file's raw bytes, 0x00;
 * - the first 16 bytes of the digest, as 32 lowercase hex digits.
 *
 * The bundle is those same files: what the ID covers is what is uploaded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Artifact, Connection } from './api';
import { formatBytes } from './files';
import { consoleLogger } from './log';
import { send, type NativeUploadOptions } from './native';
import { collectSources, projectRoot, sourceBundleArtifacts } from './source-bundle';

/** The `*.rs` files under `<root>/src`, by path from `root` (forward slashes), in byte order. */
export function rustSourceFiles(root: string): { path: string; full: string }[] {
  const out: { path: string; full: string }[] = [];
  const visit = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Like Rust's read_dir file types: symbolic links are neither files nor folders here.
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), path);
      else if (entry.isFile() && entry.name.endsWith('.rs')) out.push({ path, full: join(dir, entry.name) });
    }
  };
  visit(join(root, 'src'), 'src');
  return out.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
}

/** The build ID `zharp::build::id()` computes for the crate at `root`. */
export function rustBuildId(root: string): string {
  const hash = createHash('sha256');
  const zero = Buffer.from([0]);
  for (const file of rustSourceFiles(root)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file.full);
    } catch {
      continue; // Unreadable: left out, as the build.rs helper does.
    }
    hash.update(Buffer.from(file.path, 'utf8'));
    hash.update(zero);
    hash.update(bytes);
    hash.update(zero);
  }
  return hash.digest().subarray(0, 16).toString('hex');
}

const cargoToml = (dir: string): string | null => {
  try {
    return readFileSync(join(dir, 'Cargo.toml'), 'utf8');
  } catch {
    return null;
  }
};

/** The crate's folder: the nearest one at or above `from` with a Cargo.toml. */
export function rustCrateRoot(from: string): string | null {
  return projectRoot(from, (dir) => existsSync(join(dir, 'Cargo.toml')));
}

export interface RustSourcesOptions extends Omit<NativeUploadOptions, 'sources' | 'xcodeTool'> {
  /** The build ID to upload under, instead of the one computed from the files. */
  buildId?: string;
}

/** Bundle the crate's src/ and upload it under its build ID. Returns the artifacts (sent or, dry, not). */
export async function uploadRustSources(dir: string | undefined, connection: Connection | null, options: RustSourcesOptions = {}): Promise<{ buildId: string; artifacts: Artifact[] }> {
  const logger = options.logger ?? consoleLogger();
  const from = resolve(dir ?? process.cwd());
  if (dir && !existsSync(from)) throw new Error(`${dir} does not exist.`);
  const root = rustCrateRoot(from);
  if (!root) throw new Error(`No Cargo.toml at or above ${from}: run it in the crate's folder, or pass it: zharp sources upload <crate folder> --app <id>.`);
  const toml = cargoToml(root) ?? '';
  if (!/^\s*\[package\]/m.test(toml)) {
    throw new Error(`${join(root, 'Cargo.toml')} is a workspace root, not a crate: pass the folder of the binary crate whose build.rs calls zharp::build::id() (zharp sources upload crates/api --app <id>).`);
  }
  const computed = rustBuildId(root);
  const buildId = options.buildId ?? computed;
  const sources = collectSources(join(root, 'src'), ['.rs'], [], false);
  // Keyed from the crate's folder, as the build ID hashed them: src/main.rs.
  sources.root = root;
  sources.files = Object.fromEntries(Object.entries(sources.files).map(([path, text]) => [`src/${path}`, text]));
  if (!sources.count) throw new Error(`No .rs files under ${join(root, 'src')}.`);
  logger.info(`Build ID ${buildId}${options.buildId ? (options.buildId === computed ? ' (given; the same as the sources\')' : ` (given; the sources hash to ${computed})`) : ' (from src/**/*.rs, as zharp::build::id() computes it)'}`);
  logger.info(`${options.dryRun ? 'Would upload' : 'Uploading'} ${sources.count} .rs file(s), ${formatBytes(sources.bytes)} from ${root}${sources.skipped ? ` (${sources.skipped} over the size caps left out)` : ''}`);
  const artifacts = sourceBundleArtifacts(sources, [buildId], options.release);
  await send(connection, artifacts, options);
  return { buildId, artifacts };
}

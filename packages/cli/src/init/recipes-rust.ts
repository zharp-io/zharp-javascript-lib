/**
 * `zharp init` for Rust: a crate's Cargo.toml (or, at a workspace root, its binary member), the
 * web framework it depends on, and the `zharp` crate with the features for it.
 *
 * - `cargo add zharp -F <features>`: `axum`, `actix` or `tower` for the framework, and `sqlx`,
 *   `reqwest`, `anyhow` when the crate uses them. Without cargo, the Cargo.toml line to add.
 * - `let _zharp = zharp::init!();` first in `main`. When the app sets up its own `tracing`
 *   subscriber, Zharp doesn't install one (`install_subscriber(false)`), starts after it, and its
 *   layer joins a `registry()` chain; a `fmt()` one-liner gets the lines to change printed.
 * - Axum: `.layer(zharp::axum::layer())` on the router given to `axum::serve`; Actix Web:
 *   `.wrap(zharp::actix::Middleware)` after `App::new()`; other Tower servers: the layer to add.
 * - `debug = "line-tables-only"` in `[profile.release]` (the workspace root's, for a member): a
 *   release build then keeps file and line for its backtraces.
 * - ZHARP_KEY in .env.
 *
 * Anything that isn't in the common shape is printed to paste, never guessed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { Connected } from './connect';
import type { Project } from './detect';
import type { Plan } from './recipes';

export type RustFramework = 'axum' | 'actix' | 'tower' | 'rust';

/** A Rust crate to set up: where it is, what it serves with, and what it uses. */
export interface RustCrate {
  /** The crate's folder, from the folder init runs in ('' when it is that folder). */
  path: string;
  name: string;
  framework: RustFramework;
  /** The tile it is in Add app. */
  catalog: string;
  label: string;
  /** Its dependencies (the [dependencies] tables, target-specific ones included). */
  dependencies: string[];
  /** The binary's entry file from the crate's folder (src/main.rs, or a [[bin]] path). */
  main: string | null;
  /** The Cargo.toml whose [profile.release] counts: the workspace root's, from the folder init runs in. */
  profileManifest: string;
  /** A workspace's other binary members, when one was picked among several. */
  otherBinaries: string[];
}

const read = (path: string): string | null => {
  try {
    // Worked on with \n line endings; a file that had \r\n gets them back (see planFor).
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};

const slash = (p: string) => p.replace(/\\/g, '/');

// ── Cargo.toml ───────────────────────────────────────────────────────────────────

/** The TOML's lines grouped by table header (`''` before the first one). */
function tables(toml: string): { header: string; start: number; end: number }[] {
  const lines = toml.split('\n');
  const out: { header: string; start: number; end: number }[] = [];
  let current = { header: '', start: 0, end: lines.length };
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(lines[i]);
    if (!m) continue;
    current.end = i;
    out.push(current);
    current = { header: m[1].replace(/\s+/g, ''), start: i + 1, end: lines.length };
  }
  out.push(current);
  return out;
}

/** The lines of every table with this header. */
function tableLines(toml: string, header: (h: string) => boolean): string[] {
  const lines = toml.split('\n');
  return tables(toml).filter((t) => header(t.header)).flatMap((t) => lines.slice(t.start, t.end));
}

const hasTable = (toml: string, name: string) => tables(toml).some((t) => t.header === name);

/** The crate's dependencies: `[dependencies]`, `[target.'…'.dependencies]` and `[dependencies.name]` tables. */
export function cargoDependencies(toml: string): string[] {
  const names = new Set<string>();
  for (const t of tables(toml)) {
    const sub = /^(?:target\..+\.)?dependencies\.([\w-]+)$/.exec(t.header);
    if (sub) names.add(sub[1]);
  }
  for (const line of tableLines(toml, (h) => /^(?:target\..+\.)?dependencies$/.test(h))) {
    // `name = …`, `"name" = …`, `name.workspace = true`.
    const m = /^\s*"?([\w-]+)"?\s*(?:\.\s*[\w-]+\s*)*=/.exec(line);
    if (!m) continue;
    // A renamed dependency (`web = { package = "actix-web" }`) is known by its package.
    const renamed = /\bpackage\s*=\s*"([\w-]+)"/.exec(line);
    names.add(renamed ? renamed[1] : m[1]);
  }
  return [...names];
}

/** A string value from a table: `name = "shop"`. */
function stringIn(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const m = new RegExp(String.raw`^\s*${key}\s*=\s*"([^"]*)"`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** An array of strings from a table, over several lines: `members = ["api", "crates/*"]`. */
function arrayIn(lines: string[], key: string): string[] {
  const text = lines.join('\n');
  const m = new RegExp(String.raw`^\s*${key}\s*=\s*\[([\s\S]*?)\]`, 'm').exec(text);
  if (!m) return [];
  return [...m[1].replace(/#[^\n]*/g, '').matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/** The [[bin]] targets' paths, and the binary's entry file. */
function mainOf(crateDir: string, toml: string): string | null {
  if (existsSync(join(crateDir, 'src', 'main.rs'))) return 'src/main.rs';
  const lines = toml.split('\n');
  for (const t of tables(toml).filter((x) => x.header === 'bin')) {
    const own = lines.slice(t.start, t.end);
    const path = stringIn(own, 'path');
    const name = stringIn(own, 'name');
    const file = path ?? (name ? `src/bin/${name}.rs` : undefined);
    if (file && existsSync(join(crateDir, file))) return slash(file);
  }
  // src/bin/*.rs without [[bin]]: the first one, when there is only one.
  try {
    const bins = readdirSync(join(crateDir, 'src', 'bin')).filter((f) => f.endsWith('.rs'));
    if (bins.length === 1) return `src/bin/${bins[0]}`;
  } catch {
    // No src/bin.
  }
  return null;
}

/** The workspace's member folders (globs ending in `/*` expanded), excluded ones left out. */
function workspaceMembers(root: string, toml: string): string[] {
  const ws = tableLines(toml, (h) => h === 'workspace');
  const exclude = new Set(arrayIn(ws, 'exclude').map((e) => slash(e).replace(/\/+$/, '')));
  const out: string[] = [];
  for (const entry of arrayIn(ws, 'members')) {
    const clean = slash(entry).replace(/\/+$/, '');
    if (/\/\*$/.test(clean)) {
      const parent = clean.slice(0, -2);
      try {
        for (const e of readdirSync(join(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.isDirectory() && existsSync(join(root, parent, e.name, 'Cargo.toml'))) out.push(`${parent}/${e.name}`);
        }
      } catch {
        // A glob over a folder that isn't there.
      }
    } else if (!/[*?[]/.test(clean) && existsSync(join(root, clean, 'Cargo.toml'))) {
      out.push(clean);
    }
  }
  return out.filter((m) => !exclude.has(m));
}

/** The workspace root above a member: the nearest Cargo.toml up the tree with a [workspace]. */
function workspaceRootAbove(dir: string): string | null {
  let at = dirname(dir);
  for (let i = 0; i < 8; i++) {
    const toml = read(join(at, 'Cargo.toml'));
    if (toml !== null && hasTable(toml, 'workspace')) return at;
    if (existsSync(join(at, '.git')) || dirname(at) === at) break;
    at = dirname(at);
  }
  return null;
}

const FRAMEWORKS: Record<RustFramework, [string, string]> = {
  axum: ['Axum', 'Axum'],
  actix: ['Actix Web', 'Actix Web'],
  tower: ['Rust', 'Rust (Tower)'],
  rust: ['Rust', 'Rust'],
};

/** The framework a crate serves with, from its dependencies. */
export function rustFrameworkOf(deps: string[]): RustFramework {
  if (deps.includes('axum')) return 'axum';
  if (deps.includes('actix-web')) return 'actix';
  if (deps.some((d) => ['tonic', 'poem', 'salvo', 'hyper'].includes(d))) return 'tower';
  return 'rust';
}

function crateAt(dir: string, path: string, toml: string, profileManifest: string): RustCrate {
  const crateDir = join(dir, path);
  const deps = cargoDependencies(toml);
  const framework = rustFrameworkOf(deps);
  const [catalog, label] = FRAMEWORKS[framework];
  const name = stringIn(tableLines(toml, (h) => h === 'package'), 'name') ?? (path.split('/').pop() || 'app');
  return { path, name, framework, catalog, label: path ? `${label} (${path})` : label, dependencies: deps, main: mainOf(crateDir, toml), profileManifest, otherBinaries: [] };
}

/**
 * The crate to set up in `dir`: its own, when Cargo.toml has a [package]; at a workspace root,
 * the binary member that serves (Axum, Actix, Tower first), the others named for a later run.
 */
export function detectRust(dir: string): RustCrate | null {
  const toml = read(join(dir, 'Cargo.toml'));
  if (toml === null) return null;
  if (hasTable(toml, 'package')) {
    const root = hasTable(toml, 'workspace') ? null : workspaceRootAbove(dir);
    return crateAt(dir, '', toml, root ? slash(relative(dir, join(root, 'Cargo.toml'))) : 'Cargo.toml');
  }
  if (!hasTable(toml, 'workspace')) return null;
  const members = workspaceMembers(dir, toml).map((path) => crateAt(dir, path, read(join(dir, path, 'Cargo.toml')) ?? '', 'Cargo.toml'));
  const binaries = members.filter((m) => m.main);
  const pick = binaries.sort((a, b) => score(b) - score(a) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0];
  if (!pick) return { path: '', name: basename(dir), framework: 'rust', catalog: 'Rust', label: 'Rust workspace', dependencies: [], main: null, profileManifest: 'Cargo.toml', otherBinaries: [] };
  return { ...pick, otherBinaries: binaries.filter((b) => b !== pick).map((b) => b.path) };
}

const score = (c: RustCrate) => (c.framework === 'rust' ? 0 : 3) + (/test|bench|example|xtask/i.test(c.path) ? -5 : 0);

/** The `zharp` features for a crate: the framework's, then sqlx, reqwest, anyhow when it uses them. */
export function zharpFeatures(crate: Pick<RustCrate, 'framework' | 'dependencies'>): string[] {
  const out: string[] = [];
  if (crate.framework !== 'rust') out.push(crate.framework);
  for (const dep of ['sqlx', 'reqwest', 'anyhow']) if (crate.dependencies.includes(dep)) out.push(dep);
  return out;
}

/** The Cargo.toml line `cargo add` would write. */
export function zharpDependencyLine(features: string[]): string {
  return features.length ? `zharp = { version = "0.1", features = [${features.map((f) => `"${f}"`).join(', ')}] }` : 'zharp = "0.1"';
}

/** Cargo.toml with `debug = "line-tables-only"` in [profile.release]: null when it already says how much debug info. */
export function editReleaseProfile(toml: string): string | null {
  if (/^\s*(?:profile\.)?release\.debug\s*=/m.test(toml)) return null;
  const lines = toml.split('\n');
  const release = tables(toml).find((t) => t.header === 'profile.release');
  const line = ['# Zharp: file and line in release backtraces (the binary grows; speed doesn\'t change).', 'debug = "line-tables-only"'];
  if (release) {
    if (lines.slice(release.start, release.end).some((l) => /^\s*debug\s*=/.test(l))) return null;
    lines.splice(release.start, 0, ...line);
    return lines.join('\n');
  }
  const body = toml.replace(/\s*$/, '');
  return `${body}${body ? '\n\n' : ''}[profile.release]\n${line.join('\n')}\n`;
}

/** Whether [profile.release] strips what the line tables need. */
export function stripsDebugInfo(toml: string): boolean {
  return tableLines(toml, (h) => h === 'profile.release').some((l) => /^\s*strip\s*=\s*(?:true|"(?:symbols|debuginfo)")/.test(l));
}

// ── main.rs ──────────────────────────────────────────────────────────────────────

/** Where `{` at `open` closes, skipping strings, chars and comments. -1 when it doesn't. */
export function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    const raw = /^r(#*)"/.exec(text.slice(i, i + 20));
    if (raw && !/\w/.test(text[i - 1] ?? '')) {
      const end = text.indexOf(`"${raw[1]}`, i + raw[0].length);
      if (end < 0) return -1;
      i = end + raw[1].length;
      continue;
    }
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (ch === "'") {
      // A char literal ('{', '\n', '\''); a lifetime ('a) is left alone.
      const lit = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'])'/.exec(text.slice(i, i + 12));
      if (lit) i += lit[0].length - 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `fn main()` (async, returning a Result or not): where its body starts and ends. */
export function mainBody(text: string): { open: number; close: number; indent: string } | null {
  const m = /^([ \t]*)(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(\s*\)\s*(?:->\s*[^{;]+?)?\s*\{/m.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchingBrace(text, open);
  return close < 0 ? null : { open, close, indent: m[1] };
}

/** A statement in main's body, from the start of its first line to the end of the line its `;` is on. */
interface Statement {
  start: number;
  end: number;
  indent: string;
  text: string;
}

/** The top-level statements in main's body that match: a statement here is the text up to `;` at depth 0. */
function statementsIn(text: string, body: { open: number; close: number }, match: RegExp): Statement[] {
  const out: Statement[] = [];
  let at = text.indexOf('\n', body.open) + 1;
  while (at > 0 && at < body.close) {
    // The statement's end: the first `;` outside brackets, strings and comments.
    let i = at;
    let depth = 0;
    for (; i < body.close; i++) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '/') {
        i = text.indexOf('\n', i);
        if (depth === 0 && /^\s*$/.test(text.slice(at, i).replace(/\/\/[^\n]*/g, ''))) break;
        continue;
      }
      if (ch === '"') {
        for (i++; i < body.close && text[i] !== '"'; i++) if (text[i] === '\\') i++;
        continue;
      }
      if (ch === "'") {
        const lit = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'])'/.exec(text.slice(i, i + 12));
        if (lit) i += lit[0].length - 1;
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') {
        if (ch === '{') {
          const close = matchingBrace(text, i);
          if (close < 0) return out;
          i = close;
          // A block statement (`if … { }`, `loop { }`) ends at its brace when a new line follows.
          if (depth === 0 && /^[ \t]*(?:\/\/[^\n]*)?\n/.test(text.slice(i + 1)) && !/^\s*[.?;]/.test(text.slice(i + 1).replace(/^[ \t]*(?:\/\/[^\n]*)?\n/, ''))) break;
          continue;
        }
        depth++;
        continue;
      }
      if (ch === ')' || ch === ']') depth--;
      if (ch === ';' && depth === 0) break;
    }
    if (i >= body.close) break;
    const lineEnd = text.indexOf('\n', i);
    const end = lineEnd < 0 || lineEnd > body.close ? i + 1 : lineEnd + 1;
    const stmt = text.slice(at, end);
    if (stmt.trim() && match.test(stmt)) out.push({ start: at, end, indent: /^([ \t]*)/.exec(stmt)![1], text: stmt });
    at = end;
  }
  return out;
}

/** A tracing subscriber set up in a statement: `tracing_subscriber::registry()…init();`, `fmt().init()`. */
const SUBSCRIBER = /(?:\btracing_subscriber::|^\s*(?:registry|fmt)\(\)|^\s*fmt::)[^;]*(?:\.|::)(?:try_)?init\(\)|\bset_global_default\(/m;
/** .env loaded: `dotenvy::dotenv().ok();`. */
const DOTENV = /^\s*(?:let\s+[\w_]+\s*=\s*)?(?:dotenvy|dotenv)::[\w:]*\(/;

export interface MainEdit {
  text: string;
  /** What else to print: lines that couldn't be placed for sure. */
  manual: { why: string; snippet: string }[];
  /** For the plan: "starts Zharp; traces Axum requests". */
  note: string;
}

/**
 * main.rs with Zharp started, the framework wired in where its shape is the common one. Null
 * when nothing changes (already set up) or there is no `fn main` to start it in.
 * `subscriberElsewhere`: the crate sets up a subscriber in another file or function.
 */
export function editRustMain(text: string, framework: RustFramework, subscriberElsewhere = false): MainEdit | null {
  const body = mainBody(text);
  if (!body) return null;
  const manual: MainEdit['manual'] = [];
  const notes: string[] = [];
  let out = text;
  let changed = false;
  const started = /\bzharp::init!?\s*\(/.test(text);

  if (!started) {
    const firstLine = /\n([ \t]*)\S/.exec(text.slice(body.open, body.close));
    const indent = firstLine ? firstLine[1] : `${body.indent}    `;
    const subscribers = statementsIn(text, body, SUBSCRIBER);
    const dotenv = statementsIn(text, body, DOTENV);
    const own = subscribers.length > 0 || subscriberElsewhere;
    const init = own ? 'let _zharp = zharp::init!(zharp::Options::new().install_subscriber(false));' : 'let _zharp = zharp::init!();';
    // After .env is loaded (the key may be there) and after the app's own subscriber; else first.
    const after = [...subscribers, ...dotenv].sort((a, b) => b.end - a.end)[0];
    const edits: { at: number; insert: string; remove?: number }[] = [];
    if (after) edits.push({ at: after.end, insert: `${after.indent}${init}\n` });
    else edits.push({ at: text.indexOf('\n', body.open) + 1, insert: `${indent}${init}\n` });

    const sub = subscribers[subscribers.length - 1];
    if (sub && /\bregistry\(\)/.test(sub.text) && /\.with\(/.test(sub.text) && !/zharp::layer\(\)/.test(sub.text)) {
      // `.with(zharp::layer())` before the chain's `.init()`: on its own line when the chain is on several.
      const call = /(\n([ \t]*))?\.(?:try_)?init\(\)/.exec(sub.text)!;
      const at = sub.start + call.index;
      edits.push({ at, insert: call[1] ? `\n${call[2]}.with(zharp::layer())` : '.with(zharp::layer())' });
      notes.push('Zharp\'s layer in your subscriber');
      if (/\.with\(\s*(?:tracing_subscriber::)?(?:EnvFilter|filter::)|\.with\(\s*\w*filter\w*\s*\)/i.test(sub.text)) {
        manual.push({ why: 'a filter on the whole registry also limits what Zharp sees: give it to the fmt layer instead', snippet: '.with(tracing_subscriber::fmt::layer().with_filter(tracing_subscriber::EnvFilter::from_default_env()))\n.with(zharp::layer())' });
      }
    } else if (own) {
      manual.push({
        why: 'your app sets up its own tracing subscriber, so Zharp doesn\'t install one: add its layer to yours',
        snippet: [
          'use tracing_subscriber::prelude::*;',
          '',
          'tracing_subscriber::registry()',
          '    .with(tracing_subscriber::EnvFilter::new("info").and_then(zharp::fmt_layer()))',
          '    .with(zharp::layer())',
          '    .init();',
          'let _zharp = zharp::init!(zharp::Options::new().install_subscriber(false));',
        ].join('\n'),
      });
    }
    for (const e of edits.sort((a, b) => b.at - a.at)) out = `${out.slice(0, e.at)}${e.insert}${out.slice(e.at)}`;
    changed = true;
  }

  if (framework === 'axum' && !/zharp::axum::layer\(\)/.test(out)) {
    const next = addAxumLayer(out);
    if (next) {
      out = next;
      changed = true;
      notes.push('traces Axum requests');
    } else {
      manual.push({ why: 'trace requests: add the layer to your Router, after its routes', snippet: '.layer(zharp::axum::layer())' });
    }
  } else if (framework === 'actix' && !/zharp::actix::Middleware/.test(out)) {
    const next = addActixMiddleware(out);
    if (next) {
      out = next;
      changed = true;
      notes.push('traces Actix requests');
    } else {
      manual.push({ why: 'trace requests: wrap your App', snippet: 'App::new()\n    .wrap(zharp::actix::Middleware)' });
    }
  } else if (framework === 'tower' && !/zharp::tower::layer\(\)/.test(out)) {
    manual.push({ why: 'trace requests: add the Tower layer to your server (tonic, Poem, Salvo, hyper)', snippet: '// tonic:\nServer::builder().layer(zharp::tower::layer())\n// any Tower service:\nuse tower_layer::Layer as _;\nlet service = zharp::tower::layer().layer(service);' });
  }
  if (!changed) return manual.length ? { text, manual, note: '' } : null;
  return { text: out, manual, note: [started ? null : 'starts Zharp first in main', ...notes].filter(Boolean).join('; ') };
}

/** `.layer(zharp::axum::layer())` at the end of the Router chain bound to the name `axum::serve` is given. */
export function addAxumLayer(text: string): string | null {
  const body = mainBody(text);
  if (!body) return null;
  const inMain = text.slice(body.open, body.close);
  const served = /\bserve\(\s*[^;]*?,\s*(\w+)\s*(?:\.into_make_service[\w:<>]*\(\s*\))?\s*,?\s*\)/.exec(inMain)
    ?? /\.serve\(\s*(\w+)\.into_make_service[\w:<>]*\(\s*\)/.exec(inMain);
  if (!served) return null;
  const name = served[1];
  const servedAt = body.open + served.index;
  const bindings = statementsIn(text, body, new RegExp(String.raw`^\s*let\s+(?:mut\s+)?${name}\s*(?::[^=]+)?=`)).filter((s) => s.start < servedAt);
  const binding = bindings[bindings.length - 1];
  if (!binding) return null;
  const expr = binding.text.replace(/^\s*let\s+(?:mut\s+)?\w+\s*(?::[^=]+)?=\s*/, '');
  // A Router chain: built here, or an earlier router with more added to it.
  if (!/\bRouter::new\(\)/.test(expr) && !/^\w+\s*\.\s*(?:route|layer|merge|nest|nest_service|with_state|fallback|route_service)\b/.test(expr.trim())) return null;
  const semi = binding.text.lastIndexOf(';');
  const before = binding.text.slice(0, semi);
  const lastLine = /\n([ \t]*)\.[^\n]*$/.exec(before);
  const insert = lastLine ? `\n${lastLine[1]}.layer(zharp::axum::layer())` : '.layer(zharp::axum::layer())';
  // Before a trailing comment on the last line, if any.
  const tail = /(\s*(?:\/\/[^\n]*)?)$/.exec(before)![1];
  const at = binding.start + before.length - tail.length;
  return `${text.slice(0, at)}${insert}${text.slice(at)}`;
}

/** `.wrap(zharp::actix::Middleware)` right after the one `App::new()` in main. */
export function addActixMiddleware(text: string): string | null {
  const body = mainBody(text);
  if (!body) return null;
  const inMain = text.slice(body.open, body.close);
  const apps = [...inMain.matchAll(/\bApp::new\(\)/g)];
  if (apps.length !== 1) return null;
  const at = body.open + apps[0].index! + apps[0][0].length;
  const next = /^\n([ \t]*)\./.exec(text.slice(at));
  const insert = next ? `\n${next[1]}.wrap(zharp::actix::Middleware)` : '.wrap(zharp::actix::Middleware)';
  return `${text.slice(0, at)}${insert}${text.slice(at)}`;
}

/** Whether another of the crate's files (or another function in main.rs) sets up a tracing subscriber. */
function subscriberOutsideMain(crateDir: string, mainPath: string, mainText: string): boolean {
  const body = mainBody(mainText);
  const outside = body ? mainText.slice(0, body.open) + mainText.slice(body.close) : mainText;
  if (SUBSCRIBER.test(outside.replace(/#\[cfg\(test\)\][\s\S]*$/, ''))) return true;
  const files: string[] = [];
  const walk = (at: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && depth < 4) walk(join(at, e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith('.rs')) files.push(join(at, e.name));
    }
  };
  walk(join(crateDir, 'src'), 0);
  return files.some((f) => slash(relative(crateDir, f)) !== mainPath && SUBSCRIBER.test((read(f) ?? '').replace(/#\[cfg\(test\)\][\s\S]*$/, '')));
}

// ── The plan ─────────────────────────────────────────────────────────────────────

const DEFAULT_API = 'https://api.zharp.io';

export function rust(project: Project, c: Connected, api: string): Plan | null {
  const crate = detectRust(project.dir);
  if (!crate) return null;
  const plan: Plan = { install: [], devInstall: [], changes: [], manual: [], notes: [], env: { file: '.env', vars: { ZHARP_KEY: c.application.ingestKey } }, commands: [] };
  const endpoint = api.replace(/\/+$/, '') === DEFAULT_API ? null : `${api.replace(/\/+$/, '')}/api/v1/otlp`;
  if (endpoint) plan.env.vars.ZHARP_ENDPOINT = endpoint;
  const at = (file: string) => (crate.path ? `${crate.path}/${file}` : file);
  const crateDir = join(project.dir, crate.path);
  const manifest = at('Cargo.toml');
  const manifestText = read(join(project.dir, manifest)) ?? '';

  if (!crate.main) {
    plan.notes.push(crate.label === 'Rust workspace'
      ? 'No binary crate found in this workspace: run npm init zharp@latest in the folder of the crate that has your main.rs.'
      : 'No main.rs found: add the zharp crate, then start it first in your main().');
  }

  // The crate, with the features for what the app uses.
  const features = zharpFeatures(crate);
  const line = zharpDependencyLine(features);
  if (!cargoDependencies(manifestText).includes('zharp')) {
    const argv = ['cargo', 'add', ...(crate.path ? ['--manifest-path', manifest] : []), 'zharp', ...(features.length ? ['-F', features.join(',')] : [])];
    plan.commands!.push({ label: argv.join(' '), argv, ifMissing: { path: manifest, why: 'add the zharp crate under [dependencies]', snippet: line } });
  }

  // Zharp first in main, and the framework's layer.
  if (crate.main) {
    const mainPath = at(crate.main);
    const text = read(join(project.dir, mainPath));
    const edit = text === null ? null : editRustMain(text, crate.framework, subscriberOutsideMain(crateDir, crate.main, text));
    if (edit && edit.text !== text) plan.changes.push({ path: mainPath, kind: 'edit', content: edit.text, note: edit.note });
    for (const m of edit?.manual ?? []) plan.manual.push({ path: mainPath, ...m });
    if (text !== null && !edit && !/\bzharp::init!?\s*\(/.test(text)) plan.manual.push({ path: mainPath, why: 'start Zharp first in main() and keep the guard', snippet: 'let _zharp = zharp::init!();' });
  }

  // Line tables in release builds, in the workspace root's profile (Cargo reads only that one).
  const profilePath = crate.profileManifest;
  const profileText = profilePath === manifest ? manifestText : read(join(project.dir, profilePath));
  if (profileText !== null) {
    const next = editReleaseProfile(profileText);
    if (next) plan.changes.push({ path: profilePath, kind: 'edit', content: next, note: 'debug = "line-tables-only" in [profile.release]: file and line in release backtraces' });
    if (stripsDebugInfo(profileText)) plan.notes.push(`${profilePath}: strip in [profile.release] removes the line tables, so release backtraces have no file or line. Use strip = "none" (or leave strip out) to keep them.`);
  }

  plan.notes.push('Rust doesn\'t read .env by itself: set ZHARP_KEY in the environment you run the app in'
    + (crate.dependencies.some((d) => d === 'dotenvy' || d === 'dotenv') ? ' (your dotenv call loads it when it runs before zharp::init!).' : ', or load .env with the dotenvy crate before zharp::init!.'));
  plan.notes.push(`The code that ran, without a linked repository: call zharp::build::id() in build.rs (zharp in [build-dependencies] with default-features = false) and run npx @zharp/cli sources upload --app ${c.application.id} in CI.`);
  if (crate.otherBinaries.length) plan.notes.push(`Set up ${crate.path} (${crate.label.replace(/ \(.*\)$/, '')}). This workspace has more binaries (${crate.otherBinaries.join(', ')}): run npm init zharp@latest in a crate's folder to set it up.`);
  return plan;
}

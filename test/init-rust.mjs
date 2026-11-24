/**
 * `zharp init` for Rust: Axum, Actix Web, Tower servers, plain binaries, workspaces, an app's own
 * tracing subscriber, the release profile, and nothing done twice.
 *
 *     node test/init-rust.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'detect', 'recipes-rust']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const rs = await import(pathToFileURL(join(tmp, 'recipes-rust.mjs')).href);
const c = { application: { id: 42, name: 'shop', serviceName: 'shop', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
const API = 'https://api.zharp.io';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}
function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
function project(name, files, sub = '') {
  const dir = join(tmp, name);
  write(dir, files);
  return detect(join(dir, sub));
}
/** The plan's file changes written, as `zharp init` writes them. */
function apply(p, plan) {
  for (const ch of plan.changes) {
    mkdirSync(dirname(join(p.dir, ch.path)), { recursive: true });
    writeFileSync(join(p.dir, ch.path), ch.content);
  }
}
const change = (plan, path) => plan.changes.find((ch) => ch.path === path);
const lines = (...l) => `${l.join('\n')}\n`;

const cargo = (name, deps = [], extra = '') => lines('[package]', `name = "${name}"`, 'version = "0.1.0"', 'edition = "2024"', '', '[dependencies]', ...deps, ...(extra ? ['', extra] : []));

const AXUM_MAIN = lines(
  'use axum::{Router, routing::get};',
  '',
  '#[tokio::main]',
  'async fn main() {',
  '    let app = Router::new()',
  '        .route("/", get(|| async { "Hello, World!" }))',
  '        .route("/orders/{id}", get(show));',
  '',
  '    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();',
  '    axum::serve(listener, app).await.unwrap();',
  '}',
  '',
  'async fn show() -> &\'static str {',
  '    "ok"',
  '}',
);

console.log('\nzharp init — Rust');

await test('Axum: detected with its tile; cargo add with axum and the libraries it uses; init! first, the layer after the routes; the release profile; the key in .env', () => {
  const p = project('axum', {
    'Cargo.toml': cargo('shop', ['axum = "0.8"', 'tokio = { version = "1", features = ["full"] }', 'sqlx = { version = "0.9", features = ["postgres"] }', 'serde = "1"', 'anyhow = "1"'], '[dev-dependencies]\nreqwest = "0.13"'),
    'src/main.rs': AXUM_MAIN,
  });
  assert.equal(p.framework, 'rust');
  assert.equal(p.platform, 'rust');
  assert.equal(p.catalog, 'Axum');
  assert.equal(p.name, 'shop');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv), [['cargo', 'add', 'zharp', '-F', 'axum,sqlx,anyhow']], 'reqwest is only a dev-dependency');
  assert.equal(plan.commands[0].ifMissing.snippet, 'zharp = { version = "0.1", features = ["axum", "sqlx", "anyhow"] }');
  assert.equal(change(plan, 'src/main.rs').content, AXUM_MAIN
    .replace('async fn main() {\n', 'async fn main() {\n    let _zharp = zharp::init!();\n')
    .replace('get(show));', 'get(show))\n        .layer(zharp::axum::layer());'));
  assert.match(change(plan, 'src/main.rs').note, /starts Zharp first in main; traces Axum requests/);
  assert.match(change(plan, 'Cargo.toml').content, /\n\n\[profile\.release\]\n# Zharp: [^\n]+\ndebug = "line-tables-only"\n$/);
  assert.deepEqual(plan.env, { file: '.env', vars: { ZHARP_KEY: 'zpk_abc' } });
  assert.equal(plan.manual.length, 0);
  assert.ok(plan.notes.some((n) => n.includes('sources upload --app 42')));
});

await test('Axum on one line, with state, and served from into_make_service; a self-hosted Zharp gets ZHARP_ENDPOINT', () => {
  const main = lines(
    '#[tokio::main]',
    'async fn main() -> anyhow::Result<()> {',
    '    let state = AppState::default();',
    '    let app = Router::new().route("/", get(root)).with_state(state); // routes',
    '    let listener = TcpListener::bind("0.0.0.0:3000").await?;',
    '    axum::serve(listener, app.into_make_service()).await?;',
    '    Ok(())',
    '}',
  );
  const p = project('axum-inline', { 'Cargo.toml': cargo('api', ['axum = "0.8"', 'tokio = "1"', 'anyhow = "1"', 'reqwest = { version = "0.13", features = ["json"] }']), 'src/main.rs': main });
  const plan = planFor(p, c, 'https://zharp.example.com/');
  assert.deepEqual(plan.commands[0].argv, ['cargo', 'add', 'zharp', '-F', 'axum,reqwest,anyhow']);
  assert.equal(change(plan, 'src/main.rs').content, main
    .replace('anyhow::Result<()> {\n', 'anyhow::Result<()> {\n    let _zharp = zharp::init!();\n')
    .replace('.with_state(state); // routes', '.with_state(state).layer(zharp::axum::layer()); // routes'));
  assert.equal(plan.env.vars.ZHARP_ENDPOINT, 'https://zharp.example.com/api/v1/otlp');
});

await test('Axum with the router built elsewhere: init! added, the layer printed', () => {
  const main = lines('#[tokio::main]', 'async fn main() {', '    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();', '    axum::serve(listener, routes::app()).await.unwrap();', '}');
  const p = project('axum-fn', { 'Cargo.toml': cargo('svc', ['axum = "0.8"']), 'src/main.rs': main });
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'src/main.rs').content.includes('    let _zharp = zharp::init!();\n    let listener'));
  assert.ok(!change(plan, 'src/main.rs').content.includes('zharp::axum::layer'));
  assert.deepEqual(plan.manual.map((m) => m.snippet), ['.layer(zharp::axum::layer())']);
});

await test('Actix Web: -F actix, the middleware right after App::new()', () => {
  const main = lines(
    'use actix_web::{App, HttpServer, web};',
    '',
    '#[actix_web::main]',
    'async fn main() -> std::io::Result<()> {',
    '    HttpServer::new(|| {',
    '        App::new()',
    '            .route("/", web::get().to(index))',
    '    })',
    '    .bind(("127.0.0.1", 8080))?',
    '    .run()',
    '    .await',
    '}',
  );
  const p = project('actix', { 'Cargo.toml': cargo('web', ['actix-web = "4"']), 'src/main.rs': main });
  assert.equal(p.catalog, 'Actix Web');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands[0].argv, ['cargo', 'add', 'zharp', '-F', 'actix']);
  assert.equal(change(plan, 'src/main.rs').content, main
    .replace('Result<()> {\n', 'Result<()> {\n    let _zharp = zharp::init!();\n')
    .replace('App::new()\n', 'App::new()\n            .wrap(zharp::actix::Middleware)\n'));
  const inline = lines('#[actix_web::main]', 'async fn main() -> std::io::Result<()> {', '    HttpServer::new(|| App::new().service(hello)).bind(("0.0.0.0", 8080))?.run().await', '}');
  const q = project('actix-inline', { 'Cargo.toml': cargo('web2', ['actix-web = { version = "4", default-features = false }']), 'src/main.rs': inline });
  assert.ok(change(planFor(q, c, API), 'src/main.rs').content.includes('App::new().wrap(zharp::actix::Middleware).service(hello)'));
});

await test('Tower servers (tonic): -F tower, the layer printed; plain Rust: cargo add zharp, init! first', () => {
  const main = lines('#[tokio::main]', 'async fn main() -> Result<(), Box<dyn std::error::Error>> {', '    Server::builder().add_service(svc).serve(addr).await?;', '    Ok(())', '}');
  const p = project('tonic', { 'Cargo.toml': cargo('grpc', ['tonic = "0.14"', 'prost = "0.14"']), 'src/main.rs': main });
  assert.equal(p.catalog, 'Rust');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands[0].argv, ['cargo', 'add', 'zharp', '-F', 'tower']);
  assert.match(plan.manual[0].snippet, /Server::builder\(\)\.layer\(zharp::tower::layer\(\)\)/);

  const plain = lines('fn main() {', '    println!("Hello, world!");', '}');
  const q = project('plain', { 'Cargo.toml': cargo('hello'), 'src/main.rs': plain });
  assert.equal(q.catalog, 'Rust');
  const plainPlan = planFor(q, c, API);
  assert.deepEqual(plainPlan.commands[0].argv, ['cargo', 'add', 'zharp']);
  assert.equal(plainPlan.commands[0].ifMissing.snippet, 'zharp = "0.1"');
  assert.equal(change(plainPlan, 'src/main.rs').content, lines('fn main() {', '    let _zharp = zharp::init!();', '    println!("Hello, world!");', '}'));
  assert.equal(plainPlan.manual.length, 0);
});

await test('a [[bin]] path is the file edited', () => {
  const p = project('bin-path', { 'Cargo.toml': cargo('tool') + lines('', '[[bin]]', 'name = "tool"', 'path = "src/cli.rs"'), 'src/cli.rs': lines('fn main() {', '}') });
  assert.equal(change(planFor(p, c, API), 'src/cli.rs').content, lines('fn main() {', '    let _zharp = zharp::init!();', '}'));
});

await test('the release profile: added to an existing [profile.release]; an existing debug setting kept; strip said', () => {
  assert.equal(rs.editReleaseProfile(lines('[package]', 'name = "a"', '', '[profile.release]', 'lto = true', '', '[profile.dev]', 'opt-level = 1')),
    lines('[package]', 'name = "a"', '', '[profile.release]', '# Zharp: file and line in release backtraces (the binary grows; speed doesn\'t change).', 'debug = "line-tables-only"', 'lto = true', '', '[profile.dev]', 'opt-level = 1'));
  assert.equal(rs.editReleaseProfile(lines('[profile.release]', 'debug = 1')), null);
  assert.equal(rs.editReleaseProfile(lines('[profile.release]', 'debug = true')), null);
  assert.equal(rs.editReleaseProfile(lines('[profile]', 'release.debug = "full"')), null);
  const p = project('strip', { 'Cargo.toml': cargo('s', [], '[profile.release]\nstrip = true'), 'src/main.rs': 'fn main() {}\n' });
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'Cargo.toml').content.includes('[profile.release]\n# Zharp'));
  assert.ok(plan.notes.some((n) => n.includes('strip')));
});

await test('a workspace root: the binary that serves is picked (not the library, not the worker), cargo add by manifest path, the profile in the root', () => {
  const p = project('workspace', {
    'Cargo.toml': lines('[workspace]', 'resolver = "3"', 'members = [', '    "crates/*",', '    "tools/xtask",', ']', '', '[workspace.dependencies]', 'axum = "0.8"'),
    'crates/api/Cargo.toml': cargo('shop-api', ['axum = { workspace = true }', 'shop-core = { path = "../core" }', 'reqwest.workspace = true']),
    'crates/api/src/main.rs': AXUM_MAIN,
    'crates/worker/Cargo.toml': cargo('shop-worker', ['tokio = "1"']),
    'crates/worker/src/main.rs': 'fn main() {}\n',
    'crates/core/Cargo.toml': cargo('shop-core'),
    'crates/core/src/lib.rs': 'pub fn x() {}\n',
    'tools/xtask/Cargo.toml': cargo('xtask'),
    'tools/xtask/src/main.rs': 'fn main() {}\n',
  });
  assert.equal(p.framework, 'rust');
  assert.equal(p.catalog, 'Axum');
  assert.equal(p.name, 'shop-api');
  assert.equal(p.label, 'Axum (crates/api)');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands[0].argv, ['cargo', 'add', '--manifest-path', 'crates/api/Cargo.toml', 'zharp', '-F', 'axum,reqwest']);
  assert.ok(change(plan, 'crates/api/src/main.rs').content.includes('.layer(zharp::axum::layer())'));
  assert.ok(change(plan, 'Cargo.toml').content.includes('[profile.release]\n# Zharp'), 'the profile goes in the workspace root');
  assert.ok(!change(plan, 'crates/api/Cargo.toml'), 'not in the member (Cargo ignores it there)');
  assert.ok(plan.notes.some((n) => n.includes('crates/worker') && n.includes('tools/xtask')));
});

await test('run in a workspace member: that crate, and the profile in the root above it', () => {
  const p = project('member', {
    'Cargo.toml': lines('[workspace]', 'members = ["api"]', '', '[profile.release]', 'opt-level = 3'),
    'api/Cargo.toml': cargo('api', ['actix-web = "4"']),
    'api/src/main.rs': 'fn main() {\n}\n',
  }, 'api');
  assert.equal(p.catalog, 'Actix Web');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands[0].argv, ['cargo', 'add', 'zharp', '-F', 'actix']);
  const root = change(plan, '../Cargo.toml');
  assert.ok(root && root.content.includes('[profile.release]\n# Zharp: file and line in release backtraces (the binary grows; speed doesn\'t change).\ndebug = "line-tables-only"\nopt-level = 3'));
  assert.deepEqual(plan.manual.map((m) => m.why), ['trace requests: wrap your App'], 'no App::new() here: printed');
});

await test('a workspace with no binary: said, nothing guessed', () => {
  const p = project('libs', { 'Cargo.toml': lines('[workspace]', 'members = ["a"]'), 'a/Cargo.toml': cargo('a'), 'a/src/lib.rs': '' });
  assert.equal(p.framework, 'rust');
  const plan = planFor(p, c, API);
  assert.ok(plan.notes[0].includes('No binary crate'));
  assert.ok(!plan.changes.some((ch) => ch.path.endsWith('.rs')));
});

await test('an app\'s own registry() subscriber: Zharp\'s layer joins it, init! after it without installing one', () => {
  const main = lines(
    'use tracing_subscriber::prelude::*;',
    '',
    '#[tokio::main]',
    'async fn main() {',
    '    dotenvy::dotenv().ok();',
    '    tracing_subscriber::registry()',
    '        .with(tracing_subscriber::fmt::layer())',
    '        .init();',
    '',
    '    let app = Router::new().route("/", get(root));',
    '    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();',
    '    axum::serve(listener, app).await.unwrap();',
    '}',
  );
  const p = project('subscriber', { 'Cargo.toml': cargo('sub', ['axum = "0.8"', 'tracing-subscriber = "0.3"', 'dotenvy = "0.15"']), 'src/main.rs': main });
  const plan = planFor(p, c, API);
  assert.equal(change(plan, 'src/main.rs').content, main
    .replace('        .init();\n', '        .with(zharp::layer())\n        .init();\n    let _zharp = zharp::init!(zharp::Options::new().install_subscriber(false));\n')
    .replace('get(root));', 'get(root)).layer(zharp::axum::layer());'));
  assert.equal(plan.manual.length, 0);
  assert.ok(plan.notes.some((n) => n.includes('your dotenv call')));
});

await test('a fmt() one-liner: init! after it without a subscriber, the change to make printed; a subscriber in another file too', () => {
  const main = lines('fn main() {', '    tracing_subscriber::fmt().with_env_filter("info").init();', '    run();', '}');
  const p = project('fmt', { 'Cargo.toml': cargo('f', ['tracing-subscriber = "0.3"']), 'src/main.rs': main });
  const plan = planFor(p, c, API);
  assert.equal(change(plan, 'src/main.rs').content, main.replace('.init();\n', '.init();\n    let _zharp = zharp::init!(zharp::Options::new().install_subscriber(false));\n'));
  assert.equal(plan.manual.length, 1);
  assert.match(plan.manual[0].snippet, /\.with\(zharp::layer\(\)\)/);

  const q = project('elsewhere', {
    'Cargo.toml': cargo('e', ['tracing-subscriber = "0.3"']),
    'src/main.rs': lines('mod telemetry;', '', 'fn main() {', '    telemetry::init();', '}'),
    'src/telemetry.rs': lines('pub fn init() {', '    tracing_subscriber::fmt::init();', '}'),
  });
  const qPlan = planFor(q, c, API);
  assert.equal(change(qPlan, 'src/main.rs').content, lines('mod telemetry;', '', 'fn main() {', '    let _zharp = zharp::init!(zharp::Options::new().install_subscriber(false));', '    telemetry::init();', '}'));
  assert.equal(qPlan.manual.length, 1);
});

await test('nothing twice: the plan applied, a second run changes nothing and runs nothing', () => {
  const p = project('again', {
    'Cargo.toml': cargo('again', ['axum = "0.8"', 'tokio = "1"']),
    'src/main.rs': AXUM_MAIN,
  });
  const plan = planFor(p, c, API);
  apply(p, plan);
  // What cargo add would write.
  writeFileSync(join(p.dir, 'Cargo.toml'), readFileSync(join(p.dir, 'Cargo.toml'), 'utf8').replace('tokio = "1"\n', 'tokio = "1"\nzharp = { version = "0.1", features = ["axum"] }\n'));
  const again = planFor(detect(p.dir), c, API);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.commands, []);
  assert.deepEqual(again.manual, []);
});

await test('Windows line endings kept', () => {
  const p = project('crlf', { 'Cargo.toml': cargo('w').replace(/\n/g, '\r\n'), 'src/main.rs': 'fn main() {\r\n    println!("hi");\r\n}\r\n' });
  const plan = planFor(p, c, API);
  assert.equal(change(plan, 'src/main.rs').content, 'fn main() {\r\n    let _zharp = zharp::init!();\r\n    println!("hi");\r\n}\r\n');
  assert.ok(!/[^\r]\n/.test(change(plan, 'Cargo.toml').content));
});

await test('Cargo.toml parsing: dependency tables, renamed packages, target-specific ones; not dev-dependencies', () => {
  const toml = lines('[package]', 'name = "x"', '', '[dependencies]', 'web = { package = "actix-web", version = "4" }', '"serde" = "1"', '', '[dependencies.sqlx]', 'version = "0.9"', '', "[target.'cfg(unix)'.dependencies]", 'hyper = "1"', '', '[dev-dependencies]', 'axum = "0.8"');
  assert.deepEqual(rs.cargoDependencies(toml).sort(), ['actix-web', 'hyper', 'serde', 'sqlx']);
  assert.equal(rs.rustFrameworkOf(rs.cargoDependencies(toml)), 'actix');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);

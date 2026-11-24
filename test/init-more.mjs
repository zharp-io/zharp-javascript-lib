/**
 * `zharp init` beyond the JavaScript build tools: Express, Django, FastAPI, Flask, Laravel, Go, Ruby.
 *
 *     node test/init-more.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'recipes-more', 'detect']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const more = await import(pathToFileURL(join(tmp, 'recipes-more.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const c = { application: { id: 42, name: 'shop', serviceName: 'shop', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
const API = 'https://api.zharp.io';
const NL = '\n';

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
function project(name, files) {
  const dir = join(tmp, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return detect(dir);
}
const change = (plan, path) => plan.changes.find((ch) => ch.path === path);

console.log('\nzharp init — more frameworks');

await test('Express (CommonJS): instrument.js next to the entry, required first, key in .env', () => {
  const p = project('express-cjs', {
    'package.json': JSON.stringify({ name: 'api', main: 'src/server.js', scripts: { start: 'node src/server.js' }, dependencies: { express: '^5.1.0' } }),
    'src/server.js': ["const express = require('express');", 'const app = express();', 'app.listen(3000);', ''].join(NL),
  });
  assert.equal(p.framework, 'express');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.install, ['@zharp/node']);
  assert.ok(change(plan, 'src/instrument.js').content.startsWith("const { Zharp } = require('@zharp/node');"));
  assert.ok(change(plan, 'src/server.js').content.startsWith("require('./instrument');" + NL + "const express"));
  assert.deepEqual(plan.env, { file: '.env', vars: { ZHARP_KEY: 'zpk_abc' } });
});

await test('Express (ES modules): preloaded from the start script, the entry left alone', () => {
  const pkgText = JSON.stringify({ name: 'api', type: 'module', scripts: { start: 'node server.js', dev: 'node --watch server.js' }, dependencies: { express: '5' } }, null, 2);
  const p = project('express-esm', { 'package.json': pkgText, 'server.js': "import express from 'express';" + NL });
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'instrument.js').content.startsWith("import { Zharp } from '@zharp/node';"));
  const scripts = JSON.parse(change(plan, 'package.json').content).scripts;
  assert.equal(scripts.start, 'node --import ./instrument.js server.js');
  assert.equal(scripts.dev, 'node --import ./instrument.js --watch server.js');
  assert.ok(!change(plan, 'server.js'));
});

await test('Django: zharp.init after the docstring and imports of manage.py, wsgi.py and asgi.py; added to requirements', () => {
  const manage = ['#!/usr/bin/env python', '"""Django\'s command-line utility for administrative tasks."""', 'import os', 'import sys', '', '', 'def main():', '    pass', ''].join(NL);
  const wsgi = ['"""', 'WSGI config for shop project.', '"""', '', 'import os', '', 'from django.core.wsgi import get_wsgi_application', '', "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'shop.settings')", 'application = get_wsgi_application()', ''].join(NL);
  const p = project('django-app', { 'requirements.txt': 'Django==5.2' + NL, 'manage.py': manage, 'shop/wsgi.py': wsgi, 'shop/asgi.py': wsgi.replace(/WSGI|wsgi/g, 'ASGI') });
  assert.equal(p.framework, 'django');
  const plan = planFor(p, c, API);
  const m = change(plan, 'manage.py').content;
  assert.ok(m.includes('import sys' + NL + NL + 'import zharp' + NL), m);
  assert.ok(m.includes('zharp.init(key="zpk_abc", service="shop")'));
  assert.ok(m.indexOf('zharp.init') < m.indexOf('def main'));
  const w = change(plan, 'shop/wsgi.py').content;
  assert.ok(w.indexOf('zharp.init') > w.indexOf('from django.core.wsgi import') && w.indexOf('zharp.init') < w.indexOf('os.environ.setdefault'), w);
  assert.ok(change(plan, 'shop/asgi.py'));
  assert.equal(change(plan, 'requirements.txt').content, 'Django==5.2' + NL + 'zharp' + NL);
  assert.equal(plan.env.file, '', 'the key is in code, no env file');
  assert.deepEqual(plan.manual.map((x) => x.snippet), ['pip install zharp'], 'no virtualenv here: the install is left to do');
});

await test('FastAPI and Flask: the file that creates the app; a project virtualenv gets the install', () => {
  const fast = project('fastapi-app', {
    'requirements.txt': 'fastapi' + NL,
    'app/main.py': ['from fastapi import FastAPI', '', 'app = FastAPI()', ''].join(NL),
    '.venv/bin/python': '',
  });
  const plan = planFor(fast, c, API);
  assert.ok(change(plan, 'app/main.py').content.startsWith('from fastapi import FastAPI' + NL + NL + 'import zharp'));
  assert.equal(plan.commands[0].label, 'install zharp into .venv');
  const flask = project('flask-app', { 'requirements.txt': 'Flask' + NL, 'app.py': ['from flask import Flask', 'app = Flask(__name__)', ''].join(NL) });
  assert.ok(change(planFor(flask, c, API), 'app.py').content.includes('zharp.init('));
});

await test('Laravel: composer require, the key in .env (Laravel reads it), nothing else to edit', () => {
  const p = project('laravel-app', { 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^12.0' } }) });
  assert.equal(p.framework, 'laravel');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['composer require zharp/zharp']);
  assert.deepEqual(plan.env, { file: '.env', vars: { ZHARP_KEY: 'zpk_abc', ZHARP_SERVICE: 'shop' } });
  assert.deepEqual(plan.changes, []);
});

await test('Go with Gin: Zharp started first in main(), the router traced, imports added', () => {
  const main = ['package main', '', 'import (', '\t"net/http"', '', '\t"github.com/gin-gonic/gin"', ')', '', 'func main() {', '\tr := gin.Default()', '\tr.GET("/ping", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })', '\tr.Run(":8080")', '}', ''].join(NL);
  const p = project('go-gin', { 'go.mod': ['module example.com/shop', '', 'require github.com/gin-gonic/gin v1.12.0', ''].join(NL), 'main.go': main });
  assert.equal(p.label, 'Go (Gin)');
  const plan = planFor(p, c, API);
  const out = change(plan, 'main.go').content;
  // goimports' layout: "context" with the standard library, the modules with the modules.
  assert.ok(out.includes('import (' + NL + '\t"net/http"' + NL + '\t"context"' + NL + NL + '\t"github.com/gin-gonic/gin"' + NL + '\tzharp "github.com/zharp-io/zharp-go-lib"' + NL + '\t"github.com/zharp-io/zharp-go-lib/zharpgin"' + NL + ')'), out);
  assert.ok(out.includes('func main() {' + NL + "\t// The app's key"), out);
  assert.ok(out.includes('shutdown := zharp.Init(zharp.Config{Key: "zpk_abc", Service: "shop"})' + NL + '\tdefer shutdown(context.Background())'));
  assert.ok(out.includes('\tr := gin.Default()' + NL + '\tr.Use(zharpgin.Middleware())' + NL));
  assert.deepEqual(plan.commands.map((x) => x.argv[0] + ' ' + x.argv[1]), ['go get', 'go get', 'go mod', 'gofmt -w']);
});

await test('Go with net/http: the handler given to ListenAndServe is traced', () => {
  const main = ['package main', '', 'import (', '\t"net/http"', ')', '', 'func main() {', '\tmux := http.NewServeMux()', '\thttp.ListenAndServe(":8080", mux)', '}', ''].join(NL);
  const out = more.editGoMain(main, c, API, { gin: false, echo: false });
  assert.ok(out.includes('http.ListenAndServe(":8080", zharp.Handler(mux))'), out);
  assert.ok(out.includes('\t"net/http"' + NL + '\t"context"' + NL + NL + '\tzharp "github.com/zharp-io/zharp-go-lib"' + NL + ')'), out);
  assert.ok(more.editGoMain(main.replace('mux)', 'nil)'), c, API, { gin: false, echo: false }).includes('zharp.Handler(http.DefaultServeMux)'));
  assert.equal(more.editGoMain(out, c, API, { gin: false, echo: false }), null, 'twice: no');
});

await test('Windows line endings (django-admin on Windows): the shebang stays first, the file keeps CRLF', () => {
  const CRLF = '\r\n';
  const manage = ['#!/usr/bin/env python', '"""Django\'s command-line utility for administrative tasks."""', 'import os', 'import sys', '', '', 'def main():', '    pass', ''].join(CRLF);
  const p = project('django-crlf', { 'requirements.txt': 'Django' + CRLF, 'manage.py': manage, 'shop/wsgi.py': ['import os', 'application = None', ''].join(CRLF) });
  const plan = planFor(p, c, API);
  const m = change(plan, 'manage.py').content;
  assert.ok(m.startsWith('#!/usr/bin/env python' + CRLF), m);
  assert.ok(m.includes('import sys' + CRLF + CRLF + 'import zharp' + CRLF), m);
  assert.ok(!/[^\r]\n/.test(m), 'every line ends in CRLF');
  assert.equal(change(plan, 'requirements.txt').content, 'Django' + CRLF + 'zharp' + CRLF);
});

await test('Koa, Hapi, Fastify, Connect: set up like Express, created as their Add app tile', () => {
  for (const [dep, catalog] of [['koa', 'Koa'], ['@hapi/hapi', 'Hapi'], ['fastify', 'Fastify'], ['connect', 'Connect']]) {
    const p = project(`node-${catalog}`, {
      'package.json': JSON.stringify({ name: 'api', main: 'server.js', scripts: { start: 'node server.js' }, dependencies: { [dep]: '^5.0.0' } }),
      'server.js': [`const app = require('${dep}');`, ''].join(NL),
    });
    assert.equal(p.catalog, catalog);
    assert.equal(p.platform, 'node');
    const plan = planFor(p, c, API);
    assert.deepEqual(plan.install, ['@zharp/node'], catalog);
    assert.ok(change(plan, 'server.js').content.startsWith("require('./instrument');"), catalog);
  }
});

await test('Python frameworks beyond Django/FastAPI/Flask: Zharp starts in the file that creates the app', () => {
  const cases = [
    ['chalice', 'Chalice', 'app.py', 'from chalice import Chalice\n\napp = Chalice(app_name="orders")\n'],
    ['sanic', 'Sanic', 'server.py', 'from sanic import Sanic\n\napp = Sanic("shop")\n'],
    ['starlette', 'Starlette', 'main.py', 'from starlette.applications import Starlette\n\napp = Starlette()\n'],
    ['falcon', 'Falcon', 'app.py', 'import falcon\n\napp = falcon.App()\n'],
    ['aiohttp', 'AIOHTTP', 'main.py', 'from aiohttp import web\n\napp = web.Application()\n'],
    ['celery', 'Celery', 'tasks.py', 'from celery import Celery\n\napp = Celery("shop")\n'],
  ];
  for (const [req, catalog, file, code] of cases) {
    const p = project(`py-${req}`, { 'requirements.txt': `${req}\n`, [file]: code, 'helpers.py': 'import os\n' });
    assert.equal(p.framework, req);
    assert.equal(p.catalog, catalog);
    const plan = planFor(p, c, API);
    const edited = change(plan, file);
    assert.ok(edited, `${catalog}: ${file} edited`);
    assert.ok(edited.content.indexOf('zharp.init(') < edited.content.indexOf('app = '), `${catalog}: before the app`);
    assert.equal(!!change(plan, 'helpers.py'), false);
    assert.equal(edited.content.includes('logs=True'), req === 'chalice', `${catalog}: logs only for Chalice`);
  }
});

await test('Go: Fiber after its recover middleware, Iris on the router, fasthttp handler wrapped, gorilla/mux named', () => {
  const head = (imp) => ['package main', '', 'import (', ...imp.map((i) => `\t"${i}"`), ')', '', 'func main() {'];
  const fiber = more.editGoMain([...head(['github.com/gofiber/fiber/v2']), '\tapp := fiber.New()', '\tapp.Use(recover.New())', '\tapp.Listen(":3000")', '}', ''].join(NL), c, API, { fiber: true });
  assert.ok(fiber.includes('\tapp.Use(recover.New())' + NL + '\tapp.Use(zharpfiber.Middleware())' + NL), fiber);
  assert.ok(fiber.includes('"github.com/zharp-io/zharp-go-lib/zharpfiber"'));
  const iris = more.editGoMain([...head(['github.com/kataras/iris/v12']), '\tapp := iris.New()', '\tapp.Listen(":8080")', '}', ''].join(NL), c, API, { iris: true });
  assert.ok(iris.includes('\tapp := iris.New()' + NL + '\tapp.UseRouter(zharpiris.Middleware())' + NL), iris);
  const fast = more.editGoMain([...head(['github.com/valyala/fasthttp']), '\tfasthttp.ListenAndServe(":8080", r.Handler)', '}', ''].join(NL), c, API, { fasthttp: true });
  assert.ok(fast.includes('fasthttp.ListenAndServe(":8080", zharpfasthttp.Handler(r.Handler))'), fast);
  const gorilla = more.editGoMain([...head(['net/http', 'github.com/gorilla/mux']), '\tr := mux.NewRouter()', '\thttp.ListenAndServe(":8080", r)', '}', ''].join(NL), c, API, { gorilla: true });
  assert.ok(gorilla.includes('\tr := mux.NewRouter()' + NL + '\tr.Use(zharpmux.Middleware())' + NL), gorilla);
  assert.ok(gorilla.includes('http.ListenAndServe(":8080", zharp.Handler(r))'), gorilla);
});

await test('Go detection: the router decides the tile; the plan fetches its module', () => {
  const p = project('go-fiber', { 'go.mod': 'module example.com/shop\n\nrequire github.com/gofiber/fiber/v2 v2.52.0\n', 'main.go': ['package main', '', 'import (', '\t"github.com/gofiber/fiber/v2"', ')', '', 'func main() {', '\tapp := fiber.New()', '\tapp.Listen(":3000")', '}', ''].join(NL) });
  assert.equal(p.catalog, 'Fiber');
  assert.equal(p.label, 'Go (Fiber)');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.slice(0, 3).join(' ')), ['go get github.com/zharp-io/zharp-go-lib@latest', 'go get github.com/zharp-io/zharp-go-lib/zharpfiber@latest', 'go mod tidy', 'gofmt -w main.go']);
  const negroni = project('go-negroni', { 'go.mod': 'module x\n\nrequire (\n\tgithub.com/gorilla/mux v1.8.1\n\tgithub.com/urfave/negroni v1.0.0\n)\n', 'main.go': 'package main\n' });
  assert.equal(negroni.catalog, 'Negroni');
});

await test('Rails: bundle add, the generator with the key into credentials; Rails tile, ruby platform', () => {
  const p = project('rails-app', {
    'Gemfile': 'source "https://rubygems.org"\n\ngem "rails", "~> 8.1.4"\ngem "pg"\n',
    'config/application.rb': 'module Shop\n  class Application < Rails::Application\n  end\nend\n',
    // jsbundling's package.json is the front end: still Rails.
    'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0', vite: '^7.0.0' } }),
  });
  assert.equal(p.framework, 'rails');
  assert.equal(p.catalog, 'Rails');
  assert.equal(p.platform, 'ruby');
  assert.equal(p.label, 'Rails 8');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['bundle add zharp', 'bundle exec rails generate zharp:install --key=zpk_abc']);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.env.vars, {});
});

await test('Rails with dotenv: the key in .env, the generator without it', () => {
  const p = project('rails-dotenv', { 'Gemfile': "gem 'rails', '~> 7.1'\ngem 'dotenv-rails', groups: [:development, :test]\n" });
  const plan = planFor(p, c, 'http://localhost:3000');
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['bundle add zharp', 'bundle exec rails generate zharp:install']);
  assert.deepEqual(plan.env, { file: '.env', vars: { ZHARP_KEY: 'zpk_abc', ZHARP_SERVICE: 'shop', ZHARP_ENDPOINT: 'http://localhost:3000/api/v1/otlp' } });
});

await test('Sinatra: config.ru requires zharp after its requires and uses Zharp::Rack before run; Rack Middleware tile', () => {
  const p = project('sinatra-app', {
    'Gemfile': "source 'https://rubygems.org'\ngem 'sinatra'\ngem 'puma'\n",
    'config.ru': ['require "bundler/setup"', 'require_relative "app"', '', 'run App', ''].join(NL),
  });
  assert.equal(p.framework, 'sinatra');
  assert.equal(p.catalog, 'Rack Middleware');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['bundle add zharp']);
  assert.equal(change(plan, 'config.ru').content, [
    'require "bundler/setup"',
    'require_relative "app"',
    'require "zharp"',
    "# The app's key can only send data to this app, so it is safe in code.",
    'Zharp.init(key: "zpk_abc", service: "shop")',
    '',
    'use Zharp::Rack',
    'run App',
    '',
  ].join(NL));
  // Run again: already set up.
  assert.equal(more.editConfigRu(change(plan, 'config.ru').content, c, API, true), null);
});

await test('Rack with dotenv loaded in config.ru: the key in .env; Hanami and plain Rack are Rack Middleware', () => {
  const p = project('rack-dotenv', { 'Gemfile': 'gem "rack"\ngem "dotenv"\n', 'config.ru': 'require "dotenv/load"\nrun ->(env) { [200, {}, ["ok"]] }\n' });
  assert.equal(p.framework, 'rack');
  const plan = planFor(p, c, API);
  assert.equal(change(plan, 'config.ru').content, 'require "dotenv/load"\nrequire "zharp"\nuse Zharp::Rack\nrun ->(env) { [200, {}, ["ok"]] }\n');
  assert.equal(plan.env.vars.ZHARP_KEY, 'zpk_abc');
  assert.equal(project('hanami-app', { 'Gemfile': 'gem "hanami", "~> 2.2"\n' }).catalog, 'Rack Middleware');
});

await test("Plain Ruby: bundle add and the init snippet; Ruby tile. React Native's CocoaPods Gemfile stays React Native", () => {
  const p = project('ruby-worker', { 'Gemfile': 'gem "sidekiq"\n' });
  assert.equal(p.framework, 'ruby');
  assert.equal(p.catalog, 'Ruby');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['bundle add zharp']);
  assert.match(plan.manual[0].snippet, /Zharp\.init\(key: "zpk_abc", service: "shop"\)/);
  const rn = project('rn-pods', { 'Gemfile': "gem 'cocoapods'\n", 'package.json': JSON.stringify({ name: 'm', dependencies: { 'react-native': '0.79.0', react: '19.0.0' } }) });
  assert.equal(rn.framework, 'react-native');
});

await test('Plain PHP: composer require, Zharp started after the autoloader in public/index.php; PHP tile', () => {
  const index = ['<?php', '', "require __DIR__ . '/../vendor/autoload.php';", '', "echo 'hello';", ''].join(NL);
  const p = project('plain-php', { 'composer.json': JSON.stringify({ require: { 'monolog/monolog': '^3.0' } }), 'public/index.php': index });
  assert.equal(p.framework, 'php');
  assert.equal(p.catalog, 'PHP');
  assert.equal(p.platform, 'php');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['composer require zharp/zharp']);
  const out = change(plan, 'public/index.php').content;
  assert.ok(out.includes("require __DIR__ . '/../vendor/autoload.php';" + NL + NL + "// The app's key"), out);
  assert.ok(out.includes("Zharp\\Zharp::init([" + NL + "    'key' => 'zpk_abc'," + NL + "    'service' => 'shop'," + NL + ']);' + NL + NL + "echo 'hello';"), out);
  // Run again: already started, nothing to change.
  assert.equal(more.editPhpEntry(out, c, API), null);
  // A local Zharp: the endpoint goes in too.
  assert.match(more.editPhpEntry(index, c, 'http://localhost:4000'), /'endpoint' => 'http:\/\/localhost:4000\/api\/v1\/otlp',/);
});

await test('Plain PHP without an entry point that requires the autoloader: the snippet to paste', () => {
  const p = project('plain-php-bare', { 'composer.json': '{}', 'index.php': '<?php echo 1;' + NL });
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.changes, []);
  assert.match(plan.manual[0].snippet, /Zharp\\Zharp::init\(\['key' => 'zpk_abc', 'service' => 'shop'\]\);/);
});

await test('Symfony: composer require, the key in .env.local, ZharpBundle enabled in config/bundles.php', () => {
  const bundles = ['<?php', '', 'return [', "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],", '];', ''].join(NL);
  const p = project('symfony-app', { 'composer.json': JSON.stringify({ require: { 'symfony/framework-bundle': '7.3.*' } }), 'config/bundles.php': bundles });
  assert.equal(p.framework, 'symfony');
  assert.equal(p.catalog, 'Symfony');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.env, { file: '.env.local', vars: { ZHARP_KEY: 'zpk_abc', ZHARP_SERVICE: 'shop' } });
  const out = change(plan, 'config/bundles.php').content;
  assert.ok(out.endsWith("FrameworkBundle::class => ['all' => true]," + NL + "    Zharp\\Symfony\\ZharpBundle::class => ['all' => true]," + NL + '];' + NL), out);
  assert.equal(more.editBundles(out), null);
});

// What `dart create -t server-shelf` writes (Dart 3.x).
const SHELF_SERVER = [
  "import 'dart:io';",
  '',
  "import 'package:shelf/shelf.dart';",
  "import 'package:shelf/shelf_io.dart';",
  "import 'package:shelf_router/shelf_router.dart';",
  '',
  '// Configure routes.',
  'final _router = Router()',
  "  ..get('/', _rootHandler);",
  '',
  'Response _rootHandler(Request req) {',
  "  return Response.ok('Hello, World!\\n');",
  '}',
  '',
  'void main(List<String> args) async {',
  '  // Use any available host or container IP (usually `0.0.0.0`).',
  '  final ip = InternetAddress.anyIPv4;',
  '',
  '  // Configure a pipeline that logs requests.',
  '  final handler = Pipeline()',
  '      .addMiddleware(logRequests())',
  '      .addHandler(_router.call);',
  '',
  "  final port = int.parse(Platform.environment['PORT'] ?? '8080');",
  '  final server = await serve(handler, ip, port);',
  "  print('Server listening on port ${server.port}');",
  '}',
  '',
].join(NL);

await test('Dart shelf server: dart pub add, main run inside Zharp, the middleware first; the server tile', () => {
  const p = project('shop_api_dir', {
    'pubspec.yaml': ['name: shop_api', 'environment:', '  sdk: ^3.9.0', 'dependencies:', '  shelf: ^1.4.2', '  shelf_router: ^1.1.2', ''].join(NL),
    'bin/server.dart': SHELF_SERVER,
  });
  assert.equal(p.framework, 'dart');
  assert.equal(p.platform, 'dart');
  assert.equal(p.name, 'shop_api');
  assert.equal(p.label, 'Dart (shelf)');
  assert.equal(p.catalog, 'Dart (server)');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['dart pub add zharp_core zharp_shelf']);
  const out = change(plan, 'bin/server.dart').content;
  assert.ok(out.includes("import 'package:shelf_router/shelf_router.dart';" + NL + "import 'package:zharp_core/zharp_core.dart';" + NL + "import 'package:zharp_shelf/zharp_shelf.dart';" + NL), out);
  assert.ok(out.includes('void main(List<String> args) => ZharpCore.run(() async {' + NL + "  // The app's key"), out);
  assert.ok(out.includes("    key: 'zpk_abc'," + NL + "    service: 'shop'," + NL + '  ));' + NL + '  // Use any available host'), out);
  assert.ok(out.includes('  final handler = Pipeline()' + NL + '      .addMiddleware(zharpMiddleware()) // first, so it sees everything' + NL + '      .addMiddleware(logRequests())'), out);
  assert.ok(out.endsWith("  print('Server listening on port ${server.port}');" + NL + '});' + NL), out);
  assert.equal(more.editDartMain(out, c, API, true), null);
});

await test('Dart console tool: main run inside Zharp, closed before it ends; the plain Dart tile. A Flutter app is not a Dart tool', () => {
  const main = ["import 'package:import_tool/import_tool.dart' as import_tool;", '', 'void main(List<String> arguments) {', "  print('Hello world: ${import_tool.calculate()}!');", '}', ''].join(NL);
  const p = project('import_tool', { 'pubspec.yaml': ['name: import_tool', 'environment:', '  sdk: ^3.9.0', ''].join(NL), 'bin/import_tool.dart': main });
  assert.equal(p.catalog, 'Dart (desktop)');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['dart pub add zharp_core']);
  const out = change(plan, 'bin/import_tool.dart').content;
  assert.ok(out.includes('void main(List<String> arguments) => ZharpCore.run(() async {'), out);
  assert.ok(out.endsWith("  print('Hello world: ${import_tool.calculate()}!');" + NL + '  await ZharpCore.instance?.close();' + NL + '});' + NL), out);
  const flutter = project('flutter_app', { 'pubspec.yaml': ['name: flutter_app', 'dependencies:', '  flutter:', '    sdk: flutter', ''].join(NL) });
  assert.notEqual(flutter.framework, 'dart');
});

await test('dart_frog: zharp_shelf through fromShelfMiddleware, as snippets', () => {
  const p = project('frog', { 'pubspec.yaml': ['name: frog', 'dependencies:', '  dart_frog: ^1.1.0', ''].join(NL) });
  assert.equal(p.label, 'Dart (dart_frog)');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv.join(' ')), ['dart pub add zharp_core zharp_shelf']);
  assert.match(plan.manual[0].snippet, /fromShelfMiddleware\(zharpMiddleware\(\)\)/);
  assert.match(plan.manual[1].snippet, /ZharpCore\.start\(ZharpOptions\(key: 'zpk_abc', service: 'shop'\)\)/);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);

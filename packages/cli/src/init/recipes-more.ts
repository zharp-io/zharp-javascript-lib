/**
 * `zharp init` for the frameworks outside the JavaScript build tools: Express, Django, FastAPI,
 * Flask, Laravel and Go. The same rules as the others — standard files only, edited only where
 * their shape is the common one, everything else a snippet to paste.
 *
 * Python and Go get the app's key in code. It is the same key a web page ships: it can only send
 * data to this one app, so it is safe in a repository, and it avoids depending on how a project
 * loads its environment. Laravel reads .env itself, so its key goes there.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GO_ROUTERS, PYTHON_FRAMEWORKS, type GoRouter, type Project } from './detect';
import type { Connected } from './connect';
import type { Plan } from './recipes';
import { dotnet } from './recipes-dotnet';

export interface Command {
  /** What it does, for the plan: "install zharp into .venv". */
  label: string;
  argv: string[];
}

const read = (dir: string, path: string): string | null => {
  try {
    // Worked on with \n line endings; a file that had \r\n gets them back (see planFor).
    return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const first = (dir: string, paths: string[]) => paths.find((p) => existsSync(join(dir, p))) ?? null;

function emptyPlan(envFile: string | null): Plan {
  return { install: [], devInstall: [], changes: [], manual: [], notes: [], env: { file: envFile ?? '', vars: {} }, commands: [] };
}

const DEFAULT_API = 'https://api.zharp.io';
const otlpOf = (api: string) => {
  const clean = api.replace(/\/+$/, '');
  return clean === DEFAULT_API ? null : `${clean}/api/v1/otlp`;
};

/** Files under `dir` (a few levels, skipping dependencies and virtualenvs) whose name ends with `suffix`. */
export function findFiles(dir: string, suffix: string, depth = 3): string[] {
  const skip = /^(node_modules|vendor|\.git|\.venv|venv|env|__pycache__|dist|build|target|\.next|site-packages)$/;
  const out: string[] = [];
  const walk = (at: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (level < depth && !skip.test(e.name) && !e.name.startsWith('.')) walk(join(at, e.name), level + 1);
      } else if (e.name.endsWith(suffix)) {
        out.push(relative(dir, join(at, e.name)).replace(/\\/g, '/'));
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// ── Express (and plain Node servers) ─────────────────────────────────────────────

/** The file a Node app starts from: its start script's, else package.json's main, else the usual names. */
export function nodeEntry(project: Project): string | null {
  const scripts: Record<string, string> = project.packageJson?.scripts ?? {};
  for (const name of ['start', 'dev', 'serve']) {
    const m = /(?:^|\s)(?:node|nodemon|tsx|ts-node)(?:\s+--?[\w-]+(?:[= ][^\s]+)?)*\s+([\w./-]+\.(?:c|m)?[jt]s)\b/.exec(scripts[name] ?? '');
    if (m && existsSync(join(project.dir, m[1]))) return m[1].replace(/^\.\//, '');
  }
  const main = project.packageJson?.main;
  if (typeof main === 'string' && existsSync(join(project.dir, main))) return main.replace(/^\.\//, '');
  return first(project.dir, ['server.js', 'app.js', 'index.js', 'src/server.js', 'src/app.js', 'src/index.js', 'src/server.ts', 'src/app.ts', 'src/index.ts', 'server.ts', 'index.ts']);
}

function express(project: Project, c: Connected, api: string): Plan {
  const plan = emptyPlan('.env');
  plan.install = ['@zharp/node'];
  const entry = nodeEntry(project);
  const endpoint = otlpOf(api);
  plan.env.vars = { ZHARP_KEY: c.application.ingestKey, ...(endpoint ? { ZHARP_ENDPOINT: endpoint } : {}) };
  plan.notes.push('Set ZHARP_KEY where the app runs in production.');
  if (!entry) {
    plan.manual.push({ path: 'your entry file', why: 'start Zharp before anything else loads', snippet: "require('./instrument');  // or: node --import ./instrument.mjs server.js" });
    return plan;
  }
  const main = read(project.dir, entry) ?? '';
  const ts = entry.endsWith('.ts');
  const esm = project.packageJson?.type === 'module' || /\.mjs$/.test(entry) || (!ts && /^\s*import\s/m.test(main));
  const dirOf = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  const instrumentName = ts ? 'instrument.ts' : esm ? (entry.endsWith('.mjs') ? 'instrument.mjs' : 'instrument.js') : (entry.endsWith('.cjs') ? 'instrument.cjs' : 'instrument.js');
  const instrumentPath = `${dirOf}${instrumentName}`;
  const body = [
    '// Before anything else: http, the framework and the database drivers are instrumented as they load.',
    "try { process.loadEnvFile?.('.env'); } catch { /* no .env: the environment has the key */ }",
    `Zharp.init({ service: '${c.application.serviceName}' });`,
    '',
  ];
  const content = esm || ts ? ["import { Zharp } from '@zharp/node';", '', ...body].join('\n') : ["const { Zharp } = require('@zharp/node');", '', ...body].join('\n');
  if (!existsSync(join(project.dir, instrumentPath))) plan.changes.push({ path: instrumentPath, kind: 'create', content, note: 'starts Zharp before the app loads' });
  if (main.includes('instrument')) return plan;

  if (esm && !ts) {
    // ES modules load every import before any code runs: Node preloads the file instead.
    const pkgText = read(project.dir, 'package.json');
    let text = pkgText ?? '';
    const preload = `--import ./${instrumentPath}`;
    let changed = false;
    for (const [name, command] of Object.entries((project.packageJson?.scripts ?? {}) as Record<string, string>)) {
      if (command.includes(preload)) continue;
      const m = /^(node|nodemon)\s+/.exec(command);
      if (!m || !command.includes(entry.replace(/^\.\//, ''))) continue;
      const next = command.replace(/^(node|nodemon)\s+/, `$1 ${preload} `);
      text = text.replace(`"${name}": ${JSON.stringify(command)}`, `"${name}": ${JSON.stringify(next)}`);
      changed = true;
    }
    if (changed) plan.changes.push({ path: 'package.json', kind: 'edit', content: text, note: 'start scripts preload Zharp (--import)' });
    plan.manual.push({ path: 'your start command', why: 'ES modules: wherever the app starts outside these scripts, preload Zharp', snippet: `node ${preload} ${entry}` });
    return plan;
  }
  const line = ts ? "import './instrument';" : "require('./instrument');";
  plan.changes.push({ path: entry, kind: 'edit', content: `${line}\n${main}`, note: 'loads it first' });
  return plan;
}

// ── Python: Django, FastAPI, Flask ───────────────────────────────────────────────

/** The block that starts Zharp, for Python. */
function pythonInit(c: Connected, api: string, logs = false): string {
  const endpoint = otlpOf(api);
  return [
    'import zharp',
    '',
    "# The app's key can only send data to this app, so it is safe in code.",
    `zharp.init(key="${c.application.ingestKey}", service="${c.application.serviceName}"${endpoint ? `, endpoint="${api.replace(/\/+$/, '')}/api/v1/otlp"` : ''}${logs ? ', logs=True' : ''})`,
  ].join('\n');
}

/** Where each Python framework's app is created: the file Zharp is started in. */
const PYTHON_APP: Record<string, { marker: RegExp; where: string }> = {
  fastapi: { marker: /\bFastAPI\(/, where: 'the file that creates FastAPI()' },
  flask: { marker: /\bFlask\(\s*__name__/, where: 'the file that creates Flask(__name__)' },
  chalice: { marker: /\bChalice\(/, where: 'app.py, before Chalice(...)' },
  sanic: { marker: /\bSanic\(/, where: 'the file that creates Sanic(...)' },
  quart: { marker: /\bQuart\(/, where: 'the file that creates Quart(__name__)' },
  starlette: { marker: /\bStarlette\(/, where: 'the file that creates Starlette(...)' },
  falcon: { marker: /\bfalcon\.(?:asgi\.)?(?:App|API)\(/, where: 'the file that creates falcon.App()' },
  tornado: { marker: /\b(?:tornado\.web\.)?Application\(/, where: 'the file that creates the tornado Application' },
  pyramid: { marker: /\bConfigurator\(/, where: 'the file that creates the Configurator' },
  aiohttp: { marker: /\bweb\.Application\(/, where: 'the file that creates web.Application()' },
  bottle: { marker: /\bBottle\(|\bbottle\.run\(|^\s*run\(/m, where: 'the file that creates the Bottle app' },
  celery: { marker: /\bCelery\(/, where: 'the module that creates your Celery app' },
  rq: { marker: /\bWorker\(|\bQueue\(/, where: 'the module your RQ worker imports' },
};

/** `block` placed after a module's docstring and its leading imports — before any other code. */
export function afterPythonImports(text: string, block: string): string | null {
  if (/^\s*import zharp\b/m.test(text)) return null;
  const lines = text.split('\n');
  let i = 0;
  // A shebang, an encoding line, comments, blank lines.
  while (i < lines.length && (/^\s*(#.*)?$/.test(lines[i]))) i++;
  // The module docstring.
  if (i < lines.length && /^\s*[rubRUB]*("""|''')/.test(lines[i])) {
    const quote = /("""|''')/.exec(lines[i])![1];
    const rest = lines[i].slice(lines[i].indexOf(quote) + 3);
    if (!rest.includes(quote)) {
      i++;
      while (i < lines.length && !lines[i].includes(quote)) i++;
    }
    i++;
  }
  // Leading imports (and `from __future__`), blank lines and comments between them.
  let last = -1;
  for (let j = i; j < lines.length; j++) {
    if (/^(import |from \S+ import )/.test(lines[j])) {
      last = j;
      // A parenthesised import runs on until its closing bracket.
      if (/\($/.test(lines[j].trim())) while (j < lines.length && !lines[j].includes(')')) last = ++j;
    } else if (!/^\s*(#.*)?$/.test(lines[j])) break;
  }
  const at = last >= 0 ? last + 1 : i;
  return [...lines.slice(0, at), '', block, '', ...lines.slice(at)].join('\n').replace(/\n{4,}/g, '\n\n\n');
}

function pythonInstall(project: Project): { changes: Plan['changes']; commands: Command[]; manual: Plan['manual'] } {
  const dir = project.dir;
  const changes: Plan['changes'] = [];
  const commands: Command[] = [];
  const manual: Plan['manual'] = [];
  const requirements = read(dir, 'requirements.txt');
  const pyproject = read(dir, 'pyproject.toml') ?? '';
  if (requirements !== null) {
    if (!/^zharp\b/im.test(requirements)) changes.push({ path: 'requirements.txt', kind: 'edit', content: `${requirements.replace(/\s*$/, '\n')}zharp\n`, note: 'adds zharp' });
  }
  const venvPython = first(dir, ['.venv/Scripts/python.exe', '.venv/bin/python', 'venv/Scripts/python.exe', 'venv/bin/python']);
  if (existsSync(join(dir, 'uv.lock'))) commands.push({ label: 'uv add zharp', argv: ['uv', 'add', 'zharp'] });
  else if (/\[tool\.poetry\]/.test(pyproject)) commands.push({ label: 'poetry add zharp', argv: ['poetry', 'add', 'zharp'] });
  else if (venvPython) commands.push({ label: `install zharp into ${venvPython.split('/')[0]}`, argv: [join(dir, venvPython), '-m', 'pip', 'install', 'zharp'] });
  else manual.push({ path: 'your Python environment', why: 'install the package where the app runs', snippet: 'pip install zharp' });
  return { changes, commands, manual };
}

function python(project: Project, c: Connected, api: string): Plan {
  const plan = emptyPlan(null);
  const installed = pythonInstall(project);
  plan.changes.push(...installed.changes);
  plan.commands = installed.commands;
  plan.manual.push(...installed.manual);
  // Chalice runs on Lambda: nothing else collects what it prints.
  const block = pythonInit(c, api, project.framework === 'chalice');

  let targets: string[] = [];
  if (project.framework === 'django') {
    // runserver and the management commands start at manage.py; production at wsgi.py / asgi.py.
    targets = [first(project.dir, ['manage.py']), ...findFiles(project.dir, 'wsgi.py'), ...findFiles(project.dir, 'asgi.py')].filter((p): p is string => !!p);
  } else {
    const { marker } = PYTHON_APP[project.framework];
    const files = findFiles(project.dir, '.py').filter((f) => marker.test(read(project.dir, f) ?? ''));
    const preferred = files.find((f) => /(^|\/)(main|app|server|wsgi|__init__)\.py$/.test(f)) ?? files[0];
    if (preferred) targets = [preferred];
  }
  for (const path of targets) {
    const text = read(project.dir, path);
    const edited = text !== null ? afterPythonImports(text, block) : null;
    if (edited) plan.changes.push({ path, kind: 'edit', content: edited, note: 'starts Zharp' });
  }
  if (!targets.length) {
    const where = project.framework === 'django' ? 'manage.py, wsgi.py and asgi.py' : PYTHON_APP[project.framework].where;
    plan.manual.push({ path: where, why: 'start Zharp at the top, after the imports', snippet: block });
  }
  return plan;
}

// ── Laravel ──────────────────────────────────────────────────────────────────────

function laravel(project: Project, c: Connected, api: string): Plan {
  const plan = emptyPlan('.env');
  plan.commands = [{ label: 'composer require zharp/zharp', argv: ['composer', 'require', 'zharp/zharp'] }];
  const endpoint = otlpOf(api);
  plan.env.vars = { ZHARP_KEY: c.application.ingestKey, ZHARP_SERVICE: c.application.serviceName, ...(endpoint ? { ZHARP_ENDPOINT: endpoint } : {}) };
  plan.notes.push('Laravel finds Zharp by itself (package discovery). Set ZHARP_KEY in production too.');
  void project;
  return plan;
}

// ── Go ───────────────────────────────────────────────────────────────────────────

const GO_MODULE = 'github.com/zharp-io/zharp-go-lib';

/** Which routers a Go module uses (from go.mod), for the ones with their own setup. */
export type GoRouters = Partial<Record<GoRouter, boolean>>;

/** main.go with Zharp started first in main(), and the router wrapped where its shape is known. */
export function editGoMain(text: string, c: Connected, api: string, routers: GoRouters): string | null {
  if (text.includes(GO_MODULE)) return null;
  const block = /^import \(\n([\s\S]*?)^\)/m.exec(text);
  const mainFn = /^func main\(\) \{\n/m.exec(text);
  if (!block || !mainFn) return null;
  const imports = block[1];
  const stdlib: string[] = [];
  if (!/^\s*"context"$/m.test(imports)) stdlib.push('\t"context"');
  const add: string[] = [`\tzharp "${GO_MODULE}"`];
  let next = text;
  /** `line` added after the first match of `after` (a whole line), with its indentation. */
  const addAfter = (after: RegExpExecArray, line: string) => {
    next = next.replace(after[0], `${after[0]}${after[1]}${line}\n`);
  };
  const gin = routers.gin ? /^(\s*)(\w+) := gin\.(?:Default|New)\(\)\n/m.exec(next) : null;
  const echo = routers.echo ? /^(\s*)(\w+) := echo\.New\(\)\n/m.exec(next) : null;
  const fiber = routers.fiber ? /^(\s*)(\w+) := fiber\.New\([^\n]*\)\n/m.exec(next) : null;
  const iris = routers.iris ? /^(\s*)(\w+) := iris\.(?:New|Default)\(\)\n/m.exec(next) : null;
  if (gin) {
    add.push(`\t"${GO_MODULE}/zharpgin"`);
    addAfter(gin, `${gin[2]}.Use(zharpgin.Middleware())`);
  } else if (echo) {
    add.push(`\t"${GO_MODULE}/zharpecho"`);
    addAfter(echo, `${echo[2]}.Use(zharpecho.Middleware())`);
  } else if (fiber) {
    add.push(`\t"${GO_MODULE}/zharpfiber"`);
    // After Fiber's recover middleware when there is one, so a panic reaches Zharp first and recover still answers it.
    const recover = new RegExp(String.raw`^([ \t]*)${fiber[2]}\.Use\(recover\.New\([^\n]*\)\)\n`, 'm').exec(next);
    addAfter(recover ?? fiber, `${fiber[2]}.Use(zharpfiber.Middleware())`);
  } else if (iris) {
    add.push(`\t"${GO_MODULE}/zharpiris"`);
    addAfter(iris, `${iris[2]}.UseRouter(zharpiris.Middleware())`);
  } else if (routers.fasthttp && /fasthttp\.ListenAndServe\(/.test(next)) {
    add.push(`\t"${GO_MODULE}/zharpfasthttp"`);
    next = next.replace(/fasthttp\.ListenAndServe\(([^,]+),\s*([\w.]+)\)/, (_, addr: string, handler: string) => `fasthttp.ListenAndServe(${addr}, zharpfasthttp.Handler(${handler}))`);
  } else {
    // net/http (Negroni and gorilla/mux included): the handler given to ListenAndServe, traced.
    const gorilla = routers.gorilla ? /^(\s*)(\w+) := mux\.NewRouter\(\)\n/m.exec(next) : null;
    if (gorilla) {
      add.push(`\t"${GO_MODULE}/zharpmux"`);
      addAfter(gorilla, `${gorilla[2]}.Use(zharpmux.Middleware())`);
    }
    next = next.replace(/http\.ListenAndServe\(([^,]+),\s*(nil|[\w.]+)\)/, (_, addr: string, handler: string) =>
      `http.ListenAndServe(${addr}, zharp.Handler(${handler === 'nil' ? 'http.DefaultServeMux' : handler}))`);
  }
  const endpoint = otlpOf(api);
  const start = [
    "\t// The app's key can only send data to this app, so it is safe in code.",
    `\tshutdown := zharp.Init(zharp.Config{Key: "${c.application.ingestKey}", Service: "${c.application.serviceName}"${endpoint ? `, Endpoint: "${api.replace(/\/+$/, '')}/api/v1/otlp"` : ''}})`,
    '\tdefer shutdown(context.Background())',
    '',
  ].join('\n');
  next = next.replace(block[0], `import (\n${groupedImports(imports, stdlib, add)})`);
  next = next.replace(/^func main\(\) \{\n/m, `func main() {\n${start}`);
  return next;
}

/**
 * The import block's lines with ours added the way goimports keeps them: "context" with the
 * standard library, the Zharp modules with the other modules (gofmt sorts inside each group).
 */
function groupedImports(body: string, stdlib: string[], modules: string[]): string {
  const groups = body.replace(/\n+$/, '').split(/\n[ \t]*\n/).map((g) => g.split('\n'));
  // A module path has a dot in its first element ("github.com/…"); the standard library's don't.
  const isModule = (line: string) => /"[^"/]*\.[^"/]*\//.test(line) || /"[^"/]*\.[^"/]*"/.test(line);
  const std = groups.find((g) => g.some((l) => /"/.test(l)) && !g.some(isModule));
  const mods = groups.find((g) => g.some(isModule));
  if (stdlib.length) std ? std.push(...stdlib) : groups.unshift(stdlib);
  mods ? mods.push(...modules) : groups.push(modules);
  return `${groups.map((g) => g.join('\n')).join('\n\n')}\n`;
}

function go(project: Project, c: Connected, api: string): Plan {
  const plan = emptyPlan(null);
  const goMod = read(project.dir, 'go.mod') ?? '';
  const routers: GoRouters = Object.fromEntries(GO_ROUTERS.map((r) => [r.id, r.module.test(goMod)]));
  plan.commands = [{ label: `go get ${GO_MODULE}`, argv: ['go', 'get', `${GO_MODULE}@latest`] }];
  const mainPath = first(project.dir, ['main.go', 'cmd/server/main.go', 'cmd/api/main.go', 'cmd/main.go']) ?? findFiles(project.dir, 'main.go').find((f) => /func main\(\)/.test(read(project.dir, f) ?? '')) ?? null;
  const text = mainPath ? read(project.dir, mainPath) : null;
  const edited = text ? editGoMain(text, c, api, routers) : null;
  if (mainPath && edited) {
    // The router module main.go now imports, fetched like the core.
    const module = /"github\.com\/zharp-io\/zharp-go-lib\/(zharp\w+)"/.exec(edited)?.[1];
    if (module) plan.commands.push({ label: `go get …/${module}`, argv: ['go', 'get', `${GO_MODULE}/${module}@latest`] });
    const traced = { zharpgin: 'Gin', zharpecho: 'Echo', zharpfiber: 'Fiber', zharpiris: 'Iris', zharpfasthttp: 'fasthttp', zharpmux: 'gorilla/mux' }[module ?? ''];
    plan.changes.push({ path: mainPath, kind: 'edit', content: edited, note: `starts Zharp${traced ? `; traces ${traced}` : edited.includes('zharp.Handler(') ? '; traces requests' : ''}` });
    plan.commands.push({ label: 'go mod tidy', argv: ['go', 'mod', 'tidy'] });
    plan.commands.push({ label: `gofmt -w ${mainPath}`, argv: ['gofmt', '-w', mainPath] });
    if (!/zharp\.Handler\(|zharp\w+\.(Middleware|Handler)\(/.test(edited)) {
      plan.manual.push({ path: mainPath, why: 'trace incoming requests: wrap the handler your server runs', snippet: routers.negroni ? 'http.ListenAndServe(":3000", zharp.Handler(n))  // instead of n.Run(":3000")' : 'http.ListenAndServe(":8080", zharp.Handler(mux))' });
    }
  } else if (!text?.includes(GO_MODULE)) {
    plan.manual.push({ path: mainPath ?? 'main.go', why: 'start Zharp first in main()', snippet: `shutdown := zharp.Init(zharp.Config{Key: "${c.application.ingestKey}"})\ndefer shutdown(context.Background())` });
  }
  return plan;
}

export function morePlanFor(project: Project, c: Connected, api: string): Plan | null {
  switch (project.framework) {
    case 'express':
    case 'koa':
    case 'hapi':
    case 'fastify':
    case 'connect':
      return express(project, c, api);
    case 'django':
    case 'fastapi':
    case 'flask':
      return python(project, c, api);
    case 'laravel':
      return laravel(project, c, api);
    case 'go':
      return go(project, c, api);
    case 'dotnet':
      return dotnet(project, c, api);
    default:
      return PYTHON_FRAMEWORKS.some((f) => f.id === project.framework) ? python(project, c, api) : null;
  }
}

/**
 * What `zharp init` changes in a project, per framework — worked out first, as a plan the person
 * sees before anything is written. Only standard files are touched, each in the one way that is
 * safe: a new file is created only where none exists; an existing file is edited only where its
 * shape is the common one (a plain `export default`, a `plugins: [` array, a `createRoot(…)` call).
 * Anything else becomes a snippet to paste, never a guess.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './detect';
import type { Connected } from './connect';
import { morePlanFor, type Command } from './recipes-more';
import { reactNativePlanFor } from './recipes-rn';

export interface Change {
  path: string;
  kind: 'create' | 'edit';
  content: string;
  /** What it is, in a few words: "wrapped with withZharp". */
  note: string;
}

export interface Manual {
  path: string;
  why: string;
  snippet: string;
}

export interface Plan {
  install: string[];
  devInstall: string[];
  changes: Change[];
  /** Keys go in this file, which is checked to be ignored by git. */
  env: { file: string; vars: Record<string, string> };
  manual: Manual[];
  /** Said at the end: what to set up elsewhere (CI). */
  notes: string[];
  /** Installs outside npm: pip, composer, go get. Run after the files are written. */
  commands?: Command[];
}

export const DEFAULT_API = 'https://api.zharp.io';

const read = (dir: string, path: string): string | null => {
  try {
    // Worked on with \n line endings; a file that had \r\n gets them back (see planFor).
    return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const first = (dir: string, paths: string[]) => paths.find((p) => existsSync(join(dir, p))) ?? null;
const mentionsZharp = (text: string | null) => !!text && /@zharp\//.test(text);

/** Lines added to a file follow its style: no semicolons where its imports have none. */
function styled(text: string, line: string): string {
  const imports = [...text.matchAll(/^import .*$/gm)].map((m) => m[0].trimEnd());
  const bare = imports.length > 0 && imports.every((l) => !l.endsWith(';'));
  // Double-quoted imports: the line's strings in double quotes too.
  const double = imports.filter((l) => /from "/.test(l)).length > imports.filter((l) => /from '/.test(l)).length;
  const quoted = double ? line.replace(/'([^'"]*)'/g, '"$1"') : line;
  return bare ? quoted.replace(/;$/, '') : quoted;
}

/** The OTLP endpoint, said only when it isn't Zharp's own. */
function endpointOf(api: string): string | null {
  const clean = api.replace(/\/+$/, '');
  return clean === DEFAULT_API ? null : `${clean}/api/v1/otlp`;
}

// ── Next.js ──────────────────────────────────────────────────────────────────────

/** `export default X;` → `export default withZharp(X, { app: 42 });`, the import added. */
export function wrapNextConfig(text: string, appId: number, esm: boolean): string | null {
  if (/withZharp/.test(text)) return null;
  const exportDefault = /export\s+default\s+([\s\S]+?);?\s*$/.exec(text);
  if (esm && exportDefault) {
    const value = exportDefault[1].trim().replace(/;$/, '');
    const head = text.slice(0, exportDefault.index);
    return `import { withZharp } from '@zharp/nextjs';\n${head}export default withZharp(${value}, { app: ${appId} });\n`;
  }
  const moduleExports = /module\.exports\s*=\s*([\s\S]+?);?\s*$/.exec(text);
  if (!esm && moduleExports) {
    const value = moduleExports[1].trim().replace(/;$/, '');
    const head = text.slice(0, moduleExports.index);
    return `const { withZharp } = require('@zharp/nextjs');\n${head}module.exports = withZharp(${value}, { app: ${appId} });\n`;
  }
  return null;
}

/** The client component rendered first in <body>, with its import, in the root layout. */
export function addToLayout(text: string, importPath: string): string | null {
  if (/ZharpClient/.test(text)) return null;
  const body = /<body\b[^>]*>/.exec(text);
  if (!body) return null;
  const at = body.index + body[0].length;
  // On its own line, indented one step in from <body>; what followed <body> keeps its own line.
  const bodyIndent = /[ \t]*$/.exec(text.slice(0, body.index))![0];
  const inner = `${bodyIndent}  `;
  const rest = text.slice(at);
  const after = /^\s*\n/.test(rest) ? rest : `\n${inner}${rest.replace(/^[ \t]+/, '')}`;
  const withComponent = `${text.slice(0, at)}\n${inner}<ZharpClient />${after}`;
  const imports = [...withComponent.matchAll(/^import .*$/gm)];
  const line = styled(text, `import { ZharpClient } from '${importPath}';`);
  if (!imports.length) return `${line}\n${withComponent}`;
  const last = imports[imports.length - 1];
  const end = last.index! + last[0].length;
  return `${withComponent.slice(0, end)}\n${line}${withComponent.slice(end)}`;
}

function nextjs(project: Project, c: Connected, api: string): Plan {
  const dir = project.dir;
  const ts = project.typescript;
  const plan: Plan = { install: ['@zharp/browser', '@zharp/node'], devInstall: ['@zharp/nextjs'], changes: [], manual: [], notes: [], env: { file: '.env.local', vars: {} } };
  const endpoint = endpointOf(api);

  // Server: instrumentation.ts, next to app/ (in src/ when the app lives there).
  const instrumentationPath = `${project.appDir?.startsWith('src/') ? 'src/' : ''}instrumentation.${ts ? 'ts' : 'js'}`;
  const instrumentation = [
    'export async function register() {',
    "  if (process.env.NEXT_RUNTIME === 'nodejs') {",
    "    const { Zharp } = await import('@zharp/node');",
    `    Zharp.init({ service: '${c.application.serviceName}' });`,
    '  }',
    '}',
    '',
    '// Errors Next.js answers with an error page: reported with their route.',
    `export async function onRequestError(...args${ts ? ": Parameters<typeof import('@zharp/node').Zharp.onRequestError>" : ''}) {`,
    "  if (process.env.NEXT_RUNTIME === 'nodejs') {",
    "    const { Zharp } = await import('@zharp/node');",
    '    Zharp.onRequestError(...args);',
    '  }',
    '}',
    '',
  ].join('\n');
  const existingInstrumentation = first(dir, ['instrumentation.ts', 'instrumentation.js', 'src/instrumentation.ts', 'src/instrumentation.js']);
  if (!existingInstrumentation) plan.changes.push({ path: instrumentationPath, kind: 'create', content: instrumentation, note: 'starts Zharp on the server' });
  else if (!mentionsZharp(read(dir, existingInstrumentation))) plan.manual.push({ path: existingInstrumentation, why: 'it already exists — add Zharp to it', snippet: instrumentation });

  // Build: next.config wrapped with withZharp (source maps uploaded, @zharp/node kept external).
  const configPath = first(dir, ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']);
  if (!configPath) {
    plan.changes.push({ path: ts ? 'next.config.ts' : 'next.config.mjs', kind: 'create', content: `import { withZharp } from '@zharp/nextjs';\n\nexport default withZharp({}, { app: ${c.application.id} });\n`, note: 'source maps uploaded on build' });
  } else {
    const text = read(dir, configPath) ?? '';
    const esm = /\.(ts|mjs)$/.test(configPath) || /^\s*(import|export)\s/m.test(text);
    const wrapped = mentionsZharp(text) ? null : wrapNextConfig(text, c.application.id, esm);
    if (wrapped) plan.changes.push({ path: configPath, kind: 'edit', content: wrapped, note: 'wrapped with withZharp' });
    else if (!mentionsZharp(text)) plan.manual.push({ path: configPath, why: "its export isn't a plain value — wrap it yourself", snippet: `import { withZharp } from '@zharp/nextjs';\n\nexport default withZharp(nextConfig, { app: ${c.application.id} });` });
  }

  // Browser: a client component started from the root layout (app router).
  if (project.appDir) {
    const ext = ts ? 'tsx' : 'jsx';
    const clientPath = `${project.appDir}/zharp-client.${ext}`;
    const client = [
      "'use client';",
      "import { Zharp } from '@zharp/browser';",
      '',
      "if (typeof window !== 'undefined' && !Zharp.isActive) {",
      `  Zharp.init({ key: process.env.NEXT_PUBLIC_ZHARP_KEY${ts ? '!' : ''}${endpoint ? ', endpoint: process.env.NEXT_PUBLIC_ZHARP_ENDPOINT' : ''}, service: '${c.application.serviceName}' });`,
      '}',
      '',
      '/** Starts Zharp in the browser; rendered once, in the root layout. */',
      'export function ZharpClient() {',
      '  return null;',
      '}',
      '',
    ].join('\n');
    if (!existsSync(join(dir, clientPath))) plan.changes.push({ path: clientPath, kind: 'create', content: client, note: `starts Zharp in the browser` });
    const layoutPath = first(dir, [`${project.appDir}/layout.tsx`, `${project.appDir}/layout.jsx`, `${project.appDir}/layout.js`]);
    const layout = layoutPath ? read(dir, layoutPath) : null;
    const edited = layout ? addToLayout(layout, './zharp-client') : null;
    if (layoutPath && edited) plan.changes.push({ path: layoutPath, kind: 'edit', content: edited, note: 'renders <ZharpClient />' });
    else if (layoutPath && !/ZharpClient/.test(layout ?? '')) plan.manual.push({ path: layoutPath, why: 'add the component inside <body>', snippet: "import { ZharpClient } from './zharp-client';\n…\n<body>\n  <ZharpClient />" });
  } else {
    plan.manual.push({ path: 'pages/_app', why: 'pages router: start Zharp in your _app', snippet: "import { Zharp } from '@zharp/browser';\n\nif (typeof window !== 'undefined') Zharp.init({ key: process.env.NEXT_PUBLIC_ZHARP_KEY });" });
  }

  plan.env.vars = {
    NEXT_PUBLIC_ZHARP_KEY: c.application.ingestKey,
    ZHARP_KEY: c.application.ingestKey,
    ZHARP_AUTH_TOKEN: c.uploadKey,
    ...(endpoint ? { NEXT_PUBLIC_ZHARP_ENDPOINT: endpoint, ZHARP_ENDPOINT: endpoint, ZHARP_URL: api.replace(/\/+$/, '') } : {}),
  };
  plan.notes.push('Add ZHARP_AUTH_TOKEN (and the keys) to your CI and hosting, so production builds upload their source maps.');
  return plan;
}

// ── React with Vite ──────────────────────────────────────────────────────────────

/** `plugins: [react()]` → `plugins: [react(), zharp({ app: 42 })]`, the import added. */
export function addVitePlugin(text: string, appId: number): string | null {
  if (/@zharp\/vite-plugin/.test(text)) return null;
  const plugins = /plugins\s*:\s*\[/.exec(text);
  if (!plugins) return null;
  // The array's closing bracket: the first `]` at depth zero after the opening one.
  let depth = 0;
  let close = -1;
  for (let i = plugins.index + plugins[0].length; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') {
      if (depth === 0 && ch === ']') {
        close = i;
        break;
      }
      depth--;
    }
  }
  if (close < 0) return null;
  const inside = text.slice(plugins.index + plugins[0].length, close).trimEnd();
  const sep = inside.length === 0 ? '' : inside.endsWith(',') ? ' ' : ', ';
  const withPlugin = `${text.slice(0, plugins.index + plugins[0].length)}${inside}${sep}zharp({ app: ${appId} })${text.slice(close)}`;
  const imports = [...withPlugin.matchAll(/^import .*$/gm)];
  const line = styled(text, "import { zharp } from '@zharp/vite-plugin';");
  if (!imports.length) return `${line}\n${withPlugin}`;
  const last = imports[imports.length - 1];
  const end = last.index! + last[0].length;
  return `${withPlugin.slice(0, end)}\n${line}${withPlugin.slice(end)}`;
}

/** Zharp started before React renders; createRoot given React 19's error handlers. */
export function addToViteMain(text: string, serviceName: string, withEndpoint: boolean): string | null {
  if (/@zharp\/browser/.test(text)) return null;
  const call = /createRoot\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(text);
  let next = text;
  if (call && !call[1].includes(',')) {
    next = `${text.slice(0, call.index)}createRoot(${call[1]}, {\n  onUncaughtError: Zharp.reactErrorHandler(),\n  onCaughtError: Zharp.reactErrorHandler(),\n})${text.slice(call.index + call[0].length)}`;
  }
  const imports = [...next.matchAll(/^import .*$/gm)];
  const start = styled(text, `Zharp.init({ key: import.meta.env.VITE_ZHARP_KEY${withEndpoint ? ', endpoint: import.meta.env.VITE_ZHARP_ENDPOINT' : ''}, service: '${serviceName}' });`);
  const init = `\n${start}\n`;
  const line = styled(text, "import { Zharp } from '@zharp/browser';");
  if (!imports.length) return `${line}\n${init}\n${next}`;
  const last = imports[imports.length - 1];
  const end = last.index! + last[0].length;
  return `${next.slice(0, end)}\n${line}\n${init}${next.slice(end).replace(/^\n+/, '\n')}`;
}

function viteReact(project: Project, c: Connected, api: string): Plan {
  const dir = project.dir;
  const endpoint = endpointOf(api);
  const plan: Plan = { install: ['@zharp/browser'], devInstall: ['@zharp/vite-plugin'], changes: [], manual: [], notes: [], env: { file: '.env.local', vars: {} } };
  const configPath = first(dir, ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']);
  const config = configPath ? read(dir, configPath) : null;
  const editedConfig = config ? addVitePlugin(config, c.application.id) : null;
  if (configPath && editedConfig) plan.changes.push({ path: configPath, kind: 'edit', content: editedConfig, note: 'source maps uploaded on build' });
  else if (!mentionsZharp(config)) plan.manual.push({ path: configPath ?? 'vite.config.ts', why: 'add the plugin to plugins', snippet: `import { zharp } from '@zharp/vite-plugin';\n…\nplugins: [react(), zharp({ app: ${c.application.id} })]` });

  const mainPath = first(dir, ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx']);
  const main = mainPath ? read(dir, mainPath) : null;
  const editedMain = main ? addToViteMain(main, c.application.serviceName, !!endpoint) : null;
  if (mainPath && editedMain) plan.changes.push({ path: mainPath, kind: 'edit', content: editedMain, note: 'starts Zharp; React errors with their component stack' });
  else if (!mentionsZharp(main)) plan.manual.push({ path: mainPath ?? 'src/main.tsx', why: 'start Zharp before React renders', snippet: "import { Zharp } from '@zharp/browser';\n\nZharp.init({ key: import.meta.env.VITE_ZHARP_KEY });\n\ncreateRoot(el, { onUncaughtError: Zharp.reactErrorHandler(), onCaughtError: Zharp.reactErrorHandler() })" });

  plan.env.vars = {
    VITE_ZHARP_KEY: c.application.ingestKey,
    ZHARP_AUTH_TOKEN: c.uploadKey,
    ...(endpoint ? { VITE_ZHARP_ENDPOINT: endpoint, ZHARP_URL: api.replace(/\/+$/, '') } : {}),
  };
  plan.notes.push('Add ZHARP_AUTH_TOKEN and VITE_ZHARP_KEY to your CI, so production builds upload their source maps.');
  return plan;
}

// ── NestJS ───────────────────────────────────────────────────────────────────────

function nestjs(project: Project, c: Connected, api: string): Plan {
  const dir = project.dir;
  const endpoint = endpointOf(api);
  const plan: Plan = { install: ['@zharp/node'], devInstall: [], changes: [], manual: [], notes: [], env: { file: '.env', vars: {} } };
  const ext = project.typescript ? 'ts' : 'js';
  const instrumentPath = `src/instrument.${ext}`;
  const instrument = [
    "import { Zharp } from '@zharp/node';",
    '',
    '// Before anything else: http, the database drivers and NestJS are instrumented as they load.',
    "try { process.loadEnvFile?.('.env'); } catch { /* no .env: the environment has the keys */ }",
    `Zharp.init({ service: '${c.application.serviceName}' });`,
    '',
  ].join('\n');
  if (!existsSync(join(dir, instrumentPath))) plan.changes.push({ path: instrumentPath, kind: 'create', content: instrument, note: 'starts Zharp before the app loads' });

  const mainPath = first(dir, [`src/main.${ext}`]);
  const main = mainPath ? read(dir, mainPath) : null;
  const esm = project.packageJson?.type === 'module' || /from '\.{1,2}\/[^']+\.js'/.test(main ?? '');
  if (esm) {
    // ES modules load every import before any code runs, so a first import is too late for
    // NestJS: Node preloads the file instead (--import), from the project's own start scripts.
    const pkgText = read(dir, 'package.json');
    const scripts = { ...(project.packageJson?.scripts ?? {}) } as Record<string, string>;
    const preload = '--import ./dist/instrument.js';
    let changed = false;
    for (const [name, command] of Object.entries(scripts)) {
      if (command.includes(preload)) continue;
      if (/^nest start\b/.test(command) && !/--exec\b/.test(command)) {
        scripts[name] = `${command} --exec "node ${preload}"`;
        changed = true;
      } else if (/^node (?:--[^\s]+ )*dist\/main(?:\.js)?\s*$/.test(command)) {
        scripts[name] = command.replace(/^node /, `node ${preload} `);
        changed = true;
      }
    }
    if (changed && pkgText) {
      // Only those lines change: the rest of package.json keeps its formatting.
      let text = pkgText;
      for (const [name, command] of Object.entries(scripts)) {
        const before = (project.packageJson?.scripts ?? {})[name];
        if (before === command) continue;
        const line = new RegExp(`("${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*)${JSON.stringify(before).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
        text = text.replace(line, (_, key: string) => `${key}${JSON.stringify(command)}`);
      }
      plan.changes.push({ path: 'package.json', kind: 'edit', content: text, note: 'start scripts preload Zharp (--import)' });
    }
    plan.manual.push({ path: 'your start command', why: 'ES modules: wherever the app is started outside these scripts (a Dockerfile, a process manager), preload Zharp', snippet: `node ${preload} dist/main.js` });
  } else if (mainPath && main && !main.includes('./instrument')) {
    plan.changes.push({ path: mainPath, kind: 'edit', content: `${styled(main, "import './instrument';")}\n${main}`, note: 'loads it first' });
  } else if (!mainPath) {
    plan.manual.push({ path: 'src/main.ts', why: 'import it first in your entry file', snippet: "import './instrument';" });
  }
  plan.env.vars = { ZHARP_KEY: c.application.ingestKey, ...(endpoint ? { ZHARP_ENDPOINT: endpoint } : {}) };
  plan.notes.push('Set ZHARP_KEY where the app runs in production.');
  return plan;
}

export function planFor(project: Project, c: Connected, api: string): Plan | null {
  const plan = basePlanFor(project, c, api);
  // Edited files keep their own line endings: \r\n where they had them (Windows, django-admin).
  for (const ch of plan?.changes ?? []) {
    if (ch.kind !== 'edit') continue;
    try {
      if (readFileSync(join(project.dir, ch.path), 'utf8').includes('\r\n')) ch.content = ch.content.replace(/\r?\n/g, '\r\n');
    } catch {
      // A file that went away: written as it is.
    }
  }
  return plan;
}

function basePlanFor(project: Project, c: Connected, api: string): Plan | null {
  switch (project.framework) {
    case 'nextjs':
      return nextjs(project, c, api);
    case 'vite-react':
      return viteReact(project, c, api);
    case 'nestjs':
      return nestjs(project, c, api);
    default:
      return reactNativePlanFor(project, c, api) ?? morePlanFor(project, c, api);
  }
}

/** Frameworks without a recipe yet: where to read how. */
export const GUIDES: Record<string, string> = {
  express: 'https://zharp.io/docs/sdks/node',
  node: 'https://zharp.io/docs/sdks/node',
  django: 'https://zharp.io/docs/sdks/python',
  fastapi: 'https://zharp.io/docs/sdks/python',
  flask: 'https://zharp.io/docs/sdks/python',
  laravel: 'https://zharp.io/docs/sdks/php',
  symfony: 'https://zharp.io/docs/sdks/php',
  php: 'https://zharp.io/docs/sdks/php#plain-php',
  dart: 'https://zharp.io/docs/sdks/dart',
  go: 'https://zharp.io/docs/sdks/go',
  rails: 'https://zharp.io/docs/sdks/ruby',
  rack: 'https://zharp.io/docs/sdks/ruby',
  ruby: 'https://zharp.io/docs/sdks/ruby',
  dotnet: 'https://zharp.io/docs/sdks/dotnet',
};

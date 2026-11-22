/**
 * `zharp init` for Cloudflare Workers and Pages Functions (projects with a Wrangler config).
 *
 * Workers: the default export in the entry Wrangler names is wrapped with `withZharp`; the
 * Wrangler config gets `nodejs_compat` (for a compatibility date before August 2026), the
 * version metadata binding, `upload_source_maps` and `ZHARP_SERVICE`; the deploy script builds
 * into a folder, filed under the commit as the release, and uploads that build's source maps.
 * The key goes in `.dev.vars` for `wrangler dev`, and the person is told the one command that
 * puts it in production (`wrangler secret put` changes their Cloudflare account, so it is theirs
 * to run).
 *
 * Pages: `functions/_middleware.ts` with `zharpPagesPlugin()`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connected } from './connect';
import type { Project } from './detect';
import type { Plan } from './recipes';

const DEFAULT_API = 'https://api.zharp.io';
/** From this compatibility date Workers get Node.js APIs (AsyncLocalStorage) without the flag. */
export const NODEJS_COMPAT_DEFAULT_DATE = '2026-08-01';
/** Where the deploy script builds to: inside .wrangler, which Cloudflare's templates ignore. */
export const BUILD_DIR = '.wrangler/zharp-dist';

const read = (dir: string, path: string): string | null => {
  try {
    return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};

export const WRANGLER_CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/** Frameworks with their own Cloudflare adapter: their server half is set up by hand for now. */
const FRAMEWORK_ADAPTERS = ['@opennextjs/cloudflare', '@astrojs/cloudflare', '@sveltejs/adapter-cloudflare', '@react-router/cloudflare', '@remix-run/cloudflare', 'nitro-cloudflare-dev', '@cloudflare/next-on-pages'];

/** A Wrangler project, and whether it is Pages; null when there is no Wrangler config. */
export function detectCloudflare(dir: string, deps: Record<string, string>): { config: string; pages: boolean } | null {
  const config = WRANGLER_CONFIGS.find((name) => existsSync(join(dir, name)));
  if (!config && !deps.wrangler) return null;
  if (FRAMEWORK_ADAPTERS.some((name) => deps[name])) return null;
  const text = config ? read(dir, config) ?? '' : '';
  const pages = /pages_build_output_dir/.test(text) || (!/^\s*"?main"?\s*[=:]/m.test(text) && existsSync(join(dir, 'functions')));
  if (!config && !pages) return null;
  return { config: config ?? 'wrangler.jsonc', pages };
}

// ── the Wrangler config ─────────────────────────────────────────────────

/** The `main` entry a Wrangler config names. */
export function wranglerMain(text: string, toml: boolean): string | null {
  const m = toml ? /^\s*main\s*=\s*["']([^"']+)["']/m.exec(text) : /"main"\s*:\s*"([^"]+)"/.exec(text);
  return m ? m[1].replace(/^\.\//, '') : null;
}

export function compatibilityDate(text: string): string | null {
  return /compatibility_date"?\s*[=:]\s*["'](\d{4}-\d{2}-\d{2})["']/.exec(text)?.[1] ?? null;
}

/**
 * The config with what Zharp needs: nodejs_compat (when the date is before it is on by itself),
 * the version metadata binding, upload_source_maps, and ZHARP_SERVICE. Null when nothing changes.
 */
export function editWranglerConfig(text: string, toml: boolean, service: string): string | null {
  let out = text;
  const date = compatibilityDate(text);
  const needsCompat = !/nodejs_compat/.test(text) && (!date || date < NODEJS_COMPAT_DEFAULT_DATE);
  const needsVersion = !/version_metadata/.test(text);
  const needsMaps = !/upload_source_maps/.test(text);
  const needsService = !/ZHARP_SERVICE/.test(text);
  if (!needsCompat && !needsVersion && !needsMaps && !needsService) return null;

  if (toml) {
    // Top-level keys go before the first [table]; tables at the end.
    const top: string[] = [];
    if (needsCompat) {
      if (/^\s*compatibility_flags\s*=\s*\[/m.test(out)) out = out.replace(/^(\s*compatibility_flags\s*=\s*\[)/m, '$1"nodejs_compat", ').replace(/, \]/, ']');
      else top.push('compatibility_flags = ["nodejs_compat"]');
    }
    if (needsMaps) top.push('upload_source_maps = true');
    if (top.length) {
      const table = /^\s*\[/m.exec(out);
      const at = table ? table.index : out.length;
      const before = out.slice(0, at).replace(/\s*$/, '\n');
      out = `${before}${top.join('\n')}\n${table ? `\n${out.slice(at).replace(/^\n+/, '')}` : ''}`;
    }
    if (needsService) {
      if (/^\s*\[vars\]\s*$/m.test(out)) out = out.replace(/^(\s*\[vars\]\s*)$/m, `$1\nZHARP_SERVICE = "${service}"`);
      else out = `${out.replace(/\s*$/, '\n')}\n[vars]\nZHARP_SERVICE = "${service}"\n`;
    }
    if (needsVersion) out = `${out.replace(/\s*$/, '\n')}\n[version_metadata]\nbinding = "CF_VERSION_METADATA"\n`;
    return out;
  }

  // JSON(C): new keys right after the opening brace, each with a trailing comma, in the file's indent.
  const open = out.indexOf('{');
  if (open < 0) return null;
  const indent = /\n([ \t]+)"/.exec(out)?.[1] ?? '  ';
  const keys: string[] = [];
  if (needsCompat) {
    if (/"compatibility_flags"\s*:\s*\[/.test(out)) out = out.replace(/("compatibility_flags"\s*:\s*\[)(\s*)(\]?)/, (_m, head, space, close) => `${head}${space}"nodejs_compat"${close ? '' : ', '}${close}`);
    else keys.push('"compatibility_flags": ["nodejs_compat"]');
  }
  if (needsMaps) keys.push('"upload_source_maps": true');
  if (needsVersion) keys.push('"version_metadata": { "binding": "CF_VERSION_METADATA" }');
  if (needsService) {
    if (/"vars"\s*:\s*\{/.test(out)) out = out.replace(/("vars"\s*:\s*\{)(\s*)(\}?)/, (_m, head, space, close) => `${head}${space || ' '}"ZHARP_SERVICE": "${service}"${close ? ' ' : ', '}${close}`);
    else keys.push(`"vars": { "ZHARP_SERVICE": "${service}" }`);
  }
  if (keys.length) {
    const at = out.indexOf('{') + 1;
    out = `${out.slice(0, at)}\n${keys.map((k) => `${indent}${k},`).join('\n')}${out.slice(at)}`;
  }
  return out;
}

// ── the Worker's entry ──────────────────────────────────────────────────

/** Where the `{` that starts at `open` closes, skipping strings, template literals and comments. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
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
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `import … from '@zharp/cloudflare'` after the file's last import, in its style. */
function withImport(text: string, names: string): string {
  const imports = [...text.matchAll(/^import [\s\S]*?from\s+['"][^'"]+['"];?$/gm)];
  const semicolons = !imports.length || imports.some((m) => m[0].trimEnd().endsWith(';'));
  const quote = imports.length && imports.every((m) => /from\s+"/.test(m[0])) ? '"' : "'";
  const line = `import { ${names} } from ${quote}@zharp/cloudflare${quote}${semicolons ? ';' : ''}`;
  if (!imports.length) return `${line}\n\n${text}`;
  const last = imports[imports.length - 1];
  const end = last.index! + last[0].length;
  return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
}

/**
 * The default export wrapped with `withZharp`: an object literal (`export default { fetch… }`,
 * with or without `satisfies ExportedHandler<Env>`), or a name (`export default app` — Hono).
 * Null when it is something else (a class, a call): then it's a snippet to paste.
 */
export function wrapWorkerEntry(text: string): string | null {
  if (/withZharp/.test(text)) return null;
  const named = /^export[ \t]+default[ \t]+([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*$/m.exec(text);
  if (named && !/^(class|function|async)$/.test(named[1])) {
    const semicolon = named[0].trimEnd().endsWith(';') ? ';' : '';
    return withImport(text.replace(named[0], `export default withZharp(${named[1]})${semicolon}`), 'withZharp');
  }
  const objectStart = /^export\s+default\s+\{/m.exec(text);
  if (!objectStart) return null;
  const open = objectStart.index + objectStart[0].length - 1;
  const close = matchingBrace(text, open);
  if (close < 0) return null;
  // What follows the object on its line: `satisfies ExportedHandler<Env>`, a semicolon, or nothing.
  const tail = /^([ \t]*satisfies[ \t]+[^;\n]*?)?([ \t]*;)?(?=[ \t]*(?:\r?\n|$))/.exec(text.slice(close + 1));
  if (!tail) return null;
  const satisfies = tail[1] ?? '';
  const semicolon = tail[2] ? ';' : '';
  const end = close + 1 + tail[0].length;
  const wrapped = `export default withZharp(${text.slice(open, close + 1)}${satisfies})${semicolon}`;
  return withImport(`${text.slice(0, objectStart.index)}${wrapped}${text.slice(end)}`, 'withZharp');
}

/** The deploy script with the build kept and its source maps uploaded, filed under the commit. */
export function deployScript(appId: number): string {
  const sha = '$(git rev-parse --short HEAD)';
  return `wrangler deploy --outdir ${BUILD_DIR} --var ZHARP_RELEASE:${sha} && zharp sourcemaps upload ${BUILD_DIR} --release ${sha} --app ${appId}`;
}

// ── plans ───────────────────────────────────────────────────────────────

function emptyPlan(): Plan {
  return { install: ['@zharp/cloudflare'], devInstall: [], changes: [], manual: [], notes: [], env: { file: '.dev.vars', vars: {} }, commands: [] };
}

function keyVars(c: Connected, api: string): Record<string, string> {
  const clean = api.replace(/\/+$/, '');
  return { ZHARP_KEY: c.application.ingestKey, ...(clean !== DEFAULT_API ? { ZHARP_ENDPOINT: `${clean}/api/v1/otlp` } : {}) };
}

function configChange(project: Project, config: string, c: Connected): Plan['changes'][number] | null {
  const text = read(project.dir, config);
  if (text === null) return null;
  const edited = editWranglerConfig(text, config.endsWith('.toml'), c.application.serviceName);
  return edited ? { path: config, kind: 'edit', content: edited, note: 'nodejs_compat, version metadata, source maps, ZHARP_SERVICE' } : null;
}

export function workersPlan(project: Project, c: Connected, api: string, config: string): Plan {
  const plan = emptyPlan();
  plan.devInstall.push('@zharp/cli');
  const dir = project.dir;
  const configText = read(dir, config) ?? '';
  const change = configChange(project, config, c);
  if (change) plan.changes.push(change);

  const main = wranglerMain(configText, config.endsWith('.toml'));
  const entry = main ? read(dir, main) : null;
  const wrapped = entry ? wrapWorkerEntry(entry) : null;
  if (main && wrapped) plan.changes.push({ path: main, kind: 'edit', content: wrapped, note: 'default export wrapped with withZharp' });
  else if (!entry || !/@zharp\/cloudflare/.test(entry)) {
    plan.manual.push({
      path: main ?? 'src/index.ts',
      why: 'wrap the default export',
      snippet: "import { withZharp } from '@zharp/cloudflare';\n\nexport default withZharp({\n  async fetch(request, env, ctx) { … },\n});",
    });
  }
  if (entry && /extends\s+DurableObject\b/.test(entry)) {
    plan.notes.push('Durable Objects: export each class through instrumentDurableObject — export const Cart = instrumentDurableObject(CartObject) — keeping the class_name Wrangler knows it by.');
  }

  const scripts: Record<string, string> = project.packageJson?.scripts ?? {};
  const deploy = Object.entries(scripts).find(([, cmd]) => /^\s*(npx\s+)?wrangler\s+deploy\s*$/.test(cmd))?.[0];
  if (deploy && project.packageJson) {
    const pkg = { ...project.packageJson, scripts: { ...scripts, [deploy]: deployScript(c.application.id) } };
    const original = read(dir, 'package.json') ?? '';
    const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? '  ';
    plan.changes.push({ path: 'package.json', kind: 'edit', content: `${JSON.stringify(pkg, null, indent)}\n`, note: `${deploy}: source maps uploaded, filed under the commit` });
  } else {
    plan.notes.push(`Readable stacks: deploy with ${deployScript(c.application.id)}`);
  }
  plan.env.vars = keyVars(c, api);
  plan.notes.push(`Production: npx wrangler secret put ZHARP_KEY, and paste ${c.application.ingestKey}.`);
  plan.notes.push(`The deploy uploads source maps with ZHARP_AUTH_TOKEN=${c.uploadKey} in its environment: add it to your shell or CI secrets.`);
  return plan;
}

export function pagesPlan(project: Project, c: Connected, api: string, config: string | null): Plan {
  const plan = emptyPlan();
  const dir = project.dir;
  if (config && existsSync(join(dir, config))) {
    const change = configChange(project, config, c);
    if (change) plan.changes.push(change);
  }
  const ext = project.typescript ? 'ts' : 'js';
  const existing = ['functions/_middleware.ts', 'functions/_middleware.js'].find((p) => existsSync(join(dir, p)));
  const middleware = `import { zharpPagesPlugin } from '@zharp/cloudflare';\n\n// Every request through the project's Functions: a span, errors reported, D1/KV/R2 traced.\nexport const onRequest = zharpPagesPlugin();\n`;
  if (!existing) plan.changes.push({ path: `functions/_middleware.${ext}`, kind: 'create', content: middleware, note: 'traces the Functions' });
  else if (!/@zharp\/cloudflare/.test(read(dir, existing) ?? '')) {
    plan.manual.push({ path: existing, why: 'add Zharp first in the middleware chain', snippet: "import { zharpPagesPlugin } from '@zharp/cloudflare';\n\nexport const onRequest = [zharpPagesPlugin(), yourMiddleware];" });
  }
  plan.env.vars = keyVars(c, api);
  plan.notes.push(`Production: npx wrangler pages secret put ZHARP_KEY, and paste ${c.application.ingestKey}.`);
  return plan;
}

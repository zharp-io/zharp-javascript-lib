/**
 * `zharp init` for Electron apps: @zharp/electron started in the main process, in each window,
 * and (where the preload is bundled) in the preload.
 *
 * - **electron-vite** (`electron.vite.config.*`): main in src/main, windows in src/renderer. Main's
 *   dependencies stay in node_modules, so main adds the preload itself. The key is
 *   `MAIN_VITE_ZHARP_KEY` in .env, baked into the build.
 * - **Electron Forge with Vite** (`@electron-forge/plugin-vite`): src/main, src/preload,
 *   src/renderer. Everything is bundled and node_modules isn't shipped, so the preload imports
 *   the bridge itself. The key is `VITE_ZHARP_KEY` in .env.
 * - **Electron Forge with webpack**: as with Vite, and the key is written in main.
 * - **electron-builder, or plain Electron**: main is package.json's `main`, windows are HTML pages
 *   loading scripts as they are, so the page gets the self-starting script build. The key is
 *   written in main.
 *
 * An app key can only send, so it is safe in a shipped app, like the browser one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connected } from './connect';
import type { Project } from './detect';
import type { Plan } from './recipes';

export type ElectronFlavor = 'electron-vite' | 'forge-vite' | 'forge-webpack' | 'electron-builder' | 'electron';

export const ELECTRON_FLAVORS: Record<ElectronFlavor, string> = {
  'electron-vite': 'electron-vite',
  'forge-vite': 'Electron Forge (Vite)',
  'forge-webpack': 'Electron Forge (webpack)',
  'electron-builder': 'electron-builder',
  electron: 'Electron',
};

/** Which kind of Electron project, from package.json's dependencies and the config files. */
export function electronFlavor(dir: string, deps: Record<string, string>): ElectronFlavor {
  if (deps['electron-vite'] || ['electron.vite.config.ts', 'electron.vite.config.mjs', 'electron.vite.config.js'].some((f) => existsSync(join(dir, f)))) return 'electron-vite';
  if (deps['@electron-forge/plugin-vite']) return 'forge-vite';
  if (deps['@electron-forge/plugin-webpack']) return 'forge-webpack';
  if (deps['electron-builder']) return 'electron-builder';
  return 'electron';
}

const read = (dir: string, path: string): string | null => {
  try {
    return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const first = (dir: string, paths: string[]) => paths.find((p) => existsSync(join(dir, p))) ?? null;
const mentionsZharp = (text: string | null) => !!text && /@zharp\/electron/.test(text);

/** Lines put after a file's last top-level import (or at the top), keeping its quote and semicolon style. */
export function afterImports(text: string, lines: string[]): string {
  const imports = [...text.matchAll(/^(?:import\b.*|.*\brequire\(['"][^'"]+['"]\);?)$/gm)].filter((m) => !/^\s/.test(m[0]));
  const bare = imports.length > 0 && imports.every((m) => !m[0].trimEnd().endsWith(';'));
  const double = imports.filter((m) => /"/.test(m[0])).length > imports.filter((m) => /'/.test(m[0])).length;
  const styled = lines.map((line) => {
    let l = double ? line.replace(/'([^'"]*)'/g, '"$1"') : line;
    if (bare) l = l.replace(/;$/, '');
    return l;
  });
  const block = styled.join('\n');
  if (!imports.length) return `${block}\n\n${text}`;
  const last = imports[imports.length - 1];
  const end = last.index! + last[0].length;
  return `${text.slice(0, end)}\n${block}${text.slice(end)}`;
}

/**
 * Zharp started before anything else in main, so main's own requests and drivers are patched as
 * they load. CommonJS runs in order: the two lines go first in the file. ES modules load every
 * import before any code runs: init goes in a module of its own (`zharp.ts`), imported first.
 * Returns the edited main, and that module's text when there is one.
 */
export function addToMain(text: string, init: string, commonjs: boolean): { main: string; module?: string } | null {
  if (mentionsZharp(text) || /^import ['"]\.\/zharp(?:\.[cm]?[jt]s)?['"]/m.test(text)) return null;
  // In the file's style: no semicolons, double quotes, where its first import has them so.
  const firstLine = text.split('\n').find((l) => /^(?:import|const|let|var)\b/.test(l)) ?? '';
  const bare = !!firstLine && !firstLine.trimEnd().endsWith(';');
  const double = /["]/.test(firstLine) && !/'/.test(firstLine);
  const style = (lines: string[]) =>
    lines.map((l) => {
      let out = double ? l.replace(/'([^'"]*)'/g, '"$1"') : l;
      if (bare) out = out.replace(/;$/, '');
      return out;
    }).join('\n');
  const header = /^(['"])use strict\1;?\n/.exec(text);
  const prepend = (block: string) => (header ? `${header[0]}${block}${text.slice(header[0].length)}` : `${block}${text}`);
  if (commonjs) return { main: prepend(`${style(["const { Zharp } = require('@zharp/electron/main');", '', init])}\n\n`) };
  return {
    main: prepend(`${style(["import './zharp';"])}\n`),
    module: `${style(["import { Zharp } from '@zharp/electron/main';", '', init])}\n`,
  };
}

/** A page without a bundler: the self-starting script, before the page's own scripts. */
export function addScriptTag(html: string, src: string): string | null {
  if (/@zharp\/electron/.test(html)) return null;
  const tag = `<script src="${src}"></script>`;
  const firstScript = /^([ \t]*)<script\b/m.exec(html);
  if (firstScript) return `${html.slice(0, firstScript.index)}${firstScript[1]}${tag}\n${html.slice(firstScript.index)}`;
  const head = /^([ \t]*)<\/head>/m.exec(html);
  if (head) return `${html.slice(0, head.index)}${head[1]}  ${tag}\n${html.slice(head.index)}`;
  return null;
}

export function electronPlanFor(project: Project, c: Connected, api: string): Plan | null {
  if (project.framework !== 'electron') return null;
  const dir = project.dir;
  const deps: Record<string, string> = { ...(project.packageJson?.dependencies ?? {}), ...(project.packageJson?.devDependencies ?? {}) };
  const flavor = electronFlavor(dir, deps);
  const clean = api.replace(/\/+$/, '');
  const custom = clean !== 'https://api.zharp.io';
  const plan: Plan = { install: ['@zharp/electron'], devInstall: [], changes: [], manual: [], notes: [], env: { file: '', vars: {} } };

  // ── main ──
  const keyExpr = flavor === 'electron-vite' ? 'import.meta.env.MAIN_VITE_ZHARP_KEY' : flavor === 'forge-vite' ? 'import.meta.env.VITE_ZHARP_KEY' : `'${c.application.ingestKey}'`;
  const endpointExpr = !custom ? '' : flavor === 'electron-vite' ? ', endpoint: import.meta.env.MAIN_VITE_ZHARP_ENDPOINT' : flavor === 'forge-vite' ? ', endpoint: import.meta.env.VITE_ZHARP_ENDPOINT' : `, endpoint: '${clean}/api/v1/otlp'`;
  const init = `Zharp.init({ key: ${keyExpr}${endpointExpr}, service: '${c.application.serviceName}' });`;
  const mainCandidates =
    flavor === 'electron-vite' ? ['src/main/index.ts', 'src/main/index.js', 'src/main/main.ts', 'src/main.ts']
    : flavor === 'forge-vite' ? ['src/main.ts', 'src/main.js', 'src/index.ts', 'src/index.js']
    : flavor === 'forge-webpack' ? ['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js']
    : [String(project.packageJson?.main ?? 'main.js').replace(/^\.\//, ''), 'main.js', 'src/main.js', 'electron/main.js', 'main.ts', 'src/main.ts', 'electron/main.ts'];
  const mainPath = first(dir, mainCandidates);
  const main = mainPath ? read(dir, mainPath) : null;
  const commonjs = !!main && /\brequire\(['"]electron['"]\)/.test(main) && !/^import\b/m.test(main);
  const editedMain = main ? addToMain(main, init, commonjs) : null;
  const zharpModule = mainPath ? mainPath.replace(/[^/]+$/, `zharp.${/\.ts$/.test(mainPath) ? 'ts' : /\.mjs$/.test(mainPath) ? 'mjs' : 'js'}`) : null;
  if (mainPath && editedMain && (!editedMain.module || !existsSync(join(dir, zharpModule!)))) {
    if (editedMain.module) plan.changes.push({ path: zharpModule!, kind: 'create', content: editedMain.module, note: 'starts Zharp in main: errors, crashes, the windows\' hub' });
    plan.changes.push({ path: mainPath, kind: 'edit', content: editedMain.main, note: editedMain.module ? 'imports it first' : 'starts Zharp first in main: errors, crashes, the windows\' hub' });
  } else if (!mentionsZharp(main) && !(editedMain === null && main)) plan.manual.push({ path: mainPath ?? 'your main process entry', why: 'start Zharp first, before the app loads anything', snippet: `import { Zharp } from '@zharp/electron/main';\n\n${init}` });

  // ── preload: only where it's bundled and node_modules isn't shipped ──
  if (flavor === 'forge-vite' || flavor === 'forge-webpack') {
    const preloadPath = first(dir, ['src/preload.ts', 'src/preload.js', 'src/preload/index.ts']);
    const preload = preloadPath ? read(dir, preloadPath) : null;
    if (preloadPath && preload !== null && !mentionsZharp(preload)) {
      plan.changes.push({ path: preloadPath, kind: 'edit', content: afterImports(preload, ["import '@zharp/electron/preload';"]), note: 'the bridge the windows send through' });
    } else if (!preloadPath) {
      plan.manual.push({ path: 'your preload script', why: 'main is bundled, so the windows\' bridge has to be in the preload', snippet: "import '@zharp/electron/preload';" });
    }
  }

  // ── each window ──
  if (flavor === 'electron-vite' || flavor === 'forge-vite' || flavor === 'forge-webpack') {
    const rendererPath = first(dir, flavor === 'electron-vite'
      ? ['src/renderer/src/main.tsx', 'src/renderer/src/main.ts', 'src/renderer/src/main.jsx', 'src/renderer/src/main.js', 'src/renderer/src/renderer.ts', 'src/renderer/src/renderer.js']
      : ['src/renderer.ts', 'src/renderer.tsx', 'src/renderer.js', 'src/renderer.jsx', 'src/renderer/index.ts', 'src/renderer/index.tsx']);
    const renderer = rendererPath ? read(dir, rendererPath) : null;
    const lines = ["import { Zharp } from '@zharp/electron/renderer';", '', 'Zharp.init();'];
    if (rendererPath && renderer !== null && !mentionsZharp(renderer)) {
      plan.changes.push({ path: rendererPath, kind: 'edit', content: afterImports(renderer, ['', ...lines]).replace(/^\n/, ''), note: 'starts Zharp in each window (sends through main)' });
    } else if (!rendererPath) {
      plan.manual.push({ path: 'your renderer entry', why: 'start Zharp in each window', snippet: lines.join('\n') });
    }
  } else {
    const htmlPath = first(dir, ['index.html', 'src/index.html', 'renderer/index.html', 'app/index.html', 'public/index.html']);
    const depth = htmlPath ? htmlPath.split('/').length - 1 : 0;
    const src = `${depth ? '../'.repeat(depth) : './'}node_modules/@zharp/electron/dist/renderer.min.js`;
    const html = htmlPath ? read(dir, htmlPath) : null;
    const edited = html ? addScriptTag(html, src) : null;
    if (htmlPath && edited) plan.changes.push({ path: htmlPath, kind: 'edit', content: edited, note: 'starts Zharp in the window (sends through main)' });
    else if (!/@zharp\/electron/.test(html ?? '')) plan.manual.push({ path: htmlPath ?? 'each window\'s HTML', why: 'start Zharp in each window, before its own scripts', snippet: `<script src="${src}"></script>\n<!-- or, with a bundler: import { Zharp } from '@zharp/electron/renderer'; Zharp.init(); -->` });
  }

  // ── source maps ──
  if (flavor === 'electron-vite' || flavor === 'forge-vite') {
    plan.devInstall.push('@zharp/vite-plugin');
    const config = flavor === 'electron-vite' ? first(dir, ['electron.vite.config.ts', 'electron.vite.config.mjs', 'electron.vite.config.js']) : first(dir, ['vite.renderer.config.ts', 'vite.renderer.config.mts', 'vite.renderer.config.mjs', 'vite.renderer.config.js']);
    plan.manual.push({
      path: config ?? (flavor === 'electron-vite' ? 'electron.vite.config.ts' : 'vite.renderer.config.ts'),
      why: 'upload the windows\' source maps on build (and main\'s, the same way in its config)',
      snippet: `import { zharp } from '@zharp/vite-plugin';\n…\n${flavor === 'electron-vite' ? 'renderer: { plugins: [react(), zharp({ app: ' + c.application.id + ' })] }' : 'plugins: [zharp({ app: ' + c.application.id + ' })]'}`,
    });
  } else if (flavor === 'forge-webpack') {
    plan.devInstall.push('@zharp/webpack-plugin');
    plan.manual.push({
      path: first(dir, ['webpack.renderer.config.ts', 'webpack.renderer.config.js']) ?? 'webpack.renderer.config.ts',
      why: 'upload the windows\' source maps on build',
      snippet: `import { zharp } from '@zharp/webpack-plugin';\n…\nplugins: [zharp({ app: ${c.application.id} })],\ndevtool: 'source-map',`,
    });
  } else {
    plan.notes.push(`Built or minified window scripts: upload their maps with npx @zharp/cli sourcemaps upload <dir> --app ${c.application.id}.`);
  }

  // ── keys ──
  if (flavor === 'electron-vite') {
    plan.env = { file: '.env', vars: { MAIN_VITE_ZHARP_KEY: c.application.ingestKey, ZHARP_AUTH_TOKEN: c.uploadKey, ...(custom ? { MAIN_VITE_ZHARP_ENDPOINT: `${clean}/api/v1/otlp`, ZHARP_URL: clean } : {}) } };
  } else if (flavor === 'forge-vite') {
    plan.env = { file: '.env', vars: { VITE_ZHARP_KEY: c.application.ingestKey, ZHARP_AUTH_TOKEN: c.uploadKey, ...(custom ? { VITE_ZHARP_ENDPOINT: `${clean}/api/v1/otlp`, ZHARP_URL: clean } : {}) } };
  } else {
    plan.env = { file: '.env', vars: { ZHARP_AUTH_TOKEN: c.uploadKey, ...(custom ? { ZHARP_URL: clean } : {}) } };
  }
  plan.notes.push('Native crashes are on: Electron\'s crash reporter sends them to Zharp, read with Electron\'s own symbols. Your own .node modules: npx @zharp/cli debug-files upload.');
  if (flavor === 'electron-vite' || flavor === 'forge-vite') plan.notes.push(`Add ${flavor === 'electron-vite' ? 'MAIN_VITE_ZHARP_KEY' : 'VITE_ZHARP_KEY'} and ZHARP_AUTH_TOKEN to the CI that builds releases.`);
  return plan;
}

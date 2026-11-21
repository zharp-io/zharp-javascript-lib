/**
 * `zharp init`: connect this project to Zharp and wire the SDK in.
 *
 *   1. find what the project is (Next.js, React with Vite, NestJS…);
 *   2. connect it in the browser — sign in, pick the workspace and app, approve;
 *   3. show every change, and make them only on a yes (`--yes` for scripts);
 *   4. install the packages, write the keys to an env file git ignores;
 *   5. send a test error and print where to see it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { connect, SetupFailed, type Connected } from './connect';
import { detect, type Project } from './detect';
import { DEFAULT_API, GUIDES, planFor, type Plan } from './recipes';

export interface InitOptions {
  dir?: string;
  url?: string;
  yes?: boolean;
  dryRun?: boolean;
  /** Install the SDK from these .tgz files instead of npm (testing unreleased versions). */
  tarballs?: string;
}

const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
const bold = (s: string) => `\u001b[1m${s}\u001b[22m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
const bar = dim('│');

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** The env file with these keys set: existing lines kept, ours replaced or added. */
export function mergeEnv(existing: string, vars: Record<string, string>): string {
  const lines = existing ? existing.replace(/\s+$/, '').split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const name = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (name && name in vars) {
      seen.add(name);
      return `${name}=${vars[name]}`;
    }
    return line;
  });
  const added = Object.entries(vars).filter(([k]) => !seen.has(k));
  if (added.length) {
    if (out.length) out.push('');
    out.push('# Zharp (npm init zharp@latest)');
    for (const [k, v] of added) out.push(`${k}=${v}`);
  }
  return `${out.join('\n')}\n`;
}

/** Whether git would ignore `file` by the project's .gitignore (the common patterns). */
export function ignoredByGit(gitignore: string, file: string): boolean {
  return gitignore.split(/\r?\n/).map((l) => l.trim()).some((l) =>
    l === file || l === `/${file}` || l === '.env*' || l === '.env*.local' && file.endsWith('.local') || l === '*.local' && file.endsWith('.local') || l === '.env.*' && file !== '.env');
}

function installCommand(project: Project, packages: string[], dev: boolean, tarballs?: string): [string, string[]] {
  const specs = tarballs ? packages.map((p) => join(tarballs, `${p.replace('@', '').replace('/', '-')}.tgz`)) : packages;
  switch (project.packageManager) {
    case 'pnpm':
      return ['pnpm', ['add', ...(dev ? ['-D'] : []), ...specs]];
    case 'yarn':
      return ['yarn', ['add', ...(dev ? ['-D'] : []), ...specs]];
    case 'bun':
      return ['bun', ['add', ...(dev ? ['-d'] : []), ...specs]];
    default:
      return ['npm', ['install', ...(dev ? ['--save-dev'] : []), ...specs]];
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/** A test error, straight to OTLP with the app's key, so the person sees one arrive. */
async function sendTestError(api: string, c: Connected): Promise<boolean> {
  const now = `${Date.now()}000000`;
  const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const body = {
    resourceLogs: [{
      resource: { attributes: [attr('service.name', c.application.serviceName), attr('telemetry.sdk.name', 'zharp-cli')] },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: now,
          severityNumber: 17,
          severityText: 'ERROR',
          body: { stringValue: 'ZharpSetupTest: Zharp is connected — this is the test error npm init zharp@latest sent' },
          attributes: [
            attr('exception.type', 'ZharpSetupTest'),
            attr('exception.message', 'Zharp is connected — this is the test error npm init zharp@latest sent'),
            attr('exception.stacktrace', 'ZharpSetupTest: Zharp is connected — this is the test error npm init zharp@latest sent\n    at zharp init'),
            attr('zharp.handled', 'true'),
          ],
        }],
      }],
    }],
  };
  try {
    const res = await fetch(`${api.replace(/\/+$/, '')}/api/v1/otlp/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.application.ingestKey}` },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function showPlan(plan: Plan, c: Connected): void {
  say(`${green('◆')} ${bold('These changes will be made:')}`);
  const deps = [...plan.install, ...plan.devInstall];
  if (deps.length) say(`${bar}  ${green('+')} install ${deps.join(' ')}`);
  for (const ch of plan.changes) say(`${bar}  ${ch.kind === 'create' ? green('+') : yellow('~')} ${bold(ch.path)}   ${dim(ch.kind === 'create' ? `(new) ${ch.note}` : ch.note)}`);
  say(`${bar}  ${green('+')} ${bold(plan.env.file)}   ${dim(Object.keys(plan.env.vars).join(', '))}`);
  for (const m of plan.manual) say(`${bar}  ${yellow('!')} ${m.path}: ${dim(`left as it is — ${m.why}`)}`);
  void c;
}

export async function runInit(options: InitOptions): Promise<number> {
  const dir = resolve(options.dir ?? process.cwd());
  const api = (options.url ?? process.env.ZHARP_URL ?? DEFAULT_API).replace(/\/+$/, '');
  const project = detect(dir);

  say();
  say(`${green('◆')} ${bold('Zharp setup')}`);
  say(`${bar} Found ${bold(project.label)} in ${dim(dir)}`);
  say(bar);

  let connected: Connected;
  try {
    connected = await connect(api, project, {
      showCode(code, url) {
        say(`${bar} Open ${url} and check this code:`);
        say(bar);
        say(`${bar}     ${bold(code)}`);
        say(bar);
        say(`${bar} ${dim('Waiting for you to approve it in the browser…')}`);
      },
    });
  } catch (error) {
    say(`${yellow('■')} ${error instanceof SetupFailed ? error.message : String(error)}`);
    return 1;
  }
  say(`${green('◇')} Connected to ${bold(`${connected.workspace.name} / ${connected.application.name}`)}`);
  say(bar);

  const plan = planFor(project, connected, api);
  if (!plan) {
    say(`${green('◆')} ${bold(`${project.label}: add the SDK with these keys`)}`);
    say(`${bar}  ZHARP_KEY=${connected.application.ingestKey}`);
    say(`${bar}  ${dim('Upload key (source maps): ZHARP_AUTH_TOKEN=')}${connected.uploadKey}`);
    const guide = GUIDES[project.framework];
    say(`${bar}  ${dim(`How: ${guide ?? 'https://zharp.io/docs'}`)}`);
    return 0;
  }

  showPlan(plan, connected);
  say(bar);
  if (options.dryRun) {
    say(`${green('◇')} Dry run: nothing was changed.`);
    return 0;
  }
  if (!options.yes) {
    for (;;) {
      const answer = await ask(`${green('◆')} Apply? ${dim('[Y]es / [n]o / show the [d]iff')} `);
      if (answer === 'd' || answer === 'diff') {
        for (const ch of plan.changes) {
          say(`\n${bold(`── ${ch.path} ${ch.kind === 'create' ? '(new)' : '(edited)'}`)}`);
          say(ch.content);
        }
        continue;
      }
      if (answer === 'n' || answer === 'no') {
        say(`${yellow('■')} Nothing was changed. The app is set up in Zharp: ${connected.appUrl}`);
        return 0;
      }
      break;
    }
  }

  // The files first: a failed install still leaves the setup in place, to finish by hand.
  for (const ch of plan.changes) {
    const path = join(dir, ch.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ch.content);
  }
  const envPath = join(dir, plan.env.file);
  writeFileSync(envPath, mergeEnv(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '', plan.env.vars));
  const gitignorePath = join(dir, '.gitignore');
  if (existsSync(join(dir, '.git')) || existsSync(gitignorePath)) {
    const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    if (!ignoredByGit(gitignore, plan.env.file)) writeFileSync(gitignorePath, `${gitignore.replace(/\s*$/, '\n')}${plan.env.file}\n`);
  }
  say(`${green('◇')} Files written`);

  for (const [packages, dev] of [[plan.install, false], [plan.devInstall, true]] as const) {
    if (!packages.length) continue;
    const [command, args] = installCommand(project, [...packages], dev, options.tarballs);
    say(`${bar} ${dim(`${command} ${args.join(' ')}`)}`);
    // Windows runs npm/pnpm through their .cmd shims, which need a shell: one command line, quoted.
    const result = process.platform === 'win32'
      ? spawnSync([command, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), { cwd: dir, stdio: 'inherit', shell: true })
      : spawnSync(command, args, { cwd: dir, stdio: 'inherit' });
    if (result.status !== 0) {
      say(`${yellow('■')} The install failed. Run it yourself: ${command} ${args.join(' ')}`);
      return 1;
    }
  }
  say(`${green('◇')} Packages installed`);

  for (const m of plan.manual) {
    say(bar);
    say(`${yellow('!')} ${bold(m.path)} — ${m.why}:`);
    for (const line of m.snippet.split('\n')) say(`${bar}   ${line}`);
  }
  for (const note of plan.notes) say(`${bar} ${yellow('!')} ${note}`);

  const sent = await sendTestError(api, connected);
  say(bar);
  say(sent
    ? `${green('◇')} Done. Sent a test error — see it at ${connected.appUrl}`
    : `${green('◇')} Done. Open ${connected.appUrl} — errors show up as your app sends them.`);
  return 0;
}

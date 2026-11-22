/**
 * The handshake with Zharp: open a setup session, show its code, open the page in the browser,
 * and wait until the person approves it there — then collect the app's key and an upload key.
 */
import { spawn } from 'node:child_process';
import { platform as osPlatform, release } from 'node:os';
import type { Project } from './detect';
import { VERSION } from '../version';

export interface Connected {
  application: { id: number; name: string; serviceName: string; ingestKey: string };
  workspace: { id: number; name: string };
  uploadKey: string;
  appUrl: string;
}

export interface ConnectHooks {
  /** Show the code and the link (the browser is opened too, where there is one). */
  showCode(code: string, url: string): void;
  /** While waiting: called each poll. */
  waiting?(): void;
  /** For tests: no browser, a fake clock. */
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

const OS_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function openBrowser(url: string): void {
  // CI, SSH, or asked not to: the link is printed, nothing is opened.
  if (process.env.ZHARP_NO_BROWSER || process.env.CI || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return;
  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url.replace(/&/g, '^&')] : [url];
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser here (SSH, CI): the link is printed.
  }
}

export class SetupFailed extends Error {}

export async function connect(api: string, project: Project, hooks: ConnectHooks): Promise<Connected> {
  const http = hooks.fetch ?? fetch;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = `${api.replace(/\/+$/, '')}/api/v1/cli-setup`;

  const opened = await http(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': `zharp-cli/${VERSION}` },
    body: JSON.stringify({ name: project.name, framework: project.label, catalog: project.catalog, platform: project.platform, os: OS_NAMES[osPlatform()] ?? `${osPlatform()} ${release()}`, cliVersion: VERSION }),
  }).catch((error) => {
    throw new SetupFailed(`Could not reach Zharp at ${api} (${error?.cause?.code ?? error?.message ?? error}).`);
  });
  if (!opened.ok) throw new SetupFailed(`Zharp refused to start a setup (${opened.status}).`);
  const session = (await opened.json()).data as { userCode: string; deviceToken: string; verificationUrl: string; expiresIn: number; interval: number };

  hooks.showCode(session.userCode, session.verificationUrl);
  (hooks.openBrowser ?? openBrowser)(session.verificationUrl);

  const until = Date.now() + session.expiresIn * 1000;
  while (Date.now() < until) {
    await sleep(Math.max(1, session.interval) * 1000);
    hooks.waiting?.();
    const res = await http(`${base}/collect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `zharp-cli/${VERSION}` },
      body: JSON.stringify({ deviceToken: session.deviceToken }),
    }).catch(() => null);
    if (!res) continue; // a blip: try again
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body?.data?.status === 'approved') return body.data as Connected;
    if (res.status === 200) continue;
    throw new SetupFailed(body?.message ?? `The setup stopped (${res.status}).`);
  }
  throw new SetupFailed('The code expired before it was approved. Run it again.');
}

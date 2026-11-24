/**
 * `zharp init` in a folder of scripts: PowerShell (the Zharp module) or shell (zharp.sh). Scripts
 * aren't edited — wrapping one changes how it fails — so the plan installs what it can and
 * prints the lines to add at the top of the entry script.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Connected } from './connect';
import type { Plan } from './recipes';

export interface Scripts {
  kind: 'powershell' | 'shell';
  /** The script the lines go in: the one at the top of the folder, else the first found. */
  entry: string;
}

const ENTRY_NAMES = /^(main|run|deploy|backup|build|install|start|job|task|script)\b/i;

/** The .ps1 and .sh files at the top of the folder and in scripts/, bin/, jobs/. */
export function detectScripts(dir: string): Scripts | null {
  const found: { path: string; kind: Scripts['kind'] }[] = [];
  for (const sub of ['', 'scripts', 'bin', 'jobs']) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, sub));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const kind = /\.ps1$/i.test(name) ? 'powershell' : /\.(sh|bash|zsh)$/i.test(name) ? 'shell' : null;
      if (!kind) continue;
      try {
        if (!statSync(join(dir, sub, name)).isFile()) continue;
      } catch {
        continue;
      }
      found.push({ path: sub ? `${sub}/${name}` : name, kind });
    }
  }
  if (!found.length) return null;
  const count = (kind: Scripts['kind']) => found.filter((f) => f.kind === kind).length;
  // More of one kind decides; a tie goes to what this machine runs.
  const kind: Scripts['kind'] = count('powershell') > count('shell') ? 'powershell'
    : count('shell') > count('powershell') ? 'shell'
    : process.platform === 'win32' ? 'powershell' : 'shell';
  const ofKind = found.filter((f) => f.kind === kind);
  const entry = ofKind.find((f) => !f.path.includes('/') && ENTRY_NAMES.test(f.path)) ?? ofKind.find((f) => !f.path.includes('/')) ?? ofKind[0];
  return { kind, entry: entry.path };
}

const endpointOf = (api: string): string | null => {
  const clean = api.replace(/\/+$/, '');
  return clean === 'https://api.zharp.io' ? null : `${clean}/api/v1/otlp`;
};

export function powershellPlan(entry: string, c: Connected, api: string): Plan {
  const endpoint = endpointOf(api);
  const start = `Start-Zharp -Service '${c.application.serviceName}'${endpoint ? ` -Endpoint '${endpoint}'` : ''}`;
  return {
    install: [],
    devInstall: [],
    changes: [],
    env: { file: '', vars: {} },
    commands: [{
      label: 'Install-Module Zharp (PowerShell Gallery, for this user)',
      argv: [process.platform === 'win32' ? 'powershell' : 'pwsh', '-NoProfile', '-Command', 'Install-Module Zharp -Scope CurrentUser -Force'],
    }],
    manual: [{
      path: entry,
      why: 'run the script inside Invoke-Zharp: an error that ends it is reported with its stack and the code that ran, then thrown on',
      snippet: `Import-Module Zharp\n${start}\n\nInvoke-Zharp {\n    # the script, as it is\n}`,
    }],
    notes: [
      `Set ZHARP_KEY=${c.application.ingestKey} where the script runs (a scheduled task: a machine variable; Azure Automation: an encrypted variable passed to Start-Zharp -Key).`,
      "For a scheduled job, Invoke-Zharp -Monitor '<token>' pings a Cron job monitor at start and finish.",
    ],
  };
}

export function shellPlan(entry: string, c: Connected, api: string): Plan {
  const endpoint = endpointOf(api);
  return {
    install: [],
    devInstall: [],
    changes: [],
    env: { file: '', vars: {} },
    manual: [
      {
        path: 'this machine',
        why: 'install zharp.sh (the hook, and the zharp command)',
        snippet: 'sudo curl -fsSL https://zharp.io/zharp.sh -o /usr/local/lib/zharp.sh\nsudo chmod +x /usr/local/lib/zharp.sh\nsudo ln -sf /usr/local/lib/zharp.sh /usr/local/bin/zharp',
      },
      {
        path: entry,
        why: 'source it at the top (bash or zsh): the first failing command is reported with its line, stack and the code that ran',
        snippet: `source /usr/local/lib/zharp.sh\n\n# or run anything through it, in a crontab too:\n# zharp run --service ${c.application.serviceName} -- ./${entry}`,
      },
    ],
    notes: [
      `Set ZHARP_KEY=${c.application.ingestKey}${endpoint ? ` and ZHARP_ENDPOINT=${endpoint}` : ''} where the script runs (its environment, or the top of the crontab).`,
      'zharp run --monitor <token> (or ZHARP_MONITOR) pings a Cron job monitor at start and with the exit code.',
    ],
  };
}

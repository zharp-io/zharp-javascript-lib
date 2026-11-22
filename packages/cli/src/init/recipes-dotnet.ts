/**
 * `zharp init` for .NET: a project file (*.csproj, or a solution's), the host it targets, and
 * the Zharp package for it — ASP.NET Core, a Generic Host worker or console app, AWS Lambda,
 * Google Cloud Functions, or classic ASP.NET on .NET Framework.
 *
 * - The package goes into the .csproj (or, under central package management, `dotnet add
 *   package` adds it where that project keeps versions).
 * - `AddZharp()` goes after the builder line in Program.cs; a plain Main gets `ZharpSdk.Init()`.
 * - `<EmbedAllSources>` makes the build carry its sources in the PDB, so errors show the code that
 *   ran, read on the server itself (nothing to upload).
 * - The app's key goes in appsettings.json ("Zharp": {"Key": …}). It is the key a web page ships:
 *   it can only send data to this one app, so it is safe in a repository, as Python and Go keep
 *   it in code. ZHARP_KEY in the environment wins over it.
 *
 * Apps (MAUI, WPF, Windows Forms) come in a later release: for those, where to read how.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Connected } from './connect';
import type { Project } from './detect';
import type { Plan } from './recipes';
import { findFiles } from './recipes-more';

/** The Zharp packages' version the setup adds. */
export const DOTNET_VERSION = '0.1.0';

export type DotnetHost = 'aspnetcore' | 'worker' | 'console' | 'lambda' | 'gcf' | 'aspnet' | 'app';

/** A .NET project: which file, and what it hosts. */
export interface DotnetProject {
  csproj: string;
  host: DotnetHost;
  /** The tile it is in Add app. */
  catalog: string;
  label: string;
}

const read = (dir: string, path: string): string | null => {
  try {
    return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};

/** The host a project file targets, from its SDK, packages and references. */
export function dotnetHostOf(csproj: string, dir: string, path: string): DotnetHost {
  if (/<Use(Maui|WPF|WindowsForms)>\s*true/i.test(csproj)) return 'app';
  if (/Amazon\.Lambda\.(Core|AspNetCoreServer|RuntimeSupport)/.test(csproj) && !/Amazon\.Lambda\.AspNetCoreServer/.test(csproj)) return 'lambda';
  if (/Google\.Cloud\.Functions\.Hosting/.test(csproj)) return 'gcf';
  if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(csproj)) return 'aspnetcore';
  const projectDir = dirname(path);
  if (/Include="System\.Web"/.test(csproj) || existsSync(join(dir, projectDir, 'Global.asax')) || existsSync(join(dir, projectDir, 'packages.config')) && /System\.Web/.test(csproj)) return 'aspnet';
  if (/Sdk="Microsoft\.NET\.Sdk\.Worker"/.test(csproj) || /Microsoft\.Extensions\.Hosting/.test(csproj)) return 'worker';
  return 'console';
}

const CATALOG: Record<DotnetHost, [string, string]> = {
  aspnetcore: ['ASP.NET Core', 'ASP.NET Core'],
  worker: ['.NET', '.NET (Generic Host)'],
  console: ['.NET', '.NET'],
  lambda: ['AWS Lambda (.NET)', '.NET on AWS Lambda'],
  gcf: ['Google Cloud Functions (.NET)', '.NET on Google Cloud Functions'],
  aspnet: ['ASP.NET', 'ASP.NET (.NET Framework)'],
  app: ['.NET', '.NET desktop/mobile app'],
};

/** The project to set up: the one with Program.cs or the web SDK first, when there are several. */
export function detectDotnet(dir: string): DotnetProject | null {
  const projects = findFiles(dir, '.csproj', 3);
  if (!projects.length) return null;
  const scored = projects.map((path) => {
    const text = read(dir, path) ?? '';
    const host = dotnetHostOf(text, dir, path);
    const hasProgram = existsSync(join(dir, dirname(path), 'Program.cs'));
    const test = /Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest/i.test(text);
    const score = (test ? -10 : 0) + (host === 'aspnetcore' || host === 'lambda' || host === 'gcf' || host === 'aspnet' ? 3 : 0) + (hasProgram ? 2 : 0);
    return { path, host, score };
  }).sort((a, b) => b.score - a.score || a.path.split('/').length - b.path.split('/').length);
  const best = scored[0];
  const [catalog, label] = CATALOG[best.host];
  return { csproj: best.path, host: best.host, catalog, label };
}

const PACKAGE: Record<DotnetHost, string | null> = {
  aspnetcore: 'Zharp.AspNetCore', worker: 'Zharp', console: 'Zharp', lambda: 'Zharp.AwsLambda',
  gcf: 'Zharp.GoogleCloudFunctions', aspnet: 'Zharp.AspNet', app: null,
};

/** Central package management: versions in Directory.Packages.props, in this folder or above. */
function centralPackages(dir: string, projectDir: string): boolean {
  let at = join(dir, projectDir);
  for (let i = 0; i < 8; i++) {
    const text = (() => { try { return readFileSync(join(at, 'Directory.Packages.props'), 'utf8'); } catch { return null; } })();
    if (text !== null) return /<ManagePackageVersionsCentrally>\s*true/i.test(text);
    if (existsSync(join(at, '.git')) || dirname(at) === at) break;
    at = dirname(at);
  }
  return false;
}

/** The project file with a package reference (and sources embedded): null when nothing changes. */
export function editCsproj(text: string, pkg: string | null, embed: boolean): string | null {
  let out = text;
  if (pkg && !new RegExp(`Include="${pkg.replace(/\./g, '\\.')}"`).test(out)) {
    const ref = `    <PackageReference Include="${pkg}" Version="${DOTNET_VERSION}" />`;
    if (/<ItemGroup>[\s\S]*?<PackageReference /.test(out)) {
      out = out.replace(/(<ItemGroup>\s*\n)(\s*<PackageReference )/, `$1${ref}\n$2`);
    } else {
      out = out.replace(/(\n?)(<\/Project>\s*)$/, `$1  <ItemGroup>\n${ref}\n  </ItemGroup>\n\n$2`);
    }
  }
  if (embed && !/<EmbedAllSources>/.test(out)) {
    const line = '    <!-- Zharp: the build carries its sources in the PDB, so errors show the code that ran. -->\n    <EmbedAllSources>true</EmbedAllSources>';
    out = /<PropertyGroup>\s*\n/.test(out)
      ? out.replace(/(<PropertyGroup>\s*\n)/, `$1${line}\n`)
      : out.replace(/(<Project[^>]*>\s*\n)/, `$1  <PropertyGroup>\n${line}\n  </PropertyGroup>\n`);
  }
  return out === text ? null : out;
}

/** `builder.Services.AddZharp();` after the line that creates the host builder. */
export function editProgramForHost(text: string): string | null {
  if (/\.AddZharp\(/.test(text)) return null;
  const m = /^([ \t]*)(?:var|[\w.<>]+)\s+(\w+)\s*=\s*(?:WebApplication\.(?:CreateBuilder|CreateSlimBuilder|CreateEmptyBuilder)|Host\.CreateApplicationBuilder|Host\.CreateEmptyApplicationBuilder|FunctionsApplication\.CreateBuilder)\([^;]*\);[^\n]*\n/m.exec(text);
  if (m) {
    const at = m.index + m[0].length;
    return `${text.slice(0, at)}${m[1]}${m[2]}.Services.AddZharp();\n${text.slice(at)}`;
  }
  // Startup.cs style: first thing in ConfigureServices.
  const cs = /(public\s+void\s+ConfigureServices\s*\(\s*IServiceCollection\s+(\w+)\s*\)\s*\n?\s*\{[^\n]*\n)/.exec(text);
  if (cs) {
    const indent = /\n([ \t]*)\S/.exec(text.slice(cs.index + cs[0].length - 1))?.[1] ?? '        ';
    const at = cs.index + cs[0].length;
    return `${text.slice(0, at)}${indent}${cs[2]}.AddZharp();\n${text.slice(at)}`;
  }
  return null;
}

/** `using var zharp = ZharpSdk.Init();` first in a plain program (top-level statements or Main). */
export function editProgramForConsole(text: string, line = 'using var zharp = Zharp.ZharpSdk.Init();'): string | null {
  if (/ZharpSdk\.Init\(/.test(text)) return null;
  const main = /static\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\([^)]*\)\s*\n?([ \t]*)\{[^\n]*\n/.exec(text);
  if (main) {
    const at = main.index + main[0].length;
    const indent = /^([ \t]*)\S/m.exec(text.slice(at))?.[1] ?? `${main[1]}    `;
    return `${text.slice(0, at)}${indent}${line}\n${text.slice(at)}`;
  }
  if (/\bnamespace\b|\bclass\s+Program\b/.test(text)) return null;
  // Top-level statements: after the using directives (not `using var`) and any comments above them.
  const lines = text.split('\n');
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^using\s+(static\s+)?[\w.]+(\s*=\s*[\w.<>]+)?;/.test(l) || /^global\s+using/.test(l)) at = i + 1;
    else if (l === '' || l.startsWith('//') || l.startsWith('#')) continue;
    else break;
  }
  lines.splice(at, 0, ...(at > 0 ? ['', line] : [line]));
  return lines.join('\n');
}

/** appsettings.json with a "Zharp" section (key, and the endpoint when it isn't the default). */
export function editAppSettings(text: string | null, key: string, endpoint: string | null): string | null {
  let json: Record<string, any>;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    return null; // Comments or trailing commas: left for a person.
  }
  const zharp = { ...(json.Zharp ?? {}), Key: key, ...(endpoint ? { Endpoint: endpoint } : {}) };
  return `${JSON.stringify({ ...json, Zharp: zharp }, null, 2)}\n`;
}

/** web.config with the key in <appSettings>. */
export function editWebConfig(text: string, key: string, endpoint: string | null): string | null {
  if (/key="Zharp:Key"/.test(text)) return null;
  const adds = [`    <add key="Zharp:Key" value="${key}" />`, ...(endpoint ? [`    <add key="Zharp:Endpoint" value="${endpoint}" />`] : [])].join('\n');
  if (/<appSettings\s*\/>/.test(text)) return text.replace(/<appSettings\s*\/>/, `<appSettings>\n${adds}\n  </appSettings>`);
  if (/<appSettings>/.test(text)) return text.replace(/(<appSettings>[^\n]*\n)/, `$1${adds}\n`);
  if (/<configuration>/.test(text)) return text.replace(/(<configuration>[^\n]*\n)/, `$1  <appSettings>\n${adds}\n  </appSettings>\n`);
  return null;
}

/** The [assembly: FunctionsStartup] line in the file with the function. */
export function editGcfFunction(text: string): string | null {
  if (/Zharp\.GoogleCloudFunctions/.test(text)) return null;
  const attribute = '[assembly: FunctionsStartup(typeof(Zharp.GoogleCloudFunctions.ZharpStartup))]';
  const lines = text.split('\n');
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(global\s+)?using\s+[\w.]+(\s*=\s*[\w.]+)?;/.test(lines[i])) at = i + 1;
    else if (lines[i].trim() && !lines[i].trim().startsWith('//')) break;
  }
  const needsUsing = !/using\s+Google\.Cloud\.Functions\.Hosting;/.test(text);
  lines.splice(at, 0, ...(needsUsing ? ['using Google.Cloud.Functions.Hosting;'] : []), '', attribute);
  return lines.join('\n');
}

const DEFAULT_API = 'https://api.zharp.io';
const otlpOf = (api: string) => {
  const clean = api.replace(/\/+$/, '');
  return clean === DEFAULT_API ? null : `${clean}/api/v1/otlp`;
};

export function dotnet(project: Project, c: Connected, api: string): Plan | null {
  const found = detectDotnet(project.dir);
  if (!found || found.host === 'app') return null;
  const plan: Plan = { install: [], devInstall: [], changes: [], manual: [], notes: [], env: { file: '', vars: {} }, commands: [] };
  const key = c.application.ingestKey;
  const endpoint = otlpOf(api);
  const projectDir = dirname(found.csproj) === '.' ? '' : dirname(found.csproj);
  const at = (file: string) => (projectDir ? `${projectDir}/${file}` : file);
  const pkg = PACKAGE[found.host]!;
  const csprojText = read(project.dir, found.csproj) ?? '';

  // The package, and the sources in the PDB.
  const central = centralPackages(project.dir, projectDir);
  if (central) plan.commands!.push({ label: `dotnet add ${found.csproj} package ${pkg}`, argv: ['dotnet', 'add', found.csproj, 'package', pkg, '--version', DOTNET_VERSION] });
  const classicPackages = found.host === 'aspnet' && existsSync(join(project.dir, projectDir, 'packages.config'));
  const edited = editCsproj(csprojText, central || classicPackages ? null : pkg, true);
  if (edited) plan.changes.push({ path: found.csproj, kind: 'edit', content: edited, note: [central || classicPackages ? null : `adds ${pkg}`, /<EmbedAllSources>/.test(csprojText) ? null : 'embeds the sources in the PDB'].filter(Boolean).join('; ') });
  if (classicPackages) plan.manual.push({ path: found.csproj, why: 'a packages.config project: add the package from Visual Studio\'s Package Manager Console', snippet: `Install-Package ${pkg} -Version ${DOTNET_VERSION}` });

  const program = at('Program.cs');
  const programText = read(project.dir, program);
  const settingsPath = at('appsettings.json');
  const keyInSettings = () => {
    const text = read(project.dir, settingsPath);
    const next = editAppSettings(text, key, endpoint);
    if (next) plan.changes.push({ path: settingsPath, kind: text === null ? 'create' : 'edit', content: next, note: 'the app\'s key ("Zharp": {"Key"}); ZHARP_KEY in the environment wins' });
    else plan.manual.push({ path: settingsPath, why: 'add the app\'s key (or set ZHARP_KEY in the environment)', snippet: `"Zharp": { "Key": "${key}"${endpoint ? `, "Endpoint": "${endpoint}"` : ''} }` });
  };

  switch (found.host) {
    case 'aspnetcore':
    case 'worker': {
      const next = programText ? editProgramForHost(programText) : null;
      if (next) plan.changes.push({ path: program, kind: 'edit', content: next, note: found.host === 'aspnetcore' ? 'AddZharp(): requests, errors, failed queries' : 'AddZharp() on the host' });
      else if (!programText?.includes('AddZharp(')) plan.manual.push({ path: programText ? program : 'Program.cs', why: 'start Zharp where the services are added', snippet: 'builder.Services.AddZharp();' });
      keyInSettings();
      break;
    }
    case 'console': {
      const init = endpoint
        ? `using var zharp = Zharp.ZharpSdk.Init(o => { o.Key = "${key}"; o.Endpoint = "${endpoint}"; });`
        : `using var zharp = Zharp.ZharpSdk.Init(o => o.Key = "${key}");`;
      const withKey = programText ? editProgramForConsole(programText, init) : null;
      if (withKey) plan.changes.push({ path: program, kind: 'edit', content: withKey, note: 'ZharpSdk.Init() first: errors, HttpClient and database calls' });
      else plan.manual.push({ path: program, why: 'start Zharp first in Main', snippet: init });
      break;
    }
    case 'lambda': {
      plan.manual.push({
        path: 'your function class',
        why: 'wrap the handler: each invocation traced, its errors reported, everything sent before Lambda freezes',
        snippet: [
          `static readonly Func<Order, ILambdaContext, Task<string>> Handle = Zharp.AwsLambda.ZharpLambda.Wrap<Order, string>(HandleAsync, o => o.Key = "${key}");`,
          'public Task<string> Handler(Order input, ILambdaContext context) => Handle(input, context);',
        ].join('\n'),
      });
      plan.notes.push('Or set ZHARP_KEY in the function\'s environment variables instead of the key in code.');
      break;
    }
    case 'gcf': {
      const fnFile = findFiles(project.dir, '.cs', 3).find((f) => /:\s*I(Http|CloudEvent|Typed)Function\b/.test(read(project.dir, f) ?? ''));
      const next = fnFile ? editGcfFunction(read(project.dir, fnFile)!) : null;
      if (fnFile && next) plan.changes.push({ path: fnFile, kind: 'edit', content: next, note: 'one attribute: invocations traced, errors reported, sent before the response' });
      else plan.manual.push({ path: fnFile ?? 'your function file', why: 'start Zharp with the function', snippet: '[assembly: FunctionsStartup(typeof(Zharp.GoogleCloudFunctions.ZharpStartup))]' });
      plan.notes.push(`Deploy with the key in the environment: gcloud functions deploy … --set-env-vars ZHARP_KEY=${key}`);
      break;
    }
    case 'aspnet': {
      const webConfig = at('Web.config');
      const path = existsSync(join(project.dir, webConfig)) ? webConfig : at('web.config');
      const text = read(project.dir, path);
      const next = text ? editWebConfig(text, key, endpoint) : null;
      if (next) plan.changes.push({ path, kind: 'edit', content: next, note: 'the app\'s key in <appSettings>; the package installs its own module' });
      else if (!text?.includes('Zharp:Key')) plan.manual.push({ path, why: 'add the app\'s key', snippet: `<add key="Zharp:Key" value="${key}" />` });
      plan.notes.push('.NET Framework 4.6.2–4.7.1 reads only Windows PDBs: set <DebugType>full</DebugType> there (4.7.2+ reads the portable PDBs that carry the sources).');
      break;
    }
  }
  plan.notes.push('Builds that can\'t embed their sources: add Zharp.Build (PrivateAssets="all") and set ZHARP_APP_ID and ZHARP_AUTH_TOKEN in CI to upload a source bundle instead.');
  return plan;
}

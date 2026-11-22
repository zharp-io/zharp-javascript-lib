/**
 * `zharp init` for .NET: ASP.NET Core, a worker, a console app, AWS Lambda, Google Cloud
 * Functions, classic ASP.NET, central package management, and apps (a later release).
 *
 *     node test/init-dotnet.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'detect', 'recipes-dotnet']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const net = await import(pathToFileURL(join(tmp, 'recipes-dotnet.mjs')).href);
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

const WEB_CSPROJ = ['<Project Sdk="Microsoft.NET.Sdk.Web">', '', '  <PropertyGroup>', '    <TargetFramework>net10.0</TargetFramework>', '  </PropertyGroup>', '', '</Project>', ''].join(NL);
const MINIMAL = ['var builder = WebApplication.CreateBuilder(args);', 'builder.Services.AddControllers();', '', 'var app = builder.Build();', 'app.MapControllers();', 'app.Run();', ''].join(NL);

console.log('\nzharp init — .NET');

await test('ASP.NET Core: the package and embedded sources in the .csproj, AddZharp() after the builder, the key in appsettings.json', () => {
  const p = project('aspnetcore', {
    'Shop.Api.csproj': WEB_CSPROJ,
    'Program.cs': MINIMAL,
    'appsettings.json': JSON.stringify({ Logging: { LogLevel: { Default: 'Information' } }, AllowedHosts: '*' }, null, 2),
  });
  assert.equal(p.framework, 'dotnet');
  assert.equal(p.platform, 'dotnet');
  assert.equal(p.catalog, 'ASP.NET Core');
  assert.equal(p.name, 'Shop.Api');
  const plan = planFor(p, c, API);
  const csproj = change(plan, 'Shop.Api.csproj').content;
  assert.match(csproj, /<PackageReference Include="Zharp\.AspNetCore" Version="0\.1\.0" \/>/);
  assert.match(csproj, /<PropertyGroup>\n    <!-- Zharp: [^\n]+ -->\n    <EmbedAllSources>true<\/EmbedAllSources>\n    <TargetFramework>/);
  assert.equal(change(plan, 'Program.cs').content, MINIMAL.replace('(args);\n', '(args);\nbuilder.Services.AddZharp();\n'));
  const settings = JSON.parse(change(plan, 'appsettings.json').content);
  assert.deepEqual(settings.Zharp, { Key: 'zpk_abc' });
  assert.equal(settings.AllowedHosts, '*');
  assert.equal(plan.env.file, '');
  assert.deepEqual(plan.commands, []);
});

await test('a solution: the web project, not its tests; a self-hosted Zharp gets its endpoint', () => {
  const p = project('solution', {
    'Shop.sln': 'Microsoft Visual Studio Solution File',
    'src/Shop.Web/Shop.Web.csproj': WEB_CSPROJ,
    'src/Shop.Web/Program.cs': MINIMAL,
    'tests/Shop.Tests/Shop.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.3" /><PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0" /></ItemGroup></Project>',
  });
  assert.equal(p.catalog, 'ASP.NET Core');
  const plan = planFor(p, c, 'http://localhost:3000');
  assert.ok(change(plan, 'src/Shop.Web/Program.cs').content.includes('builder.Services.AddZharp();'));
  const created = change(plan, 'src/Shop.Web/appsettings.json');
  assert.equal(created.kind, 'create');
  assert.deepEqual(JSON.parse(created.content).Zharp, { Key: 'zpk_abc', Endpoint: 'http://localhost:3000/api/v1/otlp' });
});

await test('central package management: `dotnet add package`, the .csproj only embeds the sources', () => {
  const p = project('cpm', {
    'Directory.Packages.props': '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>',
    'Api/Api.csproj': WEB_CSPROJ,
    'Api/Program.cs': MINIMAL,
  });
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((x) => x.argv), [['dotnet', 'add', 'Api/Api.csproj', 'package', 'Zharp.AspNetCore', '--version', '0.1.0']]);
  assert.doesNotMatch(change(plan, 'Api/Api.csproj').content, /PackageReference/);
});

await test('a worker (Generic Host): Zharp and AddZharp() on Host.CreateApplicationBuilder', () => {
  const p = project('worker', {
    'Worker.csproj': '<Project Sdk="Microsoft.NET.Sdk.Worker">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Microsoft.Extensions.Hosting" Version="10.0.0" />\n  </ItemGroup>\n</Project>\n',
    'Program.cs': 'var builder = Host.CreateApplicationBuilder(args);\nbuilder.Services.AddHostedService<Worker>();\nbuilder.Build().Run();\n',
    'appsettings.json': '{}',
  });
  assert.equal(p.catalog, '.NET');
  const plan = planFor(p, c, API);
  assert.match(change(plan, 'Worker.csproj').content, /<ItemGroup>\n    <PackageReference Include="Zharp" Version="0\.1\.0" \/>\n    <PackageReference Include="Microsoft\.Extensions\.Hosting"/);
  assert.ok(change(plan, 'Program.cs').content.startsWith('var builder = Host.CreateApplicationBuilder(args);\nbuilder.Services.AddZharp();\n'));
});

await test('Startup.cs style: services.AddZharp() first in ConfigureServices', () => {
  const text = ['public class Startup', '{', '    public void ConfigureServices(IServiceCollection services)', '    {', '        services.AddMvc();', '    }', '}', ''].join(NL);
  assert.equal(net.editProgramForHost(text), text.replace('    {\n        services.AddMvc();', '    {\n        services.AddZharp();\n        services.AddMvc();'));
});

await test('a console app: ZharpSdk.Init() first, after the using directives, with the key', () => {
  const p = project('console', {
    'Tool.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n  </PropertyGroup>\n</Project>\n',
    'Program.cs': '// The importer.\nusing System.Net.Http;\n\nvar http = new HttpClient();\nawait Import.RunAsync(http);\n',
  });
  assert.equal(p.catalog, '.NET');
  const plan = planFor(p, c, API);
  assert.equal(change(plan, 'Program.cs').content, '// The importer.\nusing System.Net.Http;\n\nusing var zharp = Zharp.ZharpSdk.Init(o => o.Key = "zpk_abc");\n\nvar http = new HttpClient();\nawait Import.RunAsync(http);\n');
  assert.ok(!change(plan, 'appsettings.json'));
});

await test('a console app with Main', () => {
  const text = 'namespace Tool;\n\nclass Program\n{\n    static async Task Main(string[] args)\n    {\n        await Run();\n    }\n}\n';
  assert.equal(net.editProgramForConsole(text), text.replace('    {\n        await Run();', '    {\n        using var zharp = Zharp.ZharpSdk.Init();\n        await Run();'));
});

await test('AWS Lambda: Zharp.AwsLambda, and the wrap to paste', () => {
  const p = project('lambda', {
    'Orders.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Amazon.Lambda.Core" Version="2.8.1" />\n  </ItemGroup>\n</Project>\n',
    'Function.cs': 'public class Function { public string Handler(string input, ILambdaContext context) => input; }\n',
  });
  assert.equal(p.catalog, 'AWS Lambda (.NET)');
  const plan = planFor(p, c, API);
  assert.match(change(plan, 'Orders.csproj').content, /Include="Zharp\.AwsLambda"/);
  assert.match(plan.manual[0].snippet, /ZharpLambda\.Wrap<Order, string>\(HandleAsync, o => o\.Key = "zpk_abc"\)/);
});

await test('ASP.NET Core on Lambda stays ASP.NET Core', () => {
  const p = project('aspnet-lambda', { 'Api.csproj': WEB_CSPROJ.replace('</PropertyGroup>', '</PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Amazon.Lambda.AspNetCoreServer.Hosting" Version="1.9.0" />\n  </ItemGroup>'), 'Program.cs': MINIMAL });
  assert.equal(p.catalog, 'ASP.NET Core');
});

await test('Google Cloud Functions: the attribute in the function\'s file', () => {
  const p = project('gcf', {
    'Checkout.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Google.Cloud.Functions.Hosting" Version="3.0.1" />\n  </ItemGroup>\n</Project>\n',
    'Function.cs': 'using Google.Cloud.Functions.Framework;\nusing Microsoft.AspNetCore.Http;\n\nnamespace Shop;\n\npublic class Checkout : IHttpFunction\n{\n}\n',
  });
  assert.equal(p.catalog, 'Google Cloud Functions (.NET)');
  const plan = planFor(p, c, API);
  assert.equal(change(plan, 'Function.cs').content, 'using Google.Cloud.Functions.Framework;\nusing Microsoft.AspNetCore.Http;\nusing Google.Cloud.Functions.Hosting;\n\n[assembly: FunctionsStartup(typeof(Zharp.GoogleCloudFunctions.ZharpStartup))]\n\nnamespace Shop;\n\npublic class Checkout : IHttpFunction\n{\n}\n');
  assert.match(change(plan, 'Checkout.csproj').content, /Include="Zharp\.GoogleCloudFunctions"/);
  assert.ok(plan.notes.some((n) => n.includes('--set-env-vars ZHARP_KEY=zpk_abc')));
});

await test('classic ASP.NET (packages.config): the key in Web.config, Install-Package to run', () => {
  const p = project('classic', {
    'Shop/Shop.csproj': '<?xml version="1.0" encoding="utf-8"?>\n<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n  <PropertyGroup>\n    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n  </PropertyGroup>\n  <ItemGroup>\n    <Reference Include="System.Web" />\n  </ItemGroup>\n</Project>\n',
    'Shop/packages.config': '<packages />',
    'Shop/Global.asax': '<%@ Application %>',
    'Shop/Web.config': '<?xml version="1.0"?>\n<configuration>\n  <appSettings>\n    <add key="webpages:Version" value="3.0.0.0" />\n  </appSettings>\n</configuration>\n',
  });
  assert.equal(p.catalog, 'ASP.NET');
  const plan = planFor(p, c, API);
  assert.match(change(plan, 'Shop/Web.config').content, /<appSettings>\n    <add key="Zharp:Key" value="zpk_abc" \/>\n    <add key="webpages:Version"/);
  assert.equal(plan.manual[0].snippet, 'Install-Package Zharp.AspNet -Version 0.1.0');
  const csproj = change(plan, 'Shop/Shop.csproj').content;
  assert.match(csproj, /<EmbedAllSources>true<\/EmbedAllSources>/);
  assert.doesNotMatch(csproj, /PackageReference/);
});

await test('apps (MAUI, WPF, Windows Forms) come later: no recipe, a guide', () => {
  const p = project('wpf', { 'Desk.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <UseWPF>true</UseWPF>\n  </PropertyGroup>\n</Project>\n' });
  assert.equal(p.framework, 'dotnet');
  assert.equal(planFor(p, c, API), null);
});

await test('nothing twice: a project already set up changes nothing in Program.cs or the .csproj', () => {
  const csproj = WEB_CSPROJ.replace('<PropertyGroup>\n', '<PropertyGroup>\n    <EmbedAllSources>true</EmbedAllSources>\n').replace('</Project>', '  <ItemGroup>\n    <PackageReference Include="Zharp.AspNetCore" Version="0.1.0" />\n  </ItemGroup>\n</Project>');
  const p = project('again', { 'Api.csproj': csproj, 'Program.cs': MINIMAL.replace('(args);\n', '(args);\nbuilder.Services.AddZharp();\n') });
  const plan = planFor(p, c, API);
  assert.ok(!change(plan, 'Api.csproj'));
  assert.ok(!change(plan, 'Program.cs'));
  assert.equal(plan.manual.length, 0);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);

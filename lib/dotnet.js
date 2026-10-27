/**
 * `dotnet build` / `dotnet run` for the workspace: picks the target, runs the CLI, and reports the result.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { discover } from './solution.js';

/** MSBuild diagnostics: path(line,col): error CS1002: ; expected [project.csproj] */
const DIAGNOSTIC = /^\s*(.+?)\((\d+),(\d+)(?:,\d+,\d+)?\)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]*\])?\s*$/;

const running = new Map(); // `${kind}\0${projectPath}` → child process

export function parseDiagnostics(output) {
  const seen = new Set();
  const out = [];
  for (const line of output.split(/\r?\n/)) {
    const m = DIAGNOSTIC.exec(line);
    if (!m || seen.has(line.trim())) continue;
    seen.add(line.trim());
    const [, file, row, col, severity, code, message] = m;
    out.push({ file, line: Number(row), column: Number(col), severity, code, message });
  }
  return out;
}

/** The solution to build: the shallowest .slnx/.sln, else the shallowest project. */
export async function buildTarget(projectPath) {
  const { solutions, projects } = await discover(projectPath);
  return solutions[0] ?? projects.find((p) => p.endsWith('.csproj')) ?? null;
}

/**
 * The project to run: the startup-project setting if set, otherwise the shallowest executable project
 * (OutputType Exe/WinExe, or a Web/Worker SDK project).
 */
export async function runTarget(projectPath, setting) {
  if (setting) return isAbsolute(setting) ? setting : join(projectPath, setting);
  const { projects } = await discover(projectPath);
  for (const p of projects.filter((x) => x.endsWith('.csproj'))) {
    const xml = await readFile(p, 'utf8').catch(() => '');
    if (/<OutputType>\s*(?:Win)?Exe\s*<\/OutputType>/i.test(xml) || /Sdk="Microsoft\.NET\.Sdk\.(?:Web|Worker|BlazorWebAssembly|Razor)"/.test(xml)) return p;
  }
  return null;
}

/**
 * Runs `dotnet <args>` in `cwd`. Clicking the same command again while it runs stops it.
 * @returns {Promise<{ code: number | null, output: string, stopped: boolean } | null>} null when it was a stop request
 */
export function runDotnet(key, args, cwd, onOutput) {
  const existing = running.get(key);
  if (existing) {
    existing.stopped = true;
    existing.kill();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('dotnet', args, { cwd, env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' } });
    running.set(key, child);
    const collect = (chunk) => {
      const text = chunk.toString();
      output += text;
      onOutput?.(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      running.delete(key);
      resolve({ code: null, output, stopped: false, error: e });
    });
    child.on('close', (code) => {
      running.delete(key);
      resolve({ code, output, stopped: Boolean(child.stopped) });
    });
  });
}

export function stopAll() {
  for (const child of running.values()) child.kill();
  running.clear();
}

const notInstalled = (r) => r?.error?.code === 'ENOENT';
const INSTALL_HINT = 'The .NET SDK was not found. Install it from https://dotnet.microsoft.com/download and restart Saturn.';

/** Quotes a path for the user's shell when it needs it. */
const quote = (path) => (/^[\w./\\:-]+$/.test(path) ? path : `"${path.replace(/"/g, '\\"')}"`);

/** A project-relative path for commands shown to the user. */
const shown = (projectPath, path) => {
  const rel = relative(projectPath, path);
  return rel && !rel.startsWith('..') ? rel : path;
};

const isTestProject = (xml) => /<PackageReference\s+Include="(?:xunit|xunit\.v3|NUnit|MSTest(?:\.TestFramework)?|TUnit)"/i.test(xml) || /<IsTestProject>\s*true/i.test(xml);

/**
 * Run-menu entries: build the solution, run each executable project, and test when there are test projects.
 */
export async function runConfigurations(projectPath) {
  const { projects } = await discover(projectPath);
  const target = await buildTarget(projectPath);
  const entries = [];
  if (target) entries.push({ name: `Build ${basename(target)}`, command: `dotnet build ${quote(shown(projectPath, target))}` });
  let hasTests = false;
  for (const p of projects.filter((x) => x.endsWith('.csproj'))) {
    const xml = await readFile(p, 'utf8').catch(() => '');
    if (isTestProject(xml)) hasTests = true;
    else if (/<OutputType>\s*(?:Win)?Exe\s*<\/OutputType>/i.test(xml) || /Sdk="Microsoft\.NET\.Sdk\.(?:Web|Worker|BlazorWebAssembly)"/.test(xml)) {
      entries.push({ name: `Run ${basename(p, '.csproj')}`, command: `dotnet run --project ${quote(shown(projectPath, p))}` });
    }
  }
  if (hasTests && target) entries.push({ name: 'Test', command: `dotnet test ${quote(shown(projectPath, target))}` });
  return entries;
}

/**
 * Registers csharp.build and csharp.run. With Saturn's terminal they run in a Terminal tab (interactive, with
 * a Stop button); otherwise they run in the background and `saturn.window.showMessage` reports the result.
 */
export function registerDotnetCommands(saturn) {
  const say = (message, kind, projectPath) => saturn.window?.showMessage?.(message, { kind, projectPath });
  const terminal = typeof saturn.terminal?.run === 'function';

  if (typeof saturn.run?.registerProvider === 'function') saturn.run.registerProvider(({ projectPath }) => runConfigurations(projectPath));

  async function build({ projectPath, target }) {
    target ??= await buildTarget(projectPath);
    if (!target) return say('No solution or project to build.', 'warning', projectPath);
    const name = basename(target);
    if (terminal) return saturn.terminal.run(projectPath, { name: `Build ${name}`, command: `dotnet build ${quote(shown(projectPath, target))}` });
    say(`Building ${name}…`, 'info', projectPath);
    const result = await runDotnet(`build\0${projectPath}`, ['build', target, '-nologo', '-consoleLoggerParameters:NoSummary'], dirname(target));
    if (!result) return say(`Stopped building ${name}.`, 'info', projectPath);
    if (notInstalled(result)) return say(INSTALL_HINT, 'error', projectPath);
    const diagnostics = parseDiagnostics(result.output);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.length - errors.length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (result.code === 0) return say(`Build succeeded: ${name} (${plural(warnings, 'warning')}).`, warnings ? 'warning' : 'info', projectPath);
    const first = errors[0];
    const where = first ? ` First: ${relative(projectPath, first.file) || first.file}(${first.line},${first.column}) ${first.code}: ${first.message}` : '';
    say(`Build failed: ${name} (${plural(errors.length, 'error')}, ${plural(warnings, 'warning')}).${where}`, 'error', projectPath);
    return { diagnostics };
  }

  async function run({ projectPath, target }) {
    target ??= await runTarget(projectPath, saturn.settings?.get?.('csharp.startupProject'));
    if (!target) return say('No runnable project found. Set a startup project in the C# settings.', 'warning', projectPath);
    const name = basename(target).replace(/\.csproj$/, '');
    if (terminal) return saturn.terminal.run(projectPath, { name: `Run ${name}`, command: `dotnet run --project ${quote(shown(projectPath, target))}` });
    say(`Running ${name}… (run again to stop)`, 'info', projectPath);
    const result = await runDotnet(`run\0${projectPath}`, ['run', '--project', target], dirname(target));
    if (!result) return say(`Stopped ${name}.`, 'info', projectPath);
    if (notInstalled(result)) return say(INSTALL_HINT, 'error', projectPath);
    const tail = result.output.trim().split(/\r?\n/).slice(-5).join('\n');
    const diagnostics = parseDiagnostics(result.output).filter((d) => d.severity === 'error');
    if (diagnostics.length) return say(`${name} failed to build (${diagnostics.length} errors). First: ${diagnostics[0].code}: ${diagnostics[0].message}`, 'error', projectPath);
    say(`${name} exited with code ${result.code}.${tail ? `\n${tail}` : ''}`, result.code === 0 ? 'info' : 'error', projectPath);
  }

  saturn.commands.register('csharp.build', build);
  saturn.commands.register('csharp.run', run);
  return { build, run };
}

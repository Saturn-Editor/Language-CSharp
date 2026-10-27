/**
 * New Project creation via `dotnet new`. Template ids in saturn-language.json are `dotnet new` short names
 * (plus "sln" for an empty solution). The chosen framework is checked against the template's own
 * --framework choices, since those depend on the template and the installed SDK.
 */
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

/** Templates that only exist with a workload installed, and the workload to name in the error. */
const WORKLOADS = [
  [/^maui/, 'maui'],
  [/^android/, 'android'],
  [/^ios/, 'ios'],
  [/^maccatalyst/, 'maccatalyst'],
];

function dotnet(args, cwd) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('dotnet', args, { cwd, env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' } });
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', (e) => resolve({ code: null, output: e.message, missingDotnet: e.code === 'ENOENT' }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

/**
 * A template's --help, or null when the template isn't installed: its framework choices
 * (e.g. ['net10.0', 'net9.0']; empty when it has no --framework option) and whether it takes --use-program-main.
 */
const helpCache = new Map();
function templateInfo(template) {
  if (!helpCache.has(template)) {
    helpCache.set(
      template,
      dotnet(['new', template, '--help']).then(({ code, output, missingDotnet }) => {
        if (missingDotnet) return { missingDotnet };
        // An unknown template still exits 0 for --help.
        if (code !== 0 || /No templates or subcommands found/.test(output)) return null;
        const lines = output.split(/\r?\n/);
        const start = lines.findIndex((l) => /^\s*(?:-f, )?--framework\b/.test(l));
        const frameworks = [];
        if (start >= 0) {
          for (const line of lines.slice(start + 1)) {
            if (/^\s*-/.test(line) || /^\s*Default:/.test(line)) break;
            const m = /^\s+(net[\w.-]+)(?:\s|$)/.exec(line);
            if (m) frameworks.push(m[1]);
          }
        }
        return { frameworks, programMain: output.includes('--use-program-main') };
      }),
    );
  }
  return helpCache.get(template);
}

const MISSING_DOTNET = 'The .NET SDK was not found. Install it from https://dotnet.microsoft.com/download';

/**
 * Creates a solution and/or project in `projectPath` (which already exists). Throws with a readable
 * message on failure; Saturn shows it and removes the folder.
 */
export async function createProject({ projectPath, fields, progress }) {
  const name = basename(projectPath);
  const template = String(fields.template ?? 'console');
  const run = async (args) => {
    const result = await dotnet(args, projectPath);
    if (result.missingDotnet) throw new Error(MISSING_DOTNET);
    if (result.code !== 0) throw new Error(result.output.trim().split(/\r?\n/).slice(0, 8).join('\n') || `dotnet ${args.slice(0, 2).join(' ')} failed.`);
  };

  if (fields.gitignore !== false) await run(['new', 'gitignore']);

  if (template === 'sln') {
    progress?.('Creating solution…');
    await run(['new', 'sln', '-n', name, '--format', fields.emptyFormat === 'slnx' ? 'slnx' : 'sln']);
    return;
  }

  progress?.('Checking template…');
  const info = await templateInfo(template);
  if (info?.missingDotnet) throw new Error(MISSING_DOTNET);
  if (!info) {
    const workload = WORKLOADS.find(([re]) => re.test(template))?.[1];
    throw new Error(
      workload
        ? `This template needs the ${workload} workload. Install it with:\n  dotnet workload install ${workload}`
        : `The "${template}" template isn't installed with this .NET SDK.`,
    );
  }

  const framework = String(fields.framework ?? '').trim();
  if (framework && info.frameworks.length && !info.frameworks.includes(framework)) {
    throw new Error(`This template doesn't support ${framework} with the installed SDK.\nChoose one of: ${info.frameworks.join(', ')}.`);
  }

  const solution = fields.solution === 'sln' || fields.solution === 'slnx' ? fields.solution : null;
  // Like Visual Studio: with a solution, the project gets its own folder unless asked otherwise.
  const outDir = solution && fields.sameDir !== true ? name : '.';
  const args = ['new', template, '-n', name, '-o', outDir];
  // Templates without a --framework option (e.g. razorclasslib) pick their own.
  if (framework && info.frameworks.length) args.push('-f', framework);
  if (fields.topLevel === false && info.programMain) args.push('--use-program-main');

  progress?.('Creating project and restoring packages…');
  await run(args);

  if (solution) {
    progress?.('Adding to solution…');
    await run(['new', 'sln', '-n', name, '--format', solution]);
    // Multi-project templates create several .csproj files, so add every one.
    const projects = await filesEndingWith(join(projectPath, outDir), projectPath, '.csproj');
    if (projects.length) await run(['sln', `${name}.${solution}`, 'add', ...projects]);
    // ...and some (maui-multiproject) bring their own solution, which ours replaces.
    if (outDir !== '.') {
      for (const file of [...(await filesEndingWith(join(projectPath, outDir), projectPath, '.sln')), ...(await filesEndingWith(join(projectPath, outDir), projectPath, '.slnx'))]) {
        await rm(join(projectPath, file));
      }
    }
  }
}

async function filesEndingWith(dir, root, ext) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => relative(root, join(e.parentPath ?? e.path, e.name)))
    .filter((p) => !p.split(/[\\/]/).some((s) => s === 'bin' || s === 'obj'));
}

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { KEYWORDS, PRIMITIVE_TYPES, outline } from './lib/csharp.js';
import { install as installCsharpLs, isInstalled as csharpLsInstalled } from './lib/csharpls.js';
import { docCommentSnippet } from './lib/doccomment.js';
import { registerDotnetCommands, stopAll, useDotnetSetting } from './lib/dotnet.js';
import { registerSolutionExplorer } from './lib/explorer.js';
import { renderSolution } from './lib/preview.js';
import { registerTests, stopTests } from './lib/tests.js';
import { createProject } from './lib/templates.js';

const RESERVED = new Set([...KEYWORDS, ...PRIMITIVE_TYPES]);

/** Turns a folder or file name into a valid C# identifier, the way `dotnet new` does. */
function identifier(name) {
  let id = name.replace(/[^\w]/g, '_');
  if (!id) return '_';
  if (/^\d/.test(id) || RESERVED.has(id)) id = `_${id}`;
  return id;
}

const namespaceOf = (name) => name.split('.').filter(Boolean).map(identifier).join('.');

/** The nearest .csproj at or above `dir`, stopping at the project root. */
function findCsproj(projectPath, dir) {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const file = readdirSync(d).find((f) => f.endsWith('.csproj'));
      if (file) return join(d, file);
    } catch {
      // Unreadable folder: keep walking up.
    }
    if (d === projectPath || dirname(d) === d || relative(projectPath, d).startsWith('..')) return null;
  }
}

function csprojInfo(path) {
  try {
    const xml = readFileSync(path, 'utf8');
    const tag = (name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];
    return {
      rootNamespace: tag('RootNamespace'),
      frameworks: (tag('TargetFramework') ?? tag('TargetFrameworks') ?? '').split(';').filter(Boolean),
      langVersion: tag('LangVersion'),
    };
  } catch {
    return { frameworks: [] };
  }
}

/**
 * Namespace for a new file in `dir`: the project's RootNamespace (or .csproj name, or folder name)
 * followed by the folders between the .csproj and the file.
 */
function templateContext({ projectPath, dir, name }) {
  const targetDir = join(dir ?? projectPath, dirname(name));
  const csproj = findCsproj(projectPath, targetDir);
  const base = csproj ? dirname(csproj) : projectPath;
  const info = csproj ? csprojInfo(csproj) : { frameworks: [] };
  const rootName = info.rootNamespace ?? (csproj ? basename(csproj, '.csproj') : basename(projectPath));
  const folders = relative(base, targetDir).split(sep).filter((s) => s && s !== '.');
  const namespace = [namespaceOf(rootName), ...folders.map(identifier)].filter(Boolean).join('.');
  // File-scoped namespaces need C# 10 (.NET 6+); .NET Framework (net48), netstandard, netcoreapp and net5.0 get a block.
  const legacy =
    info.frameworks.some((f) => /^(net\d+$|netstandard|netcoreapp|net5\.0)/.test(f)) ||
    (info.langVersion && /^[1-9](\.\d)?$/.test(info.langVersion));
  return { namespace, fileScoped: !legacy, typeName: identifier(basename(name, extname(name))) };
}

function wrapInNamespace({ namespace, fileScoped }, body) {
  if (!namespace) return `${body}\n`;
  if (fileScoped) return `namespace ${namespace};\n\n${body}\n`;
  return `namespace ${namespace}\n{\n${body.replace(/^(?=.)/gm, '    ')}\n}\n`;
}

const LANG_VERSIONS = [
  { id: 'default', label: 'default', detail: 'The default for the target framework' },
  { id: 'latest', label: 'latest', detail: 'Latest released version' },
  { id: 'preview', label: 'preview', detail: 'Latest preview features' },
  { id: '14', label: '14', detail: '.NET 10' },
  { id: '13', label: '13', detail: '.NET 9' },
  { id: '12', label: '12', detail: '.NET 8' },
  { id: '11', label: '11', detail: '.NET 7' },
  { id: '10', label: '10', detail: '.NET 6' },
  { id: '9', label: '9', detail: '.NET 5' },
  { id: '8', label: '8', detail: '.NET Core 3.x, .NET Standard 2.1' },
  { id: '7.3', label: '7.3', detail: '.NET Framework' },
];

function withLangVersion(xml, version) {
  const existing = /[ \t]*<LangVersion>[^<]*<\/LangVersion>[ \t]*\r?\n?/;
  if (version === 'default') return xml.replace(existing, '');
  if (existing.test(xml)) return xml.replace(/<LangVersion>[^<]*<\/LangVersion>/, `<LangVersion>${version}</LangVersion>`);
  const group = /(<PropertyGroup\b[^>]*>)(\r?\n)([ \t]*)/.exec(xml);
  if (group) return `${xml.slice(0, group.index)}${group[1]}${group[2]}${group[3]}<LangVersion>${version}</LangVersion>${group[2]}${group[3]}${xml.slice(group.index + group[0].length)}`;
  return xml.replace(/(<Project\b[^>]*>)(\r?\n)?/, (_m, open, nl = '\n') => `${open}${nl}  <PropertyGroup>${nl}    <LangVersion>${version}</LangVersion>${nl}  </PropertyGroup>${nl}`);
}

function templateContent(id, ctx) {
  const info = templateContext(ctx);
  return wrapInNamespace(info, TEMPLATES[id](info.typeName));
}

const fileName = ({ name }) => (/\.[^.]+$/.test(name) ? name : `${name}.cs`);

const TEMPLATES = {
  'csharp.class': (type) => `public class ${type}\n{\n}`,
  'csharp.interface': (type) => `public interface ${type}\n{\n}`,
  'csharp.record': (type) => `public record ${type}\n{\n}`,
  'csharp.enum': (type) => `public enum ${type}\n{\n}`,
};

/** Shallowest match first, so the root project wins over nested ones. */
const byDepth = (projectPath) => (a, b) =>
  relative(projectPath, a).split(sep).length - relative(projectPath, b).split(sep).length ||
  relative(projectPath, a).localeCompare(relative(projectPath, b));

let disposeExplorer = () => {};

const previewCss = readFileSync(new URL('./preview.css', import.meta.url), 'utf8');

export function activate(saturn) {
  useDotnetSetting(() => saturn.settings?.get?.('dotnetPath'));
  saturn.previews?.registerRenderer('csharp.solutionPreview', (text, ctx) => renderSolution(text, ctx, previewCss));
  const dotnet = registerDotnetCommands(saturn);
  disposeExplorer = registerSolutionExplorer(saturn, dotnet, templateContent);
  registerLanguageServerSetup(saturn);
  registerTests(saturn);

  for (const id of Object.keys(TEMPLATES)) {
    saturn.files.registerTemplate(id, { fileName, content: (ctx) => templateContent(id, ctx) });
  }

  saturn.languages?.registerDocComment?.('csharp', docCommentSnippet);

  saturn.languages?.registerVersions?.('csharp', {
    list: () => LANG_VERSIONS,
    async onChange({ projectPath, version }) {
      const files = (await saturn.workspace.findFiles(projectPath, '**/*.csproj')).filter((f) => !/(^|[\\/])(bin|obj)[\\/]/.test(f));
      for (const file of files) {
        const path = isAbsolute(file) ? file : join(projectPath, file);
        try {
          writeFileSync(path, withLangVersion(readFileSync(path, 'utf8'), version.id));
        } catch (e) {
          saturn.window?.showMessage?.(`Could not update ${basename(path)}: ${e.message}`, { kind: 'warning', projectPath });
        }
      }
      saturn.languageServer?.restart?.();
    },
  });

  saturn.languages?.onDidRenameSymbol?.(async ({ projectPath, path, languageId, oldName, newName }) => {
    if (languageId !== 'csharp' || !path || oldName === newName) return;
    const file = isAbsolute(path) ? path : join(projectPath, path);
    if (basename(file) !== `${oldName}.cs`) return;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const topLevel = outline(text).types.filter((t) => t.container === -1);
    if (topLevel.length !== 1 || topLevel[0].name !== newName) return;
    try {
      await saturn.workspace.renameFile(projectPath, file, `${newName}.cs`);
    } catch (e) {
      saturn.window?.showMessage?.(`Could not rename ${oldName}.cs: ${e.message}`, { kind: 'warning', projectPath });
    }
  });

  saturn.commands.register('csharp.openProjectFile', async ({ projectPath }) => {
    for (const glob of ['**/*.csproj', '**/*.slnx', '**/*.sln']) {
      const files = await saturn.workspace.findFiles(projectPath, glob);
      if (files.length) {
        saturn.workspace.openFile(projectPath, files.sort(byDepth(projectPath))[0]);
        return;
      }
    }
    saturn.window?.showMessage?.('No .csproj, .slnx or .sln file found in this project.', { kind: 'warning', projectPath });
  });

  saturn.projects.onCreate((ctx) => createProject(ctx));
}

/**
 * Downloads csharp-ls into module storage in the background when a C# project first opens, so it's ready
 * before the server starts, and registers csharp.installLanguageServer to install or update it on demand.
 */
function registerLanguageServerSetup(saturn) {
  const storage = saturn.storagePath;
  const notify = (n) => (saturn.window?.notify ? saturn.window.notify(n) : saturn.window?.showMessage?.(n.message ?? n.title, { kind: n.kind }));

  async function setup({ update = false } = {}) {
    if (!storage) return;
    notify({ title: 'Setting up C#', message: update ? 'Updating csharp-ls…' : 'Downloading csharp-ls…' });
    const result = await installCsharpLs(storage, { update });
    if (result.ok) {
      saturn.languageServer?.restart?.();
      return notify({ title: 'C# is ready', message: 'csharp-ls is installed.' });
    }
    if (result.missingDotnet) {
      return notify({
        title: 'C# needs .NET SDK',
        message: 'Install the .NET SDK, then restart Saturn.',
        kind: 'error',
        actions: [{ label: 'Download', url: 'https://dotnet.microsoft.com/download' }],
      });
    }
    notify({
      title: 'Could not install csharp-ls',
      message: result.output.trim().split(/\r?\n/).slice(-3).join('\n'),
      kind: 'error',
      actions: [
        { label: 'Retry', command: 'csharp.installLanguageServer' },
        { label: 'Open settings', openSettings: true },
      ],
    });
  }

  saturn.commands.register('csharp.installLanguageServer', () => setup({ update: true }));
  // Saturn activates every module at startup, so download on the first C# project instead. Without an
  // open event, the server launcher downloads on first use.
  let started = false;
  saturn.projects.onDidOpen?.(async ({ projectPath }) => {
    const custom = String(saturn.settings?.get?.('csharpLsPath') ?? '').trim();
    if (started || !storage || custom || csharpLsInstalled(storage)) return;
    for (const glob of ['**/*.csproj', '**/*.slnx', '**/*.sln', '**/*.cs']) {
      if ((await saturn.workspace.findFiles(projectPath, glob)).length) {
        if (started) return;
        started = true;
        return setup();
      }
    }
  });
}

export function deactivate() {
  stopAll();
  stopTests();
  disposeExplorer();
}

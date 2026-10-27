import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { KEYWORDS, PRIMITIVE_TYPES } from './lib/csharp.js';
import { registerSolutionExplorer } from './lib/explorer.js';

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

const fileName = ({ name }) => (/\.[^.]+$/.test(name) ? name : `${name}.cs`);

const TEMPLATES = {
  'csharp.class': (type) => `public class ${type}\n{\n}`,
  'csharp.interface': (type) => `public interface ${type}\n{\n}`,
  'csharp.record': (type) => `public record ${type}\n{\n}`,
  'csharp.enum': (type) => `public enum ${type}\n{\n}`,
};

function writeIfMissing(path, content) {
  if (!existsSync(path)) writeFileSync(path, content);
}

function csproj({ template, framework, rootNamespace, projectName }) {
  const props = [
    template === 'console' ? '    <OutputType>Exe</OutputType>' : null,
    `    <TargetFramework>${framework}</TargetFramework>`,
    rootNamespace !== identifier(projectName) ? `    <RootNamespace>${rootNamespace}</RootNamespace>` : null,
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '    <Nullable>enable</Nullable>',
  ].filter(Boolean);
  return `<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n${props.join('\n')}\n  </PropertyGroup>\n\n</Project>\n`;
}

const GITIGNORE = 'bin/\nobj/\n.vs/\n*.user\n*.suo\nTestResults/\n';

/** Shallowest match first, so the root project wins over nested ones. */
const byDepth = (projectPath) => (a, b) =>
  relative(projectPath, a).split(sep).length - relative(projectPath, b).split(sep).length ||
  relative(projectPath, a).localeCompare(relative(projectPath, b));

export function activate(saturn) {
  registerSolutionExplorer(saturn);

  for (const [id, body] of Object.entries(TEMPLATES)) {
    saturn.files.registerTemplate(id, {
      fileName,
      content: (ctx) => {
        const info = templateContext(ctx);
        return wrapInNamespace(info, body(info.typeName));
      },
    });
  }

  saturn.commands.register('csharp.openProjectFile', async ({ projectPath }) => {
    for (const glob of ['**/*.csproj', '**/*.slnx', '**/*.sln']) {
      const files = await saturn.workspace.findFiles(projectPath, glob);
      if (files.length) {
        saturn.workspace.openFile(projectPath, files.sort(byDepth(projectPath))[0]);
        return;
      }
    }
  });

  saturn.projects.onCreate(({ projectPath, fields }) => {
    const projectName = basename(projectPath);
    const template = fields.template === 'classlib' ? 'classlib' : 'console';
    const framework = String(fields.framework ?? '').trim() || 'net10.0';
    const rootNamespace = namespaceOf(String(fields.namespace ?? '').trim() || projectName) || identifier(projectName);
    const ns = { namespace: rootNamespace, fileScoped: true };

    mkdirSync(projectPath, { recursive: true });
    writeIfMissing(join(projectPath, `${projectName}.csproj`), csproj({ template, framework, rootNamespace, projectName }));

    if (template === 'console') {
      const program =
        fields.topLevel !== false
          ? 'Console.WriteLine("Hello, World!");\n'
          : wrapInNamespace(ns, 'internal class Program\n{\n    static void Main(string[] args)\n    {\n        Console.WriteLine("Hello, World!");\n    }\n}');
      writeIfMissing(join(projectPath, 'Program.cs'), program);
    } else {
      writeIfMissing(join(projectPath, 'Class1.cs'), wrapInNamespace(ns, 'public class Class1\n{\n}'));
    }

    if (fields.gitignore !== false) writeIfMissing(join(projectPath, '.gitignore'), GITIGNORE);
  });
}

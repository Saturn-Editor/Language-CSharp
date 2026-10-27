/**
 * Preview for .sln and .slnx files: solution folders, projects (with target frameworks and output type),
 * Solution Items and build configurations. The preview frame runs no scripts, so folders use <details>.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { byName, parseSolution } from './solution.js';

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const KIND = { '.csproj': 'C#', '.fsproj': 'F#', '.vbproj': 'VB', '.sqlproj': 'SQL', '.esproj': 'JS', '.shproj': 'Shared' };

function projectInfo(path) {
  if (!existsSync(path)) return { missing: true };
  const xml = readFileSync(path, 'utf8');
  const tag = (name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];
  const sdk = /<Project\b[^>]*\bSdk\s*=\s*"([^"]*)"/.exec(xml)?.[1];
  const output = tag('OutputType') ?? (/\.(Web|Worker|BlazorWebAssembly)$/.test(sdk ?? '') ? 'Exe' : 'Library');
  const tests = /<PackageReference\s+Include="(?:xunit|xunit\.v3|NUnit|MSTest[\w.]*|TUnit)"/i.test(xml) || /<IsTestProject>\s*true/i.test(xml);
  return {
    frameworks: (tag('TargetFramework') ?? tag('TargetFrameworks') ?? '').split(';').filter(Boolean),
    output: tests ? 'Tests' : /Exe/i.test(output) ? 'Application' : 'Library',
    sdk,
    packages: (xml.match(/<PackageReference\b/g) ?? []).length,
    references: (xml.match(/<ProjectReference\b/g) ?? []).length,
  };
}

export function renderSolution(text, ctx, css) {
  const path = isAbsolute(ctx.path) ? ctx.path : join(ctx.projectPath, ctx.path);
  const s = parseSolution(text, path);
  const rel = (p) => escape(relative(ctx.projectPath, p) || basename(p));

  const project = (p) => {
    const info = projectInfo(p.path);
    const chips = info.missing
      ? '<span class="chip warn">missing</span>'
      : [info.output, ...info.frameworks, info.packages && plural(info.packages, 'package'), info.references && plural(info.references, 'project reference')]
          .filter(Boolean)
          .map((c) => `<span class="chip">${escape(c)}</span>`)
          .join('');
    return `<li class="project"><span class="badge">${escape(KIND[extname(p.path)] ?? 'PRJ')}</span><span class="name">${escape(p.name)}</span><span class="path">${rel(p.path)}</span>${chips}</li>`;
  };
  const file = (f) => `<li class="file"><span class="badge">FILE</span><span class="name">${escape(basename(f))}</span><span class="path">${rel(f)}</span>${existsSync(f) ? '' : '<span class="chip warn">missing</span>'}</li>`;

  const level = (key) => {
    const folders = [...s.folders].filter(([, f]) => f.parent === key).sort(([, a], [, b]) => byName(a.name, b.name));
    const projects = s.projects.filter((p) => p.parent === key).sort((a, b) => byName(a.name, b.name));
    const files = key === null ? s.rootFiles : s.folders.get(key)?.files ?? [];
    return [
      ...folders.map(([k, f]) => `<li><details open><summary><span class="badge">DIR</span>${escape(f.name)}</summary><ul>${level(k)}</ul></details></li>`),
      ...projects.map(project),
      ...files.map(file),
    ].join('');
  };

  const meta = [
    `${s.projects.length} project${s.projects.length === 1 ? '' : 's'}`,
    s.folders.size && `${s.folders.size} solution folder${s.folders.size === 1 ? '' : 's'}`,
    path.endsWith('.slnx') ? 'XML solution (.slnx)' : s.formatVersion && `Format ${s.formatVersion}`,
    s.vsVersion && `Visual Studio ${s.vsVersion}`,
  ].filter(Boolean);

  const configs = s.configurations.length
    ? `<h2>Configurations</h2><div class="configs">${s.configurations.map((c) => `<span class="chip">${escape(c)}</span>`).join('')}</div>`
    : '';

  return `<style>${css}</style>
<article class="solution">
  <h1><span class="badge">SLN</span>Solution '${escape(s.name)}'</h1>
  <p class="meta">${meta.map(escape).join(' · ')}</p>
  <ul class="tree">${level(null) || '<li class="empty">This solution has no projects.</li>'}</ul>
  ${configs}
</article>`;
}

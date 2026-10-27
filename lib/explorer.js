/**
 * Solution Explorer panel: Solution → solution folders → projects → Dependencies / folders → files →
 * nested files (Form1.Designer.cs under Form1.cs) → types → nested types and members, like Visual Studio.
 */
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { outline, positionAt } from './csharp.js';
import { byName, discover, listFiles, nestFiles, readProject, readSolution } from './solution.js';

export const PANEL_ID = 'csharp.solution';

// Ids are JSON arrays so paths containing any character stay unambiguous: ["file", projectFile, path].
const id = (...parts) => JSON.stringify(parts);

/** Folders Visual Studio pins above the others. */
const PINNED_FOLDERS = ['Properties', 'My Project', 'wwwroot'];

export function registerSolutionExplorer(saturn) {
  // Older Saturn builds have no panel API; the rest of the module still works without it.
  if (!saturn.panels?.registerTree) return;

  const workspaces = new Map(); // projectPath → { model?, projects: Map, outlines: Map, watcher }

  const workspace = (projectPath) => {
    let ws = workspaces.get(projectPath);
    if (!ws) {
      ws = { model: null, projects: new Map(), outlines: new Map(), watcher: startWatching(projectPath) };
      workspaces.set(projectPath, ws);
    }
    return ws;
  };

  let refreshTimer = null;
  function startWatching(projectPath) {
    try {
      const watcher = watch(projectPath, { recursive: true }, (_event, file) => {
        if (file && /(^|[\\/])(bin|obj|\.git|\.vs|node_modules)([\\/]|$)/.test(String(file))) return;
        const ws = workspaces.get(projectPath);
        if (ws) {
          ws.model = null;
          ws.projects.clear();
        }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => saturn.panels.refresh(PANEL_ID), 400);
      });
      watcher.unref?.();
      watcher.on('error', () => {});
      return watcher;
    } catch {
      return null;
    }
  }

  async function model(projectPath) {
    const ws = workspace(projectPath);
    ws.model ??= discover(projectPath).then(async ({ solutions, projects }) => ({
      solutions: await Promise.all(solutions.map(readSolution)),
      projects,
    }));
    return ws.model;
  }

  async function project(projectPath, path) {
    const ws = workspace(projectPath);
    if (!ws.projects.has(path)) {
      ws.projects.set(
        path,
        (async () => {
          const p = await readProject(path);
          return { ...p, nesting: nestFiles(p.files, p.dependentUpon) };
        })(),
      );
    }
    return ws.projects.get(path);
  }

  /** A pseudo-project for a folder with no solution or project, so loose .cs files still get an outline. */
  async function looseFolder(projectPath) {
    const ws = workspace(projectPath);
    const key = `\0loose`;
    if (!ws.projects.has(key)) {
      ws.projects.set(
        key,
        (async () => {
          const files = await listFiles(projectPath, null, { stopAtProjects: false });
          return { path: key, name: basename(projectPath), dir: projectPath, files, nesting: nestFiles(files), packages: [], projectRefs: [], frameworkRefs: [], frameworks: [] };
        })(),
      );
    }
    return ws.projects.get(key);
  }

  const projectFor = (projectPath, key) => (key === '\0loose' ? looseFolder(projectPath) : project(projectPath, key));

  async function fileOutline(projectPath, path) {
    const ws = workspace(projectPath);
    try {
      const { mtimeMs } = await stat(path);
      const cached = ws.outlines.get(path);
      if (cached?.mtimeMs === mtimeMs) return cached;
      const text = await readFile(path, 'utf8');
      const entry = { mtimeMs, text, ...outline(text) };
      ws.outlines.set(path, entry);
      return entry;
    } catch {
      return null;
    }
  }

  // ---- Node builders ----

  const solutionNode = (s) => {
    const count = s.projects.length;
    return { id: id('sln', s.path), label: `Solution '${s.name}' (${count} project${count === 1 ? '' : 's'})`, hasChildren: true, open: { path: s.path } };
  };

  const projectNode = (path, name = basename(path, extname(path))) => ({ id: id('proj', path), label: name, hasChildren: true, open: { path } });

  async function fileNode(projectPath, projectKey, path, nestedChildren) {
    const isCode = path.endsWith('.cs') || path.endsWith('.csx');
    let hasChildren = nestedChildren > 0;
    if (!hasChildren && isCode) hasChildren = Boolean((await fileOutline(projectPath, path))?.types.length);
    return { id: id('file', projectKey, path), label: basename(path), hasChildren, open: { path } };
  }

  async function folderChildren(projectPath, proj, dir) {
    const childrenOf = new Map();
    for (const [child, parent] of proj.nesting) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(child);
    }
    const folders = new Set();
    const files = [];
    for (const file of proj.files) {
      const rel = relative(dir, file);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      const parts = rel.split(sep);
      if (parts.length > 1) folders.add(parts[0]);
      else if (!proj.nesting.has(file)) files.push(file);
    }
    const pinned = (name) => {
      const i = PINNED_FOLDERS.indexOf(name);
      return i === -1 ? PINNED_FOLDERS.length : i;
    };
    const folderNodes = [...folders]
      .sort((a, b) => pinned(a) - pinned(b) || byName(a, b))
      .map((name) => ({ id: id('dir', proj.path, join(dir, name)), label: name, hasChildren: true }));
    const fileNodes = await Promise.all(
      files.sort((a, b) => byName(basename(a), basename(b))).map((f) => fileNode(projectPath, proj.path, f, childrenOf.get(f)?.length ?? 0)),
    );
    return [...folderNodes, ...fileNodes];
  }

  function typeNode(projectKey, path, info, index) {
    const t = info.types[index];
    const line = positionAt(info.text, t.offset).line + 1;
    const hasChildren = t.members.length > 0 || info.types.some((x) => x.container === index);
    return { id: id('type', projectKey, path, index), label: t.name, hasChildren, open: { path, line } };
  }

  function memberLabel(m) {
    const params = m.params ? `(${m.params.slice(1, -1).split(/,\s*/).filter(Boolean).map((p) => p.replace(/\s+\S+$/, '')).join(', ')})` : '';
    if (m.kind === 'enumMember') return m.name;
    if (m.kind === 'constructor') return `${m.name}${params}`;
    if (m.kind === 'method') return `${m.name}${params} : ${m.type}`;
    return m.type ? `${m.name} : ${m.type}` : m.name;
  }

  // ---- getChildren ----

  async function rootChildren(projectPath) {
    const { solutions, projects } = await model(projectPath);
    if (solutions.length) return solutions.map(solutionNode);
    if (projects.length) return projects.map((p) => projectNode(p));
    const loose = await looseFolder(projectPath);
    return folderChildren(projectPath, loose, projectPath);
  }

  async function solutionChildren(projectPath, slnPath, folderKey) {
    const { solutions } = await model(projectPath);
    const s = solutions.find((x) => x.path === slnPath);
    if (!s) return [];
    const folders = [...s.folders]
      .filter(([, f]) => f.parent === folderKey)
      .sort(([, a], [, b]) => byName(a.name, b.name))
      .map(([key, f]) => ({
        id: id('slnf', slnPath, key),
        label: f.name,
        hasChildren: f.files.length > 0 || s.projects.some((p) => p.parent === key) || [...s.folders.values()].some((x) => x.parent === key),
      }));
    const projects = s.projects
      .filter((p) => p.parent === folderKey)
      .sort((a, b) => byName(a.name, b.name))
      .map((p) => projectNode(p.path, p.name));
    const items = folderKey === null ? s.rootFiles : s.folders.get(folderKey)?.files ?? [];
    const files = items.map((f) => ({ id: id('sfile', slnPath, folderKey, f), label: basename(f), hasChildren: false, open: { path: f } }));
    return [...folders, ...projects, ...files];
  }

  async function projectChildren(projectPath, path) {
    const proj = await project(projectPath, path);
    const hasDeps = proj.sdk || proj.packages.length || proj.projectRefs.length;
    const deps = hasDeps ? [{ id: id('deps', path), label: 'Dependencies', hasChildren: true }] : [];
    return [...deps, ...(await folderChildren(projectPath, proj, proj.dir))];
  }

  async function dependencyChildren(projectPath, path, group) {
    const proj = await project(projectPath, path);
    const frameworks = proj.sdk ? ['Microsoft.NETCore.App', ...proj.frameworkRefs] : proj.frameworkRefs;
    if (!group) {
      const groups = [];
      if (frameworks.length) groups.push({ id: id('depgroup', path, 'frameworks'), label: 'Frameworks', hasChildren: true });
      if (proj.packages.length) groups.push({ id: id('depgroup', path, 'packages'), label: 'Packages', hasChildren: true });
      if (proj.projectRefs.length) groups.push({ id: id('depgroup', path, 'projects'), label: 'Projects', hasChildren: true });
      return groups;
    }
    if (group === 'frameworks') {
      const tfm = proj.frameworks.length ? ` (${proj.frameworks.join(', ')})` : '';
      return [...new Set(frameworks)].map((f) => ({ id: id('dep', path, 'fw', f), label: `${f}${tfm}`, hasChildren: false }));
    }
    if (group === 'packages') {
      return proj.packages
        .sort((a, b) => byName(a.name, b.name))
        .map((p) => ({ id: id('dep', path, 'pkg', p.name), label: p.version ? `${p.name} (${p.version})` : p.name, hasChildren: false, open: { path } }));
    }
    return proj.projectRefs.map((ref) => ({ id: id('dep', path, 'proj', ref), label: basename(ref, extname(ref)), hasChildren: false, open: { path: ref } }));
  }

  async function fileChildren(projectPath, projectKey, path) {
    const proj = await projectFor(projectPath, projectKey);
    const nested = [...proj.nesting].filter(([, parent]) => parent === path).map(([child]) => child);
    const childrenOf = new Map();
    for (const [child, parent] of proj.nesting) childrenOf.set(parent, (childrenOf.get(parent) ?? 0) + 1);
    const fileNodes = await Promise.all(nested.sort((a, b) => byName(basename(a), basename(b))).map((f) => fileNode(projectPath, projectKey, f, childrenOf.get(f) ?? 0)));
    const info = path.endsWith('.cs') || path.endsWith('.csx') ? await fileOutline(projectPath, path) : null;
    const typeNodes = info ? info.types.map((t, i) => [t, i]).filter(([t]) => t.container === -1).map(([, i]) => typeNode(projectKey, path, info, i)) : [];
    return [...fileNodes, ...typeNodes];
  }

  async function typeChildren(projectPath, projectKey, path, index) {
    const info = await fileOutline(projectPath, path);
    const t = info?.types[index];
    if (!t) return [];
    // Nested types and members in declaration order, like Visual Studio's class view under a file.
    const entries = [
      ...info.types.map((x, i) => [x, i]).filter(([x]) => x.container === index).map(([x, i]) => ({ offset: x.offset, node: typeNode(projectKey, path, info, i) })),
      ...t.members.map((m, j) => ({
        offset: m.offset,
        node: { id: id('member', projectKey, path, index, j), label: memberLabel(m), hasChildren: false, open: { path, line: positionAt(info.text, m.offset).line + 1 } },
      })),
    ];
    return entries.sort((a, b) => a.offset - b.offset).map((e) => e.node);
  }

  saturn.panels.registerTree(PANEL_ID, {
    async getChildren(parentId, { projectPath }) {
      if (parentId === null) return rootChildren(projectPath);
      const [kind, ...rest] = JSON.parse(parentId);
      switch (kind) {
        case 'sln':
          return solutionChildren(projectPath, rest[0], null);
        case 'slnf':
          return solutionChildren(projectPath, rest[0], rest[1]);
        case 'proj':
          return projectChildren(projectPath, rest[0]);
        case 'deps':
          return dependencyChildren(projectPath, rest[0], null);
        case 'depgroup':
          return dependencyChildren(projectPath, rest[0], rest[1]);
        case 'dir':
          return folderChildren(projectPath, await projectFor(projectPath, rest[0]), rest[1]);
        case 'file':
          return fileChildren(projectPath, rest[0], rest[1]);
        case 'type':
          return typeChildren(projectPath, rest[0], rest[1], rest[2]);
        default:
          return [];
      }
    },
  });

  saturn.commands.register('csharp.refreshSolutionExplorer', async () => {
    for (const ws of workspaces.values()) {
      ws.model = null;
      ws.projects.clear();
      ws.outlines.clear();
    }
    saturn.panels.refresh(PANEL_ID);
  });
}

/**
 * Solution, project and file-nesting model for the Solution Explorer: reads .sln/.slnx solutions and
 * .csproj projects the way Visual Studio presents them.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';

const SOLUTION_FOLDER_GUID = '2150E333-8FDC-42A3-9474-1A3956D46DE8';
const SKIP_DIRS = new Set(['bin', 'obj', '.git', '.vs', '.vscode', '.idea', 'node_modules', 'TestResults', 'packages']);
const SKIP_FILES = /\.(user|suo)$|^\.DS_Store$/;
const PROJECT_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj', '.esproj', '.sqlproj', '.shproj', '.proj']);
const FILE_LIMIT = 5000;

/** Paths in solution and project files use backslashes on every platform. */
const fromMsBuild = (base, path) => normalize(join(base, path.replace(/\\/g, '/')));

export const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

// ---- Discovery ----

/** Solutions and projects in the workspace, shallowest first. */
export async function discover(projectPath) {
  const solutions = [];
  const projects = [];
  const walk = async (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) subdirs.push(full);
      } else if (e.name.endsWith('.sln') || e.name.endsWith('.slnx')) solutions.push(full);
      else if (PROJECT_EXTENSIONS.has(extname(e.name))) projects.push(full);
    }
    for (const d of subdirs) await walk(d, depth + 1);
  };
  await walk(projectPath, 0);
  const depth = (p) => relative(projectPath, p).split(sep).length;
  const order = (a, b) => depth(a) - depth(b) || byName(a, b);
  return { solutions: solutions.sort(order), projects: projects.sort(order) };
}

// ---- Solutions ----

/**
 * @returns {Promise<{ path, name, folders: Map<string, { name, parent: string | null, files: string[] }>,
 *   projects: Array<{ name, path, parent: string | null }>, rootFiles: string[] }>}
 * Folder keys are stable ids within the solution; parent is a folder key or null for the root.
 */
export async function readSolution(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  const base = dirname(path);
  const solution = { path, name: basename(path).replace(/\.slnx?$/, ''), folders: new Map(), projects: [], rootFiles: [] };
  if (path.endsWith('.slnx')) readSlnx(text, base, solution);
  else readSln(text, base, solution);
  return solution;
}

function readSln(text, base, solution) {
  const entries = new Map(); // guid → entry
  const projectRe = /^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]*)",\s*"([^"]*)",\s*"\{([^}]+)\}"([\s\S]*?)^EndProject/gm;
  for (const m of text.matchAll(projectRe)) {
    const [, typeGuid, name, relPath, guid, body] = m;
    const id = guid.toUpperCase();
    if (typeGuid.toUpperCase() === SOLUTION_FOLDER_GUID) {
      const files = [];
      const items = /ProjectSection\(SolutionItems\)[\s\S]*?EndProjectSection/.exec(body)?.[0] ?? '';
      for (const line of items.matchAll(/^\s*([^=\r\n]+?)\s*=\s*[^\r\n]+$/gm)) {
        if (!/ProjectSection|EndProjectSection/.test(line[1])) files.push(fromMsBuild(base, line[1]));
      }
      entries.set(id, { folder: true, key: id, name, files });
    } else {
      entries.set(id, { folder: false, name, path: fromMsBuild(base, relPath) });
    }
  }
  const parents = new Map();
  const nested = /GlobalSection\(NestedProjects\)[\s\S]*?EndGlobalSection/.exec(text)?.[0] ?? '';
  for (const m of nested.matchAll(/\{([^}]+)\}\s*=\s*\{([^}]+)\}/g)) parents.set(m[1].toUpperCase(), m[2].toUpperCase());

  for (const [id, e] of entries) {
    const parent = entries.get(parents.get(id))?.folder ? parents.get(id) : null;
    if (e.folder) solution.folders.set(e.key, { name: e.name, parent, files: e.files });
    else solution.projects.push({ name: e.name, path: e.path, parent });
  }
}

function readSlnx(text, base, solution) {
  // <Folder Name="/src/tools/"> … <Project Path="…" /> <File Path="…" /> … </Folder>
  const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  let folder = null;
  for (const m of text.matchAll(/<(\/?)(Folder|Project|File)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs] = m;
    if (tag === 'Folder') {
      if (closing) {
        folder = null;
        continue;
      }
      const name = attr(attrs, 'Name') ?? '';
      const parts = name.split('/').filter(Boolean);
      // Create every level so "/src/tools/" nests under "/src/".
      for (let i = 0; i < parts.length; i++) {
        const key = `/${parts.slice(0, i + 1).join('/')}/`;
        if (!solution.folders.has(key)) {
          solution.folders.set(key, { name: parts[i], parent: i ? `/${parts.slice(0, i).join('/')}/` : null, files: [] });
        }
      }
      folder = parts.length ? `/${parts.join('/')}/` : null;
      if (m[4]) folder = null; // self-closing <Folder />
    } else if (tag === 'Project' && !closing) {
      const rel = attr(attrs, 'Path');
      if (!rel) continue;
      const path = fromMsBuild(base, rel);
      solution.projects.push({ name: basename(path, extname(path)), path, parent: folder });
    } else if (tag === 'File' && !closing) {
      const rel = attr(attrs, 'Path');
      if (!rel) continue;
      if (folder) solution.folders.get(folder).files.push(fromMsBuild(base, rel));
      else solution.rootFiles.push(fromMsBuild(base, rel));
    }
  }
}

// ---- Projects ----

/**
 * @returns {Promise<{ path, name, dir, sdk: boolean, frameworks: string[], packages: Array<{ name, version }>,
 *   projectRefs: string[], frameworkRefs: string[], dependentUpon: Map<string, string>, files: string[] }>}
 * `files` are absolute paths shown under the project; `dependentUpon` maps a file to the file it nests under.
 */
export async function readProject(path) {
  const xml = await readFile(path, 'utf8').catch(() => '');
  const dir = dirname(path);
  const sdk = /<Project\b[^>]*\bSdk\s*=/.test(xml) || /<Sdk\b/.test(xml) || /<Import\b[^>]*\bSdk\s*=/.test(xml);
  const tag = (name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];
  const items = (kind) =>
    [...xml.matchAll(new RegExp(`<${kind}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${kind}>)`, 'g'))].map((m) => ({
      include: /\bInclude="([^"]*)"/.exec(m[1])?.[1],
      update: /\bUpdate="([^"]*)"/.exec(m[1])?.[1],
      remove: /\bRemove="([^"]*)"/.exec(m[1])?.[1],
      attrs: m[1],
      body: m[2] ?? '',
    }));
  const meta = (item, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(item.attrs)?.[1] ?? new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(item.body)?.[1];

  const packages = items('PackageReference')
    .filter((i) => i.include)
    .map((i) => ({ name: i.include, version: meta(i, 'Version') ?? meta(i, 'VersionOverride') ?? '' }));
  const projectRefs = items('ProjectReference').filter((i) => i.include).map((i) => fromMsBuild(dir, i.include));
  const frameworkRefs = items('FrameworkReference').filter((i) => i.include).map((i) => i.include);

  const dependentUpon = new Map();
  const itemKinds = ['Compile', 'Content', 'None', 'EmbeddedResource', 'Page', 'AvaloniaResource', 'ApplicationDefinition', 'Resource'];
  const explicit = [];
  const removed = [];
  for (const kind of itemKinds) {
    for (const item of items(kind)) {
      const target = item.include ?? item.update;
      if (item.remove && !/[*?]/.test(item.remove)) removed.push(fromMsBuild(dir, item.remove));
      if (!target || /[*?$]/.test(target)) continue;
      const file = fromMsBuild(dir, target);
      if (item.include && !item.remove) explicit.push(file);
      const parent = meta(item, 'DependentUpon');
      if (parent) dependentUpon.set(file, fromMsBuild(dirname(file), parent));
    }
  }

  // SDK-style projects include everything under the project folder; legacy ones list their items.
  let files;
  if (sdk) {
    files = await listFiles(dir, path);
    const extra = explicit.filter((f) => !f.startsWith(dir + sep));
    files.push(...extra);
  } else {
    files = explicit;
  }
  const removedSet = new Set(removed);
  files = [...new Set(files)].filter((f) => !removedSet.has(f));

  return {
    path,
    name: basename(path, extname(path)),
    dir,
    sdk,
    frameworks: (tag('TargetFramework') ?? tag('TargetFrameworks') ?? '').split(';').map((s) => s.trim()).filter(Boolean),
    packages,
    projectRefs,
    frameworkRefs,
    dependentUpon,
    files,
  };
}

/**
 * Files under a folder, skipping build output and (unless `stopAtProjects` is false) subfolders that hold
 * another project.
 */
export async function listFiles(dir, projectFile, { stopAtProjects = true } = {}) {
  const files = [];
  const walk = async (d, isRoot) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (stopAtProjects && !isRoot && entries.some((e) => e.isFile() && PROJECT_EXTENSIONS.has(extname(e.name)))) return;
    for (const e of entries) {
      if (files.length >= FILE_LIMIT) return;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(full, false);
      } else if (full !== projectFile && !SKIP_FILES.test(e.name) && !e.name.endsWith('.sln') && !e.name.endsWith('.slnx')) {
        files.push(full);
      }
    }
  };
  await walk(dir, true);
  return files;
}

// ---- File nesting ----

/**
 * Which file each file nests under, following explicit DependentUpon first and then Visual Studio's
 * default nesting rules (Form1.Designer.cs → Form1.cs, Index.razor.cs → Index.razor,
 * appsettings.Development.json → appsettings.json, site.min.css → site.css, …).
 * @param {string[]} files absolute paths
 * @param {Map<string, string>} dependentUpon explicit file → parent map
 * @returns {Map<string, string>} child → parent, only for parents that exist in `files`
 */
export function nestFiles(files, dependentUpon = new Map()) {
  const present = new Set(files);
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const find = (p) => (present.has(p) ? p : lower.get(p.toLowerCase()));
  const parents = new Map();

  for (const file of files) {
    const dir = dirname(file);
    const name = basename(file);
    let parent = dependentUpon.has(file) ? find(dependentUpon.get(file)) : undefined;
    if (!parent) {
      for (const candidate of nestingCandidates(name)) {
        const hit = find(join(dir, candidate));
        if (hit && hit !== file) {
          parent = hit;
          break;
        }
      }
    }
    if (parent && parent !== file) parents.set(file, parent);
  }

  // Break cycles (a ↔ b) by dropping the later link.
  for (const [child] of parents) {
    const seen = new Set([child]);
    for (let p = parents.get(child); p; p = parents.get(p)) {
      if (seen.has(p)) {
        parents.delete(child);
        break;
      }
      seen.add(p);
    }
  }
  return parents;
}

function nestingCandidates(name) {
  const out = [];
  let m;
  // Generated and designer code: Form1.Designer.cs, Resources.Designer.cs, MainWindow.g.cs, MainWindow.g.i.cs
  if ((m = /^(.+)\.(?:designer|g|g\.i)\.cs$/i.exec(name))) out.push(`${m[1]}.cs`, `${m[1]}.resx`, `${m[1]}.settings`, `${m[1]}.xaml`, `${m[1]}.axaml`);
  // Code-behind and scoped assets: Index.razor.cs, Index.razor.css, Index.cshtml.cs, MainWindow.xaml.cs
  if ((m = /^(.+\.(?:razor|cshtml|xaml|axaml|aspx|ascx|master|asax|ashx|asmx))\.(?:cs|css|js|less|scss)$/i.exec(name))) out.push(m[1]);
  // WinForms resources: Form1.resx under Form1.cs
  if ((m = /^(.+)\.resx$/i.exec(name)) && !/\.[a-z]{2}(-[A-Za-z]+)?$/.test(m[1])) out.push(`${m[1]}.cs`);
  // Localised resources: Strings.fr.resx under Strings.resx
  if ((m = /^(.+)\.[a-z]{2}(?:-[A-Za-z]+)?\.resx$/.exec(name))) out.push(`${m[1]}.resx`);
  // appsettings.Development.json under appsettings.json
  if ((m = /^(appsettings|bundleconfig|launchSettings)\.[^.]+\.json$/i.exec(name))) out.push(`${m[1]}.json`);
  // Minified files and source maps: site.min.css under site.css, site.js.map under site.js
  if ((m = /^(.+)\.min\.(js|css)$/i.exec(name))) out.push(`${m[1]}.${m[2]}`);
  if ((m = /^(.+\.(?:js|css))\.map$/i.exec(name))) out.push(m[1]);
  // Web.Debug.config under Web.config
  if ((m = /^(.+)\.[^.]+\.config$/i.exec(name))) out.push(`${m[1]}.config`);
  return out;
}

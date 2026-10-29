/**
 * Tests panel support: finds xUnit, NUnit and MSTest tests by reading the .cs sources of test projects, and
 * runs them with `dotnet test`, reading results from the TRX log and coverage from coverlet's Cobertura report.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { buildTarget, dotnetCommand, dotnetEnv, isTestProject } from './dotnet.js';
import { discover as discoverWorkspace } from './solution.js';

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', 'TestResults']);
const TEST_ATTRIBUTE = /^(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)(?:Attribute)?$/;

async function csFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await csFiles(full, out);
    } else if (e.name.endsWith('.cs')) out.push(full);
  }
  return out;
}

/** Blanks comments and string/char literals, keeping line breaks so offsets still map to lines. */
function stripNoise(src) {
  return src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|@"(?:[^"]|"")*"|"""[\s\S]*?"""|\$?"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
}

/**
 * Test methods in one C# source: [{ namespace, className, method, line }]. Tracks namespaces and classes by
 * brace depth; a method is a test when one of the attribute lists just before it names a test attribute.
 */
export function parseTests(source) {
  const src = stripNoise(source);
  const tests = [];
  const scopes = []; // { kind: 'namespace' | 'class' | 'other', name, depth }
  let fileNamespace = null;
  let depth = 0;
  let pendingScope = null;
  let attributes = [];
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  const token = /\[([^\[\]]*(?:\[[^\]]*\][^\[\]]*)*)\]|\bnamespace\s+([\w.]+)\s*(;)?|\b(?:class|record|struct)\s+(\w+)|\b(\w+)\s*(?:<[^<>()]*>)?\s*\(|[{};]/g;
  for (let m; (m = token.exec(src)); ) {
    const [text, attrList, ns, fileScoped, cls, method] = m;
    if (attrList !== undefined) {
      // Skip indexers and array types: an attribute list starts a statement, so the previous token was ; { } or ].
      const before = src.slice(0, m.index).trimEnd().slice(-1);
      if (!before || /[;{}\]]/.test(before)) attributes.push(...attrList.split(',').map((a) => a.trim().replace(/^\w+:\s*/, '').split(/[\s(]/)[0].split('.').pop()));
    } else if (ns) {
      if (fileScoped) fileNamespace = ns;
      else pendingScope = { kind: 'namespace', name: ns };
      attributes = [];
    } else if (cls) {
      pendingScope = { kind: 'class', name: cls };
      attributes = [];
    } else if (method) {
      const inClass = scopes.at(-1)?.kind === 'class' && scopes.at(-1).depth === depth;
      if (inClass && !pendingScope && attributes.some((a) => TEST_ATTRIBUTE.test(a))) {
        const namespace = [fileNamespace, ...scopes.filter((s) => s.kind === 'namespace').map((s) => s.name)].filter(Boolean).join('.');
        const classes = scopes.filter((s) => s.kind === 'class').map((s) => s.name);
        tests.push({ namespace, className: classes.join('+'), method, line: lineAt(m.index + text.indexOf(method)) });
      }
      attributes = [];
      if (!pendingScope) pendingScope = { kind: 'other' };
    } else if (text === '{') {
      scopes.push({ ...(pendingScope ?? { kind: 'other' }), depth: ++depth });
      pendingScope = null;
      attributes = [];
    } else if (text === '}') {
      if (scopes.at(-1)?.depth === depth) scopes.pop();
      depth = Math.max(0, depth - 1);
      attributes = [];
    } else if (text === ';') {
      // `record Point(int X, int Y);` and expression-bodied members end without a body.
      pendingScope = null;
      attributes = [];
    }
  }
  return tests;
}

/** The fully qualified name `dotnet test` filters on: Namespace.Class.Method (nested classes joined with +). */
const fullName = (t) => [t.namespace, t.className, t.method].filter(Boolean).join('.');

/** Test project → namespace → class → method. Leaf ids are fully qualified names. */
export async function discoverTests(projectPath) {
  const { projects } = await discoverWorkspace(projectPath);
  const items = [];
  for (const proj of projects.filter((p) => p.endsWith('.csproj'))) {
    const xml = await readFile(proj, 'utf8').catch(() => '');
    if (!isTestProject(xml)) continue;
    const namespaces = new Map();
    for (const file of (await csFiles(dirname(proj))).sort()) {
      const source = await readFile(file, 'utf8').catch(() => '');
      for (const t of parseTests(source)) {
        const nsKey = t.namespace || '(global)';
        if (!namespaces.has(nsKey)) namespaces.set(nsKey, new Map());
        const classes = namespaces.get(nsKey);
        const clsId = `${proj}|${[t.namespace, t.className].filter(Boolean).join('.')}`;
        if (!classes.has(clsId)) classes.set(clsId, { id: clsId, label: t.className, path: file, children: [] });
        const id = fullName(t);
        const cls = classes.get(clsId);
        if (!cls.children.some((c) => c.id === id)) cls.children.push({ id, label: t.method, path: file, line: t.line });
      }
    }
    if (!namespaces.size) continue;
    items.push({
      id: proj,
      label: basename(proj, '.csproj'),
      path: proj,
      children: [...namespaces].map(([ns, classes]) => ({ id: `${proj}|ns:${ns}`, label: ns, children: [...classes.values()] })),
    });
  }
  return items;
}

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const attr = (tag, name) => {
  const v = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];
  return v === undefined ? undefined : decode(v);
};
const element = (xml, name) => {
  const v = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
  return v === undefined ? undefined : decode(v).trim();
};

/** hh:mm:ss.fffffff → milliseconds. */
const durationMs = (d) => {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d ?? '');
  return m ? Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) : undefined;
};

/**
 * Results from a TRX log: [{ id, case, outcome, durationMs, message }]. `id` is the fully qualified method
 * name; `case` is the display name, which differs for each data row of a theory.
 */
export function parseTrx(xml) {
  const methods = new Map(); // test id → fully qualified method name
  for (const m of xml.matchAll(/<UnitTest\s[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<TestMethod\s([^>]*)>/g)) {
    const className = attr(m[2], 'className')?.split(',')[0].trim();
    const name = attr(m[2], 'name')?.replace(/\(.*$/s, '');
    if (className && name) methods.set(m[1], `${className}.${name}`);
  }
  const results = [];
  for (const m of xml.matchAll(/<UnitTestResult\s([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const [, tag, body = ''] = m;
    const caseName = attr(tag, 'testName') ?? '';
    const id = methods.get(attr(tag, 'testId')) ?? caseName.replace(/\(.*$/s, '');
    const outcome = attr(tag, 'outcome');
    const message = [element(body, 'Message'), element(body, 'StackTrace')].filter(Boolean).join('\n');
    results.push({ id, case: caseName, outcome, durationMs: durationMs(attr(tag, 'duration')), message });
  }
  return results;
}

const STATE = { Passed: 'passed', Failed: 'failed', Error: 'failed', Timeout: 'failed', Aborted: 'failed', NotExecuted: 'skipped', Inconclusive: 'skipped' };

/** Folds a theory's rows into one result per method: failed if any row failed, durations summed. */
function combine(rows) {
  const states = rows.map((r) => STATE[r.outcome] ?? 'failed');
  const state = states.includes('failed') ? 'failed' : states.includes('passed') ? 'passed' : 'skipped';
  const durationMs = rows.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const shown = rows.filter((r) => r.message && (state !== 'failed' || STATE[r.outcome] === 'failed'));
  const message = shown.map((r) => (rows.length > 1 ? `${r.case}\n${r.message}` : r.message)).join('\n\n') || undefined;
  return { state, durationMs, message };
}

/**
 * `dotnet test` filter for these ids. Exact matches still cover every data row of a theory or TestCase, and
 * nested classes (Outer+Inner), since VSTest compares against the method's name without arguments.
 */
export const filterFor = (ids) => ids.map((id) => `FullyQualifiedName=${id.replace(/[\\(),|&=!~]/g, (c) => `\\${c}`)}`).join('|');

async function filesNamed(dir, suffix) {
  const entries = await readdir(dir, { recursive: true }).catch(() => []);
  return entries.filter((f) => f.endsWith(suffix)).map((f) => join(dir, f));
}

/**
 * Line coverage from a Cobertura report: [{ path, covered, uncovered }]. Class filenames are relative to one
 * of the report's <source> folders, or to `projectDir` when none of those has the file.
 */
export function parseCobertura(xml, projectDir) {
  const sources = [...xml.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => decode(m[1]).trim());
  const files = new Map(); // path → Map(line → hits)
  for (const m of xml.matchAll(/<class\s([^>]*)>([\s\S]*?)<\/class>/g)) {
    const name = attr(m[1], 'filename');
    if (!name) continue;
    const path = isAbsolute(name) ? name : ([...sources, projectDir].map((dir) => join(dir, name)).find((f) => existsSync(f)) ?? join(projectDir, name));
    if (!files.has(path)) files.set(path, new Map());
    const lines = files.get(path);
    for (const l of m[2].matchAll(/<line\s([^>]*?)\/?>/g)) {
      const line = Number(attr(l[1], 'number'));
      const hits = Number(attr(l[1], 'hits'));
      if (line) lines.set(line, Math.max(lines.get(line) ?? 0, hits || 0));
    }
  }
  return [...files].map(([path, lines]) => ({
    path,
    covered: [...lines].filter(([, h]) => h > 0).map(([n]) => n).sort((a, b) => a - b),
    uncovered: [...lines].filter(([, h]) => h === 0).map(([n]) => n).sort((a, b) => a - b),
  }));
}

/** Stops a process and everything it started (dotnet test runs testhost and MSBuild nodes as children). */
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/** Runs dotnet in its own process group, so killTree can reach its children. */
function spawnDotnet(args, cwd, env) {
  return spawn(dotnetCommand(), args, { cwd, env: dotnetEnv(env), detached: process.platform !== 'win32' });
}

const running = new Set(); // `dotnet test` processes, stopped on deactivate

export async function runTests({ projectPath, ids, report, output, signal, coverage, reportCoverage }) {
  const target = await buildTarget(projectPath);
  if (!target) throw new Error('No solution or project to test.');
  if (ids && !ids.length) return;
  const tree = await discoverTests(projectPath);
  const known = ids ?? tree.flatMap(function leaves(i) {
    return i.children ? i.children.flatMap(leaves) : [i.id];
  });
  for (const id of known) report({ id, state: 'running' });

  const results = await mkdtemp(join(tmpdir(), 'saturn-dotnet-test-'));
  try {
    const args = ['test', target, '--logger', 'trx', '--results-directory', results];
    if (ids) args.push('--filter', filterFor(ids));
    if (coverage) args.push('--collect', 'XPlat Code Coverage');
    output(`> dotnet ${args.map((a) => (/[\s|]/.test(a) ? `"${a}"` : a)).join(' ')}\n`);
    const code = await new Promise((resolve, reject) => {
      if (signal?.aborted) return resolve(null);
      const child = spawnDotnet(args, dirname(target));
      running.add(child);
      const stop = () => killTree(child);
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (d) => output(d.toString()));
      child.stderr.on('data', (d) => output(d.toString()));
      child.on('error', (e) =>
        reject(e.code === 'ENOENT' ? new Error('The .NET SDK was not found. Install it from https://dotnet.microsoft.com/download, or set the .NET CLI in the C# settings.') : e),
      );
      child.on('close', (c) => {
        running.delete(child);
        signal?.removeEventListener('abort', stop);
        resolve(c);
      });
    });
    // Saturn marks unfinished tests as stopped and ignores reports after an abort.
    if (signal?.aborted) return;

    const byId = new Map();
    for (const file of await filesNamed(results, '.trx')) {
      for (const r of parseTrx(await readFile(file, 'utf8'))) {
        if (!byId.has(r.id)) byId.set(r.id, []);
        byId.get(r.id).push(r);
      }
    }
    const wanted = new Set(known);
    for (const [id, rows] of byId) if (wanted.has(id) || !ids) report({ id, ...combine(rows) });
    // Tests that never reported: the build failed, or discovery found a test dotnet didn't.
    const why = code === 0 ? 'Not run: dotnet test did not report this test.' : `Not run: dotnet test exited with code ${code}. See the output.`;
    for (const id of known) if (!byId.has(id)) report({ id, state: 'skipped', message: why });

    if (coverage) {
      const reports = await filesNamed(results, 'coverage.cobertura.xml');
      if (!reports.length) output('\nNo coverage report was written. Add the coverlet.collector package to the test projects to collect coverage.\n');
      for (const file of reports) reportCoverage?.(parseCobertura(await readFile(file, 'utf8'), dirname(target)));
    }
  } finally {
    await rm(results, { recursive: true, force: true });
  }
}

/** The test project (.csproj) that holds each id, from discovery. */
function projectsFor(tree, ids) {
  const owner = new Map();
  for (const proj of tree) {
    (function walk(i) {
      if (i.children) i.children.forEach(walk);
      else owner.set(i.id, proj.id);
    })(proj);
  }
  return new Set(ids.map((id) => owner.get(id)).filter(Boolean));
}

/**
 * Launch arguments for debugging tests. server/debug.js runs `dotnet test` with VSTEST_HOST_DEBUG=1 and
 * attaches netcoredbg to the testhost it reports, so Saturn's .NET debugger handles the session.
 */
export async function debugTests({ projectPath, ids }) {
  const tree = await discoverTests(projectPath);
  const projects = ids ? projectsFor(tree, ids) : new Set(tree.map((p) => p.id));
  if (projects.size !== 1) {
    throw new Error(projects.size ? 'Debug tests from one test project at a time.' : 'No test project found for these tests.');
  }
  const [project] = projects;
  const leaf = ids?.length === 1 ? ids[0].split('.').slice(-2).join('.') : null;
  return {
    languageId: 'csharp',
    name: `Tests: ${leaf ?? basename(project, '.csproj')}`,
    launch: {
      type: 'coreclr',
      request: 'launch',
      cwd: '${project}',
      testProject: project,
      ...(ids ? { testFilter: filterFor(ids) } : {}),
      justMyCode: true,
    },
  };
}

export function stopTests() {
  for (const child of running) killTree(child);
  running.clear();
}

export function registerTests(saturn) {
  saturn.tests?.registerController('csharp.dotnet', {
    label: '.NET',
    supportsCoverage: true,
    discover: ({ projectPath }) => discoverTests(projectPath),
    run: runTests,
    debug: debugTests,
  });
}

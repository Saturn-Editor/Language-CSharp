/**
 * A minimal C# language server over stdio (JSON-RPC with Content-Length framing).
 * Supports full-text sync and textDocument/completion:
 *   - keywords, built-in types, locals, parameters and members of the enclosing type
 *   - types and namespaces declared anywhere in the project, plus common .NET types
 *   - members after "." for project types, common .NET types and namespaces
 *   - namespaces after "using", attributes inside "[...]", preprocessor directives after "#"
 *   - a few plain-text snippets (ctor, prop, cw, svm, fore, fori, tryc)
 */
import { readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYWORDS, PRIMITIVE_TYPES, baseTypeName, enclosingType, inNonCode, localsAt, outline, tokenize } from '../lib/csharp.js';
import { ATTRIBUTES, BCL_TYPES, COMMON_TYPES, ENUMERABLE, NAMESPACES, OBJECT, bclType, parseMember } from '../lib/bcl.js';

const { version } = JSON.parse(readFileSync(new URL('../saturn-module.json', import.meta.url), 'utf8'));

const Kind = {
  Method: 2, Constructor: 4, Field: 5, Variable: 6, Class: 7, Interface: 8, Module: 9, Property: 10, Enum: 13,
  Keyword: 14, Snippet: 15, EnumMember: 20, Constant: 21, Struct: 22, Event: 23,
};

const documents = new Map();
let root = process.cwd();

// ---- Transport ----

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    const start = headerEnd + 4;
    if (!Number.isFinite(length)) {
      buffer = buffer.subarray(start);
      continue;
    }
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    try {
      void dispatch(JSON.parse(body));
    } catch (e) {
      log(`bad message: ${e}`);
    }
  }
});

function send(message) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

const log = (message) => process.stderr.write(`[csharp-ls] ${message}\n`);

// ---- Dispatch ----

const handlers = {
  initialize(params) {
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    if (folder) root = toPath(folder);
    else if (params.rootPath) root = params.rootPath;
    return {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: ['.', '[', '#', '<'] },
      },
      serverInfo: { name: 'saturn-csharp', version },
    };
  },
  shutdown: () => null,
  'textDocument/completion': (params) => complete(params),
};

const notifications = {
  exit: () => process.exit(0),
  'textDocument/didOpen': ({ textDocument }) => documents.set(textDocument.uri, textDocument.text),
  'textDocument/didChange': ({ textDocument, contentChanges }) => {
    const last = contentChanges[contentChanges.length - 1];
    if (last && !last.range) documents.set(textDocument.uri, last.text);
  },
  'textDocument/didClose': ({ textDocument }) => documents.delete(textDocument.uri),
};

async function dispatch(message) {
  if (message.id === undefined) {
    notifications[message.method]?.(message.params ?? {});
    return;
  }
  const handler = handlers[message.method];
  if (!handler) {
    send({ id: message.id, error: { code: -32601, message: `Unhandled method ${message.method}` } });
    return;
  }
  try {
    send({ id: message.id, result: await handler(message.params ?? {}) });
  } catch (e) {
    send({ id: message.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

// ---- Completion ----

const toPath = (uri) => (uri.startsWith('file:') ? fileURLToPath(uri) : uri);

/** Saturn replaces the text matching this before the cursor, so insertText must cover exactly that. */
const WORD_BEFORE = /[\w#`[\]-]*$/;
const MAX_ITEMS = 400;

async function complete({ textDocument, position }) {
  const uri = textDocument.uri;
  const path = toPath(uri);
  const text = documents.get(uri) ?? readOrEmpty(path);
  const lines = text.split('\n');
  const lineText = (lines[position.line] ?? '').replace(/\r$/, '');
  const before = lineText.slice(0, position.character);
  const offset = lines.slice(0, position.line).reduce((n, l) => n + l.length + 1, 0) + before.length;

  // Saturn replaces `span`; we only complete the identifier at its end, so keep whatever precedes it.
  const span = WORD_BEFORE.exec(before)[0];
  const ident = /@?\w*$/.exec(before)[0];
  const ctx = { kept: span.slice(0, span.length - ident.length), ident, indent: /^[ \t]*/.exec(lineText)[0] };

  const directive = /^\s*#\s*(\w*)$/.exec(before);
  if (directive) return finish(directiveItems(), ctx);

  if (inNonCode(tokenize(text), offset)) return [];

  const project = await projectIndex(path, text);

  const using = /^\s*(?:global\s+)?using\s+(static\s+)?((?:\w+\.)*)\w*$/.exec(before);
  if (using) return finish(namespaceItems(project, using[2], Boolean(using[1])), ctx);

  const namespace = /^\s*namespace\s+((?:\w+\.)*)\w*$/.exec(before);
  if (namespace) return finish(namespaceItems(project, namespace[1], false, true), ctx);

  if (/^\s*\[(?:[^\]]*,\s*)?\w*$/.test(before) || /\(\s*\[\w*$/.test(before)) return finish(attributeItems(project), ctx);

  if (/(?<![\w.])\d[\d_]*\.\w*$/.test(before)) return []; // a number literal like 1.5

  const access = memberAccess(before);
  if (access) return finish(memberItems(access, project, text, offset), ctx);

  if (/\bnew\s+@?\w*$/.test(before)) return finish(typeItems(project, { creatable: true }), ctx);

  return finish(generalItems(project, text, offset), ctx);
}

/** Filters by the typed identifier and turns candidates into LSP items Saturn can insert. */
function finish(candidates, { kept, ident, indent }) {
  const typed = ident.replace(/^@/, '').toLowerCase();
  const seen = new Set();
  const items = [];
  for (const c of candidates) {
    if (!c.label || seen.has(c.label)) continue;
    const label = c.label.toLowerCase();
    if (typed && !label.startsWith(typed) && !label.replace(/^_+/, '').startsWith(typed) && !camelMatch(c.label, typed)) continue;
    seen.add(c.label);
    const insert = (c.insert ?? c.label).replace(/\n/g, `\n${indent}`);
    items.push({
      label: c.label,
      kind: c.kind,
      detail: c.detail,
      sortText: `${c.rank ?? 5}${c.label.toLowerCase()}`,
      insertText: kept + insert,
      insertTextFormat: 1,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** "sb" matches "StringBuilder", "rlt" matches "ReadAllText". */
function camelMatch(label, typed) {
  const humps = label.replace(/[a-z0-9_]+/g, '').toLowerCase();
  return typed.length > 1 && humps.startsWith(typed);
}

// ---- Contexts ----

const DIRECTIVES = ['region', 'endregion', 'if', 'elif', 'else', 'endif', 'define', 'undef', 'nullable enable', 'nullable disable', 'pragma warning disable', 'pragma warning restore', 'warning', 'error', 'line'];

const directiveItems = () => DIRECTIVES.map((d) => ({ label: d, kind: Kind.Keyword, detail: 'Preprocessor directive' }));

function namespaceItems(project, typedPrefix, includeTypes, onlyProject = false) {
  const prefix = typedPrefix;
  const all = new Set(onlyProject ? project.namespaces : [...NAMESPACES, ...project.namespaces]);
  const items = [];
  for (const ns of all) {
    if (!ns.startsWith(prefix) || ns === prefix.replace(/\.$/, '')) continue;
    const segment = ns.slice(prefix.length).split('.')[0];
    items.push({ label: segment, kind: Kind.Module, detail: `namespace ${prefix}${segment}`, rank: 1 });
  }
  if (includeTypes && prefix) {
    const ns = prefix.replace(/\.$/, '');
    for (const t of typesIn(project, ns)) items.push(t);
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

function typesIn(project, ns) {
  const items = [];
  for (const t of project.types) if (t.namespace === ns) items.push(typeItem(t));
  for (const [name, t] of Object.entries(BCL_TYPES)) if (t.namespace === ns) items.push({ label: name, kind: Kind.Class, detail: `${ns}.${name}` });
  return items;
}

function attributeItems(project) {
  const items = ATTRIBUTES.map((a) => ({ label: a, kind: Kind.Class, detail: 'Attribute', rank: 2 }));
  for (const t of project.types) {
    if (t.name.endsWith('Attribute') || t.bases.some((b) => b.endsWith('Attribute'))) {
      items.push({ label: t.name.replace(/Attribute$/, ''), kind: Kind.Class, detail: `${t.namespace ? `${t.namespace}.` : ''}${t.name}`, rank: 1 });
    }
  }
  return items;
}

function typeItem(t) {
  const kind = t.kind === 'interface' ? Kind.Interface : t.kind === 'enum' ? Kind.Enum : t.kind.includes('struct') ? Kind.Struct : Kind.Class;
  return { label: t.name, kind, detail: `${t.kind} ${t.namespace ? `${t.namespace}.` : ''}${t.name}`, rank: 3 };
}

function typeItems(project, { creatable = false } = {}) {
  const items = [];
  for (const t of project.types) {
    if (creatable && (t.kind === 'interface' || t.kind === 'enum')) continue;
    items.push(typeItem(t));
  }
  for (const [name, t] of Object.entries(BCL_TYPES)) {
    if (creatable && !t.instance) continue;
    items.push({ label: name, kind: Kind.Class, detail: `${t.namespace}.${name}`, rank: 4 });
  }
  for (const name of COMMON_TYPES) items.push({ label: name, kind: Kind.Class, detail: 'Type', rank: 4 });
  if (!creatable) for (const p of PRIMITIVE_TYPES) items.push({ label: p, kind: Kind.Keyword, detail: 'Built-in type', rank: 4 });
  return items;
}

const SNIPPETS = [
  { label: 'ctor', detail: 'Constructor', body: (type) => `public ${type ?? 'ClassName'}()\n{\n}` },
  { label: 'prop', detail: 'Auto-property', body: () => 'public int Property { get; set; }' },
  { label: 'cw', detail: 'Console.WriteLine', body: () => 'Console.WriteLine(' },
  { label: 'svm', detail: 'Main method', body: () => 'static void Main(string[] args)\n{\n}' },
  { label: 'fore', detail: 'foreach loop', body: () => 'foreach (var item in collection)\n{\n}' },
  { label: 'fori', detail: 'for loop', body: () => 'for (int i = 0; i < length; i++)\n{\n}' },
  { label: 'tryc', detail: 'try/catch', body: () => 'try\n{\n}\ncatch (Exception ex)\n{\n}' },
];

function generalItems(project, text, offset) {
  const items = [];
  const current = enclosingType(text, offset);
  for (const local of localsAt(text, offset)) {
    items.push({ label: local.name, kind: Kind.Variable, detail: local.type || 'var', rank: 0 });
  }
  if (current) {
    for (const m of instanceAndStaticMembers(project, current)) items.push({ ...m, rank: 1 });
  }
  items.push(...typeItems(project));
  for (const k of KEYWORDS) items.push({ label: k, kind: Kind.Keyword, detail: 'Keyword', rank: 6 });
  for (const s of SNIPPETS) items.push({ label: s.label, kind: Kind.Snippet, detail: s.detail, insert: s.body(current), rank: 7 });
  return items;
}

// ---- Member access ----

/**
 * Parses the receiver chain before a trailing ".ident": "foo.Bar().Baz." → ['foo', 'Bar()', 'Baz'].
 * Generic arguments and simple call/index arguments are tolerated; anything fancier returns null.
 */
function memberAccess(before) {
  const m = /((?:@?\w+(?:<[\w\s,.<>\[\]?]*>)?(?:\((?:[^()]|\([^()]*\))*\))?(?:\[[^\[\]]*\])*!?\??\s*\.\s*)+)@?\w*$/.exec(before);
  if (!m) {
    if (/"\s*\.\s*\w*$/.test(before)) return ['""'];
    return null;
  }
  const preceding = before.slice(0, m.index);
  if (/\d$/.test(preceding) || /^\d/.test(m[1])) return null; // 1.5
  const chain = m[1].split(/\s*\.\s*/).slice(0, -1).map((s) => s.replace(/[!?]$/, ''));
  if (/"\s*$/.test(preceding) && chain[0] === '') return ['""'];
  return chain.length ? chain : null;
}

function memberItems(chain, project, text, offset) {
  const resolved = resolveChain(chain, project, text, offset);
  if (!resolved) {
    // Unknown receiver: offer every instance member we know of in the project, plus object members.
    const items = [];
    for (const t of project.types) for (const m of t.members) if (!m.isStatic && m.kind !== 'constructor') items.push(memberItem(m, t.name));
    for (const e of OBJECT) items.push(memberItem(parseMember(e), 'object'));
    return items;
  }
  if (resolved.namespace !== undefined) return namespaceItems(project, `${resolved.namespace}.`, true);
  return resolved.isStatic ? staticMembers(project, resolved.type) : instanceMembers(project, resolved.type);
}

/**
 * Resolves a receiver chain to { type, isStatic } or { namespace }.
 * The first link may be a local, a member of the enclosing type, this/base, a type or a namespace.
 */
function resolveChain(chain, project, text, offset) {
  const [first, ...rest] = chain.map((s) => s.replace(/^@/, ''));
  const head = first.replace(/[<(\[].*$/s, '');
  let current = null;

  if (first === '""') current = { type: 'string', isStatic: false };
  else if (head === 'this' || head === 'base') {
    const enclosing = enclosingType(text, offset);
    const type = head === 'base' ? findType(project, enclosing)?.bases[0] : enclosing;
    if (type) current = { type, isStatic: false };
  } else {
    const local = localsAt(text, offset).find((l) => l.name === head);
    const enclosing = enclosingType(text, offset);
    const member = enclosing && findMember(project, enclosing, head);
    const implicit = local && !local.type ? implicitType(head, project, text, offset) : '';
    if (local?.type) current = { type: local.type, isStatic: false };
    else if (implicit) current = { type: implicit, isStatic: false };
    else if (member?.type) current = { type: member.type, isStatic: false };
    else if (findType(project, head) || bclType(head)) current = { type: head, isStatic: true };
    else if (!local && !member) {
      // A namespace, possibly continuing into a type: System.IO.File.
      let ns = head;
      let i = 0;
      const known = new Set([...NAMESPACES, ...project.namespaces]);
      const isPrefix = (n) => [...known].some((k) => k === n || k.startsWith(`${n}.`));
      if (!isPrefix(ns)) return null;
      while (i < rest.length && isPrefix(`${ns}.${rest[i]}`)) ns = `${ns}.${rest[i++]}`;
      if (i === rest.length) return { namespace: ns };
      const typeName = rest[i++].replace(/[<(\[].*$/s, '');
      if (!findType(project, typeName) && !bclType(typeName)) return null;
      current = { type: typeName, isStatic: true };
      rest.splice(0, i);
      i = 0;
    }
  }
  if (!current) return null;

  for (const link of rest) {
    const name = link.replace(/[<(\[].*$/s, '');
    const indexed = /\]$/.test(link);
    const member = memberOf(project, current.type, name, current.isStatic);
    if (!member?.type) return null;
    current = { type: indexed ? elementType(member.type) : member.type, isStatic: false };
  }
  if (/\]$/.test(chain[0]) && current) current = { type: elementType(current.type), isStatic: false };
  return current;
}

/**
 * Element type for untyped iteration variables and lambda parameters:
 * "foreach (var x in xs)" and "xs.Where(x => …)" both give x the element type of xs.
 */
function implicitType(name, project, text, offset) {
  const before = text.slice(0, offset);
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chain = String.raw`((?:@?\w+(?:\([^()]*\))?\s*\.\s*)*@?\w+(?:\([^()]*\))?)`;
  const patterns = [
    new RegExp(String.raw`foreach\s*\(\s*var\s+${id}\s+in\s+${chain}\s*\)`, 'g'),
    new RegExp(chain + String.raw`\s*\.\s*\w+\s*\(\s*\(?\s*${id}\s*\)?\s*=>`, 'g'),
  ];
  let best = null;
  for (const re of patterns) for (const m of before.matchAll(re)) if (!best || m.index > best.index) best = m;
  if (!best) return '';
  const links = best[1].split(/\s*\.\s*/);
  if (links[0] === name) return '';
  const source = resolveChain(links, project, text, best.index);
  return source && !source.isStatic ? elementType(source.type) : '';
}

function elementType(type) {
  if (/\[\]\??$/.test(type)) return type.replace(/\[\]\??$/, '');
  const args = /<(.*)>/.exec(type)?.[1].split(',').map((s) => s.trim());
  if (!args) return type === 'string' ? 'char' : '';
  return /^(?:Dictionary|IDictionary|IReadOnlyDictionary|ConcurrentDictionary|SortedDictionary)\b/.test(type) ? args[1] : args[0];
}

function findType(project, name) {
  const bare = baseTypeName(name);
  return project.types.find((t) => t.name === bare) ?? null;
}

function findMember(project, typeName, name) {
  const seen = new Set();
  for (let t = findType(project, typeName); t && !seen.has(t.name); t = findType(project, t.bases[0] ?? '')) {
    seen.add(t.name);
    const m = t.members.find((x) => x.name === name);
    if (m) return m;
  }
  return null;
}

function memberOf(project, typeName, name, isStatic) {
  const own = findMember(project, typeName, name);
  if (own) return own;
  const bcl = bclType(baseTypeName(typeName)) ?? (/\[\]\??$/.test(typeName) ? bclType('Array') : null);
  if (!bcl) return null;
  const pool = isStatic ? bcl.static ?? [] : [...(bcl.instance ?? []), ...(bcl.enumerable ? ENUMERABLE : []), ...OBJECT];
  const entry = pool.map(parseMember).find((m) => m.name === name);
  if (!entry) return null;
  return { ...entry, type: substituteGenerics(entry.type, typeName) };
}

/** Maps T/TKey/TValue in a BCL member's type onto the receiver's type arguments. */
function substituteGenerics(memberType, receiverType) {
  const args = /<(.*)>/.exec(receiverType)?.[1].split(',').map((s) => s.trim()) ?? (/\[\]$/.test(receiverType) ? [receiverType.slice(0, -2)] : []);
  if (!args.length) return memberType;
  const isDictionary = /Dictionary\b/.test(receiverType);
  const map = isDictionary ? { TKey: args[0], TValue: args[1], T: `KeyValuePair<${args[0]}, ${args[1]}>` } : { T: args[0] };
  return memberType.replace(/\b(TKey|TValue|T)\b/g, (t) => map[t] ?? t);
}

function memberItem(m, owner) {
  const kind = {
    method: Kind.Method, property: Kind.Property, field: Kind.Field, constant: Kind.Constant, event: Kind.Event,
    enumMember: Kind.EnumMember, constructor: Kind.Constructor,
  }[m.kind] ?? Kind.Property;
  const detail = m.kind === 'method' ? `${m.type} ${owner}.${m.name}${m.params ?? '()'}` : `${m.type || m.kind} ${owner}.${m.name}`;
  return { label: m.name, kind, detail, rank: m.kind === 'method' ? 2 : 1 };
}

function instanceMembers(project, typeName) {
  const items = [];
  const seen = new Set();
  for (let t = findType(project, typeName); t && !seen.has(t.name); t = findType(project, t.bases[0] ?? '')) {
    seen.add(t.name);
    for (const m of t.members) if (!m.isStatic && m.kind !== 'constructor') items.push(memberItem(m, t.name));
    if (t.kind === 'enum') items.push(memberItem(parseMember('HasFlag(Enum flag): bool'), t.name));
    // Interfaces and BCL bases contribute their members too.
    for (const b of t.bases.slice(1)) {
      const iface = findType(project, b);
      if (iface) for (const m of iface.members) if (!m.isStatic) items.push(memberItem(m, iface.name));
    }
    const bclBase = t.bases.map((b) => bclType(baseTypeName(b))).find(Boolean);
    if (bclBase) items.push(...bclInstance(bclBase, typeName));
  }
  const bare = baseTypeName(typeName);
  const bcl = bclType(bare) ?? (/\[\]\??$/.test(typeName) ? bclType('Array') : null);
  if (bcl && !findType(project, bare)) items.push(...bclInstance(bcl, typeName));
  for (const e of OBJECT) items.push(memberItem(parseMember(e), 'object'));
  return items;
}

function bclInstance(bcl, receiverType) {
  const entries = [...(bcl.instance ?? []), ...(bcl.enumerable || /\[\]\??$/.test(receiverType) ? ENUMERABLE : [])];
  return entries.map(parseMember).map((m) => memberItem({ ...m, type: substituteGenerics(m.type, receiverType) }, bcl.name));
}

function staticMembers(project, typeName) {
  const items = [];
  const t = findType(project, typeName);
  if (t) for (const m of t.members) if (m.isStatic) items.push(memberItem(m, t.name));
  const bcl = !t && bclType(baseTypeName(typeName));
  if (bcl) for (const e of bcl.static ?? []) items.push(memberItem(parseMember(e), bcl.name));
  // Nested types are reachable as Outer.Inner.
  return items;
}

/** Members visible unqualified inside a type body: its own (and base types') members, static or not. */
function instanceAndStaticMembers(project, typeName) {
  const t = findType(project, typeName);
  if (!t) return [];
  return [...instanceMembers(project, typeName), ...staticMembers(project, typeName)].filter((m) => m.detail && !m.detail.includes(' object.'));
}

// ---- Project index (cached briefly; completion asks often) ----

const SKIP = new Set(['.git', 'node_modules', '.idea', '.vs', '.vscode', 'bin', 'obj', 'dist', 'out', 'packages', 'TestResults']);
const FILE_LIMIT = 3000;
const parsed = new Map(); // path → { mtimeMs, outline }
let fileCache = { at: 0, files: [] };

async function projectIndex(currentPath, currentText) {
  const files = await projectFiles();
  const namespaces = new Set();
  const types = [];
  const openPaths = new Map([...documents].map(([uri, text]) => [toPath(uri), text]));
  openPaths.set(currentPath, currentText);

  for (const file of new Set([...files, ...openPaths.keys()])) {
    if (!file.endsWith('.cs') && !file.endsWith('.csx')) continue;
    let info;
    if (openPaths.has(file)) {
      info = outline(openPaths.get(file));
    } else {
      info = await outlineFromDisk(file);
      if (!info) continue;
    }
    for (const n of info.namespaces) namespaces.add(n);
    types.push(...info.types);
  }
  // Every prefix of a declared namespace is itself a namespace.
  for (const n of [...namespaces]) {
    const parts = n.split('.');
    for (let i = 1; i < parts.length; i++) namespaces.add(parts.slice(0, i).join('.'));
  }
  return { namespaces: [...namespaces], types };
}

async function outlineFromDisk(file) {
  try {
    const { mtimeMs, size } = await stat(file);
    if (size > 2 * 1024 * 1024) return null;
    const cached = parsed.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached.outline;
    const info = outline(readFileSync(file, 'utf8'));
    parsed.set(file, { mtimeMs, outline: info });
    return info;
  } catch {
    return null;
  }
}

async function projectFiles() {
  if (Date.now() - fileCache.at < 5000) return fileCache.files;
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= FILE_LIMIT) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full);
      } else if (e.name.endsWith('.cs') || e.name.endsWith('.csx')) {
        files.push(full);
      }
    }
  };
  await walk(root);
  fileCache = { at: Date.now(), files };
  return files;
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

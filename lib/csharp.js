/**
 * Lightweight C# source analysis shared by the module and the language server.
 * Not a parser: a lexer plus brace-aware heuristics, good enough for completion.
 */

export const KEYWORDS = [
  'abstract', 'as', 'async', 'await', 'base', 'break', 'case', 'catch', 'checked', 'class', 'const', 'continue',
  'default', 'delegate', 'do', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'file', 'finally', 'fixed',
  'for', 'foreach', 'get', 'global', 'goto', 'if', 'implicit', 'in', 'init', 'interface', 'internal', 'is', 'lock',
  'namespace', 'new', 'nameof', 'null', 'operator', 'out', 'override', 'params', 'partial', 'private', 'protected',
  'public', 'readonly', 'record', 'ref', 'required', 'return', 'sealed', 'set', 'sizeof', 'stackalloc', 'static',
  'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'unchecked', 'unsafe', 'using', 'value', 'virtual',
  'volatile', 'when', 'where', 'while', 'with', 'yield',
];

export const PRIMITIVE_TYPES = [
  'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short', 'ushort',
  'nint', 'nuint', 'object', 'string', 'void', 'var', 'dynamic',
];

const RESERVED = new Set([...KEYWORDS, ...PRIMITIVE_TYPES]);
const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'sealed', 'abstract', 'virtual',
  'override', 'extern', 'unsafe', 'volatile', 'async', 'partial', 'required', 'file', 'new', 'ref', 'implicit',
  'explicit', 'event',
]);
const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'enum', 'record']);

// ---- Lexer ----

/**
 * Splits source into tokens: ident, number, string, char, comment, preproc, punct.
 * Unterminated strings and comments run to the end of the line or file and carry `open: true`.
 */
export function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  const push = (type, start, extra) => tokens.push({ type, start, end: i, value: text.slice(start, i), ...extra });

  while (i < n) {
    const c = text[i];
    const start = i;

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    if (c === '/' && text[i + 1] === '/') {
      i = lineEnd(text, i);
      push('comment', start);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      push('comment', start, close === -1 ? { open: true } : {});
      continue;
    }

    if (c === '#' && /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i))) {
      i = lineEnd(text, i);
      push('preproc', start);
      continue;
    }

    // String prefixes: $, $$..., @, $@, @$, followed by a quote.
    const prefix = /^(?:\$+@?|@\$*)?(?=")/.exec(text.slice(i, i + 12));
    if (prefix) {
      const verbatim = prefix[0].includes('@');
      const dollars = (prefix[0].match(/\$/g) ?? []).length;
      i += prefix[0].length;
      const quotes = /^"{3,}/.exec(text.slice(i, i + 64));
      let open = false;
      const holes = [];
      if (quotes && !verbatim) {
        const close = text.indexOf(quotes[0], i + quotes[0].length);
        open = close === -1;
        i = open ? n : close + quotes[0].length;
      } else {
        i++;
        open = true;
        while (i < n) {
          const ch = text[i];
          if (dollars && ch === '{') {
            if (text[i + 1] === '{') { i += 2; continue; }
            const holeStart = i + 1;
            i = skipHole(text, holeStart);
            holes.push([holeStart, text[i - 1] === '}' ? i - 1 : i]);
            continue;
          }
          if (verbatim) {
            if (ch === '"') {
              if (text[i + 1] === '"') i += 2;
              else { i++; open = false; break; }
              continue;
            }
          } else {
            if (ch === '\\') { i += 2; continue; }
            if (ch === '"') { i++; open = false; break; }
            if (ch === '\n') break;
          }
          i++;
        }
      }
      if (text.startsWith('u8', i)) i += 2;
      push('string', start, { ...(open ? { open: true } : {}), ...(holes.length ? { holes } : {}) });
      continue;
    }

    if (c === "'") {
      i++;
      let open = true;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === "'") { i++; open = false; break; }
        i++;
      }
      push('char', start, open ? { open: true } : {});
      continue;
    }

    if (/[A-Za-z_@]/.test(c)) {
      i++;
      while (i < n && /\w/.test(text[i])) i++;
      push('ident', start);
      continue;
    }

    if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] ?? ''))) {
      i++;
      while (i < n && /[\w.]/.test(text[i]) && !(text[i] === '.' && !/\d/.test(text[i + 1] ?? ''))) i++;
      push('number', start);
      continue;
    }

    i++;
    push('punct', start);
  }
  return tokens;
}

function lineEnd(text, i) {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}

/** Skips an interpolation hole starting just after its `{`, returning the index after the matching `}`. */
function skipHole(text, i) {
  let depth = 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    } else if (ch === '\n' && depth === 1) return i;
    i++;
  }
  return i;
}

/** True when `offset` is inside a comment, string, char literal or preprocessor line. */
export function inNonCode(tokens, offset) {
  for (const t of tokens) {
    if (t.start >= offset) return false;
    if (t.type === 'ident' || t.type === 'number' || t.type === 'punct') continue;
    if (offset < t.end || (offset === t.end && (t.open || t.type === 'comment' && t.value.startsWith('//') || t.type === 'preproc'))) {
      // Interpolation holes ({expr} in $"...") are code.
      return !t.holes?.some(([a, b]) => offset >= a && offset <= b);
    }
  }
  return false;
}

/** Code tokens only (no comments, strings or preprocessor lines). */
const codeTokens = (tokens) => tokens.filter((t) => t.type === 'ident' || t.type === 'number' || t.type === 'punct');

// ---- Outline ----

/**
 * Extracts namespaces, types and their members.
 * Types and members carry `offset`, the source index of their name; nested types carry `container`,
 * the index of their enclosing type (or -1).
 * @returns {{ namespaces: string[], usings: string[], types: Array<{ name, kind, namespace, bases: string[],
 *   container: number, offset: number, members: Array<{ name, kind, type, isStatic, offset }> }> }}
 */
export function outline(text) {
  const toks = codeTokens(tokenize(text));
  const namespaces = new Set();
  const usings = [];
  const types = [];
  // Each scope: { kind: 'namespace' | 'type' | 'block', name?, type? }
  const scopes = [];
  let fileNamespace = '';

  const currentNamespace = () =>
    [fileNamespace, ...scopes.filter((s) => s.kind === 'namespace').map((s) => s.name)].filter(Boolean).join('.');
  const currentType = () => {
    const top = scopes[scopes.length - 1];
    return top?.kind === 'type' ? top.type : null;
  };

  let pendingScope = null;
  let statement = [];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const v = t.value;

    if (t.type === 'ident' && v === 'using' && statement.length === 0 && !currentType() && toks[i + 1]?.value !== '(') {
      const name = [];
      let j = i + 1;
      while (j < toks.length && toks[j].value !== ';') {
        name.push(toks[j].value);
        j++;
      }
      const joined = name.join('').replace(/^static/, '');
      if (!joined.includes('=')) usings.push(joined);
      i = j;
      continue;
    }

    if (t.type === 'ident' && v === 'namespace') {
      const [name, j] = dottedName(toks, i + 1);
      const full = [currentNamespace(), name].filter(Boolean).join('.');
      namespaces.add(full);
      if (toks[j]?.value === ';') {
        fileNamespace = name;
        i = j;
      } else {
        pendingScope = { kind: 'namespace', name };
        i = j - 1;
      }
      statement = [];
      continue;
    }

    if (t.type === 'ident' && TYPE_KINDS.has(v) && !isGenericConstraint(statement)) {
      let j = i + 1;
      let kind = v;
      if (v === 'record' && (toks[j]?.value === 'class' || toks[j]?.value === 'struct')) {
        kind = `record ${toks[j].value}`;
        j++;
      }
      const nameTok = toks[j];
      if (nameTok?.type === 'ident' && !RESERVED.has(nameTok.value)) {
        const type = {
          name: stripAt(nameTok.value),
          kind,
          namespace: currentNamespace(),
          bases: [],
          members: [],
          // Index of the enclosing type in `types` for nested types, else -1.
          container: types.indexOf(currentType()),
          offset: nameTok.start,
        };
        types.push(type);
        j++;
        j = skipAngles(toks, j);
        // Primary constructor parameters become properties on records.
        if (toks[j]?.value === '(') {
          const close = matching(toks, j, '(', ')');
          if (kind.startsWith('record')) {
            for (const p of parameters(toks.slice(j + 1, close))) type.members.push({ ...p, kind: 'property', isStatic: false });
          }
          j = close + 1;
        }
        if (toks[j]?.value === ':') {
          j++;
          while (j < toks.length && toks[j].value !== '{' && toks[j].value !== ';' && toks[j].value !== 'where') {
            const [base, k] = dottedName(toks, j);
            if (base) type.bases.push(base.split('.').pop());
            j = skipAngles(toks, k);
            if (toks[j]?.value === '(') j = matching(toks, j, '(', ')') + 1;
            if (toks[j]?.value === ',') j++;
            else if (k === j && !base) j++;
          }
        }
        while (j < toks.length && toks[j].value !== '{' && toks[j].value !== ';') j++;
        if (toks[j]?.value === '{') pendingScope = { kind: 'type', type };
        i = j - 1;
        statement = [];
        continue;
      }
    }

    if (v === '{') {
      const owner = currentType();
      if (!pendingScope && owner && statement.length) {
        if (owner.kind === 'enum') recordEnumMembers(owner, statement);
        else recordMember(owner, statement, '{');
      }
      scopes.push(pendingScope ?? { kind: 'block' });
      pendingScope = null;
      statement = [];
      continue;
    }
    if (v === '}') {
      const owner = currentType();
      if (owner?.kind === 'enum' && statement.length) recordEnumMembers(owner, statement);
      scopes.pop();
      statement = [];
      continue;
    }
    if (v === ';' || (v === '=' && toks[i + 1]?.value === '>')) {
      const owner = currentType();
      if (owner && statement.length) recordMember(owner, statement, v === ';' ? ';' : '=>');
      if (v === '=') {
        // Skip an expression body up to its semicolon.
        let depth = 0;
        let j = i + 2;
        for (; j < toks.length; j++) {
          const x = toks[j].value;
          if (x === '(' || x === '{' || x === '[') depth++;
          else if (x === ')' || x === '}' || x === ']') depth--;
          else if (x === ';' && depth <= 0) break;
          if (depth < 0) break;
        }
        i = toks[j]?.value === ';' ? j : j - 1;
      }
      statement = [];
      continue;
    }
    if (v === '(' && currentType() && statement.length) {
      // Keep parameter lists as one unit so commas and defaults inside them don't confuse member detection.
      const close = matching(toks, i, '(', ')');
      statement.push({ type: 'parens', value: '(...)', inner: toks.slice(i + 1, close) });
      i = close;
      continue;
    }
    if (v === '[' && currentType() && statement.length === 0) {
      i = matching(toks, i, '[', ']');
      continue;
    }
    statement.push(t);
  }

  return { namespaces: [...namespaces], usings, types };
}

function recordEnumMembers(type, statement) {
  let expectName = true;
  for (const t of statement) {
    if (t.value === ',') expectName = true;
    else if (expectName && t.type === 'ident') {
      type.members.push({ name: stripAt(t.value), kind: 'enumMember', type: type.name, isStatic: true, offset: t.start });
      expectName = false;
    } else expectName = false;
  }
}

/** Classifies the tokens of a member declaration ending in `;`, `{` or `=>`. */
function recordMember(type, statement, terminator) {
  const words = statement.filter((t) => !(t.type === 'ident' && MODIFIERS.has(t.value)));
  const isStatic = statement.some((t) => t.value === 'static' || t.value === 'const');
  const isConst = statement.some((t) => t.value === 'const');
  const isEvent = statement.some((t) => t.value === 'event');
  if (!words.length) return;

  const eq = words.findIndex((t) => t.value === '=');
  const parens = words.findIndex((t) => t.type === 'parens');
  if (parens > 0 && (eq === -1 || parens < eq)) {
    const nameTok = words[parens - 1].value === '>' ? findBeforeAngles(words, parens - 1) : words[parens - 1];
    if (nameTok?.type !== 'ident' || RESERVED.has(nameTok.value) && nameTok.value !== 'this') return;
    const name = stripAt(nameTok.value);
    const typeText = typeTextOf(words.slice(0, words.indexOf(nameTok)));
    if (name === type.name || !typeText) {
      if (name === type.name) type.members.push({ name, kind: 'constructor', type: type.name, isStatic, params: paramText(words[parens]), offset: nameTok.start });
      return;
    }
    if (name === 'operator') return;
    type.members.push({ name, kind: 'method', type: typeText, isStatic, params: paramText(words[parens]), offset: nameTok.start });
    return;
  }

  const head = eq === -1 ? words : words.slice(0, eq);
  if (terminator === '{' || terminator === '=>') {
    const nameTok = head[head.length - 1];
    if (nameTok?.type !== 'ident' || RESERVED.has(nameTok.value)) return;
    type.members.push({ name: stripAt(nameTok.value), kind: isEvent ? 'event' : 'property', type: typeTextOf(head.slice(0, -1)), isStatic, offset: nameTok.start });
    return;
  }

  // Fields: "Type a = 1, b;" — the first name follows the type, further names follow commas at depth 0.
  const nameTok = head[head.length - 1];
  if (nameTok?.type !== 'ident' || RESERVED.has(nameTok.value)) return;
  const typeText = typeTextOf(head.slice(0, -1));
  if (!typeText) return;
  const kind = isConst ? 'constant' : isEvent ? 'event' : 'field';
  type.members.push({ name: stripAt(nameTok.value), kind, type: typeText, isStatic, offset: nameTok.start });
  let depth = 0;
  for (let k = eq + 1; eq !== -1 && k < words.length; k++) {
    const x = words[k].value;
    if (x === '(' || x === '[' || x === '{' || x === '<') depth++;
    else if (x === ')' || x === ']' || x === '}' || x === '>') depth--;
    else if (x === ',' && depth === 0 && words[k + 1]?.type === 'ident') {
      type.members.push({ name: stripAt(words[k + 1].value), kind, type: typeText, isStatic, offset: words[k + 1].start });
    }
  }
}

/** Parameter declarations: "int a, string b = null" → [{ name: 'a', type: 'int' }, …]. */
export function parameters(toks) {
  const out = [];
  let current = [];
  let depth = 0;
  const flush = () => {
    const eq = current.findIndex((t) => t.value === '=');
    const head = (eq === -1 ? current : current.slice(0, eq)).filter((t) => !['this', 'ref', 'out', 'in', 'params', 'scoped', 'readonly'].includes(t.value));
    const nameTok = head[head.length - 1];
    if (nameTok?.type === 'ident' && head.length > 1) out.push({ name: stripAt(nameTok.value), type: typeTextOf(head.slice(0, -1)), offset: nameTok.start });
    current = [];
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.value === '[' && current.length === 0) {
      // Parameter attributes: [NotNull] string s
      while (k < toks.length && toks[k].value !== ']') k++;
      continue;
    }
    if (t.value === '<' || t.value === '(' || t.value === '[') depth++;
    else if (t.value === '>' || t.value === ')' || t.value === ']') depth--;
    if (t.value === ',' && depth === 0) flush();
    else current.push(t);
  }
  flush();
  return out.filter((p) => p.type);
}

function paramText(parensTok) {
  return `(${parameters(parensTok.inner).map((p) => `${p.type} ${p.name}`).join(', ')})`;
}

function typeTextOf(toks) {
  const text = toks.map((t) => t.value).join('').replace(/,/g, ', ');
  return /^[\w.<>\[\]?, ()]+$/.test(text) && /\w/.test(text) ? text : '';
}

function findBeforeAngles(words, closeIndex) {
  let depth = 0;
  for (let k = closeIndex; k >= 0; k--) {
    if (words[k].value === '>') depth++;
    else if (words[k].value === '<' && --depth === 0) return words[k - 1];
  }
  return null;
}

function isGenericConstraint(statement) {
  // "where T : class" or "where T : struct" should not start a type declaration.
  const last = statement[statement.length - 1];
  return last?.value === ':' || last?.value === ',' || statement.some((t) => t.value === 'where');
}

function dottedName(toks, j) {
  const parts = [];
  while (toks[j]?.type === 'ident') {
    parts.push(stripAt(toks[j].value));
    if (toks[j + 1]?.value === '.' && toks[j + 2]?.type === 'ident') j += 2;
    else {
      j++;
      break;
    }
  }
  return [parts.join('.'), j];
}

function skipAngles(toks, j) {
  if (toks[j]?.value !== '<') return j;
  let depth = 0;
  for (; j < toks.length; j++) {
    if (toks[j].value === '<') depth++;
    else if (toks[j].value === '>' && --depth === 0) return j + 1;
    else if (toks[j].value === '{' || toks[j].value === ';') return j;
  }
  return j;
}

function matching(toks, j, open, close) {
  let depth = 0;
  for (; j < toks.length; j++) {
    if (toks[j].value === open) depth++;
    else if (toks[j].value === close && --depth === 0) return j;
  }
  return toks.length - 1;
}

const stripAt = (name) => name.replace(/^@/, '');

// ---- Locals ----

/**
 * Variables visible-ish at `offset`: parameters and locals declared before it (with the `offset` of their name), with their type when it's
 * written out ("Foo x", "var x = new Foo(…)", "foreach (Foo x in …)"). Scope is approximated by brace depth.
 */
export function localsAt(text, offset) {
  const toks = tokenize(text.slice(0, offset)).filter((t) => t.type !== 'comment' && t.type !== 'preproc');
  const found = new Map();
  // Track the brace depth at which each local was declared; drop them when that block closes.
  let depth = 0;
  const declaredAt = [];
  const declare = (name, type, at) => {
    if (RESERVED.has(name)) return;
    found.set(name, { name: stripAt(name), type, offset: at });
    declaredAt.push({ name, depth });
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.value === '{') depth++;
    else if (t.value === '}') {
      depth--;
      while (declaredAt.length && declaredAt[declaredAt.length - 1].depth > depth) found.delete(declaredAt.pop().name);
    } else if (t.value === '(' ) {
      // Parameter lists of method-like declarations: "Name(Type a, Type b) {" or "=> ".
      const close = matchingOrEnd(toks, i);
      const next = toks[close + 1]?.value;
      const prev = toks[i - 1];
      const isDecl = prev?.type === 'ident' && !RESERVED.has(prev.value) && (next === '{' || next === '=' || next === ':' || next === 'where');
      const isLambda = next === '=' && toks[close + 2]?.value === '>';
      if (isDecl || isLambda) {
        const inner = toks.slice(i + 1, close);
        const typed = parameters(inner);
        const params = typed.length
          ? typed
          : inner.filter((p) => p.type === 'ident' && !RESERVED.has(p.value)).map((p) => ({ name: p.value, type: '', offset: p.start }));
        // Parameters belong to the body that follows, one level deeper.
        depth++;
        for (const p of params) declare(p.name, p.type, p.offset);
        depth--;
      }
    } else if (t.type === 'ident' && toks[i + 1]?.value === '=' && toks[i + 2]?.value === '>' && toks[i - 1]?.value !== '.') {
      declare(t.value, '', t.start);
    } else if (t.type === 'ident' && !RESERVED.has(t.value) || ['var', ...PRIMITIVE_TYPES].includes(t.value)) {
      // "Type name" followed by = ; , ) in
      const [typeEnd, typeText] = readType(toks, i);
      const nameTok = toks[typeEnd];
      const after = toks[typeEnd + 1]?.value;
      if (typeText && nameTok?.type === 'ident' && !RESERVED.has(nameTok.value) && ['=', ';', ',', 'in', ')'].includes(after) && toks[i - 1]?.value !== '.') {
        let type = typeText;
        if (type === 'var' && after === '=') type = inferredType(toks, typeEnd + 2);
        if (after !== ')' || ['(', ',', 'is'].includes(toks[i - 1]?.value)) declare(nameTok.value, type === 'var' ? '' : type, nameTok.start);
        i = typeEnd;
      }
    }
  }
  return [...found.values()];
}

function matchingOrEnd(toks, j) {
  let depth = 0;
  for (; j < toks.length; j++) {
    if (toks[j].value === '(') depth++;
    else if (toks[j].value === ')' && --depth === 0) return j;
  }
  return toks.length;
}

/** Reads "Foo", "Foo.Bar<int, List<string>>[]?" starting at i. Returns [index after type, text]. */
function readType(toks, i) {
  let j = i;
  let text = '';
  for (;;) {
    if (toks[j]?.type !== 'ident') return [i, ''];
    text += toks[j].value;
    j++;
    if (toks[j]?.value === '<') {
      let depth = 0;
      const start = j;
      for (; j < toks.length; j++) {
        const v = toks[j].value;
        if (v === '<') depth++;
        else if (v === '>') {
          if (--depth === 0) { j++; break; }
        } else if (!/^[\w,.?\[\]]$|^\w+$/.test(v)) return [i, ''];
      }
      text += toks.slice(start, j).map((t) => t.value).join('');
    }
    while (toks[j]?.value === '[' && toks[j + 1]?.value === ']') { text += '[]'; j += 2; }
    if (toks[j]?.value === '?') { text += '?'; j++; }
    if (toks[j]?.value === '.' && toks[j + 1]?.type === 'ident') { text += '.'; j++; continue; }
    break;
  }
  return [j, text];
}

/** Type of "new Foo(…)", "new Foo<…>", a string/number literal, or "Foo.Create(…)"-style factories. */
function inferredType(toks, j) {
  const t = toks[j];
  if (!t) return '';
  if (t.value === 'new') {
    const [, type] = readType(toks, j + 1);
    return type;
  }
  if (t.type === 'number') return /[.eE]|[dD]$/.test(t.value) && !/^0[xX]/.test(t.value) ? (/[fF]$/.test(t.value) ? 'float' : /[mM]$/.test(t.value) ? 'decimal' : 'double') : 'int';
  if (t.value === 'true' || t.value === 'false') return 'bool';
  if (t.type === 'string') return 'string';
  if (t.type === 'char') return 'char';
  return '';
}

/** Name of the innermost class/struct/record/interface/enum whose body contains `offset`, if any. */
export function enclosingType(text, offset) {
  const toks = codeTokens(tokenize(text.slice(0, offset)));
  const stack = [];
  let pending = null;
  for (let i = 0; i < toks.length; i++) {
    const v = toks[i].value;
    if (TYPE_KINDS.has(v) && !isConstraintKeyword(toks, i)) {
      let j = i + 1;
      if (v === 'record' && (toks[j]?.value === 'class' || toks[j]?.value === 'struct')) j++;
      if (toks[j]?.type === 'ident' && !RESERVED.has(toks[j].value)) pending = stripAt(toks[j].value);
    } else if (v === '{') {
      stack.push(pending);
      pending = null;
    } else if (v === '}') stack.pop();
    else if (v === ';') pending = null;
  }
  return stack.filter(Boolean).pop() ?? null;
}

/** "where T : class" / "where T : struct" / "new() where T : class, IFoo". */
function isConstraintKeyword(toks, i) {
  const prev = toks[i - 1]?.value;
  return prev === ':' || prev === ',';
}

/** Zero-based { line, character } of a source index. */
export function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}

/** Strips generics, arrays and nullability: "List<int>[]?" → "List". */
export const baseTypeName = (type) => (type ?? '').replace(/<.*$/s, '').replace(/[\[\]?]/g, '').split('.').pop();

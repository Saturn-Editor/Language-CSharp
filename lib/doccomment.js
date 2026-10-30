const CONTROL = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'nameof', 'typeof', 'sizeof', 'fixed']);

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const paramNames = (list) =>
  splitTopLevel(list)
    .map((p) => p.replace(/=[\s\S]*$/, '').trim().match(/@?(\w+)$/)?.[1])
    .filter(Boolean);

const typeParamNames = (list) => (list ? splitTopLevel(list.slice(1, -1)).map((p) => p.replace(/^(in|out)\s+/, '').match(/\w+$/)?.[0]).filter(Boolean) : []);

function nextDeclaration(lines, line) {
  let text = '';
  for (let i = line + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!text) {
      if (!trimmed || trimmed.startsWith('[')) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) return null;
    }
    text += ` ${trimmed}`;
    let depth = 0;
    for (let j = 0; j < text.length; j++) {
      const c = text[j];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && (c === '{' || c === ';' || (c === '=' && text[j + 1] === '>') || (c === '=' && text[j + 1] !== '='))) return text.slice(0, j).trim();
    }
    if (i - line > 20) break;
  }
  return text.trim() || null;
}

const MODIFIERS = /\b(public|private|protected|internal|static|readonly|sealed|abstract|virtual|override|async|extern|unsafe|new|partial|required|file|volatile|const|implicit|explicit|operator)\b/g;

function describe(decl) {
  const clean = decl.replace(/\bwhere\b[\s\S]*$/, '').replace(MODIFIERS, ' ').replace(/\s+/g, ' ').trim();
  const type = /\b(class|struct|interface|enum|record)\b(?:\s+(?:class|struct))?\s+@?\w+\s*(<[^>]*>)?\s*(\(([\s\S]*)\))?/.exec(clean);
  if (type) return { typeParams: typeParamNames(type[2]), params: type[3] ? paramNames(type[4]) : [], returns: false };
  const delegate = /\bdelegate\s+([\s\S]+?)\s+@?\w+\s*(<[^>]*>)?\s*\(([\s\S]*)\)$/.exec(clean);
  if (delegate) return { typeParams: typeParamNames(delegate[2]), params: paramNames(delegate[3]), returns: delegate[1] !== 'void' };
  const method = /^(?:([\s\S]*?\S)\s+)?@?(\w+)\s*(<[^<>()]*>)?\s*\(([\s\S]*)\)$/.exec(clean.replace(/\)\s*:\s*(base|this)\s*\([\s\S]*$/, ')'));
  if (method && !CONTROL.has(method[2])) {
    const returnType = (method[1] ?? '').trim();
    return { typeParams: typeParamNames(method[3]), params: paramNames(method[4]), returns: Boolean(returnType) && returnType !== 'void' };
  }
  if (/^[\w<>[\]?,.\s()]+\s@?\w+$/.test(clean) || /\bevent\b/.test(clean) || /\bthis\s*\[/.test(clean)) return { typeParams: [], params: [], returns: false };
  return null;
}

export function docCommentSnippet({ text, line }) {
  const lines = text.split(/\r?\n/);
  if (/^\s*\/\/\//.test(lines[line - 1] ?? '') || /^\s*\/\/\//.test(lines[line + 1] ?? '')) return null;
  const decl = nextDeclaration(lines, line);
  const info = decl && describe(decl);
  if (!info) return null;
  return [
    '/// <summary>',
    '/// $1',
    '/// </summary>',
    ...info.typeParams.map((t) => `/// <typeparam name="${t}"></typeparam>`),
    ...info.params.map((p) => `/// <param name="${p}"></param>`),
    ...(info.returns ? ['/// <returns></returns>'] : []),
  ].join('\n');
}

import { storageError } from './errors.mjs';

export function queryShape(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw storageError();
  let visible = '', parameters = 0, ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (/\s/.test(c)) { visible += ' '; continue; }
    if (c === '-' && next === '-') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      visible += ' '; continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw storageError();
      i = end + 1; visible += ' '; continue;
    }
    if (ended) throw storageError();
    if (c === ';') { ended = true; continue; }
    if (['\'', '"', '`', '['].includes(c)) {
      const closing = c === '[' ? ']' : c;
      let closed = false;
      for (i++; i < text.length; i++) {
        if (text[i] !== closing) continue;
        if (closing !== ']' && text[i + 1] === closing) { i++; continue; }
        closed = true; break;
      }
      if (!closed) throw storageError();
      visible += ' quoted '; continue;
    }
    if (c === '?') {
      if (/\d/.test(next ?? '')) throw storageError();
      parameters++;
    }
    if ([':', '@', '$'].includes(c)) throw storageError();
    visible += c;
  }
  const first = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.exec(visible)?.[1].toUpperCase();
  if (!first) throw storageError();
  let kind = first;
  if (first === 'WITH') {
    let depth = 0;
    kind = undefined;
    for (const [token] of visible.matchAll(/[a-z_][a-z_0-9]*|[()]/gi)) {
      if (token === '(') depth++;
      else if (token === ')') depth--;
      else if (depth === 0 && /^(SELECT|INSERT|UPDATE|DELETE)$/i.test(token)) {
        kind = token.toUpperCase(); break;
      }
    }
    if (!kind) throw storageError();
  }
  return { parameters, kind };
}

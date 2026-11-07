const at = (value, path) => path.split('.').reduce((v, key) => v?.[key], value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function predicateMatches(args, p) {
  const v = at(args, p.path);
  if (p.op === 'exists') return v !== undefined;
  if (p.op === 'eq') return same(v, p.value);
  if (p.op === 'includes') return Array.isArray(v) && v.some(x => same(x, p.value));
  if (p.op === 'gte') return typeof v === 'number' && v >= p.value;
  if (p.op === 'lte') return typeof v === 'number' && v <= p.value;
  return false;
}
export function gradeRequiredTools(required, calls) {
  const checks = required.map(r => ({ ...r, ok: calls.some(c => !c.isError && c.name === r.name && r.predicates.every(p => predicateMatches(c.args, p))) }));
  return { ok: checks.every(c => c.ok), checks };
}

const small = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const scales = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const wordPattern = new RegExp(`\\b(?:${Object.keys(small).join('|')}|${Object.keys(scales).join('|')})(?:(?:[ -]+and)?[ -]+(?:${Object.keys(small).join('|')}|${Object.keys(scales).join('|')}))*\\b`, 'gi');
const quantity = /[+-]?(?:\$\s*)?\d[\d,]*(?:\.\d+)?\s*(?:billion|million|thousand|percent|[kmb](?![a-z])|%)?/gi;
const scaleOf = s => /billion|b\b/i.test(s) ? 1e9 : /million|m\b/i.test(s) ? 1e6 : /thousand|k\b/i.test(s) ? 1000 : 1;
const close = (a, b) => Math.abs(a - b) <= Math.max(0.0050001, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);
export function numericFigures(text) {
  const clean = String(text).replace(/^\s*\d+[.)]\s/gm, m => ' '.repeat(m.length))
    .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, m => ' '.repeat(m.length));
  const values = [];
  for (const m of clean.matchAll(quantity)) {
    const n = Number(m[0].replace(/[^\d.+-]/g, '')) * scaleOf(m[0]);
    if (Number.isFinite(n)) values.push({ text: m[0].trim(), value: n });
  }
  for (const m of clean.matchAll(wordPattern)) {
    let sum = 0, part = 0;
    for (const word of m[0].toLowerCase().split(/[ -]+/)) {
      if (Object.hasOwn(small, word)) part += small[word];
      else if (word === 'hundred') part = (part || 1) * 100;
      else if (scales[word]) { sum += (part || 1) * scales[word]; part = 0; }
    }
    values.push({ text: m[0], value: sum + part });
  }
  return values;
}

const metadata = /^(?:id|ids|key|keys|label|labels|name|title|description|category|entity|symbol|inst|institution|owner|mask|src|source|sources|url|file|parser|locator|date|clock|asof|as_of|datathrough|version|period|month|year|tax_year|citation|citations|reference|references|page|pages|accountNumber)$/i;
const isMetadata = key => metadata.test(key) || /(?:Id|Ids|_id|_ids|Date|_date|Mask|Number)$/.test(key);
function leaves(value, out = []) {
  if (value && typeof value === 'object') Object.values(value).forEach(v => leaves(v, out));
  else out.push(value);
  return out;
}
export function evidenceNumbers(calls) {
  const out = [];
  for (const c of calls.filter(c => !c.isError)) {
    const echoes = leaves(c.args ?? {});
    const visit = (value, key = '') => {
      if (isMetadata(key) || echoes.some(arg => same(arg, value))) return;
      if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
      else if (typeof value === 'string') {
        const clean = value.replace(/https?:\/\/\S+/gi, '');
        for (const n of numericFigures(clean)) {
          if (!/^\s*[+-]?(?:\$\s*)?\d[\d,.]*(?:\s*(?:%|percent|[kmb]|thousand|million|billion))?\s*$/i.test(clean)
            && !/[$%]|\b(?:dollars?|percent|thousand|million|billion)\b/i.test(n.text + clean.slice(clean.indexOf(n.text) + n.text.length, clean.indexOf(n.text) + n.text.length + 12))) continue;
          if (!echoes.some(arg => typeof arg === 'number' ? close(arg, n.value) : typeof arg === 'string' && numericFigures(arg).some(a => close(a.value, n.value)))) out.push(n.value);
        }
      } else if (Array.isArray(value)) value.forEach(v => visit(v));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => visit(v, k));
    };
    visit(c.result);
  }
  return [...new Set(out)];
}
function derivation(value, numbers) {
  for (const a of numbers) for (const b of numbers) {
    const candidates = [[a + b, '+'], [a - b, '-'], [a * b, '*']];
    if (b) candidates.push([a / b, '/'], [a / b * 100, '/ percent']);
    for (const [n, op] of candidates) if (Number.isFinite(n) && close(value, n)) return { a, b, op };
  }
  return null;
}
export function gradeFigures(text, calls, { figures = {}, contextNumbers = [] } = {}) {
  const numbers = evidenceNumbers(calls);
  const violations = [];
  const tokenFigures = [];
  const cleaned = String(text).replace(/\{(?:fk|f):([^{}]+)\}/g, (token, key) => {
    const returned = calls.some(c => !c.isError && c.name === 'get_figures' && Array.isArray(c.result)
      && c.result.some(f => f.key === key && !f.unavailable && Number.isFinite(f.v)));
    if (!returned) violations.push({ text: token, value: figures[key] ?? null, kind: 'context-only' });
    else tokenFigures.push({ text: token, value: figures[key] });
    return ' ';
  });
  for (const n of numericFigures(cleaned)) if (!numbers.some(v => close(v, n.value))) {
    const arithmetic = derivation(n.value, numbers);
    violations.push({ ...n, kind: arithmetic ? 'self-computed' : contextNumbers.some(v => close(v, n.value)) ? 'context-only' : 'unsourced', ...(arithmetic ? { arithmetic } : {}) });
  }
  return { ok: violations.length === 0, unsourced: violations, selfComputed: violations.filter(v => v.kind === 'self-computed'),
    contextOnly: violations.filter(v => v.kind === 'context-only'), evidence: numbers, tokenFigures };
}
export function gradeLength(text, maxWords) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return { ok: words <= maxWords, words, maxWords };
}
export function gradeExpected(text, values, { figures = {} } = {}) {
  const expanded = String(text).replace(/\{(?:fk|f):([^{}]+)\}/g, (_, key) => String(figures[key] ?? ''));
  const actual = numericFigures(expanded);
  const checks = values.map(value => ({ value, ok: actual.some(n => close(n.value, value)) }));
  return { ok: checks.every(c => c.ok), checks };
}

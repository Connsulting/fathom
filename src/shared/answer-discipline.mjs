import { ANSWER_MAX_WORDS } from './answer-contract.mjs';
import { plainAnswerText, markdownBlocks, wrapBlocks } from './answer-text.mjs';
import { escapeUserText } from './tokens.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const small = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const scales = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const wordPattern = new RegExp(`\\b(?:${Object.keys(small).join('|')}|${Object.keys(scales).join('|')})(?:(?:[ -]+and)?[ -]+(?:${Object.keys(small).join('|')}|${Object.keys(scales).join('|')}))*\\b`, 'gi');
const quantity = /[+-]?(?:\$\s*)?\d[\d,]*(?:\.\d+)?\s*(?:billion|million|thousand|percent|[kmb](?![a-z])|%)?/gi;
const scaleOf = s => /billion|b\b/i.test(s) ? 1e9 : /million|m\b/i.test(s) ? 1e6 : /thousand|k\b/i.test(s) ? 1000 : 1;
const close = (a, b, money = false) => Math.abs(a - b) <= (money ? 0.0050001 : Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b)) * 1e-6));
const monthName = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const dates = new RegExp(`\\b(?:${monthName}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}\\s+${monthName}\\.?(?:\\s+\\d{4})?)\\b`, 'gi');
const blank = m => ' '.repeat(m.length);
export function numericFigures(text) {
  const clean = String(text).replace(/^\s*\d+[.)]\s/gm, blank)
    .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, blank)
    .replace(dates, blank)
    .replace(/\b(?:401|403|457)\s*(?:\([abk]\)|[abk])|\b529(?=\s+(?:plan|account))|\b(?:W-2|K-1)\b/gi, blank)
    .replace(/(?<![$\d.,])\b(?:1099(?:-[A-Z]+)?|1040|529)\b(?!\s*(?:%|dollars?))/gi, blank)
    .replace(/(?<![$\d.,])\b(?:19|20)\d{2}\b(?!\d|[.,]\d|\s*(?:%|percent|dollars?|thousand|million|billion))/g, blank);
  const values = [];
  for (const m of clean.matchAll(quantity)) {
    const n = Number(m[0].replace(/[^\d.+-]/g, '')) * scaleOf(m[0]);
    if (Number.isFinite(n)) values.push({ text: m[0].trim(), value: n,
      money: /\$/.test(m[0]) || /^\s*dollars?\b/i.test(clean.slice(m.index + m[0].length)),
      percent: /%|percent/i.test(m[0]),
      abbrev: /(?:^|[^a-z])[kmb](?![a-z])/i.test(m[0]) && !/(?:thousand|million|billion)/i.test(m[0]),
      scale: scaleOf(m[0]), words: false });
  }
  for (const m of clean.replace(quantity, blank).matchAll(wordPattern)) {
    const after = clean.slice(m.index + m[0].length);
    const before = clean.slice(0, m.index);
    if (/^one$/i.test(m[0]) && !/^\s*(?:%|percent|dollars?)\b/i.test(after)
      && (/^\s+(?:of|more|another)\b/i.test(after) || /\b(?:the|a|no|any|another)(?:\s+\w+)?\s+$/i.test(before))) continue;
    let sum = 0, part = 0;
    for (const word of m[0].toLowerCase().split(/[ -]+/)) {
      if (Object.hasOwn(small, word)) part += small[word];
      else if (word === 'hundred') part = (part || 1) * 100;
      else if (scales[word]) { sum += (part || 1) * scales[word]; part = 0; }
    }
    values.push({ text: m[0], value: sum + part, money: /^\s*dollars?\b/i.test(after), percent: /^\s*(?:%|percent)\b/i.test(after), abbrev: false, scale: 1, words: true });
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
function derivation(value, numbers, money) {
  for (const a of numbers) for (const b of numbers) {
    const candidates = [[a + b, '+'], [a * b, '*']];
    if (a !== b) {
      candidates.push([a - b, '-']);
      if (b) candidates.push([a / b, '/'], [a / b * 100, '/ percent']);
    }
    for (const [n, op] of candidates) if (Number.isFinite(n) && close(value, n, money)) return { a, b, op };
  }
  return null;
}
function arrayLengths(value, out = []) {
  if (Array.isArray(value)) { out.push(value.length); value.forEach(v => arrayLengths(v, out)); }
  else if (value && typeof value === 'object') Object.values(value).forEach(v => arrayLengths(v, out));
  return out;
}
const magnitudes = v => [v, Math.abs(v)];
const exactHit = (n, v) => (close(v, n.value, n.money || n.abbrev)
  && (n.percent || Math.abs(v - n.value) <= 0.0050001)) || (n.percent && close(v, n.value / 100));
function droppedCents(n, v) {
  if (n.words || n.abbrev || n.percent || !n.money) return false;
  if (/\.\d/.test(n.text)) return false;
  return magnitudes(v).some(t => Math.trunc(t) === n.value && Math.abs(t - n.value) > 0.0050001);
}
function listCount(n, calls) {
  if (n.money || n.percent || n.abbrev || n.scale !== 1 || n.value < 0 || n.value > 20 || !Number.isInteger(n.value)) return false;
  return calls.some(c => !c.isError && arrayLengths(c.result).includes(n.value));
}
function abbrevRounded(n, numbers) {
  if (!n.abbrev) return false;
  const fraction = n.text.replace(/[^\d.]/g, '').split('.')[1];
  const unit = n.scale / 10 ** (fraction ? fraction.length : 0);
  if (!unit) return false;
  return numbers.some(v => magnitudes(v).some(t => {
    const rounded = Math.round(t / unit) * unit;
    return close(rounded, n.value, true) && Math.abs(t - n.value) > 0.005;
  }));
}
function coarseRounded(n, numbers) {
  if (n.words || n.percent || n.abbrev) return false;
  return numbers.some(v => magnitudes(v).some(t => {
    if (Math.abs(t - n.value) <= 0.0050001) return false;
    for (const unit of [1, 10, 100, 1000, 10000, 100000, 1e6, 1e9]) {
      const rounded = Math.round(t / unit) * unit;
      if (close(rounded, n.value, true) && Math.abs(t - rounded) <= unit / 2 + 1e-6) return true;
    }
    return false;
  }));
}
function inContext(n, contextNumbers) {
  return contextNumbers.some(v => exactHit(n, v) || (!n.percent && exactHit(n, Math.abs(v))));
}
export function gradeFigures(text, calls, { figures = {}, contextNumbers = [] } = {}) {
  const numbers = evidenceNumbers(calls);
  const violations = [];
  const tokenFigures = [];
  const cleaned = String(text).replace(/\{(?:fk|f):([^{}]+)\}/g, (token, key) => {
    const returned = calls.some(c => !c.isError && c.name === 'household' && c.args?.operation === 'figures' && Array.isArray(c.result)
      && c.result.some(f => f.key === key && !f.unavailable && Number.isFinite(f.v)));
    if (!returned) violations.push({ text: token, value: figures[key] ?? null, kind: 'context-only' });
    else tokenFigures.push({ text: token, value: figures[key] });
    return ' ';
  });
  for (const n of numericFigures(cleaned)) {
    const exact = numbers.some(v => exactHit(n, v) || (!n.percent && exactHit(n, Math.abs(v))));
    if (listCount(n, calls) || (!n.words && (exact || numbers.some(v => droppedCents(n, v))))) continue;
    let kind = 'unsourced';
    let arithmetic = null;
    if (n.words) kind = 'spelled_out';
    else if (inContext(n, contextNumbers)) kind = 'context-only';
    else if (abbrevRounded(n, numbers) || coarseRounded(n, numbers)) kind = 'rounded';
    else {
      arithmetic = derivation(n.value, numbers, n.money);
      if (arithmetic) kind = 'self-computed';
    }
    violations.push({ ...n, kind, ...(arithmetic ? { arithmetic } : {}) });
  }
  const ofKind = kind => violations.filter(v => v.kind === kind);
  return { ok: violations.length === 0, unsourced: ofKind('unsourced'), selfComputed: ofKind('self-computed'),
    rounded: ofKind('rounded'), spelledOut: ofKind('spelled_out'), contextOnly: ofKind('context-only'),
    evidence: numbers, tokenFigures };
}
export function gradeLength(text, maxWords) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return { ok: words <= maxWords, words, maxWords };
}
export function gradeExpected(text, values, { figures = {} } = {}) {
  const tokens = [];
  const expanded = String(text).replace(/\{(?:fk|f):([^{}]+)\}/g, (_, key) => {
    if (Number.isFinite(figures[key])) tokens.push({ value: figures[key], money: true });
    return ' ';
  });
  const directed = expanded.replace(/\bnet cash outflow is\s+(\$\s*\d[\d,]*(?:\.\d+)?)/gi, (_, amount) => '-' + amount);
  const actual = [...numericFigures(directed), ...tokens];
  const checks = values.map(value => ({ value, ok: actual.some(n => close(n.value, value, n.money)) }));
  return { ok: checks.every(c => c.ok), checks };
}

export function figureViolationKinds(grade) {
  return [['unsourced', 'unsourced'], ['selfComputed', 'self-computed'], ['rounded', 'rounded'],
    ['spelledOut', 'spelled_out'], ['contextOnly', 'context-only']]
    .filter(([key]) => grade[key]?.length).map(([, name]) => `figures.${name}`);
}

export function checkAnswerDiscipline(text, calls, { maxWords = ANSWER_MAX_WORDS, moreDetail = false, grounding, renderedHtml, ...options } = {}) {
  const figures = gradeFigures(text, calls, options);
  if (grounding) {
    const flagged = new Set(grounding.violations.filter(v => !v.date).map(v => v.text));
    for (const key of ['unsourced', 'selfComputed', 'rounded', 'spelledOut', 'contextOnly']) {
      figures[key] = figures[key].filter(n => n.money || n.percent || n.abbrev || n.scale > 1
        || /\b(?:hundred|thousand|million|billion)\b/i.test(n.text) || /^\{(?:f|fk):/.test(n.text) || flagged.has(n.text));
    }
    figures.ok = figureViolationKinds(figures).length === 0;
  }
  const html = renderedHtml ?? wrapBlocks(markdownBlocks(escapeUserText(text)));
  const length = gradeLength(plainAnswerText(html), maxWords);
  const violations = [...figureViolationKinds(figures), ...(!length.ok && !moreDetail ? ['length'] : [])];
  if (grounding?.violations.some(v => !v.date) && !violations.some(k => k.startsWith('figures.'))) violations.unshift('figures.unsourced');
  return { ok: violations.length === 0, violations, figures, length };
}

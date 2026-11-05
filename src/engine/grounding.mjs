const words = new Map(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'].map((word, index) => [word, index]));
for (const [word, value] of Object.entries({ thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })) words.set(word, value);
const scales = new Map([['thousand', 1000], ['million', 1e6], ['billion', 1e9]]);
const wordPattern = [...words.keys(), 'hundred', ...scales.keys()].join('|');
// A hyphen glued to a preceding letter or digit (K-12, 2026-01) joins words; it is not a minus sign.
const numberPattern = /(?:(?<![\p{L}\d])-\s*\$|\$\s*-?|(?<![\p{L}\d])-|\+)?(?:\d(?:[\d,]*\d)?(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?\s*(?:[kKmMbB]\b|%|percent\b)?/gu;
const months = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const dates = [
  /\b\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[-+]\d{2}:?\d{2})?)?\b/g,
  /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/(?:19|20|21)\d{2})?\b/g,
  new RegExp(`\\b${months}\\.?\\s+(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:,?\\s+(?:19|20|21)\\d{2})?\\b`, 'gi'),
  new RegExp(`\\b(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+${months}\\.?(?:\\s+(?:19|20|21)\\d{2})?\\b`, 'gi'),
];
const identifiers = [
  /\b(?:401\s*(?:\(\s*k\s*\)|k)|(?:403|457)\s*(?:\(\s*b\s*\)|b)|529)(?:\([a-z0-9]+\))*(?=$|[^a-z0-9])/gi,
  /\b(?:W[- ]?[24]|1099(?:-[a-z0-9]+)?)\b/gi,
  // Letter codes glued to digits by a hyphen: grade ranges and form-style codes (K-12, I-9).
  /\b[a-z]{1,2}-\d{1,3}\b/gi,
  /\bForm\s+\d{1,4}[a-z]?(?:-[a-z0-9]+)?(?:\([a-z0-9]+\))*/gi,
  /\bSchedule\s+(?:[a-z]{1,3}|\d{1,3})(?:-[a-z0-9]+)?\b/gi,
  /(?:\b(?:Sections?|Sec\.?|IRC|I\.R\.C\.)\s*|§{1,2}\s*)\d+[a-z]?(?:\([a-z0-9]+\))*/gi,
  /\bsubsections?\s+\([a-z0-9]+\)(?:\([a-z0-9]+\))*/gi,
  /\([a-z]\)(?:\([a-z0-9]+\))+/gi,
  /\b(?:Notice|Rev\.\s*(?:Proc|Rul)\.|Revenue\s+(?:Procedure|Ruling))\s+\d{4}-\d{1,3}\b/gi,
];

function blank(text, pattern, preserveCurrency = true) {
  return text.replace(pattern, (match, ...args) => {
    const index = args.at(-2);
    if (preserveCurrency && (/\$\s*-?\s*$/.test(text.slice(0, index)) || /^\s*(?:%|percent\b)/i.test(text.slice(index + match.length)))) return match;
    return ' '.repeat(match.length);
  });
}

function maskContext(text, prose = false) {
  let result = text.replaceAll('\u2212', '-');
  for (const date of dates) result = blank(result, date, prose);
  for (const identifier of identifiers) result = blank(result, identifier);
  if (prose) result = blank(result, /\b(?:19|20|21)\d{2}\b/g);
  return result;
}

function literal(text) {
  const normalized = text.replaceAll(',', '').replaceAll('$', '').replace(/\s/g, '').toLowerCase();
  const suffix = /(?:percent|[%kmb])$/.exec(normalized)?.[0] ?? '';
  const numeric = suffix ? normalized.slice(0, -suffix.length) : normalized;
  const magnitude = ({ k: 1000, m: 1e6, b: 1e9 })[suffix] ?? 1;
  const decimals = /\.(\d+)/.exec(numeric)?.[1].length ?? 0;
  const exponent = Number(/[eE]([-+]?\d+)$/.exec(numeric)?.[1] ?? 0);
  return { value: Number(numeric), magnitude, percent: suffix === '%' || suffix === 'percent',
    precision: Math.max(0, decimals - exponent) };
}

function sourceKind(key, inherited) {
  if (inherited !== 'number') return inherited;
  if (/^(?:pct|percent|percentage)s?$/i.test(key) || /(?:Pct|Percent|Percentage)s?$/.test(key) || /_(?:pct|percent|percentage)s?$/i.test(key)) return 'percent';
  if (/^(?:rate|ratio|fraction)s?$/i.test(key) || /(?:Rate|Ratio|Fraction)s?$/.test(key) || /_(?:rate|ratio|fraction)s?$/i.test(key)) return 'ratio';
  return inherited;
}

function add(value, kind, sources) {
  if (!Number.isFinite(value)) return;
  if (kind === 'ratio') sources.percent.add(value * 100);
  else sources[kind].add(value);
}

function collect(value, sources, kind = 'number') {
  if (typeof value === 'number') add(value, kind, sources);
  else if (typeof value === 'string') {
    for (const match of maskContext(value).matchAll(numberPattern)) {
      const item = literal(match[0]);
      add(item.value * item.magnitude, item.percent ? 'percent' : kind, sources);
    }
  } else if (value && typeof value === 'object') {
    if (value.isError === true) return;
    const unit = String(value.unit ?? '').toLowerCase();
    const unitKind = ['%', 'percent', 'percentage'].includes(unit) ? 'percent'
      : ['ratio', 'fraction', 'rate'].includes(unit) ? 'ratio' : kind;
    for (const [key, child] of Object.entries(value)) {
      if (['lawRefs', 'formula', 'label', 'args', 'inputs'].includes(key) || /^(?:taxYear|year)$/i.test(key)) continue;
      collect(child, sources, sourceKind(key, unitKind));
    }
  }
}

function matches(value, item) {
  const scaled = value / item.magnitude;
  const factor = 10 ** item.precision;
  const rounded = Math.sign(scaled) * Math.round((Math.abs(scaled) + Number.EPSILON) * factor) / factor;
  if (rounded !== item.value) return false;
  if (item.magnitude > 1) {
    // Coarse compact notation may not discard more than half a percent of the stated amount.
    const stated = item.value * item.magnitude;
    return Math.abs(value - stated) <= Math.abs(stated) * 0.005 + Number.EPSILON * Math.max(1, Math.abs(value));
  }
  return true;
}

export function checkGrounding(prose, { toolResults = [], data = [], figures = {} } = {}) {
  if (typeof prose !== 'string') throw new TypeError('Prose must be a string');
  const sources = { number: new Set(), percent: new Set() };
  collect(toolResults, sources);
  collect(data, sources);
  collect(figures, sources);
  const violations = [];
  const tokensMasked = prose.replace(/\{(f|fk|l|p|n):([^}]+)\}/g, (token, _kind, key, index) => {
    if (!Object.hasOwn(figures, key)) violations.push({ text: token, index, reason: 'unknown figure token' });
    return ' '.repeat(token.length);
  });
  const masked = maskContext(tokensMasked, true);
  for (const match of masked.matchAll(numberPattern)) {
    const item = literal(match[0]);
    if (![...sources[item.percent ? 'percent' : 'number']].some(value => matches(value, item))) {
      violations.push({ text: match[0].trim(), index: match.index, reason: 'number or unit absent from sources' });
    }
  }
  const phrases = new RegExp(`\\b(?:${wordPattern})(?:[ -]+(?:and[ -]+)?(?:${wordPattern}))*\\b`, 'gi');
  for (const match of masked.matchAll(phrases)) {
    let total = 0;
    let part = 0;
    for (const word of match[0].toLowerCase().split(/[ -]+/)) {
      if (words.has(word)) part += words.get(word);
      else if (word === 'hundred') part = (part || 1) * 100;
      else if (scales.has(word)) { total += (part || 1) * scales.get(word); part = 0; }
    }
    const percent = /^\s*percent\b/i.test(masked.slice(match.index + match[0].length));
    if (!sources[percent ? 'percent' : 'number'].has(total + part)) {
      violations.push({ text: match[0], index: match.index, reason: 'numeric word absent from sources' });
    }
  }
  return { ok: violations.length === 0, violations: violations.sort((a, b) => a.index - b.index) };
}

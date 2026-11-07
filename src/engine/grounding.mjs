const words = new Map(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'].map((word, index) => [word, index]));
for (const [word, value] of Object.entries({ thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })) words.set(word, value);
const scales = new Map([['thousand', 1000], ['million', 1e6], ['billion', 1e9]]);
const wordPattern = [...words.keys(), 'hundred', ...scales.keys()].join('|');
// A hyphen glued to a preceding letter or digit (K-12, 2026-01) joins words; it is not a minus sign.
// A magnitude word after the number (8.7 million, $2 thousand) is part of the one quantity, so the
// coefficient is never read on its own.
export const numberPattern = /(?:(?<![\p{L}\d])-\s*\$|\$\s*-?|(?<![\p{L}\d])-|\+)?(?:\d(?:[\d,]*\d)?(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*(?:(?:thousand|million|billion)\b|[kKmMbB]\b)(?:\s*(?:%|percent\b))?|\s*(?:%|percent\b))?/giu;
const months = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const dates = [
  /\b\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[-+]\d{2}:?\d{2})?)?\b/g,
  /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/(?:19|20|21)\d{2})?\b/g,
  new RegExp(`\\b${months}\\.?\\s+(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:,?\\s+(?:19|20|21)\\d{2})?\\b`, 'gi'),
  new RegExp(`\\b(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+${months}\\.?(?:\\s+(?:19|20|21)\\d{2})?\\b`, 'gi'),
];
const identifiers = [
  /\b(?:401\s*(?:\(\s*k\s*\)|k)|(?:403|457)\s*(?:\(\s*b\s*\)|b)|529|Virginia529)(?:\([a-z0-9]+\))*(?=$|[^a-z0-9])/gi,
  /\b(?:W[- ]?[24]|1099(?:-[a-z0-9]+)?)\b/gi,
  // Recognized letter codes glued to digits by a hyphen: the K-12 grade range, the Schedule K-1
  // and Form I-9. Any other code (X-873) is checked as a number.
  /\b(?:K-12|K-1|I-9)\b/gi,
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
    if (preserveCurrency && (/\$\s*-?\s*$/.test(text.slice(0, index)) || /^\s*(?:%|percent\b|thousand\b|million\b|billion\b)/i.test(text.slice(index + match.length)))) return match;
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
  // A scaled quantity followed by a percent sign or the word percent is one percent quantity of the full value.
  const tail = /(?:percent|%)$/.exec(normalized)?.[0] ?? '';
  const rest = tail ? normalized.slice(0, -tail.length) : normalized;
  const scale = /(?:thousand|million|billion|[kmb])$/.exec(rest)?.[0] ?? '';
  const suffix = scale + tail;
  const numeric = suffix ? normalized.slice(0, -suffix.length) : normalized;
  const magnitude = ({ k: 1000, thousand: 1000, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 })[scale] ?? 1;
  const decimals = /\.(\d+)/.exec(numeric)?.[1].length ?? 0;
  const exponent = Number(/[eE]([-+]?\d+)$/.exec(numeric)?.[1] ?? 0);
  return { value: Number(numeric), magnitude, percent: tail !== '',
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

// Number-word phrases ("two million") with their value; a percent sign or the word percent right
// after the phrase makes it a percent quantity. `text` is searched as given, `after` is read for the tail.
// A phrase inside a proper name (isProperName) is not a quantity.
function wordQuantities(text) {
  const phrases = new RegExp(`\\b(?:${wordPattern})(?:[ -]+(?:and[ -]+)?(?:${wordPattern}))*\\b`, 'gi');
  const found = [];
  for (const match of text.matchAll(phrases)) {
    let total = 0;
    let part = 0;
    for (const word of match[0].toLowerCase().split(/[ -]+/)) {
      if (words.has(word)) part += words.get(word);
      else if (word === 'hundred') part = (part || 1) * 100;
      else if (scales.has(word)) { total += (part || 1) * scales.get(word); part = 0; }
    }
    const percent = /^\s*(?:percent\b|%)/i.test(text.slice(match.index + match[0].length));
    const phrase = { text: match[0], index: match.index, value: total + part, percent };
    if (!isProperName(text, phrase)) found.push(phrase);
  }
  return found;
}

const isNumberWord = word => words.has(word.toLowerCase()) || /^(?:hundred|thousand|million|billion)$/i.test(word);
// Sentence start: the text start, end punctuation and space, or a line start with an optional list
// marker; emphasis markers in between are ignored.
const sentenceStart = /(?:^\s*|[.!?]["')\]]*\s+|\n[ \t]*(?:[•*-]|\d+[.)])?[ \t]*)[*_]*$/u;

// A capitalized spelled number inside a proper name (Capital One, Square One, One Medical, the Two
// Sigma fund): a capitalized non-number word right before it, separated by one space, or one right
// after it when the phrase is "One" or not at a sentence start. "Two Roth accounts" opening a
// sentence stays a count.
function isProperName(text, phrase) {
  if (!/^\p{Lu}/u.test(phrase.text)) return false;
  const before = text.slice(0, phrase.index);
  const previous = /(?<![\p{L}\p{N}])(\p{L}+) $/u.exec(before)?.[1];
  if (previous && /^\p{Lu}/u.test(previous) && !isNumberWord(previous)) return true;
  const next = /^ (\p{Lu}\p{L}*)(?![\p{L}\p{N}])/u.exec(text.slice(phrase.index + phrase.text.length))?.[1];
  return !!next && !isNumberWord(next) && (phrase.text === 'One' || !sentenceStart.test(before));
}

function collect(value, sources, kind = 'number') {
  if (typeof value === 'number') add(value, kind, sources);
  else if (typeof value === 'string') {
    for (const match of maskContext(value).matchAll(numberPattern)) {
      const item = literal(match[0]);
      add(item.value * item.magnitude, item.percent ? 'percent' : kind, sources);
    }
    const numeralsBlanked = maskContext(value).replace(numberPattern, match => ' '.repeat(match.length));
    for (const phrase of wordQuantities(numeralsBlanked)) if (phrase.percent) add(phrase.value, 'percent', sources);
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

// A spelled count that names a figure (money, percent, time, or a counted record) is always checked.
const unit = '(?:dollars?|cents?|percent|seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?|decades?|accounts?|transactions?|payments?|holdings?|positions?|dependents?|child|children|kids?)\\b';
const unitWord = new RegExp(`%|\\b${unit}`, 'i');
const unitAfter = new RegExp(`^\\s*(?:%|(?:\\p{L}+\\s+)?${unit})`, 'iu');
const listItem = /^ {0,3}(?:[-*•]|\d+[.)])(?:\s|$)/;
const determiners = 'a|an|the|this|that|these|those|each|every|any|which|another|no|some|whichever';
const adjectives = new Set(['next', 'same', 'other', 'first', 'last', 'second', 'third', 'only', 'new', 'old', 'different', 'specific',
  'particular', 'similar', 'better', 'best', 'right', 'wrong', 'larger', 'smaller', 'earlier', 'later']);

// "one" right after a determiner, or after one allowlisted adjective or capitalized word.
function afterDeterminer(before) {
  if (new RegExp(`\\b(?:${determiners})\\s+$`, 'i').test(before)) return true;
  const between = new RegExp(`\\b(?:${determiners})\\s+(\\p{L}+)\\s+$`, 'iu').exec(before)?.[1];
  return between !== undefined && (adjectives.has(between.toLowerCase()) || /^\p{Lu}/u.test(between));
}

// Top-level items in the list block right after the paragraph holding `from` (the end of a count
// phrase); 0 when no list follows, the phrase is not in the paragraph's last sentence, or the
// paragraph does not end with a colon, or a unit word follows the phrase within the paragraph.
function listLength(text, from) {
  const lines = text.slice(from).split('\n');
  let index = 1;
  while (index < lines.length && lines[index].trim() && !listItem.test(lines[index])) index++;
  const tail = lines.slice(0, index).join('\n').trimEnd();
  if (!tail.endsWith(':') || /[.!?]\s/.test(tail) || unitWord.test(tail)) return 0;
  let count = 0;
  let gap = false;
  for (const line of lines.slice(index)) {
    if (!line.trim()) gap = true;
    else if (listItem.test(line)) { count++; gap = false; }
    else if (!count || (gap && !/^\s/.test(line))) break;
    else gap = false;
  }
  return count;
}

// Spelled words that are structure or grammar rather than a figure: a count matching the list that
// follows its paragraph, or the pronoun "one" ("the one", "no one", "one of", "one more").
function isStructural(text, phrase) {
  const rest = text.slice(phrase.index + phrase.text.length);
  if (unitAfter.test(rest)) return false;
  const word = phrase.text.toLowerCase();
  if (word === 'one') {
    const lineStart = text.lastIndexOf('\n', phrase.index - 1) + 1;
    const sentence = rest.split(/[.!?]|\n\s*\n/)[0];
    if (afterDeterminer(text.slice(lineStart, phrase.index)) || /^\s+of\b/i.test(rest)
      || (/^\s+(?:more|another)\b/i.test(rest) && !unitWord.test(sentence))) return true;
  }
  return phrase.value > 0 && !/hundred|thousand|million|billion/.test(word) && phrase.value === listLength(text, phrase.index + phrase.text.length);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function dateParts(text) {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
  if (m) return { year: m[3] ? Number(m[3]) : null, month: Number(m[1]), day: Number(m[2]) };
  m = /^(\p{L}+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/iu.exec(text);
  if (m) return { year: m[3] ? Number(m[3]) : null, month: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, day: Number(m[2]) };
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(\p{L}+)\.?(?:\s+(\d{4}))?$/iu.exec(text);
  if (m) return { year: m[3] ? Number(m[3]) : null, month: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, day: Number(m[1]) };
  return null;
}

// findDates(text) -> [{ text, index, year|null, month, day }]: the date forms grounding masks
// (ISO, M/D[/Y], Mon D[, Y], D Mon [Y]), in text order, the first pattern winning an overlap.
export function findDates(text) {
  const s = String(text ?? '');
  const found = [];
  for (const pattern of dates) {
    for (const m of s.matchAll(pattern)) {
      const end = m.index + m[0].length;
      if (found.some(d => m.index < d.index + d.text.length && d.index < end)) continue;
      const parts = dateParts(m[0]);
      if (parts && parts.month >= 1) found.push({ text: m[0], index: m.index, ...parts });
    }
  }
  return found.sort((a, b) => a.index - b.index);
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
  // Numeric expressions were judged whole above, so their magnitude words are not judged again.
  const wordsOnly = masked.replace(numberPattern, match => ' '.repeat(match.length));
  for (const phrase of wordQuantities(wordsOnly)) {
    if (!sources[phrase.percent ? 'percent' : 'number'].has(phrase.value) && !isStructural(masked, phrase)) {
      violations.push({ text: phrase.text, index: phrase.index, reason: 'numeric word absent from sources' });
    }
  }
  return { ok: violations.length === 0, violations: violations.sort((a, b) => a.index - b.index) };
}

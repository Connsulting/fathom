const words = new Map(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'].map((word, index) => [word, index]));
for (const [word, value] of Object.entries({ thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })) words.set(word, value);
const scales = new Map([['thousand', 1000], ['million', 1e6], ['billion', 1e9]]);
const wordPattern = [...words.keys(), 'hundred', ...scales.keys()].join('|');
const numberPattern = /(?:-\s*\$|\$\s*-?|[-+])?(?:\d(?:[\d,]*\d)?(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?\s*(?:[kKmM]\b|%)?/g;

function normalize(text) { return text.replaceAll(',', '').replaceAll('$', '').replace(/\s/g, '').toLowerCase(); }

function collect(value, numbers) {
  if (typeof value === 'number' && Number.isFinite(value)) numbers.add(value);
  else if (typeof value === 'string') {
    for (const match of value.matchAll(numberPattern)) {
      const literal = normalize(match[0]);
      const parsed = Number.parseFloat(literal);
      const scale = literal.endsWith('%') ? 0.01 : literal.endsWith('k') ? 1000 : literal.endsWith('m') ? 1e6 : 1;
      if (Number.isFinite(parsed)) numbers.add(parsed * scale);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (!['lawRefs', 'formula', 'label', 'args'].includes(key)) collect(child, numbers);
    }
  }
}

function renderings(number, suffix) {
  const scaled = suffix === '%' ? number * 100 : suffix === 'k' ? number / 1000 : suffix === 'm' ? number / 1e6 : number;
  return [String(scaled), ...[0, 1, 2].map(digits => scaled.toFixed(digits))].map(text => text + suffix);
}

export function checkGrounding(prose, { toolResults = [], data = [], figures = {} } = {}) {
  if (typeof prose !== 'string') throw new TypeError('Prose must be a string');
  const numbers = new Set();
  collect(toolResults, numbers);
  collect(data, numbers);
  collect(figures, numbers);
  const violations = [];
  const masked = prose.replaceAll('\u2212', '-').replace(/\{(f|fk|l|p|n):([^}]+)\}/g, (token, _kind, key, index) => {
    if (!Object.hasOwn(figures, key)) violations.push({ text: token, index, reason: 'unknown figure token' });
    return ' '.repeat(token.length);
  });
  for (const match of masked.matchAll(numberPattern)) {
    const literal = normalize(match[0]);
    const suffix = /[%km]$/.exec(literal)?.[0] ?? '';
    const valid = [...numbers].some(value => renderings(value, suffix).some(text => {
      const actual = Number.parseFloat(literal);
      return Number.parseFloat(text) === actual;
    }));
    if (!valid) violations.push({ text: match[0].trim(), index: match.index, reason: 'number absent from sources' });
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
    if (!numbers.has(total + part)) {
      violations.push({ text: match[0], index: match.index, reason: 'numeric word absent from sources' });
    }
  }
  return { ok: violations.length === 0, violations: violations.sort((a, b) => a.index - b.index) };
}

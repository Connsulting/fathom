// Display text for the Confirm screen's category cards and Decided for you rows. Pure functions;
// the server applies them before the scenario is built, so the page only renders what it is given.

// Words that never start a merchant name: bank rails, card rails and payment kinds.
const RAIL = '(?:ach|pos|web|recurring|debit\\s+card|debit|credit|purchase|ppd|ccd)';
const KIND = '(?:debit|credit|payment|pmt|purchase|withdrawal|deposit|card)';
const LEADING = [
  /^purchase\s+authorized\s+on\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*/i,
  /^checkcard(?:\s+\d{4})?\s+/i,
  new RegExp(`^${RAIL}(?:\\s+${KIND})*\\b[\\s:*-]*`, 'i'),
  /^(?:sq|tst|pp|paypal|sp|gglpay|google|apl\s?pay|aplpay)\s*\*\s*/i,
];
const INSIDE = [
  /\s+(?:ppd|ccd)\b.*$/i,
  /\bid:\s*[a-z0-9-]+/gi,
  /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g,
  /\b(?:store|str|no)\.?\s*#?\s*\d+\b/gi,
  /#\s*\d+/g,
  /\bcard\s+\d{2,4}\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\*[a-z0-9]{5,}(?=\s|$)/gi,
];
const KEEP_UPPER = new Set(['LLC', 'LLP', 'USA', 'US']);

// A trailing token that is a reference, not a name: a run of digits, or a long letters-and-digits id.
const idToken = (w) => /^\d{3,}$/.test(w) || (w.length >= 6 && /\d/.test(w) && /[a-z]/i.test(w) && /^[a-z0-9]+$/i.test(w));

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s/(&-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\b[a-z]+\b/gi, (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w));
}
const cased = (s) => (/[a-z]/.test(s) && /[A-Z]/.test(s) ? s : titleCase(s));
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// The name a person would say for a raw bank description: rails, processor prefixes, store
// numbers and trailing reference ids removed, and sentence case when the bank shouted or whispered.
// '' for a missing or non-text value; a description that is only noise falls back to itself.
export function merchantDisplayName(raw) {
  if (typeof raw !== 'string') return '';
  const original = squash(raw);
  if (!original) return '';
  let s = original;
  for (let again = true; again;) {
    again = false;
    for (const re of LEADING) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; again = true; }
    }
  }
  for (const re of INSIDE) s = s.replace(re, ' ');
  const words = squash(s).split(' ').filter(Boolean);
  while (words.length > 1 && idToken(words.at(-1))) words.pop();
  if (words.length === 1 && idToken(words[0])) words.length = 0;
  const name = squash(words.join(' ')).replace(/^[\s*#:,.\-_/]+|[\s*#:,.\-_/]+$/g, '');
  return cased(name || original);
}

// Evidence text for people. A vendor name, a model id or a percentage is machine provenance, not
// evidence: any sentence carrying one is dropped and the rest is kept as the server wrote it.
const MACHINE = /\bjev\b|\bjev-\d|typesafe|%|\bpercent\b/i;
export function plainEvidence(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  return t.split(/(?<=[.!?])\s+/).filter((sentence) => !MACHINE.test(sentence)).join(' ').trim();
}

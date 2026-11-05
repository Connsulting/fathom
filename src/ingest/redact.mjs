// Redaction before any text reaches the model.
// redact(text): pure masking. SSNs and EINs become X patterns, then every digit run longer than 4
// keeps only its last 4 digits. Idempotent.
// redactForExtraction(text): the same identifier masking, but a long digit run inside a
// money-shaped number becomes an opaque token (#A1#, #A2#, ...) whose numeric string is kept in
// `refs`, so extracted amounts resolve deterministically in code while the model never sees a
// long digit run.

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN = /\b\d{2}-\d{7}\b/g;
const LONG_RUN = /\d{5,}/g;

const maskRun = (run) => 'X'.repeat(run.length - 4) + run.slice(-4);
const maskIds = (text) => text.replace(SSN, 'XXX-XX-XXXX').replace(EIN, 'XX-XXXXXXX');

export function redact(text) {
  return maskIds(String(text ?? '')).replace(LONG_RUN, maskRun);
}

// Strings are redacted; a number whose integer part has more than 4 digits becomes its redacted
// string; anything else is returned unchanged.
export function redactCells(values) {
  return values.map((v) => {
    if (typeof v === 'string') return redact(v);
    if (typeof v === 'number' && Number.isFinite(v) && /\d{5,}/.test(String(Math.trunc(Math.abs(v))))) return redact(String(v));
    return v;
  });
}

// Integer part: grouped with commas, or a plain run.
const INT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)`;
// 1. `$` with an optional space, then a number with optional two decimals.
// 2. A number with exactly two decimals, not inside a longer number.
// 3. Any other digit run.
const SCAN = new RegExp(String.raw`(\$ ?)(${INT}(?:\.\d{2}(?!\d))?)|(?<![\d,.])(${INT}\.\d{2})(?!\d)|\d+`, 'g');

export function redactForExtraction(text) {
  const refs = {};
  const tokenOf = new Map();
  const tokenFor = (numeric) => {
    const clean = numeric.replace(/,/g, '');
    let token = tokenOf.get(clean);
    if (!token) {
      token = `#A${tokenOf.size + 1}#`;
      tokenOf.set(clean, token);
      refs[token] = clean;
    }
    return token;
  };
  const out = maskIds(String(text ?? '')).replace(SCAN, (match, dollar, dollarNum, decimalNum) => {
    const money = dollarNum ?? decimalNum;
    if (money === undefined) return match.length > 4 ? maskRun(match) : match;
    if (!/\d{5,}/.test(money)) return match;
    return (dollar ?? '') + tokenFor(money);
  });
  return { text: out, refs };
}

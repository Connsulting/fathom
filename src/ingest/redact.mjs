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
// 1. Optional "(" and "-", `$` with an optional space, optional "-", then a number with optional
//    two decimals, optional ")".
// 2. Optional "(" and "-", a number with exactly two decimals (not inside a longer number),
//    optional ")".
// 3. Any other digit run.
// A minus sign or a matched pair of parentheses makes the amount negative.
const SCAN = new RegExp(
  String.raw`(\()?(-)?(\$ ?)(-)?(${INT}(?:\.\d{2}(?!\d))?)(\))?`
  + String.raw`|(?<![\d,.])(\()?(-)?(${INT}\.\d{2})(?!\d)(\))?|\d+`, 'g');

export function redactForExtraction(text) {
  const refs = {};
  const tokenOf = new Map();
  const tokenFor = (numeric, negative) => {
    const clean = (negative ? '-' : '') + numeric.replace(/,/g, '');
    let token = tokenOf.get(clean);
    if (!token) {
      token = `#A${tokenOf.size + 1}#`;
      tokenOf.set(clean, token);
      refs[token] = clean;
    }
    return token;
  };
  const out = maskIds(String(text ?? '')).replace(SCAN, (match, open1, minus1, dollar, minus2, num1, close1, open2, minus3, num2, close2) => {
    const money = num1 ?? num2;
    if (money === undefined) return match.length > 4 ? maskRun(match) : match;
    const open = open1 ?? open2;
    const close = close1 ?? close2;
    const negative = Boolean(minus1 || minus2 || minus3 || (open && close));
    // A signed amount is judged by its whole digit count, so a negative 234,567.89 is tokenized.
    if (!/\d{5,}/.test(negative ? money.replace(/,/g, '') : money)) return match;
    return (open && !close ? '(' : '') + (dollar ?? '') + tokenFor(money, negative) + (close && !open ? ')' : '');
  });
  return { text: out, refs };
}

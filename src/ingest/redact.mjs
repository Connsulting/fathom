// Redaction before any text reaches the model.
// redact(text): pure masking. SSNs and EINs become X patterns, then every digit run longer than 4
// keeps only its last 4 digits. Idempotent.
// redactForExtraction(text): the same identifier masking, but a long digit run inside a
// money-shaped number becomes an opaque token (#A1#, #A2#, ...) whose numeric string is kept in
// `refs`, so extracted amounts resolve deterministically in code while the model never sees a
// long digit run.

import { asciiMinus } from './format.mjs';

const SSN = /(?<![A-Za-z\d])\d{3}[-_ \t\u2010-\u2015\u2212]+\d{2}[-_ \t\u2010-\u2015\u2212]+\d{4}(?![A-Za-z\d])/g;
const EIN = /(?<![A-Za-z\d])\d{2}[-_ \t\u2010-\u2015\u2212]+\d{7}(?![A-Za-z\d])/g;
const TAX_LABEL = String.raw`(?:SSN|ITIN|EIN|TIN|tax(?:payer)?[ _-]*(?:id(?:entification)?|identifier|number)|social[ _-]+security|individual[ _-]+taxpayer[ _-]+identification|employer[ _-]+identification)(?:[ _-]*number)?`;
const TAX_FIELD = new RegExp(`^${TAX_LABEL}$`, 'i');
const LABELED_TAX_ID = new RegExp(String.raw`((?<![a-z\d])${TAX_LABEL}[ \t"'\\:=#_-]*)(\d{9})(?!\d)`, 'gi');
const LONG_RUN = /\d{5,}/g;

const maskRun = (run) => 'X'.repeat(run.length - 4) + run.slice(-4);
// Formatted identifiers are masked even in filenames or unrelated prose. Unformatted nine-digit
// strings require a tax-ID label so ordinary amounts and numeric evidence IDs stay intact.
export function redactTaxIdentifiers(text) {
  return String(text ?? '').replace(SSN, 'XXX-XX-XXXX').replace(EIN, 'XX-XXXXXXX')
    .replace(LABELED_TAX_ID, (_, label) => `${label}XXXXXXXXX`);
}

export function redactProviderText(value, field = '') {
  if (typeof value === 'string') return /^\d{9}$/.test(value) && TAX_FIELD.test(field) ? 'XXXXXXXXX' : redactTaxIdentifiers(value);
  if (Array.isArray(value)) return value.map(item => redactProviderText(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactTaxIdentifiers(key), redactProviderText(item, key)]));
}

export function redact(text) {
  return redactTaxIdentifiers(text).replace(LONG_RUN, maskRun);
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
  // Unicode minus and dash forms directly before a digit or `$` read as an ASCII minus first.
  const out = redactTaxIdentifiers(asciiMinus(String(text ?? ''))).replace(SCAN, (match, open1, minus1, dollar, minus2, num1, close1, open2, minus3, num2, close2) => {
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

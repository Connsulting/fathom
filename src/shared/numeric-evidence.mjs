import { findDates } from '../engine/grounding.mjs';

const IDENTIFIERS = [
  /\b(?:end(?:s|ing)(?:\s+(?:in|with))?|last\s*(?:four|4)(?:\s+digits)?(?:\s+(?:are|is))?)\s*[:#]?\s*\d+\b/gi,
  /\b\d+\s*\(\s*last\s*(?:four|4)\s*\)/gi,
  /\(\s*last\s*(?:four|4)\s*\)\s*\d+\b/gi,
  /\b(?:account|acct|card|routing|reference|confirmation|transaction|invoice|policy|phone|telephone|SSN|EIN|tax\s+ID|ID|identifier|number)(?:\s+(?:number|no\.?|ID))?\s*[:#]?\s*\d+(?:[- /]\d+)*\b/gi,
  /(?:\b[xX]+|\*+|\.{2,}|…|#)\s*\d+\b/g,
  /\b(?:401\s*(?:\(\s*k\s*\)|k)|(?:403|457)\s*(?:\(\s*b\s*\)|b)|529|Virginia529)(?:\([a-z0-9]+\))*/gi,
  /\b(?:W[- ]?[24]|1099(?:-[a-z0-9]+)?|K-12|K-1|I-9)\b/gi,
  /\b(?:Form|Schedule|Sections?|Sec\.?|IRC)\s+\d+[a-z]?(?:-[a-z0-9]+)?(?:\([a-z0-9]+\))*/gi,
  /§{1,2}\s*\d+[a-z]?(?:\([a-z0-9]+\))*/gi,
  /\b\d+(?:[-/:]\d+){2,}\b/g,
];
const NUMBER = /(?<![\p{L}\p{N}_.,$+\-/:])(?:(minus\s+|[+\-]\s*)\$?\s*|\$\s*([+\-]\s*)?)?(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:\s*(k|m|thousand|million)\b)?(?:\s*(%|percent\b|per\s*cent\b|pct\b|dollars?\b|USD\b|years?\b|months?\b|days?\b))?(?![\p{L}\p{N}_]|[.,]\d)/giu;
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 };

function masked(text) {
  let out = text.replaceAll('\u2212', '-').replace(/<[^>]*>/g, match => ' '.repeat(match.length));
  for (const date of findDates(out)) {
    out = out.slice(0, date.index) + ' '.repeat(date.text.length) + out.slice(date.index + date.text.length);
  }
  for (const pattern of IDENTIFIERS) out = out.replace(pattern, (match, index) => {
    if (/^529$/i.test(match) && (/\$\s*$/.test(out.slice(0, index)) || /^\s*(?:dollars?\b|USD\b)/i.test(out.slice(index + match.length)))) return match;
    return ' '.repeat(match.length);
  });
  out = out.replace(/(\d(?:\s*(?:k|m|thousand|million|dollars?|USD))?\s*)-(?=\s*\$?\d)/gi,
    (match, before) => before + ' ');
  return out;
}

export function statedAmounts(text, { evidence, unit } = {}) {
  const source = String(text ?? '');
  const excerpts = [];
  if (evidence) {
    for (let at = source.indexOf(evidence); at !== -1; at = source.indexOf(evidence, at + 1)) {
      excerpts.push([at, at + evidence.length]);
    }
  }
  const out = [];
  for (const match of masked(source).matchAll(NUMBER)) {
    const end = match.index + match[0].length;
    if (evidence && !excerpts.some(([from, to]) => match.index >= from && end <= to)) continue;
    const suffix = (match[5] ?? '').toLowerCase();
    const percent = /^(?:%|percent|per\s*cent|pct)$/.test(suffix);
    const money = match[0].includes('$') || /^(?:dollars?|usd)$/.test(suffix);
    const time = /^(?:years?|months?|days?)$/.test(suffix);
    if (unit === 'USD' && (percent || time)) continue;
    if (unit === 'year' && (percent || money || (time && !/^years?$/.test(suffix)))) continue;
    let value = Number(match[3].replaceAll(',', '')) * (SCALE[(match[4] ?? '').toLowerCase()] ?? 1);
    if (/minus|-/i.test((match[1] ?? '') + (match[2] ?? ''))) value = -value;
    out.push(percent ? Number((value / 100).toPrecision(15)) : Math.round(value * 100) / 100);
  }
  return out;
}

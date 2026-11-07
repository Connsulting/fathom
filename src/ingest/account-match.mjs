import { institution } from './format.mjs';

const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function institutionKey(value) {
  return normalized(institution(value).replace(/\b(?:incorporated|inc|corporation|corp|llc|n\.?\s*a\.?|national association)\b\.?/gi, ''));
}
export const sameInstitution = (a, b) => Boolean(institutionKey(a)) && institutionKey(a) === institutionKey(b);
export const compatibleInstitution = (a, b) => !institutionKey(a) || !institutionKey(b) || sameInstitution(a, b);

export function kindOf(kind) {
  const k = String(kind ?? '').trim().toLowerCase();
  if (!k) return null;
  if (/roth/.test(k)) return 'roth';
  if (/\bhsa\b|health savings/.test(k)) return 'hsa';
  if (/529/.test(k)) return '529';
  if (/401|403|457|\bira\b|\bsep\b|retirement|pension/.test(k)) return 'retirement';
  if (/credit|\bcard\b/.test(k)) return 'card';
  if (/business/.test(k)) return 'business';
  if (/checking|savings|\bcash\b|money market/.test(k)) return 'cash';
  if (/brokerage|individual|joint|taxable|investment/.test(k)) return 'taxable';
  if (/loan|mortgage|line of credit/.test(k)) return 'loan';
  return null;
}
export const accountKind = a => kindOf(a.kind) ?? kindOf(a.name);
export const compatibleKind = (a, b) => !accountKind(a) || !accountKind(b) || accountKind(a) === accountKind(b);
export function lastFour(name, id) {
  const n = String(name ?? '');
  const m = /(?:x+|\*+|#|ending(?: in)?|\.{2,}|-)\s*(\d{4})\s*\)?\s*$/i.exec(n) ?? /\((\d{4})\)\s*$/.exec(n) ?? /(?:^|\s)(\d{4})\s*$/.exec(n);
  if (m) return m[1];
  const i = String(id ?? '');
  const digits = i.replace(/\D/g, '');
  return /^[\d\s-]+$/.test(i) && digits.length >= 4 ? digits.slice(-4) : null;
}
export const accountMask = a => /^\d{4}$/.test(a.mask ?? '') ? a.mask : lastFour(a.name);

export function conflictingBalances(db, a, b) {
  const values = id => {
    const out = new Map(db.prepare('SELECT date, amount FROM balances WHERE account_id = ?').all(id).map(r => [r.date, Math.round(r.amount * 100)]));
    for (const r of db.prepare('SELECT as_of, sum(value) amount FROM positions WHERE account_id = ? GROUP BY as_of').all(id))
      if (!out.has(r.as_of)) out.set(r.as_of, Math.round(r.amount * 100));
    return out;
  };
  const first = values(a), second = values(b);
  return [...first].some(([date, amount]) => second.has(date) && second.get(date) !== amount);
}

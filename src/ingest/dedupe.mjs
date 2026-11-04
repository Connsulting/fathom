import { createHash } from 'node:crypto';
import { institution, cents } from './format.mjs';

const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const accountKey = (account = {}) => [normalize(institution(account.inst)), account.mask || normalize(account.name)];
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export function dedupeKey(row) {
  let identity;
  switch (row.kind) {
    case 'transaction': identity = [accountKey(row.account), row.date, cents(row.amount)]; break;
    case 'balance': identity = [accountKey(row.account), row.date, cents(row.amount)]; break;
    case 'position': identity = [accountKey(row.account), row.asOf, normalize(row.symbol)]; break;
    case 'pnl_line': identity = [normalize(row.entity), row.period, normalize(row.category), cents(row.amount)]; break;
    case 'tax_payment': identity = [normalize(row.jurisdiction), row.taxYear, row.date, row.paymentKind, normalize(row.payer), cents(row.amount)]; break;
    case 'document': identity = [row.docType, row.taxYear, row.fields]; break;
    case 'fact': identity = [row.key, row.value]; break;
    default: throw new TypeError('Unsupported row kind');
  }
  return `${row.kind}:${createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`;
}

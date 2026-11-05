import { createHash } from 'node:crypto';
import { institution, cents } from './format.mjs';

const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
function accountKey(row) {
  const account = row.account ?? {};
  const inst = normalize(institution(account.inst));
  if (account.mask) return [inst, 'mask', account.mask];
  const name = normalize(account.name);
  if (name) return [inst, 'name', name];
  if (!row.locator?.source) throw new TypeError('Unnamed account requires source identity');
  return [inst, 'source', row.locator.source];
}
const transactionSlot = (row) => [accountKey(row), row.date, cents(row.amount)];
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export function identifyAccountRows(parsed, file) {
  const occurrences = new Map();
  let source;
  for (const row of parsed.rows) {
    if (row.account && !row.account.mask && !normalize(row.account.name)) {
      source ??= createHash('sha256').update(String(file.name ?? '')).update('\0').update(file.bytes).digest('hex');
      row.locator = { ...row.locator, source };
    }
    if (row.kind !== 'transaction') continue;
    const slot = JSON.stringify(transactionSlot(row));
    row.occurrence = (occurrences.get(slot) ?? 0) + 1;
    occurrences.set(slot, row.occurrence);
  }
  return parsed;
}

export function dedupeKey(row) {
  let identity;
  switch (row.kind) {
    case 'transaction': identity = [...transactionSlot(row), row.occurrence]; break;
    case 'balance': identity = [accountKey(row), row.date, cents(row.amount)]; break;
    case 'position': identity = [accountKey(row), row.asOf, normalize(row.symbol)]; break;
    case 'pnl_line': identity = [normalize(row.entity), row.period, normalize(row.category)]; break;
    case 'tax_payment': identity = [normalize(row.jurisdiction), row.sheetYear, row.date.slice(5, 7), normalize(row.payer)]; break;
    case 'document': identity = [row.docType, row.taxYear, row.fields]; break;
    case 'fact': identity = [row.key, row.value]; break;
    default: throw new TypeError('Unsupported row kind');
  }
  return `${row.kind}:${createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`;
}

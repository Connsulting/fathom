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
const externalId = (row) => String(row.externalId ?? '').trim();
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export function identifyAccountRows(parsed, file) {
  const occurrences = new Map(), extOccurrences = new Map();
  let source;
  for (const row of parsed.rows) {
    if (row.account && !row.account.mask && !normalize(row.account.name)) {
      source ??= createHash('sha256').update(String(file.name ?? '')).update('\0').update(file.bytes).digest('hex');
      row.locator = { ...row.locator, source };
    }
    if (row.kind !== 'transaction') continue;
    // Every transaction counts toward its date and amount slot, so rows without an external id
    // keep the occurrence (and key) they had before external ids existed.
    const slot = JSON.stringify(transactionSlot(row));
    row.occurrence = (occurrences.get(slot) ?? 0) + 1;
    occurrences.set(slot, row.occurrence);
    // A repeated external id and amount within one file stays a second row.
    if (externalId(row)) {
      const ext = JSON.stringify([accountKey(row), externalId(row), cents(row.amount)]);
      row.extOccurrence = (extOccurrences.get(ext) ?? 0) + 1;
      extOccurrences.set(ext, row.extOccurrence);
    }
  }
  return parsed;
}

export function dedupeKey(row) {
  let identity;
  switch (row.kind) {
    // A transaction with an external id (check or slip number) is identified by it and its signed
    // amount, so the same check posted on different dates or by another export still dedupes, while
    // a check and its return (opposite amounts) in separate uploads never collide.
    case 'transaction': identity = externalId(row)
      ? [accountKey(row), 'ext', externalId(row), cents(row.amount), ...(row.extOccurrence > 1 ? [row.extOccurrence] : [])]
      : [...transactionSlot(row), row.occurrence]; break;
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

import { csvScore, csvParse, isoDate, money, mask, institution, warning } from '../format.mjs';
import { identifyAccountRows } from '../dedupe.mjs';

export const id = 'aggregator';
export const label = 'Aggregator transactions';
export const sourceKind = 'aggregator_csv';
const required = ['date', 'account type', 'account name', 'account number', 'institution name', 'amount', 'description'];
export const sniff = (file) => csvScore(file, required);
export const parse = (file) => identifyAccountRows(csvParse(file, required, (record, locator, rows, warnings) => {
  const date = isoDate(record.date), amount = money(record.amount);
  if (!date || amount === null) { warning(warnings, 'invalid_transaction', locator); return; }
  const account = { inst: institution(record['institution name']), mask: mask(record['account number']), name: record['account name'], kind: record['account type'] };
  if (!account.mask) warning(warnings, 'missing_account_mask', locator);
  rows.push({ kind: 'transaction', account, date, amount: -amount || 0, description: record.description || record.name || '', ...(record.category ? { category: record.category } : {}), locator });
}), file);

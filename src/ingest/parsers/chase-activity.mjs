import { csvScore, csvParse, isoDate, money, warning } from '../format.mjs';
import { identifyAccountRows } from '../dedupe.mjs';

export const id = 'chase-activity';
export const label = 'Chase account activity';
export const sourceKind = 'bank_csv';
const required = ['details', 'posting date', 'description', 'amount', 'type', 'balance', 'check or slip #'];
export const sniff = (file) => csvScore(file, required);
export const parse = (file) => {
  const account = { inst: 'Chase', mask: /(?:^|[/\\])Chase(\d{4})_Activity(?:_|\.)/i.exec(file.name ?? '')?.[1] ?? '' };
  const parsed = csvParse(file, required, (record, locator, rows, warnings) => {
    const date = isoDate(record['posting date']), amount = money(record.amount);
    if (!date || amount === null) { warning(warnings, 'invalid_transaction', locator); return; }
    const externalId = record['check or slip #'];
    rows.push({ kind: 'transaction', account: { ...account }, date, amount, description: record.description, ...(externalId ? { externalId } : {}), locator });
    if (record.balance) {
      const balance = money(record.balance);
      if (balance === null) warning(warnings, 'invalid_balance', locator);
      else rows.push({ kind: 'balance', account: { ...account }, date, amount: balance, locator });
    }
  });
  if (!account.mask) warning(parsed.warnings, 'missing_account_mask');
  return identifyAccountRows(parsed, file);
};

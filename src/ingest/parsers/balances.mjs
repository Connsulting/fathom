import { csvScore, csvParse, monthEnd, money, warning } from '../format.mjs';

export const id = 'balances';
export const label = 'Month-end balances';
export const sourceKind = 'balances';
const required = ['month', 'account_alias', 'ending_balance'];
export const sniff = (file) => csvScore(file, required);
export const parse = (file) => csvParse(file, required, (record, locator, rows, warnings) => {
  const date = monthEnd(record.month), amount = money(record.ending_balance);
  if (!date || amount === null || !record.account_alias) { warning(warnings, 'invalid_balance', locator); return; }
  rows.push({ kind: 'balance', account: { inst: '', mask: '', name: record.account_alias }, date, amount, locator });
});

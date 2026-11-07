import { csv, csvScore, text, isoDate, money, number, mask, warning, result, empty, LimitError } from '../format.mjs';
import { holderOf } from './aggregator.mjs';

export const id = 'brokerage-positions';
export const label = 'Brokerage positions';
export const sourceKind = 'brokerage_positions';
const required = ['account number', 'account name', 'symbol', 'description', 'quantity', 'last price', 'current value'];
export const sniff = (file) => csvScore(file, required);

function asOf(file) {
  const body = text(file);
  const content = /(?:date downloaded|as of)\s*:?\s*([A-Za-z]{3})-(\d{1,2})-(\d{4})/i.exec(body);
  if (content) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(content[1].toLowerCase()) + 1;
    return isoDate(`${content[3]}-${String(month).padStart(2, '0')}-${content[2].padStart(2, '0')}`);
  }
  const contentIso = /as of\s*:?\s*(\d{4}-\d{2}-\d{2})/i.exec(body)?.[1];
  const filename = /(?:^|[^\d])(\d{4})-?(\d{2})-?(\d{2})(?:[^\d]|$)/.exec(file.name ?? '');
  return isoDate(contentIso ?? (filename ? `${filename[1]}-${filename[2]}-${filename[3]}` : ''));
}

export function parse(file) {
  try {
    const { headers, records, warnings } = csv(file);
    if (!required.every((key) => headers.includes(key))) return empty('missing_headers');
    const date = asOf(file);
    if (!date) return empty('missing_as_of');
    // A short record that starts with an account number of the file is a truncated position of
    // that account (its warning carries the account, so only that account's snapshot is
    // incomplete); other short lines, such as footers, are not positions.
    const accounts = new Set(records.flatMap(({ values }) => values.length >= 3 && values[0].trim() ? [values[0].trim()] : []));
    const rows = [];
    for (const { values, locator } of records) {
      if (values.length < 3) {
        const number = values[0].trim();
        if (accounts.has(number)) warnings.push({ code: 'truncated_position', locator, account: { inst: '', mask: mask(number) } });
        continue;
      }
      while (values.length > headers.length && !values.at(-1).trim()) values.pop();
      const record = Object.fromEntries(headers.map((key, i) => [key, values[i]?.trim() ?? '']));
      if (/pending/i.test(`${record.symbol} ${record.description}`)) { warning(warnings, 'pending_activity', locator); continue; }
      if (!record['account number'] && !record.symbol) continue;
      const cash = /held in money market|^cash(?:\s|$)/i.test(record.description) || /\*\*$/.test(record.symbol);
      const value = money(record['current value']);
      const quantity = cash && !record.quantity ? value : number(record.quantity);
      const price = cash && !record['last price'] ? 1 : money(record['last price']);
      const account = { inst: '', mask: mask(record['account number']), name: record['account name'], ...holderOf(record) };
      if (!account.mask || value === null || quantity === null || price === null || !record.symbol || values.length !== headers.length) {
        warnings.push({ code: 'invalid_position', locator, ...(account.mask ? { account: { inst: '', mask: account.mask } } : {}) });
        continue;
      }
      const costBasis = money(record['cost basis total']);
      if (record['cost basis total'] && costBasis === null) warning(warnings, 'invalid_cost_basis', locator);
      rows.push({ kind: 'position', account, asOf: date, symbol: cash ? 'CASH' : record.symbol, name: record.description, quantity, price, value, ...(costBasis !== null ? { costBasis } : {}), locator });
    }
    return result(rows, warnings);
  } catch (e) {
    if (e instanceof LimitError) throw e;
    return empty('malformed_csv');
  }
}

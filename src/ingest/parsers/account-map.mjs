import { csvScore, csvParse, warning } from '../format.mjs';

export const id = 'account-map';
export const label = 'Account metadata';
export const sourceKind = 'balances';
const required = ['account_alias', 'account_type', 'source'];
export const sniff = (file) => csvScore(file, required);
export const parse = (file) => csvParse(file, required, (record, locator, rows, warnings) => {
  if (!record.account_alias || !record.account_type || !record.source) { warning(warnings, 'invalid_account_metadata', locator); return; }
  rows.push({ kind: 'document', docType: 'account_metadata', fields: { account: { inst: '', mask: '', name: record.account_alias, kind: record.account_type }, source: record.source }, locator });
});

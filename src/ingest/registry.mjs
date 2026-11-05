import * as aggregator from './parsers/aggregator.mjs';
import * as chase from './parsers/chase-activity.mjs';
import * as positions from './parsers/brokerage-positions.mjs';
import * as pnl from './parsers/pnl-workbook.mjs';
import * as taxes from './parsers/tax-payments.mjs';
import * as balances from './parsers/balances.mjs';
import * as accounts from './parsers/account-map.mjs';
import * as notes from './parsers/notes.mjs';

export const parsers = Object.freeze([aggregator, chase, positions, pnl, taxes, balances, accounts, notes]);
export const listParsers = () => [...parsers];

export function pickParser(file, { threshold = 0.75 } = {}) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError('Invalid parser threshold');
  if (!file || !(file.bytes instanceof Uint8Array)) return null;
  if (/\.pdf$/i.test(file.name ?? '') || /application\/pdf/i.test(file.mime ?? '') || Buffer.from(file.bytes.subarray(0, 5)).toString() === '%PDF-') return null;
  let best = null, score = threshold;
  for (const parser of parsers) {
    const candidate = parser.sniff(file);
    if (Number.isFinite(candidate) && candidate > score && candidate <= 1) { best = parser; score = candidate; }
  }
  return best;
}

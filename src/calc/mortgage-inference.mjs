import { matchTransfers, normalizeMerchant, spendingAccount } from '../categories/resolve.mjs';
import { round } from './figure.mjs';
import { monthIndex, monthAt } from './aggregate.mjs';

const sum = rows => rows.reduce((s, r) => s + r.amount, 0);
const source = (table, rows) => ({ table, ids: rows.map(r => r.id).slice(0, 50), count: rows.length });
const paymentText = text => /\b(?:pay(?:ment)?|pmt|autopay|transfer)\b/i.test(text || '');

export function inferMortgage(db, clock, stated) {
  const values = { ...(stated || {}) }, assumptions = [], sources = [], inferred = {};
  const accounts = db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY id').all();
  const loans = accounts.filter(a => a.kind === 'loan' && /mortgage|home loan|housing loan/i.test(`${a.name || ''} ${a.display_name || ''}`));
  const loan = loans.length === 1 ? loans[0] : null;
  const active = new Map(accounts.map(a => [a.id, a]));
  const firstMonth = monthIndex(clock.slice(0, 7)) - 12;
  const transactions = db.prepare('SELECT * FROM transactions WHERE date>=? AND date<=? ORDER BY date,id').all(`${monthAt(firstMonth)}-01`, clock);
  const credits = loan ? transactions.filter(t => t.account_id === loan.id && t.amount > 0 && paymentText(t.description)) : [];
  const outflows = transactions.filter(t => t.amount < 0 && spendingAccount(active.get(t.account_id) || {}));
  const matches = matchTransfers(outflows, credits);
  const payeeMatches = t => {
    if (!loan || (!paymentText(t.description) && !/mortgage/i.test(t.description || ''))) return false;
    const text = normalizeMerchant(t.description);
    return [loan.display_name, loan.name, loan.inst].filter(v => typeof v === 'string' && normalizeMerchant(v).length >= 4)
      .some(v => text.includes(normalizeMerchant(v)) && !accounts.some(a => a.id !== loan.id
        && [a.name, a.inst, a.display_name].some(other => other && normalizeMerchant(other) === normalizeMerchant(v))));
  };
  const funding = loan ? outflows.filter(t => matches.has(t.id) || payeeMatches(t)) : [];
  const payments = funding.length ? funding : credits;
  const complete = payments.filter(t => t.date.slice(0, 7) < clock.slice(0, 7));
  const months = new Set(complete.map(t => t.date.slice(0, 7)));
  const observedMonthly = months.size ? round(complete.reduce((s, t) => s + Math.abs(t.amount), 0) / months.size) : null;
  if (loan) sources.push(source('accounts', [loan]));
  if (payments.length) sources.push(source('transactions', payments));
  const snapshots = loan ? db.prepare('SELECT id,date,amount FROM balances WHERE account_id=? AND date<=? ORDER BY date,id').all(loan.id, clock) : [];
  const newest = snapshots.at(-1);
  if (newest) sources.push(source('balances', snapshots));
  const add = (key, value, explanation) => {
    if (values[key] !== undefined || value === null) return;
    values[key] = value;
    inferred[key] = true;
    assumptions.push({ name: `Inferred mortgage ${key}`, value, unit: key === 'rate' ? 'ratio' : key === 'monthlyPayment' ? 'usd_per_month' : 'usd', source: 'inferred', stated: explanation });
  };
  add('balance', newest ? Math.abs(newest.amount) : null, 'Inferred from the newest balance of the only active mortgage loan account.');
  const loanPaymentMonthly = (() => {
    const rows = credits.filter(t => t.date.slice(0, 7) < clock.slice(0, 7));
    const months = new Set(rows.map(t => t.date.slice(0, 7)));
    return months.size ? round(sum(rows) / months.size) : null;
  })();
  add('monthlyPayment', observedMonthly === null ? null : !funding.length && values.escrowMonthly !== undefined
    ? round(observedMonthly + values.escrowMonthly) : observedMonthly,
  'Inferred from payments matched to this mortgage account or its payee, excluding all other debt payments.');

  let interest = 0, exposure = 0, intervals = 0;
  const ratePayments = credits.length ? credits : funding;
  const recent = snapshots.filter(s => monthIndex(s.date.slice(0, 7)) >= firstMonth - 1);
  for (let i = 1; i < recent.length; i++) {
    const before = recent[i - 1], after = recent[i];
    if (monthIndex(after.date.slice(0, 7)) - monthIndex(before.date.slice(0, 7)) !== 1) continue;
    const rows = ratePayments.filter(t => t.date > before.date && t.date <= after.date);
    if (!rows.length) continue;
    const paid = rows.reduce((s, t) => s + Math.abs(t.amount), 0) - (credits.length ? 0 : (values.escrowMonthly ?? 0));
    const residual = paid - (Math.abs(before.amount) - Math.abs(after.amount));
    if (residual < -0.02 || Math.abs(before.amount) <= 0) continue;
    interest += Math.max(0, residual);
    exposure += Math.abs(before.amount);
    intervals++;
  }
  const rate = intervals >= 3 && exposure > 0 ? 12 * interest / exposure : null;
  if (rate !== null && rate <= 1) add('rate', rate,
    'Inferred annual rate: payments minus the balance reduction, divided by opening balances, over consecutive monthly snapshots. Assumes a fixed rate and loan-account payment credits consisting of principal and interest.');
  if (ratePayments.length) sources.push(source('transactions', ratePayments));
  const principalAndInterest = values.monthlyPayment !== undefined && values.escrowMonthly !== undefined ? values.monthlyPayment - values.escrowMonthly
    : loanPaymentMonthly ?? values.monthlyPayment;
  if (values.escrowMonthly === undefined && values.monthlyPayment !== undefined) assumptions.push({
    name: 'Mortgage payment allocation', source: 'inferred',
    stated: credits.length ? 'Loan-account payment credits are assumed to exclude escrow. Escrow remains unknown; correct this assumption if those credits include escrow.'
      : 'Matched payee payments are provisionally treated as principal and interest. Escrow remains unknown; correct this assumption if the payments include escrow.',
  });
  const missing = ['balance', 'rate', 'monthlyPayment', 'escrowMonthly'].filter(k => values[k] === undefined);
  return { values, inferred, sources, assumptions, missing, observedMonthly, principalAndInterest,
    present: !!stated || loans.length > 0, loan, payments: funding, asOf: newest?.date ?? complete.at(-1)?.date ?? null };
}

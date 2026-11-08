import { matchTransfers, normalizeMerchant, spendingAccount } from '../categories/resolve.mjs';
import { round } from './figure.mjs';
import { monthIndex, monthAt } from './aggregate.mjs';
import { listPreferences } from '../actions/preferences.mjs';

const sum = rows => rows.reduce((s, r) => s + r.amount, 0);
const source = (table, rows) => ({ table, ids: rows.map(r => r.id).slice(0, 50), count: rows.length });
const paymentText = text => /\b(?:pay(?:ment)?|pmt|autopay|transfer)\b/i.test(text || '');
const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
// A trailing time phrase: "in 2024", "in March", "in March 2026", "since 2024", "last year".
const WHEN = `(?:\\s+(?:(?:in|since)\\s+(?:${MONTH}(?:\\s+(?:of\\s+)?\\d{4})?|\\d{4})|last\\s+(?:year|month)|(?:earlier\\s+)?this\\s+year))?`;
const PAID_OFF = [
  new RegExp(`^(?:(?:my|our|the)\\s+)?(?:home\\s+)?mortgage\\s+(?:(?:is|was|has been)\\s+)?(?:(?:already|fully|completely)\\s+)*paid[ -]+off${WHEN}[.!]?$`, 'i'),
  new RegExp(`^(?:i|we)\\s+(?:have\\s+)?(?:already\\s+)?paid\\s+off\\s+(?:my|our|the)\\s+(?:home\\s+)?mortgage${WHEN}[.!]?$`, 'i'),
];
const paidOffStatement = text => PAID_OFF.some(re => re.test(text.trim()));

export function inferMortgage(db, clock, stated) {
  const values = { ...(stated || {}) }, assumptions = [], sources = [], inferred = {};
  const inactive = (status, message, evidence = []) => ({ status, message, values: status === 'paid_off' ? { paidOff: true } : values,
    sources: evidence, assumptions: [], inferred: {}, missing: [], observedMonthly: null, principalAndInterest: null,
    present: false, loan: null, payments: [], asOf: null });
  const memory = listPreferences(db).find(m => paidOffStatement(m.text));
  const accounts = db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY id').all();
  const namedLoans = accounts.filter(a => a.kind === 'loan' && /mortgage|home loan|housing loan/i.test(`${a.name || ''} ${a.display_name || ''}`));
  const balances = new Map(namedLoans.map(a => [a.id, db.prepare('SELECT id,date,amount FROM balances WHERE account_id=? AND date<=? ORDER BY date DESC,id DESC LIMIT 1').get(a.id, clock)]));
  const loans = namedLoans.filter(a => Math.abs(balances.get(a.id)?.amount ?? 0) > 0);
  if (values.paidOff === true || values.status === 'paid_off' || values.balance === 0 || memory) {
    // A memory wins over loan data that still shows a balance; the result says so.
    const overridden = memory && values.paidOff !== true && values.status !== 'paid_off' && values.balance !== 0 && loans.length > 0;
    const out = inactive('paid_off',
      `Your mortgage is paid off. There is no mortgage obligation or future mortgage payoff to project. Other debt payments are not a mortgage payment.${overridden ? ' Your memory that the mortgage is paid off overrides the loan balance on file.' : ''}`,
      memory ? [source('preferences', [memory])] : [{ table: 'facts', ids: ['obligations.mortgage'], count: 1 }]);
    return overridden ? { ...out, overridden: { by: `preferences:${memory.id}`, inferred: 'active' } } : out;
  }
  if (namedLoans.length && namedLoans.every(a => balances.get(a.id)?.amount === 0)) return inactive('paid_off',
    'The mortgage loan balance is zero. There is no mortgage obligation or future mortgage payoff to project.',
    [source('accounts', namedLoans), source('balances', [...balances.values()])]);
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
  const canInfer = !!loan && payments.length > 0;
  const statedActive = values.balance > 0 || values.monthlyPayment > 0 || !!values.payoffDate;
  if (!canInfer && !statedActive) return inactive('unmatched', loans.length > 1
    ? 'Match the mortgage loan account and its payments before inferring mortgage terms. Tell Fathom which loan is the mortgage.'
    : 'Cannot match payments to an active positive-balance mortgage loan. Tell Fathom which loan and payments belong to the mortgage.');
  const complete = payments.filter(t => t.date.slice(0, 7) < clock.slice(0, 7));
  const months = new Set(complete.map(t => t.date.slice(0, 7)));
  const observedMonthly = months.size ? round(complete.reduce((s, t) => s + Math.abs(t.amount), 0) / months.size) : null;
  if (loan) sources.push(source('accounts', [loan]));
  if (payments.length) sources.push(source('transactions', payments));
  const snapshots = loan ? db.prepare('SELECT id,date,amount FROM balances WHERE account_id=? AND date<=? ORDER BY date,id').all(loan.id, clock) : [];
  const newest = snapshots.at(-1);
  if (newest) sources.push(source('balances', snapshots));
  const add = (key, value, explanation) => {
    if (!canInfer || values[key] !== undefined || value === null) return;
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
    status: canInfer ? 'active' : 'stated', present: true, loan, payments: funding, asOf: newest?.date ?? complete.at(-1)?.date ?? null };
}

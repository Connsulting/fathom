import {
  businessAccount,
  spendingAccount,
  normalizeMerchant,
  resolveCategories,
  matchTransfers,
} from '../categories/resolve.mjs';
import { figureFor, sumRows } from './aggregate.mjs';

const day = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
const median = (vs) => {
  const v = vs.toSorted((a, b) => a - b),
    i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

export function recurring(input, args = {}) {
  const rows = input.transactions.filter((t) => t.date <= input.clock),
    accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const categories = resolveCategories({ ...input, transactions: rows });
  const transfers = matchTransfers(
    rows.filter((t) => t.amount < 0),
    rows.filter((t) => t.amount > 0),
  );
  const grouped = new Map(),
    scope = args.scope ?? 'household';
  for (const t of rows) {
    const a = accounts.get(t.account_id);
    if (
      !a ||
      t.amount >= 0 ||
      transfers.has(t.id) ||
      categories.get(t.id).bucket === 'transfer' ||
      !(scope === 'all' || (scope === 'business' ? businessAccount(a) : spendingAccount(a)))
    )
      continue;
    const merchant = normalizeMerchant(t.description);
    if (!merchant) continue;
    const key = JSON.stringify([merchant, t.account_id]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(t);
  }
  const charges = [];
  const countedRows = [];
  for (const series of grouped.values()) {
    series.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    if (series.length < 2) continue;
    const gaps = series.slice(1).map((t, i) => day(t.date) - day(series[i].date)),
      gap = median(gaps);
    const cadence =
      gap >= 25 && gap <= 35
        ? 'monthly'
        : gap >= 80 && gap <= 100
          ? 'quarterly'
          : gap >= 350 && gap <= 380
            ? 'annual'
            : null;
    if (
      !cadence ||
      (args.cadence && cadence !== args.cadence) ||
      series.length < (args.minOccurrences ?? (cadence === 'annual' ? 2 : 3))
    )
      continue;
    const values = series.map((t) => -t.amount),
      typical = median(values),
      last = series.at(-1),
      prior = series.at(-2),
      next = day(last.date) + gap;
    const status = day(input.clock) > next + gap ? 'stopped' : 'active';
    const since = args.since ?? iso(day(input.clock) - 90);
    if (
      (args.status ?? 'active') === 'new'
        ? series[0].date < since
        : (args.status ?? 'active') !== 'all' && args.status !== undefined
          ? status !== args.status
          : args.status === undefined && status !== 'active'
    )
      continue;
    const f = (v, label, rs, unit = 'usd') =>
      figureFor(v, label, rs, { unit, calc: 'recurring', formula: 'median charge and detected cadence' });
    countedRows.push(...series);
    charges.push({
      merchant: normalizeMerchant(last.description),
      cadence,
      occurrences: f(series.length, 'Charge occurrences', series, 'count'),
      firstDate: series[0].date,
      lastDate: last.date,
      nextExpected: iso(next),
      typicalAmount: f(typical, 'Typical charge', series),
      annualCost: f(
        typical * { monthly: 12, quarterly: 4, annual: 1 }[cadence],
        'Annual recurring cost',
        series,
        'usd_per_year',
      ),
      amountStable: values.every((v) => Math.abs(v - typical) <= typical * 0.1),
      ...(Math.abs(last.amount - prior.amount) > Math.abs(prior.amount) * 0.1
        ? {
            changed: {
              from: f(-prior.amount, 'Previous charge', [prior]),
              to: f(-last.amount, 'Latest charge', [last]),
              on: last.date,
            },
          }
        : {}),
      status,
      account: { id: last.account_id, label: accounts.get(last.account_id).name },
    });
  }
  charges.sort(
    (a, b) =>
      b.annualCost.value - a.annualCost.value ||
      a.merchant.localeCompare(b.merchant) ||
      a.account.id.localeCompare(b.account.id),
  );
  return {
    charges: charges.slice(0, args.limit ?? 50),
    totalAnnual: figureFor(
      sumRows(charges, (c) => c.annualCost.value),
      'Annual recurring total',
      countedRows,
      { unit: 'usd_per_year', calc: 'recurring', formula: 'sum of detected annual recurring costs' },
    ),
    gaps: [],
    ...(charges.length > (args.limit ?? 50) ? { truncated: true } : {}),
  };
}

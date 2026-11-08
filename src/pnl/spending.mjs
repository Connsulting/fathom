// Household spending: categorized outflows on household spending accounts (checking, savings, cash,
// card; never business accounts) by category and month, with housing and taxes toggles, left-out
// buckets and data gaps.
//
// householdSpending({db, from, to, include, exclude, clock}) -> see docs/architecture.md
// householdSpendingRows({db, from, to, include, exclude, bucket, category, month, clock}) -> {items, total, sum, figures, sources, note}
//   sum: a figure over every matching row (not just the capped items), equal to the cell it opens from.
//   Each item: amount (raw signed), value (counted: the outflow positive, a refund negative) and fig (at value).

import { spendingAccount } from '../categories/resolve.mjs';
import { loadPlanningData } from '../jobs/planner/data.mjs';
import { getFacts } from '../store/facts.mjs';
import { personalSummaryInput, selectPersonalSummaries, SUMMARY_RULE } from '../spending/summaries.mjs';
import {
  PnlError, ITEM_LIMIT, accountLabels, addMonths, byDateDesc, checkDb, checkMonth, checkRange, classified, clockOf, enc,
  figureRegistry, fileNames, monthSums, rowItem, runsLabel, spanLabel, sumOf, txnRow, lineRow,
} from './shared.mjs';

const INCLUDE = ['tax'];
const EXCLUDE = ['housing'];
const BUCKETS = ['household', 'tax'];
const BUCKET_LABEL = { household: 'Household spending', tax: 'Taxes' };
const HOUSING = /^(mortgage|rent|housing)$/i;
const UNCATEGORIZED = 'Uncategorized';
const LEFT_OUT = [
  ['housing', 'Housing'],
  ['tax', 'Taxes'],
  ['transfer', 'Transfers and card payments'],
  ['business', 'Business costs on household accounts'],
  ['saving', 'Saving or investing'],
  ['excluded', 'Excluded'],
];
const SPEND_NOTE = ['Spending is household outflows; a refund lowers its category.', SUMMARY_RULE];

function options(list, allowed, name) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !allowed.includes(x))) {
    throw new PnlError('bad_option', `${name} must be a list of ${allowed.join(', ')}`);
  }
  return allowed.filter((x) => list.includes(x));
}

function analyze({ db, from, to, include, exclude, clock }) {
  checkDb(db);
  const c = clockOf(db, clock);
  const inc = options(include, INCLUDE, 'include');
  const exc = options(exclude, EXCLUDE, 'exclude');
  checkMonth(from, 'from');
  checkMonth(to, 'to');
  const base = classified(db, c);
  const labels = accountLabels(db);
  const accounts = base.accounts.filter(spendingAccount);
  const spendingIds = new Set(accounts.map((a) => a.id));
  const data = loadPlanningData(db, c);
  const summaries = personalSummaryInput(data, getFacts(db), data.categoryInput);
  const rows = base.transactions.filter((t) => spendingIds.has(t.account_id));

  // Default range: the trailing twelve months ending at the latest month with a spending-account
  // row, or the month before when that month is the clock's own (still in progress).
  const clockMonth = c.slice(0, 7);
  const latest = [...rows.map(t => t.date.slice(0, 7)), ...summaries.lines.map(l => l.period)].sort().at(-1) ?? addMonths(clockMonth, -1);
  const end = to ?? (latest === clockMonth ? addMonths(clockMonth, -1) : latest);
  const start = from ?? addMonths(end, -11);
  const months = checkRange(start, end);
  const inRange = rows.filter((t) => t.date.slice(0, 7) >= start && t.date.slice(0, 7) <= end);

  const counted = { household: new Map(), tax: new Map() };
  const left = new Map();
  const put = (bucket, category, row) => {
    const byCat = counted[bucket];
    if (!byCat.has(category)) byCat.set(category, new Map());
    const byMonth = byCat.get(category);
    if (!byMonth.has(row.month)) byMonth.set(row.month, []);
    byMonth.get(row.month).push(row);
  };
  const leave = (key, row) => { if (!left.has(key)) left.set(key, []); left.get(key).push(row); };
  for (const t of inRange) {
    const r = base.resolved.get(t.id);
    const row = { ...txnRow(t), value: -t.amount, category: r.category, layer: r.layer, housing: r.bucket === 'household' && HOUSING.test(r.category) };
    if (r.bucket === 'household') {
      if (row.housing && exc.includes('housing')) leave('housing', row);
      else put('household', r.category, row);
    } else if (r.bucket === 'tax') {
      if (inc.includes('tax')) put('tax', r.category, row);
      else leave('tax', row);
    } else if (r.bucket !== 'income') leave(r.bucket, row);
  }
  const supplemental = selectPersonalSummaries(summaries, { window: { from: start, to: end }, payroll: false }).rows.filter(l => !l.income);
  for (const line of supplemental) {
    const row = { ...lineRow({ ...line, id: line.sourceId }), value: -line.amount, category: line.category, layer: 'summary', person: line.person, housing: HOUSING.test(line.category) };
    if (line.bucket === 'household') {
      if (row.housing && exc.includes('housing')) leave('housing', row);
      else put('household', row.category, row);
    } else if (line.bucket === 'tax' && inc.includes('tax')) put('tax', row.category, row);
    else leave(line.bucket, row);
  }
  const lastMonth = new Map();
  for (const t of rows) lastMonth.set(t.account_id, t.date.slice(0, 7));
  const activeMonths = new Set([...inRange.map((t) => t.date.slice(0, 7)), ...supplemental.map(l => l.period)]);
  return { from: start, to: end, months, include: inc, exclude: exc, counted, left, accounts, lastMonth, activeMonths, labels, files: fileNames(db) };
}

const all = (byMonth) => [...byMonth.values()].flat();
const keyBase = (a) => `spend.${a.from}.${a.to}.${a.include.includes('tax') ? 'tax' : 'notax'}.${a.exclude.includes('housing') ? 'nohousing' : 'housing'}`;
const sortCategories = (list) => list.sort((x, y) => (x.category === UNCATEGORIZED) - (y.category === UNCATEGORIZED) || y.value - x.value || x.category.localeCompare(y.category));

export function householdSpending(opts = {}) {
  const a = analyze(opts);
  const reg = figureRegistry({ kind: 'spend', labels: a.labels, files: a.files });
  const base = keyBase(a);
  const span = spanLabel(a.from, a.to);
  const sums = (byMonth) => monthSums(byMonth, a.months, () => 'transactions');

  // Months with any household account transaction: the divisor for every monthly average.
  const active = a.months.filter((m) => a.activeMonths.has(m)).length;
  const AVG_NOTE = ['The average divides the total by the months that have any household account transaction.'];
  const AVG_DETAIL = [{ k: 'Uses', v: `${active} ${active === 1 ? 'month' : 'months'} with household account transactions` }];
  const buckets = [];
  const totalByMonth = new Map();
  for (const bucket of BUCKETS) {
    if (!a.counted[bucket].size) continue;
    const categories = [];
    const bucketByMonth = new Map();
    for (const [category, byMonth] of a.counted[bucket]) {
      const ck = `${base}.b.${bucket}.cat.${enc(category)}`;
      const cellMonths = {};
      for (const m of a.months) {
        const r = byMonth.get(m);
        cellMonths[m] = r && r.length ? reg.add(`${ck}.m.${m}`, { v: sumOf(r), label: `${category}, ${spanLabel(m, m)}`, rows: r, counted: true, notes: SPEND_NOTE }) : null;
        if (r) {
          bucketByMonth.set(m, [...(bucketByMonth.get(m) ?? []), ...r]);
          totalByMonth.set(m, [...(totalByMonth.get(m) ?? []), ...r]);
        }
      }
      const rows = all(byMonth);
      categories.push({
        category, housing: bucket === 'household' && HOUSING.test(category), value: sumOf(rows), months: cellMonths,
        total: reg.add(`${ck}.total`, { v: sumOf(rows), label: `${category}, ${span}`, rows, counted: true, notes: SPEND_NOTE, sums: sums(byMonth) }),
        average: active
          ? reg.add(`${ck}.average`, { v: sumOf(rows) / active, label: `${category}, monthly average, ${span}`, rows, counted: true, notes: AVG_NOTE, detail: AVG_DETAIL })
          : null,
      });
    }
    sortCategories(categories);
    const rows = all(bucketByMonth);
    buckets.push({
      bucket, label: BUCKET_LABEL[bucket],
      total: reg.add(`${base}.b.${bucket}.total`, { v: sumOf(rows), label: `${BUCKET_LABEL[bucket]}, ${span}`, rows, counted: true, notes: SPEND_NOTE, sums: sums(bucketByMonth) }),
      categories: categories.map(({ value, ...c }) => c),
    });
  }

  const totalRows = all(totalByMonth);
  const totalValue = sumOf(totalRows);
  const monthTotals = {};
  for (const m of a.months) {
    const r = totalByMonth.get(m);
    monthTotals[m] = r && r.length ? reg.add(`${base}.m.${m}`, { v: sumOf(r), label: `Household spending, ${spanLabel(m, m)}`, rows: r, counted: true, notes: SPEND_NOTE }) : null;
  }
  const total = totalRows.length
    ? reg.add(`${base}.total`, { v: totalValue, label: `Household spending, ${span}`, rows: totalRows, counted: true, notes: SPEND_NOTE, sums: sums(totalByMonth) })
    : null;
  const monthlyAverage = totalRows.length && active
    ? reg.add(`${base}.average`, {
      v: totalValue / active, label: `Monthly average, ${span}`, rows: totalRows, counted: true, notes: AVG_NOTE, detail: AVG_DETAIL,
    })
    : null;

  const leftOut = LEFT_OUT.filter(([k]) => a.left.has(k)).map(([key, label]) => {
    const rows = a.left.get(key);
    return {
      key, label, rows: rows.length,
      amount: reg.add(`${base}.left.${key}`, { v: sumOf(rows), label: `${label} left out, ${span}`, rows, notes: ['These household account transactions are not counted as household spending.'] }),
    };
  });

  const gap = (key, layer, label, note) => {
    const rows = totalRows.filter((r) => r.layer === layer);
    const amount = sumOf(rows);
    return {
      rows: rows.length,
      amount: rows.length ? reg.add(`${base}.gap.${key}`, { v: amount, label: `${label}, ${span}`, rows, counted: true, notes: [note] }) : null,
      share: totalValue > 0 ? Math.min(1, Math.max(0, amount / totalValue)) : 0,
    };
  };
  const gaps = {
    accounts: a.accounts.flatMap((acct) => {
      const last = a.lastMonth.get(acct.id) ?? null;
      const label = a.labels.get(acct.id)?.label ?? acct.id;
      if (last === null) return [{ id: acct.id, label, lastMonth: null, state: 'none' }];
      return last < a.to ? [{ id: acct.id, label, lastMonth: last, state: 'stopped' }] : [];
    }),
    emptyMonths: a.months.filter((m) => !a.activeMonths.has(m)),
    uncategorized: gap('uncategorized', 'uncategorized', 'Uncategorized spending', 'Outflows with no category are counted under Uncategorized.'),
    guessed: gap('guessed', 'guess', 'Spending with a guessed category', 'These categories are model guesses that have not been checked.'),
  };

  const notes = [];
  if (!totalRows.length) notes.push(`There is no household spending for ${span}.`);
  notes.push(a.exclude.includes('housing') ? 'Housing is left out.' : 'Housing is included.');
  notes.push(a.include.includes('tax') ? 'Tax payments are included.' : 'Tax payments are left out.');
  if (gaps.emptyMonths.length) notes.push(`${runsLabel(gaps.emptyMonths)} ${gaps.emptyMonths.length === 1 ? 'has' : 'have'} no household account transactions.`);
  if (gaps.accounts.some((g) => g.state === 'stopped')) notes.push('Some household accounts stopped updating before the end of the range.');

  return {
    from: a.from, to: a.to, months: a.months, include: a.include, exclude: a.exclude,
    total, monthlyAverage, monthTotals, buckets, leftOut, gaps, notes, ...reg.done(),
  };
}

export function householdSpendingRows({ bucket, category, month, ...opts } = {}) {
  const a = analyze(opts);
  if (!BUCKETS.includes(bucket)) throw new PnlError('bad_option', 'bucket must be household or tax');
  if (typeof category !== 'string' || !category) throw new PnlError('bad_input', 'category is required');
  checkMonth(month, 'month');
  if (month != null && !a.months.includes(month)) throw new PnlError('bad_range', 'month is outside the range');
  const reg = figureRegistry({ kind: 'spend', labels: a.labels, files: a.files });
  const byMonth = a.counted[bucket].get(category);
  const rows = (byMonth ? (month ? byMonth.get(month) ?? [] : all(byMonth)) : []).sort(byDateDesc);
  const items = rows.slice(0, ITEM_LIMIT).map((row) => rowItem(reg, `spend.row.${row.id}`, row, {
    account: a.labels.get(row.accountId)?.label ?? row.accountId, category, label: `Transaction on ${row.date}`,
  }));
  const where = month ? spanLabel(month, month) : spanLabel(a.from, a.to);
  const sum = reg.add(`${keyBase(a)}.rows.${bucket}.${enc(category)}.${month ?? 'total'}`, { v: sumOf(rows), label: `${category}, ${where}`, rows, counted: true, notes: SPEND_NOTE });
  return { items, total: rows.length, sum, ...reg.done(), note: `Rows behind ${category}, ${where}.` };
}

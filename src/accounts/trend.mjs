// Household balance trend for Money, summed from the same monthly account values the per-account
// series use (src/jobs/planner/series.mjs). Each account contributes its latest balance on or
// before each month end; an account whose data stopped carries its last balance forward and is
// counted as carried at every point after its last balance. Debt (cards, loans) is negative.
// Business cash is its own part and counts in the household total, as the net worth series that
// preceded this did. An archived account counts in past points only (see counts below). Accounts merged as duplicates are one row already, so they count once.
//
// buildTrend(db, clock) -> null | { trend, figures, source }
//   trend: { end, includesBusiness, note, parts, groups, points, fig }
//   figures: scenario figures (trend.total, trend.part.<id>, trend.group.<slug>) whose `sums` list
//            the accounts, balances and dates each one adds up.

import { cents } from '../store/db.mjs';
import { sourceStates } from '../ingest/coverage.mjs';
import { monthlyReadings, trendLabels } from '../jobs/planner/series.mjs';

export const TREND_SRC = 'trend';
export const MAX_MONTHS = 120;

// Accounts headings, in display order, and the part each belongs to.
export const GROUPS = [
  ['Business', 'business'], ['Cash', 'cash'], ['Investing', 'investments'], ['Retirement', 'retirement'],
  ['Health', 'education-health'], ['Education', 'education-health'], ['Debt', 'debt'], ['Other', 'other'],
];
export const PARTS = [
  ['cash', 'Cash'], ['investments', 'Investments'], ['retirement', 'Retirement'], ['education-health', 'Education and health'],
  ['business', 'Business cash'], ['debt', 'Debt'], ['other', 'Other'],
];
const PART_OF = new Map(GROUPS);

// A statement shows what is owed as a positive number, so debt is tested first: a "credit card"
// is never cash.
export function groupOfKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase();
  if (/^(credit|card|loan|mortgage|liability|debt)/.test(k)) return 'Debt';
  if (/business/.test(k)) return 'Business';
  if (/hsa|health savings/.test(k)) return 'Health';
  if (/529|education/.test(k)) return 'Education';
  if (/retire|roth|\bira\b|\bsep\b|401|403|457|pension/.test(k)) return 'Retirement';
  if (/taxable|brokerage|invest|individual/.test(k)) return 'Investing';
  if (/checking|savings|cash|money market/.test(k)) return 'Cash';
  return 'Other';
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthKey = iso => String(iso).slice(0, 7);
const dayLabel = iso => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const monthEnd = m => `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function monthsBetween(first, last) {
  const out = [];
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  while (`${y}-${String(m).padStart(2, '0')}` <= last) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

function carriedNote(carried) {
  if (!carried.length) return null;
  const dates = carried.map(c => c.lastDate).sort();
  const lo = dates[0], hi = dates.at(-1);
  const when = lo === hi ? `last updated ${dayLabel(lo)}` : `last updated between ${dayLabel(lo)} and ${dayLabel(hi)}`;
  return `includes ${plural(carried.length, 'account', 'accounts')} ${when}`;
}

export function buildTrend(db, clock) {
  const labels = trendLabels(db);
  const rows = db.prepare('SELECT id, kind, archived_at FROM accounts ORDER BY sort, id').all();
  const stored = rows.map(a => {
    const readings = monthlyReadings(db, a.id, clock);
    const months = [...readings.keys()].sort();
    return { id: a.id, label: labels.get(a.id), group: groupOfKind(a.kind), readings, months, last: readings.get(months.at(-1))?.date, archived: !!a.archived_at };
  }).filter(x => x.months.length);
  // An account counts from its first balance on and adds nothing before it.
  const counted = stored;
  if (!counted.length) return null;

  const endMonth = counted.map(x => x.months.at(-1)).sort().at(-1);
  const endDate = counted.map(x => x.last).sort().at(-1);
  const startMonth = counted.map(x => x.months[0]).sort()[0];
  const months = monthsBetween(startMonth, endMonth).slice(-MAX_MONTHS);
  if (months.length < 2) return null;

  // Freshness decides whether an account at the end is still current, not only whether it has a
  // row in the final month.
  const states = sourceStates(db, clock).accounts;
  const freshOf = new Map(counted.map(x => [x.id, states.get(x.id)?.state ?? 'unknown']));
  const carriedAt = (x, m) => (m === endMonth ? x.months.at(-1) < endMonth || freshOf.get(x.id) === 'stale' : m > x.months.at(-1));
  // The reading an account contributes at month m: its newest one on or before it.
  const readingAt = (x, m) => x.readings.get(x.months.filter(k => k <= m).at(-1));
  // An archived account keeps its history: it adds its own readings to the points before the last
  // one, is never carried forward, and leaves the current point and every current figure.
  const counts = (x, m) => x.months[0] <= m && (!x.archived || (m < endMonth && m <= x.months.at(-1)));
  const valueAt = (x, m) => {
    const v = readingAt(x, m).v;
    return x.group === 'Debt' ? -Math.abs(v) : v;
  };

  const groupIds = GROUPS.map(g => g[0]).filter(g => counted.some(x => x.group === g));
  const partIds = PARTS.map(p => p[0]).filter(p => groupIds.some(g => PART_OF.get(g) === p));
  const points = months.map(m => {
    // A part or group with no account yet at this month is zero, not missing.
    const sum = { total: 0, parts: Object.fromEntries(partIds.map(p => [p, 0])), groups: Object.fromEntries(groupIds.map(g => [g, 0])) };
    const car = { total: 0, parts: {}, groups: {} };
    for (const x of counted) {
      if (!counts(x, m)) continue;
      const part = PART_OF.get(x.group);
      const v = valueAt(x, m);
      sum.total += v;
      sum.parts[part] += v;
      sum.groups[x.group] += v;
      if (carriedAt(x, m)) {
        car.total += 1;
        car.parts[part] = (car.parts[part] ?? 0) + 1;
        car.groups[x.group] = (car.groups[x.group] ?? 0) + 1;
      }
    }
    const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, cents(v)]));
    return {
      date: m === endMonth ? endDate : monthEnd(m),
      total: cents(sum.total), parts: round(sum.parts), groups: round(sum.groups), carried: car,
    };
  });

  const sums = x => ({ id: x.id, label: x.label, v: cents(valueAt(x, endMonth)), asOf: readingAt(x, endMonth).date, fresh: freshOf.get(x.id), carried: carriedAt(x, endMonth), group: x.group });
  const current = counted.filter(x => !x.archived);
  const all = current.map(sums);
  const last = points.at(-1);
  const fig = { total: 'trend.total', parts: {}, groups: {} };
  const figures = { 'trend.total': { v: last.total, src: TREND_SRC, kind: 'a', label: 'Net worth, all accounts', sums: all.map(({ group, ...s }) => s) } };
  for (const p of partIds) {
    fig.parts[p] = `trend.part.${p}`;
    const label = PARTS.find(x => x[0] === p)[1];
    figures[fig.parts[p]] = { v: last.parts[p], src: TREND_SRC, kind: 'a', label, sums: all.filter(s => PART_OF.get(s.group) === p).map(({ group, ...s }) => s) };
  }
  for (const g of groupIds) {
    fig.groups[g] = `trend.group.${slug(g)}`;
    figures[fig.groups[g]] = { v: last.groups[g], src: TREND_SRC, kind: 'a', label: g, sums: all.filter(s => s.group === g).map(({ group, ...s }) => s) };
  }

  const carriedNow = current.filter(x => carriedAt(x, endMonth)).map(x => ({ lastDate: x.last }));
  const trend = {
    end: last.date,
    includesBusiness: true,
    note: carriedNote(carriedNow),
    parts: partIds.map(id => ({ id, label: PARTS.find(x => x[0] === id)[1] })),
    groups: groupIds.map(id => ({ id, part: PART_OF.get(id) })),
    points,
    fig,
  };
  return { trend, figures, source: { label: 'Account balances, summed', asOf: last.date } };
}

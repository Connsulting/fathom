// Trend series for the account dialog, built from the stored balances (and brokerage position
// values) of a real store: one monthly series per account. A point is the account's last stored
// balance in that month (kind 'a', actual); a month with no balance row falls back to the summed
// position values as of the month's last positions date. The scenario builder turns every point
// into a series.<key>.<i> figure whose source is 'balances'. The household aggregate over these
// same monthly values is src/accounts/trend.mjs.
//
// buildSeries(db, clock) -> {key: {label, unit, src, imported, points: [{x, v, kind}]}}

import { cents, parseJson } from '../../store/db.mjs';
import { trendLabel } from '../../shared/account-label.mjs';
import { accountNaming } from '../../accounts/naming.mjs';
import { monthLabel } from './data.mjs';
import { mapSeries } from '../../shared/series.mjs';

export const SERIES_SRC = 'balances';
export const MAX_POINTS = 12;
const monthKey = iso => String(iso).slice(0, 7);
// 'acct-ab12' -> 'acct-ab12'; any other id gets the prefix. Characters outside [a-z0-9_-] become '-'.
export const seriesKey = id => {
  const safe = String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
  return safe.startsWith('acct-') ? safe : `acct-${safe}`;
};

// Last `limit` months ending at the clock month, as 'YYYY-MM'.
function monthsEnding(clock, limit) {
  let y = Number(clock.slice(0, 4));
  let m = Number(clock.slice(5, 7));
  const out = [];
  for (let i = 0; i < limit; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

// { 'YYYY-MM': {date, v} } for one account: the reading each month's value comes from.
export async function monthlyReadings(db, accountId, clock) {
  const byMonth = new Map();
  const bal = await db.prepare('SELECT date, amount FROM balances WHERE account_id = ? AND date <= ? ORDER BY date').all(accountId, clock);
  for (const r of bal) byMonth.set(monthKey(r.date), { date: r.date, v: r.amount });
  const pos = await db.prepare('SELECT as_of, value, quantity, price FROM positions WHERE account_id = ? AND as_of <= ? ORDER BY as_of').all(accountId, clock);
  const byAsOf = new Map();
  for (const p of pos) {
    const v = Number.isFinite(p.value) ? p.value : Number.isFinite(p.quantity) && Number.isFinite(p.price) ? p.quantity * p.price : null;
    if (v == null) continue;
    byAsOf.set(p.as_of, (byAsOf.get(p.as_of) ?? 0) + v);
  }
  const lastAsOf = new Map();
  for (const asOf of [...byAsOf.keys()].sort()) lastAsOf.set(monthKey(asOf), asOf);
  for (const [month, asOf] of lastAsOf) if (!byMonth.has(month)) byMonth.set(month, { date: asOf, v: byAsOf.get(asOf) });
  return new Map([...byMonth].map(([k, r]) => [k, { date: String(r.date).slice(0, 10), v: cents(r.v) }]));
}

// { 'YYYY-MM': value } for one account.
export async function monthlyValues(db, accountId, clock) {
  return new Map([...await monthlyReadings(db, accountId, clock)].map(([k, r]) => [k, r.v]));
}

// Imported names are plain text; the label is the account's name.
export async function trendLabels(db) {
  return new Map([...(await accountNaming(db)).byId].map(([id, a]) => [id, trendLabel(a)]));
}

export async function buildSeries(db, clock) {
  const accounts = await db.prepare('SELECT id FROM accounts WHERE archived_at IS NULL ORDER BY sort, id').all();
  const labels = await trendLabels(db);
  const stored = (await mapSeries(accounts, async a => ({ a, values: await monthlyValues(db, a.id, clock) }))).filter(x => x.values.size);
  if (!stored.length) return {};
  // The window ends at the newest month any account has data for, so no month is shown that no
  // upload covers.
  const end = stored.flatMap(x => [...x.values.keys()]).sort().at(-1);
  const months = monthsEnding(`${end}-01`, MAX_POINTS);
  const out = {};
  for (const { a, values } of stored) {
    const inWindow = months.filter(m => values.has(m));
    if (inWindow.length < 2) continue;
    out[seriesKey(a.id)] = {
      label: labels.get(a.id), unit: '$', src: SERIES_SRC, imported: true,
      points: inWindow.map(m => ({ x: monthLabel(`${m}-01`), v: values.get(m), kind: 'a' })),
    };
  }
  return out;
}

// Trend series for the Accounts screen, built from the stored balances (and brokerage position
// values) of a real store: one monthly series per account and one for the accounts together. A
// point is the account's last stored balance in that month (kind 'a', actual); a month with no
// balance row falls back to the summed position values as of the month's last positions date. The
// scenario builder turns every point into a series.<key>.<i> figure whose source is 'balances'.
//
// buildSeries(db, clock) -> {key: {label, unit, src, imported, points: [{x, v, kind}]}}

import { cents } from '../../store/db.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
import { monthLabel } from './data.mjs';

export const SERIES_SRC = 'balances';
export const MAX_POINTS = 12;
// Account kinds whose balance is a debt (a statement shows what is owed as a positive number): the
// combined series subtracts them.
const LIABILITY = /^(credit|card|loan|mortgage|liability|debt)/;

const monthKey = iso => String(iso).slice(0, 7);
// 'acct-ab12' -> 'acct-ab12'; any other id gets the prefix. Characters outside [a-z0-9_-] become '-'.
export const seriesKey = id => {
  const safe = String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
  return safe.startsWith('acct-') ? safe : `acct-${safe}`;
};
// Imported names are plain text: braces would read as figure tokens.

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

// { 'YYYY-MM': value } for one account.
function monthlyValues(db, accountId, clock) {
  const byMonth = new Map();
  const bal = db.prepare('SELECT date, amount FROM balances WHERE account_id = ? AND date <= ? ORDER BY date').all(accountId, clock);
  for (const r of bal) byMonth.set(monthKey(r.date), { date: r.date, v: r.amount });
  const pos = db.prepare('SELECT as_of, value, quantity, price FROM positions WHERE account_id = ? AND as_of <= ? ORDER BY as_of').all(accountId, clock);
  const byAsOf = new Map();
  for (const p of pos) {
    const v = Number.isFinite(p.value) ? p.value : Number.isFinite(p.quantity) && Number.isFinite(p.price) ? p.quantity * p.price : null;
    if (v == null) continue;
    byAsOf.set(p.as_of, (byAsOf.get(p.as_of) ?? 0) + v);
  }
  const lastAsOf = new Map();
  for (const asOf of [...byAsOf.keys()].sort()) lastAsOf.set(monthKey(asOf), asOf);
  for (const [month, asOf] of lastAsOf) if (!byMonth.has(month)) byMonth.set(month, { date: asOf, v: byAsOf.get(asOf) });
  return new Map([...byMonth].map(([k, r]) => [k, cents(r.v)]));
}

export function buildSeries(db, clock) {
  const accounts = db.prepare('SELECT id, name, inst, mask, kind, display_name FROM accounts ORDER BY sort, id').all();
  const stored = accounts.map(a => ({ a, values: monthlyValues(db, a.id, clock) })).filter(x => x.values.size);
  if (!stored.length) return {};
  // The window ends at the newest month any account has data for, so no month is shown that no
  // upload covers.
  const end = stored.flatMap(x => [...x.values.keys()]).sort().at(-1);
  const months = monthsEnding(`${end}-01`, MAX_POINTS);
  const first = months[0];
  const out = {};
  const perAccount = [];
  for (const { a, values } of stored) {
    const plain = String(accountLabel(a)).replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim();
    const label = a.mask && !plain.includes(a.mask) ? `${plain} ${a.mask}` : plain;
    const inWindow = months.filter(m => values.has(m));
    if (inWindow.length >= 2) {
      out[seriesKey(a.id)] = {
        label, unit: '$', src: SERIES_SRC, imported: true,
        points: inWindow.map(m => ({ x: monthLabel(`${m}-01`), v: values.get(m), kind: 'a' })),
      };
    }
    // Only accounts with a trend of their own count, so one freshly uploaded account does not blank the total.
    if (inWindow.length >= 2) {
      const debt = LIABILITY.test(String(a.kind || '').toLowerCase());
      perAccount.push(debt ? new Map([...values].map(([k, v]) => [k, -Math.abs(v)])) : values);
    }
  }
  // Combined: each account counts from its first stored month on (its last balance carries
  // forward). The series starts where every counted account has begun.
  if (perAccount.length) {
    const earliest = perAccount.map(v => [...v.keys()].sort()[0]);
    const start = [first, ...earliest].sort().at(-1);
    const points = [];
    for (const m of months) {
      if (m < start) continue;
      let total = 0;
      let ok = true;
      for (const values of perAccount) {
        const upto = [...values.keys()].filter(k => k <= m).sort().at(-1);
        if (upto === undefined) { ok = false; break; }
        total += values.get(upto);
      }
      if (ok) points.push({ x: monthLabel(`${m}-01`), v: cents(total), kind: 'a' });
    }
    if (points.length >= 2) {
      out.net = { label: 'Net worth, accounts with a trend', unit: '$', src: SERIES_SRC, imported: true, points };
    }
  }
  // Net worth first, then accounts in store order.
  const { net, ...rest } = out;
  return net ? { net, ...rest } : rest;
}

// Household trend: the aggregate balance series behind Money. Each account contributes its latest
// balance on or before each month; an account whose data stopped carries its last balance forward
// and is counted as carried; debt is negative; business cash is its own part and, like the net
// worth series before it, is part of the household total.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore } from './helpers/real-store.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { buildTrend, groupOfKind } from '../src/accounts/trend.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-trend-');
after(() => S.cleanup());

const emptyDb = async () => S.track(await createRealStore(S.dir(), { clock: NOW }));
function account(db, id, { name, kind = 'checking', sort = 0, mask = null } = {}) {
  db.prepare('INSERT INTO accounts (id, inst, mask, name, kind, mirror, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Sample Bank', mask, name ?? id, kind, 'manual', sort);
}
const balance = (db, id, date, amount) => db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)').run(id, date, amount);
const position = (db, id, asOf, value) => db.prepare('INSERT INTO positions (account_id, as_of, symbol, value) VALUES (?, ?, ?, ?)').run(id, asOf, 'FUND', value);
const months = [['2026-08-31', 0], ['2026-09-30', 1], ['2026-10-31', 2]];
const fill = (db, id, base, step = 10, from = 0) => months.slice(from).forEach(([d, i]) => balance(db, id, d, base + step * i));

test('groupOfKind puts every kind in one heading, debt first so a card is never cash', () => {
  const g = (k) => groupOfKind(k);
  assert.deepEqual(['checking', 'cash', 'savings'].map(g), ['Cash', 'Cash', 'Cash']);
  assert.deepEqual(['taxable', 'brokerage'].map(g), ['Investing', 'Investing']);
  assert.deepEqual(['retirement', 'roth', 'sep ira', '401k'].map(g), ['Retirement', 'Retirement', 'Retirement', 'Retirement']);
  assert.equal(g('hsa'), 'Health');
  assert.equal(g('529'), 'Education');
  assert.equal(g('business'), 'Business');
  assert.deepEqual(['credit', 'card', 'loan', 'mortgage'].map(g), ['Debt', 'Debt', 'Debt', 'Debt']);
  assert.deepEqual([g('mystery'), g(null), g('')], ['Other', 'Other', 'Other']);
});

test('parts: cash, investments, retirement, education and health, business cash and debt', async () => {
  const db = await emptyDb();
  account(db, 'chk', { kind: 'checking', sort: 1 });
  account(db, 'sav', { kind: 'savings', sort: 2 });
  account(db, 'brk', { kind: 'taxable', sort: 3 });
  account(db, 'ira', { kind: 'retirement', sort: 4 });
  account(db, 'rth', { kind: 'roth', sort: 5 });
  account(db, 'hsa', { kind: 'hsa', sort: 6 });
  account(db, 'c529', { kind: '529', sort: 7 });
  account(db, 'biz', { kind: 'business', sort: 8 });
  account(db, 'card', { kind: 'credit', sort: 9 });
  for (const [id, base] of [['chk', 1000], ['sav', 2000], ['brk', 10000], ['ira', 20000], ['rth', 5000], ['hsa', 300], ['c529', 700], ['biz', 4000], ['card', 500]]) fill(db, id, base, 0);
  const { trend } = buildTrend(db, NOW);
  assert.deepEqual(trend.parts.map(p => p.id), ['cash', 'investments', 'retirement', 'education-health', 'business', 'debt']);
  assert.deepEqual(trend.parts.map(p => p.label), ['Cash', 'Investments', 'Retirement', 'Education and health', 'Business cash', 'Debt']);
  const last = trend.points.at(-1);
  assert.deepEqual(last.parts, { cash: 3000, investments: 10000, retirement: 25000, 'education-health': 1000, business: 4000, debt: -500 });
  assert.equal(last.total, 42500, 'business cash is in the household total, as the old net worth series had it');
  assert.equal(trend.includesBusiness, true);
  assert.deepEqual(last.groups, { Business: 4000, Cash: 3000, Investing: 10000, Retirement: 25000, Health: 300, Education: 700, Debt: -500 });
  assert.deepEqual(trend.groups.map(g => [g.id, g.part]), [['Business', 'business'], ['Cash', 'cash'], ['Investing', 'investments'], ['Retirement', 'retirement'], ['Health', 'education-health'], ['Education', 'education-health'], ['Debt', 'debt']]);
});

test('debt is negative whatever sign the statement used, and lowers the total', async () => {
  const db = await emptyDb();
  account(db, 'chk', { sort: 1 });
  account(db, 'card', { kind: 'credit', sort: 2 });
  account(db, 'loan', { kind: 'loan', sort: 3 });
  fill(db, 'chk', 1000, 100);
  fill(db, 'card', 50, 10);
  months.forEach(([d, i]) => balance(db, 'loan', d, -(200 + i)));
  const { trend } = buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => p.parts.debt), [-250, -261, -272]);
  assert.deepEqual(trend.points.map(p => p.total), [1000 - 250, 1100 - 261, 1200 - 272]);
});

test('a stopped account carries its last balance forward, is counted as carried and named in the note', async () => {
  const db = await emptyDb();
  account(db, 'live', { name: 'Live checking', sort: 1 });
  account(db, 'old', { name: 'Old savings', sort: 2 });
  account(db, 'old2', { name: 'Older savings', sort: 3 });
  fill(db, 'live', 100, 10);
  for (const id of ['old', 'old2']) { balance(db, id, '2026-07-31', 500); balance(db, id, '2026-08-31', 500); }
  const { trend } = buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => p.date), ['2026-08-31', '2026-09-30', '2026-10-31']);
  assert.deepEqual(trend.points.map(p => p.total), [1100, 1110, 1120], 'both stopped balances keep counting');
  assert.deepEqual(trend.points.map(p => p.carried.total), [0, 2, 2]);
  assert.deepEqual(trend.points.at(-1).carried.parts, { cash: 2 });
  assert.equal(trend.note, 'includes 2 accounts last updated Aug 31');
  const one = await emptyDb();
  account(one, 'a', { sort: 1 }); account(one, 'b', { sort: 2 });
  fill(one, 'a', 1, 1);
  balance(one, 'b', '2026-07-15', 9); balance(one, 'b', '2026-08-20', 9);
  assert.equal(buildTrend(one, NOW).trend.note, 'includes 1 account last updated Aug 20');
  const fresh = await emptyDb();
  account(fresh, 'a'); fill(fresh, 'a', 1, 1);
  assert.equal(buildTrend(fresh, NOW).trend.note, null, 'nothing carried, no note');
  assert.deepEqual(buildTrend(fresh, NOW).trend.points[0].carried, { total: 0, parts: {}, groups: {} });
});

test('a month without a balance row is a gap, not stopped data: it is carried silently', async () => {
  const db = await emptyDb();
  account(db, 'a', { sort: 1 }); account(db, 'b', { sort: 2 });
  fill(db, 'a', 100, 0);
  balance(db, 'b', '2026-08-31', 10); balance(db, 'b', '2026-10-31', 30);
  const { trend } = buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => p.total), [110, 110, 130]);
  assert.deepEqual(trend.points.map(p => p.carried.total), [0, 0, 0]);
});

test('the series starts once every counted account has begun; a one-month account waits and is reported', async () => {
  const db = await emptyDb();
  account(db, 'a', { sort: 1 }); account(db, 'b', { kind: 'taxable', sort: 2 }); account(db, 'new', { kind: 'taxable', sort: 3 });
  fill(db, 'a', 100, 10);
  fill(db, 'b', 1000, 100, 1);
  balance(db, 'new', '2026-10-31', 77);
  const { trend } = buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => [p.date, p.total]), [['2026-09-30', 1210], ['2026-10-31', 1320]]);
  assert.equal(trend.pending, 1, 'one account has a single balance so far');
  assert.equal(buildTrend(await emptyDb(), NOW), null, 'no balances, no trend');
  const single = await emptyDb();
  account(single, 'x'); balance(single, 'x', '2026-10-31', 5);
  assert.equal(buildTrend(single, NOW), null, 'one month is not a trend');
});

test('brokerage months without a balance use summed positions; the last point is the newest data date', async () => {
  const db = await emptyDb();
  account(db, 'brk', { kind: 'taxable' });
  position(db, 'brk', '2026-09-15', 4000); position(db, 'brk', '2026-09-15', 1000);
  position(db, 'brk', '2026-10-20', 6000);
  const { trend } = buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => [p.date, p.total]), [['2026-09-30', 5000], ['2026-10-20', 6000]]);
});

test('provenance: each aggregate lists the accounts and dates it sums, with freshness and carried', async () => {
  const db = await emptyDb();
  account(db, 'live', { name: 'Live checking', sort: 1 });
  account(db, 'old', { name: 'Old savings', kind: 'savings', sort: 2 });
  account(db, 'card', { name: 'Travel card', kind: 'credit', sort: 3 });
  fill(db, 'live', 100, 10);
  balance(db, 'old', '2026-07-31', 500); balance(db, 'old', '2026-08-31', 520);
  fill(db, 'card', 40, 0);
  const { trend, figures, source } = buildTrend(db, NOW);
  assert.deepEqual(trend.fig, { total: 'trend.total', parts: { cash: 'trend.part.cash', debt: 'trend.part.debt' }, groups: { Cash: 'trend.group.cash', Debt: 'trend.group.debt' } });
  const total = figures['trend.total'];
  assert.equal(total.v, 120 + 520 - 40);
  assert.equal(total.kind, 'a');
  assert.equal(total.src, 'trend');
  assert.deepEqual(total.sums.map(s => [s.label, s.v, s.asOf, s.carried]), [['Live checking', 120, '2026-10-31', false], ['Old savings', 520, '2026-08-31', true], ['Travel card', -40, '2026-10-31', false]]);
  assert.ok(total.sums.every(s => typeof s.fresh === 'string'));
  assert.deepEqual(figures['trend.part.cash'].sums.map(s => s.label), ['Live checking', 'Old savings']);
  assert.equal(figures['trend.part.cash'].v, 640);
  assert.equal(figures['trend.part.debt'].v, -40);
  assert.equal(figures['trend.group.cash'].v, 640);
  assert.match(source.label, /balances/i);
  assert.equal(source.asOf, '2026-10-31');
});

test('account labels in the provenance are plain text', async () => {
  const db = await emptyDb();
  account(db, 'a', { name: 'Odd {f:cash.total} <b>name</b>' });
  fill(db, 'a', 1, 1);
  const { figures } = buildTrend(db, NOW);
  assert.equal(figures['trend.total'].sums[0].label, 'Odd f:cash.total bname/b');
});

test('the scenario carries the trend, its figures and a group on every account', async () => {
  const db = await emptyDb();
  account(db, 'chk', { name: 'Checking', sort: 1 });
  account(db, 'card', { name: 'Card', kind: 'credit', sort: 2 });
  account(db, 'empty', { name: 'No balances', kind: 'roth', sort: 3 });
  fill(db, 'chk', 100, 10);
  fill(db, 'card', 20, 0);
  const sc = buildScenario(db, { clock: NOW });
  assert.equal(sc.trend.points.length, 3);
  assert.equal(sc.fig['trend.total'].v, 120 - 20);
  assert.equal(sc.src.trend.asOf, '2026-10-31');
  assert.deepEqual(Object.fromEntries(sc.accounts.map(a => [a.id, a.group])), { chk: 'Cash', card: 'Debt', empty: 'Retirement' });
  assert.equal(sc.series.net, undefined, 'the per-account wall and its combined line are gone from the scenario');
  const bare = buildScenario(await emptyDb(), { clock: NOW });
  assert.equal(bare.trend, null);
});

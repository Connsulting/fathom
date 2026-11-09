// Household trend: the aggregate balance series behind Money. Each account contributes its latest
// balance on or before each month; an account whose data stopped carries its last balance forward
// and is counted as carried; debt is negative; business cash is its own part and, like the net
// worth series before it, is part of the household total.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore } from './helpers/real-store.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { buildTrend, groupOfKind } from '../src/accounts/trend.mjs';
import { forEachSeries } from '../src/shared/series.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-trend-');
after(async () => await S.cleanup());

const emptyDb = async () => S.track(await createRealStore(S.dir(), { clock: NOW }));
async function account(db, id, { name, kind = 'checking', sort = 0, mask = null } = {}) {
  await db.prepare('INSERT INTO accounts (id, inst, mask, name, kind, mirror, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Sample Bank', mask, name ?? id, kind, 'manual', sort);
}
const balance = async (db, id, date, amount) => await db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)').run(id, date, amount);
const position = async (db, id, asOf, value) => await db.prepare('INSERT INTO positions (account_id, as_of, symbol, value) VALUES (?, ?, ?, ?)').run(id, asOf, 'FUND', value);
const months = [['2026-08-31', 0], ['2026-09-30', 1], ['2026-10-31', 2]];
const fill = async (db, id, base, step = 10, from = 0) => await forEachSeries(months.slice(from), async ([d, i]) => await balance(db, id, d, base + step * i));

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
  await account(db, 'chk', { kind: 'checking', sort: 1 });
  await account(db, 'sav', { kind: 'savings', sort: 2 });
  await account(db, 'brk', { kind: 'taxable', sort: 3 });
  await account(db, 'ira', { kind: 'retirement', sort: 4 });
  await account(db, 'rth', { kind: 'roth', sort: 5 });
  await account(db, 'hsa', { kind: 'hsa', sort: 6 });
  await account(db, 'c529', { kind: '529', sort: 7 });
  await account(db, 'biz', { kind: 'business', sort: 8 });
  await account(db, 'card', { kind: 'credit', sort: 9 });
  for (const [id, base] of [['chk', 1000], ['sav', 2000], ['brk', 10000], ['ira', 20000], ['rth', 5000], ['hsa', 300], ['c529', 700], ['biz', 4000], ['card', 500]]) await fill(db, id, base, 0);
  const { trend } = await buildTrend(db, NOW);
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
  await account(db, 'chk', { sort: 1 });
  await account(db, 'card', { kind: 'credit', sort: 2 });
  await account(db, 'loan', { kind: 'loan', sort: 3 });
  await fill(db, 'chk', 1000, 100);
  await fill(db, 'card', 50, 10);
  await forEachSeries(months, async ([d, i]) => await balance(db, 'loan', d, -(200 + i)));
  const { trend } = await buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => p.parts.debt), [-250, -261, -272]);
  assert.deepEqual(trend.points.map(p => p.total), [1000 - 250, 1100 - 261, 1200 - 272]);
});

test('a stopped account carries its last balance forward, is counted as carried and named in the note', async () => {
  const db = await emptyDb();
  await account(db, 'live', { name: 'Live checking', sort: 1 });
  await account(db, 'old', { name: 'Old savings', sort: 2 });
  await account(db, 'old2', { name: 'Older savings', sort: 3 });
  await fill(db, 'live', 100, 10);
  for (const id of ['old', 'old2']) { await balance(db, id, '2026-07-31', 500); await balance(db, id, '2026-08-31', 500); }
  const { trend } = await buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => p.date), ['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31']);
  assert.deepEqual(trend.points.map(p => p.total), [1000, 1100, 1110, 1120], 'both stopped balances keep counting; the live account joins in August');
  assert.deepEqual(trend.points.map(p => p.carried.total), [0, 0, 2, 2]);
  assert.deepEqual(trend.points.at(-1).carried.parts, { cash: 2 });
  assert.equal(trend.note, 'includes 2 accounts last updated Aug 31');
  const one = await emptyDb();
  await account(one, 'a', { sort: 1 }); await account(one, 'b', { sort: 2 });
  await fill(one, 'a', 1, 1);
  await balance(one, 'b', '2026-07-15', 9); await balance(one, 'b', '2026-08-20', 9);
  assert.equal((await buildTrend(one, NOW)).trend.note, 'includes 1 account last updated Aug 20');
  const fresh = await emptyDb();
  await account(fresh, 'a'); await fill(fresh, 'a', 1, 1);
  assert.equal((await buildTrend(fresh, NOW)).trend.note, null, 'nothing carried, no note');
  assert.deepEqual((await buildTrend(fresh, NOW)).trend.points[0].carried, { total: 0, parts: {}, groups: {} });
});

test('a month without a balance row is a gap, not stopped data: it is carried silently', async () => {
  const db = await emptyDb();
  await account(db, 'a', { sort: 1 }); await account(db, 'b', { sort: 2 });
  await fill(db, 'a', 100, 0);
  await balance(db, 'b', '2026-08-31', 10); await balance(db, 'b', '2026-10-31', 30);
  const { trend } = await buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => p.total), [110, 110, 130]);
  assert.deepEqual(trend.points.map(p => p.carried.total), [0, 0, 0]);
});

test('an account adds nothing before its first balance, and one month of data is not a trend', async () => {
  const db = await emptyDb();
  await account(db, 'a', { sort: 1 }); await account(db, 'b', { kind: 'taxable', sort: 2 }); await account(db, 'new', { kind: 'taxable', sort: 3 });
  await fill(db, 'a', 100, 10);
  await fill(db, 'b', 1000, 100, 1);
  await balance(db, 'new', '2026-10-31', 77);
  const { trend } = await buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => [p.date, p.total]), [['2026-08-31', 100], ['2026-09-30', 1210], ['2026-10-31', 1397]]);
  // A part whose accounts have not begun is zero at that point, never missing.
  assert.deepEqual(trend.points[0].parts, { cash: 100, investments: 0 });
  assert.deepEqual(trend.points[0].groups, { Cash: 100, Investing: 0 });
  for (const p of trend.points) for (const part of trend.parts) assert.ok(Number.isFinite(p.parts[part.id]), `${part.id} at ${p.date}`);
  assert.equal(await buildTrend(await emptyDb(), NOW), null, 'no balances, no trend');
  const single = await emptyDb();
  await account(single, 'x'); await balance(single, 'x', '2026-10-31', 5);
  assert.equal(await buildTrend(single, NOW), null, 'one month is not a trend');
});

test('brokerage months without a balance use summed positions; the last point is the newest data date', async () => {
  const db = await emptyDb();
  await account(db, 'brk', { kind: 'taxable' });
  await position(db, 'brk', '2026-09-15', 4000); await position(db, 'brk', '2026-09-15', 1000);
  await position(db, 'brk', '2026-10-20', 6000);
  const { trend } = await buildTrend(db, NOW);
  assert.deepEqual(trend.points.map(p => [p.date, p.total]), [['2026-09-30', 5000], ['2026-10-20', 6000]]);
});

test('provenance: each aggregate lists the accounts and dates it sums, with freshness and carried', async () => {
  const db = await emptyDb();
  await account(db, 'live', { name: 'Live checking', sort: 1 });
  await account(db, 'old', { name: 'Old savings', kind: 'savings', sort: 2 });
  await account(db, 'card', { name: 'Travel card', kind: 'credit', sort: 3 });
  await fill(db, 'live', 100, 10);
  await balance(db, 'old', '2026-07-31', 500); await balance(db, 'old', '2026-08-31', 520);
  await fill(db, 'card', 40, 0);
  const { trend, figures, source } = await buildTrend(db, NOW);
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
  await account(db, 'a', { name: 'Odd {f:cash.total} <b>name</b>' });
  await fill(db, 'a', 1, 1);
  const { figures } = await buildTrend(db, NOW);
  assert.equal(figures['trend.total'].sums[0].label, 'Odd f:cash.total bname/b');
});

test('the scenario carries the trend, its figures and a group on every account', async () => {
  const db = await emptyDb();
  await account(db, 'chk', { name: 'Checking', sort: 1 });
  await account(db, 'card', { name: 'Card', kind: 'credit', sort: 2 });
  await account(db, 'empty', { name: 'No balances', kind: 'roth', sort: 3 });
  await fill(db, 'chk', 100, 10);
  await fill(db, 'card', 20, 0);
  const sc = await buildScenario(db, { clock: NOW });
  assert.equal(sc.trend.points.length, 3);
  assert.equal(sc.fig['trend.total'].v, 120 - 20);
  assert.equal(sc.src.trend.asOf, '2026-10-31');
  assert.deepEqual(Object.fromEntries(sc.accounts.map(a => [a.id, a.group])), { chk: 'Cash', card: 'Debt', empty: 'Retirement' });
  assert.equal(sc.series.net, undefined, 'the per-account wall and its combined line are gone from the scenario');
  const bare = await buildScenario(await emptyDb(), { clock: NOW });
  assert.equal(bare.trend, null);
});

test('provenance dates the reading actually used: a balance beats later positions in its month', async () => {
  const db = await emptyDb();
  await account(db, 'brk', { kind: 'taxable', name: 'Brokerage' });
  await balance(db, 'brk', '2026-09-30', 90);
  await balance(db, 'brk', '2026-10-15', 100);
  await position(db, 'brk', '2026-10-31', 120);
  const { trend, figures } = await buildTrend(db, NOW);
  assert.equal(figures['trend.total'].v, 100);
  assert.deepEqual(figures['trend.total'].sums.map(s => [s.v, s.asOf]), [[100, '2026-10-15']]);
  assert.equal(trend.points.at(-1).date, '2026-10-15', 'the point is dated by the reading too');
});

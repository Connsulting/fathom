import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDb } from './helpers/server.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildTrend } from '../src/accounts/trend.mjs';
import { accountDetail } from '../src/api/account-detail.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

async function fixture(t) {
  const s = await tempDb();
  t.after(() => s.close());
  const { db } = s;
  db.prepare("INSERT INTO sources (id,label,kind,as_of) VALUES ('ing:balances','Synthetic balances','balances','2026-10-31')").run();
  for (const [id, kind] of [['cash','checking'],['invest','taxable'],['retire','retirement'],['roth','roth'],['debt','card'],['biz','business'],['silent','checking']]) {
    db.prepare("INSERT INTO accounts (id,name,kind,mask,source_id) VALUES (?,?,?,'1234','ing:balances')").run(id, `Synthetic ${id}`, kind);
  }
  const ins = db.prepare("INSERT INTO balances (account_id,date,amount) VALUES (?,?,?)");
  for (const [id,a,b] of [['cash',1000.11,1100.12],['invest',2000.22,2300.32],['retire',3000.33,3100.43],['roth',500,550],['debt',400,450],['biz',700,750]]) {
    ins.run(id,'2026-08-31',a);
    if (id !== 'cash') ins.run(id,'2026-10-31',b);
  }
  return { ...s, ctx: { db, dataDir: s.dataDir, clock: '2026-11-05' } };
}

test('net worth totals and each monthly part match buildTrend, including debt and carried balances', async t => {
  const { db, ctx } = await fixture(t);
  const expected = buildTrend(db, ctx.clock).trend;
  const result = await callTool('accounts', { operation: 'net_worth', series: true, months: 3 }, ctx);
  assert.equal(result.total.value, expected.points.at(-1).total);
  assert.deepEqual(result.groups.map(g => [g.key,g.figure.value]), Object.entries(expected.points.at(-1).parts));
  assert.equal(result.series.length, 3);
  for (const [i, point] of result.series.entries()) {
    assert.equal(point.total.value, expected.points[i].total);
    assert.deepEqual(point.groups.map(g => [g.key,g.figure.value]), Object.entries(expected.points[i].parts));
  }
  assert.ok(result.carried.some(a => a.id === 'cash' && a.lastDate === '2026-08-31'));
  assert.ok(result.gaps.some(g => g.code === 'carried_balance' && g.message.includes('cash')));
  assert.equal(result.total.asOf, '2026-10-31');
  assert.ok(!JSON.stringify(result).includes('undefined'));
  await assertRefsResolve(result, ctx);
});

test('net worth filters accounts, excludes business, supports treatment and explicit plan types', async t => {
  const { db, ctx } = await fixture(t);
  const all = await callTool('accounts', { operation: 'net_worth' }, ctx);
  const personal = await callTool('accounts', { operation: 'net_worth', includeBusiness: false }, ctx);
  assert.equal(personal.total.value, Math.round((all.total.value - 750) * 100) / 100);
  const groups = await callTool('accounts', { operation: 'net_worth', groupBy: 'treatment' }, ctx);
  assert.ok(groups.gaps.some(g => g.code === 'missing_fact' && g.message.includes('retire')));
  assert.equal(groups.groups.find(g => g.key === 'taxable').figure.value, 2300.32);
  db.prepare("INSERT INTO facts (key,value,updated_at) VALUES ('accounts.planType',?, '2026-11-01')").run(JSON.stringify({ retire: '401k' }));
  const typed = await callTool('accounts', { operation: 'net_worth', groupBy: 'treatment', accounts: ['retire','roth'] }, ctx);
  assert.equal(typed.groups.find(g => g.key === 'pretax').figure.value, 3100.43);
  assert.ok(!typed.gaps.some(g => g.code === 'missing_fact'));
  await assertRefsResolve(typed, ctx);
  const one = await callTool('accounts', { operation: 'net_worth', accounts: ['cash'], groupBy: 'group' }, ctx);
  assert.equal(one.total.value, 1000.11);
  assert.equal(one.groups[0].key, 'Cash');
  await assert.rejects(callTool('accounts', { operation: 'net_worth', accounts: ['absent'] }, ctx), e => e.code === 'not_found');
});

test('empty and one-month stores return an unavailable or actual total without invented history', async t => {
  const { db, ctx } = await fixture(t);
  db.exec('DELETE FROM balances');
  const empty = await callTool('accounts', { operation: 'net_worth', series: true }, ctx);
  assert.equal(empty.total.value, null);
  assert.ok(empty.gaps.some(g => g.code === 'missing_fact'));
  db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('cash','2026-10-31',42.25)").run();
  const one = await callTool('accounts', { operation: 'net_worth', series: true }, ctx);
  assert.equal(one.total.value, 42.25);
  assert.equal(one.series.length, 1);
  await assertRefsResolve(one, ctx);
});

test('account detail preserves the API result and adds a referenceable balance envelope', async t => {
  const { db, ctx } = await fixture(t);
  const api = accountDetail({ db, params: { id: 'cash' }, config: { clock: ctx.clock } });
  const result = await callTool('accounts', { operation: 'detail', id: 'cash' }, ctx);
  const { balance, ...rest } = result;
  const { balance: apiBalance, ...apiRest } = api;
  assert.deepEqual(rest, apiRest);
  assert.equal(balance.asOf, apiBalance.asOf);
  assert.equal(balance.value, 1000.11);
  await assertRefsResolve(result, ctx);
  const silent = await callTool('accounts', { operation: 'detail', id: 'silent' }, ctx);
  assert.equal(silent.balance.value, null);
  await assert.rejects(callTool('accounts', { operation: 'detail', id: 'absent' }, ctx), e => e.code === 'not_found');
});

test('monthly positions fill missing balances and respect the clock and balance precedence', async t => {
  const { db, ctx } = await fixture(t);
  db.prepare("INSERT INTO accounts (id,name,kind) VALUES ('positions','Synthetic positions','brokerage')").run();
  for (const [date,value] of [['2026-09-30',123.45],['2026-10-31',234.56],['2026-12-31',999]]) {
    db.prepare("INSERT INTO positions (account_id,symbol,value,as_of) VALUES ('positions','SYN',?,?)").run(value,date);
  }
  const result = await callTool('accounts', { operation: 'net_worth', accounts: ['positions'], series: true }, ctx);
  assert.equal(result.total.value, 234.56);
  assert.equal(result.series.length, 2);
  assert.equal(result.total.provenance.sources[0].table, 'positions');
  const detail = await callTool('accounts', { operation: 'detail', id: 'positions' }, ctx);
  assert.equal(detail.balance.value, 999, 'detail uses the same latest reading as the API');
  await assertRefsResolve(result, ctx);
  db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('positions','2026-10-01',12.34)").run();
  assert.equal((await callTool('accounts', { operation: 'net_worth', accounts: ['positions'] }, ctx)).total.value, 12.34);
});

test('unpriced positions stay unavailable and unknown treatment strings remain explicit gaps', async t => {
  const { db, ctx } = await fixture(t);
  db.prepare("INSERT INTO accounts (id,name,kind) VALUES ('unpriced','Synthetic unpriced','brokerage')").run();
  db.prepare("INSERT INTO positions (account_id,symbol,as_of) VALUES ('unpriced','SYN','2026-10-31')").run();
  const unpriced = await callTool('accounts', { operation: 'detail', id: 'unpriced' }, ctx);
  assert.equal(unpriced.balance.value, null);
  assert.ok(unpriced.balance.gaps.some(g => g.code === 'missing_fact'));
  db.prepare("UPDATE accounts SET kind='constructor' WHERE id='retire'").run();
  const out = await callTool('accounts', { operation: 'net_worth', accounts: ['retire'], groupBy: 'treatment' }, ctx);
  assert.equal(out.total.value, 3100.43);
  assert.equal(out.groups[0].key, 'unknown');
  assert.ok(out.gaps.some(g => g.code === 'missing_fact'));
  await assertRefsResolve(out, ctx);
});

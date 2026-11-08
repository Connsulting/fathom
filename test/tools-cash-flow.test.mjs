import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore, custom } from './helpers/spending.mjs';
import { matchTransfers } from '../src/categories/resolve.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

test('cash flow keeps matched transfers out of inflow and outflow on both sides', async (t) => {
  const s = await spendingStore(t);
  const out = await s.tx('business', '2026-04-15', -77, 'Business', 'Owner distribution');
  await s.tx('checking', '2026-04-16', 77, 'Income', 'Distribution');
  await s.tx('checking', '2026-05-01', -33, null, 'Capital');
  await s.tx('business', '2026-05-02', 33, null, 'Capital');
  await s.tx('business', '2026-04-10', 137, 'Income', 'Client');
  const rows = await s.db.prepare('SELECT * FROM transactions').all();
  assert.ok(
    matchTransfers(
      rows.filter((x) => x.amount < 0),
      rows.filter((x) => x.amount > 0),
    ).has(out),
  );
  const r = await s.call('cash_flow', custom);
  assert.equal(r.totals.transfersBusinessToHousehold.value, 77);
  assert.equal(r.totals.transfersHouseholdToBusiness.value, 33);
  assert.equal(r.totals.household.inflow.value, 3000);
  assert.equal(r.totals.household.outflow.value, 1650);
  assert.equal(r.totals.business.inflow.value, 137);
  assert.equal(r.totals.business.outflow.value, 0);
  for (const side of ['business', 'household'])
    assert.equal(r.totals[side].net.value, r.totals[side].inflow.value - r.totals[side].outflow.value);
  await assertRefsResolve(r, s.ctx);
  const hh = await s.call('cash_flow', { ...custom, scope: 'household' });
  assert.equal(hh.totals.business.inflow.value, 0);
});

test('cash flow attaches partial and missing-month gaps to monthly figures and totals', async t => {
  const s=await spendingStore(t);await s.tx('checking','2026-11-01',-7,'Shopping','Partial month');
  const r=await s.call('cash_flow',{scope:'household'});
  assert.ok(r.gaps.some(g=>g.code==='incomplete_month'));
  assert.ok(r.months.find(m=>m.month==='2026-11').household.net.gaps.some(g=>g.code==='incomplete_month'));
  assert.ok(r.totals.household.net.gaps.some(g=>g.code==='incomplete_month'));
  assert.equal(r.months.find(m=>m.month==='2026-04').household.net.gaps.some(g=>g.code==='incomplete_month'),false);
  const old=await s.call('cash_flow',{from:'2025-01',to:'2025-02',scope:'household'});
  assert.equal(old.gaps.find(g=>g.code==='incomplete_month').count,2);
});

test('expected-value grading recognizes an unsigned net cash outflow without accepting an inflow', async () => {
  const {gradeExpected}=await import('../evals/graders.mjs');
  assert.equal(gradeExpected('The net cash outflow is $5,031.16.',[-5031.16]).ok,true);
  assert.equal(gradeExpected('The net cash inflow is $5,031.16.',[-5031.16]).ok,false);
  assert.equal(gradeExpected('The returned result is $5,031.16.',[-5031.16]).ok,false);
  assert.equal(gradeExpected('The net cash outflow is $5,031.16.',[5031.16]).ok,false);
  assert.equal(gradeExpected('The net cash outflow is $5,031.16.',[-5000]).ok,false);
});

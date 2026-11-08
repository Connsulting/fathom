import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore } from './helpers/spending.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

test('recurring detects monthly quarterly annual stopped and changed series without transfers', async (t) => {
  const s = await spendingStore(t);
  for (const [date, v] of [
    ['2026-07-01', 10],
    ['2026-08-01', 10],
    ['2026-09-01', 15],
    ['2026-10-01', 15],
  ])
    await s.tx('card', date, -v, 'Shopping', 'Example subscription');
  for (const date of ['2026-01-05', '2026-04-05', '2026-07-05', '2026-10-05'])
    await s.tx('card', date, -30, 'Shopping', 'Quarterly service');
  for (const date of ['2025-10-15', '2026-10-15']) await s.tx('card', date, -120, 'Shopping', 'Annual service');
  for (const date of ['2026-01-20', '2026-02-20', '2026-03-20']) await s.tx('card', date, -20, 'Shopping', 'Stopped service');
  for (const date of ['2026-01-25', '2026-02-25', '2026-03-25']) {
    await s.tx('checking', date, -99, 'Internal Transfers', 'Transfer service');
    await s.tx('card', date, 99, 'Credit Card Payment', 'Transfer service');
  }
  const r = await s.call('recurring', { status: 'all' }),
    by = Object.fromEntries(r.charges.map((c) => [c.merchant, c]));
  assert.equal(by['example subscription'].cadence, 'monthly');
  assert.equal(by['example subscription'].amountStable, false);
  assert.equal(by['quarterly service'].cadence, 'quarterly');
  assert.equal(by['annual service'].cadence, 'annual');
  assert.equal(by['annual service'].annualCost.value, 120);
  assert.equal(by['stopped service'].status, 'stopped');
  assert.equal(by['transfer service'], undefined);
  const changedId = await s.tx('card', '2026-11-01', -25, 'Shopping', 'Example subscription');
  const changed = await s.call('recurring', { status: 'all' });
  const c = changed.charges.find((x) => x.merchant === 'example subscription');
  assert.equal(c.changed.from.value, 15);
  assert.equal(c.changed.to.value, 25);
  assert.ok(c.changed.to.provenance.sources.some((x) => x.ids.includes(changedId)));
  const newCharges = await s.call('recurring', { status: 'new', since: '2026-07-01' });
  assert.ok(newCharges.charges.some((c) => c.merchant === 'example subscription'));
  assert.ok((await s.call('recurring', { cadence: 'annual' })).charges.every((c) => c.cadence === 'annual'));
  await assertRefsResolve(await s.call('recurring', { status: 'stopped', limit: 2 }), s.ctx);
});

test('recurring total provenance includes only the series accepted by its filters', async t => {
  const s=await spendingStore(t);
  const included=[];
  for(const date of ['2025-10-15','2026-10-15'])included.push(await s.tx('card',date,-71,'Shopping','Annual sample'));
  await s.tx('card','2026-10-16',-51,'Shopping','One time sample');
  const r=await s.call('recurring',{cadence:'annual'});
  assert.deepEqual(r.totalAnnual.provenance.sources[0].ids,included);
  assert.equal(r.totalAnnual.provenance.sources[0].count,2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore, custom } from './helpers/spending.mjs';
import { callTool } from '../src/tools/index.mjs';
import { businessPnl, pnlEntities } from '../src/pnl/index.mjs';
import { getPnlRows } from '../src/api/pnl-handlers.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

test('business uses API calculators for totals prior periods and row drilldowns', async (t) => {
  const s = await spendingStore(t);
  await s.fact('business.entities', [{ name: 'Example Studio' }]);
  await s.fact('accounts.businessEntity', { business: 'Example Studio' });
  for (const date of ['2025-03-01', '2026-03-01', '2026-04-01', '2026-05-01']) {
    await s.tx('business', date, 1000, 'Income', 'Client');
    await s.tx('business', date, -100, 'Business', 'Supplies');
  }
  const entities = await pnlEntities({ db: s.db, clock: s.ctx.clock });
  const args = { operation: 'pnl', ...custom, compareToPriorYear: true };
  const r = await callTool('business', args, s.ctx);
  assert.equal(r.entities.length, entities.length);
  const p = await businessPnl({ db: s.db, entity: entities[0].key, ...custom, clock: s.ctx.clock }),
    f = (k) => p.figures[k]?.v ?? 0;
  const e = r.entities[0];
  assert.equal(e.revenue.value, f(p.income.total));
  assert.equal(e.expenses.value, f(p.expenses.total));
  assert.equal(e.profit.value, f(p.net.total));
  assert.equal(e.margin.value, 0.9);
  assert.equal(e.prior.revenue.value, f(p.prior.income));
  assert.equal(e.prior.revenueDifference.value, 2000);
  assert.equal(e.prior.revenueRatio.value, 3);
  const query = { entity: entities[0].key, ...custom, section: 'expenses', category: 'Business' };
  assert.deepEqual(
    await callTool('business', { operation: 'rows', ...query }, s.ctx),
    await getPnlRows({ db: s.db, query, config: { clock: s.ctx.clock } }),
  );
  await assertRefsResolve(r, s.ctx);
  for (const groupBy of ['none', 'category', 'month'])
    assert.ok((await callTool('business', { operation: 'pnl', ...custom, groupBy }, s.ctx)).entities[0]);
});

test('business accepts the shared maximum period and rejects an oversized one', async (t) => {
  const s = await spendingStore(t);
  await s.fact('business.entities', [{ name: 'Example Studio' }]);
  await s.tx('business', '2026-05-01', 100, 'Income', 'Client');
  const r = await callTool('business', { operation: 'pnl', from: '2016-06', to: '2026-05' }, s.ctx);
  assert.equal(r.entities[0].revenue.window.months, 120);
  await assert.rejects(
    callTool('business', { operation: 'pnl', from: '2016-05', to: '2026-05' }, s.ctx),
    (e) => e.code === 'bad_input',
  );
});

test('large business rows remain identical to the API and keep the full sum', async (t) => {
  const s = await spendingStore(t);
  await s.fact('business.entities', [{ name: 'Example Studio' }]);
  for (let i = 0; i < 550; i++)
    await s.tx('business', '2026-04-01', -1, 'Business', 'Synthetic merchant ' + 'x'.repeat(1000));
  const query = { entity: 'Example Studio', ...custom, section: 'expenses', category: 'Business' };
  const r = await callTool('business', { operation: 'rows', ...query }, s.ctx);
  assert.equal(r.total, 550);
  assert.equal(r.figures[r.sum].v, 550);
  assert.ok(r.truncated);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 256 * 1024);
  assert.deepEqual(r, await getPnlRows({ db: s.db, query, config: { clock: s.ctx.clock } }));
});

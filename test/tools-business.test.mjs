import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore, custom } from './helpers/spending.mjs';
import { callTool } from '../src/tools/index.mjs';
import { businessPnl, pnlEntities } from '../src/pnl/index.mjs';
import { getPnlRows } from '../src/api/pnl-handlers.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

test('business uses API calculators for totals prior periods and row drilldowns', async t=>{
  const s=await spendingStore(t); s.fact('business.entities',[{name:'Example Studio'}]); s.fact('accounts.businessEntity',{business:'Example Studio'});
  for (const date of ['2025-03-01','2026-03-01','2026-04-01','2026-05-01']) { s.tx('business',date,1000,'Income','Client'); s.tx('business',date,-100,'Business','Supplies'); }
  const entities=pnlEntities({db:s.db,clock:s.ctx.clock});
  const args={operation:'pnl',...custom,compareToPriorYear:true};
  const r=await callTool('business',args,s.ctx); assert.equal(r.entities.length,entities.length);
  const p=businessPnl({db:s.db,entity:entities[0].key,...custom,clock:s.ctx.clock}),f=k=>p.figures[k]?.v??0;
  const e=r.entities[0]; assert.equal(e.revenue.value,f(p.income.total)); assert.equal(e.expenses.value,f(p.expenses.total)); assert.equal(e.profit.value,f(p.net.total)); assert.equal(e.margin.value,.9);
  assert.equal(e.prior.revenue.value,f(p.prior.income)); assert.equal(e.prior.revenueDifference.value,2000); assert.equal(e.prior.revenueRatio.value,3);
  const query={entity:entities[0].key,...custom,section:'expenses',category:'Business'};
  assert.deepEqual(await callTool('business',{operation:'rows',...query},s.ctx),getPnlRows({db:s.db,query,config:{clock:s.ctx.clock}}));
  await assertRefsResolve(r,s.ctx);
  for (const groupBy of ['none','category','month']) assert.ok((await callTool('business',{operation:'pnl',...custom,groupBy},s.ctx)).entities[0]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore } from './helpers/spending.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';
import { callTool } from '../src/tools/index.mjs';
import { round } from '../src/calc/figure.mjs';

const owner = (value, evidence = `$${value}`) => ({ value, source:'owner',evidence });
const rate = value => owner(value,`${value * 100} percent`);
const rates = { ordinaryRate:rate(0.24),capitalGainsRate:rate(0.15),stateRate:rate(0.05) };
async function setup(t) {
  const s = await spendingStore(t);
  s.ctx.channel = 'mcp';
  return { ...s, afterTax:(args={})=>callTool('retirement',{ operation:'after_tax',...rates,...args },s.ctx) };
}

test('pretax, taxable and cash hypothetical values apply their tax rules and preserve refs',async t => {
  const s = await setup(t);
  const out = await s.afterTax({ hypothetical:[
    { treatment:'pretax',value:owner(100000) },
    { treatment:'taxable',value:owner(100000),basis:owner(60000) },
    { treatment:'cash',value:owner(10000) },
  ] });
  assert.equal(out.rows[0].taxOnWithdrawal.value,29000);
  assert.equal(out.rows[0].afterTax.value,71000);
  assert.equal(out.rows[1].unrealizedGain.value,40000);
  assert.equal(out.rows[1].taxOnWithdrawal.value,8000);
  assert.equal(out.rows[1].afterTax.value,92000);
  assert.equal(out.rows[2].taxOnWithdrawal.value,0);
  assert.equal(out.rows[2].afterTax.value,10000);
  assert.equal(out.total.value.value,210000);
  assert.equal(out.total.afterTax.value,173000);
  assert.ok(out.rows.every(r => r.packRef?.packId === 'account-tax-treatment'));
  assert.ok(out.rows.every(r => r.afterTax.provenance.packRefs.length));
  await assertRefsResolve(out,s.ctx);
});

test('actual taxable positions without basis are unavailable and count missing positions',async t => {
  const s = await setup(t);
  s.account('broker','brokerage');
  const insert = s.db.prepare('INSERT INTO positions(account_id,as_of,symbol,value,cost_basis) VALUES (?,?,?,?,?)');
  await insert.run('broker','2026-10-31','SYN-A',10000,5000);
  await insert.run('broker','2026-10-31','SYN-B',20000,null);
  await insert.run('broker','2026-10-31','SYN-C',30000,null);
  const out = await s.afterTax({accounts:['broker']});
  const row = out.rows[0];
  assert.equal(row.value.value,60000);
  for (const key of ['basis','unrealizedGain','taxOnWithdrawal','afterTax']) assert.equal(row[key].value,null,key);
  assert.ok(out.gaps.some(g => g.code === 'no_cost_basis' && g.count === 2));
  assert.equal(out.total.afterTax.value,null);
  await assertRefsResolve(out,s.ctx);
  await s.db.prepare('UPDATE positions SET cost_basis=0 WHERE cost_basis IS NULL').run();
  const complete = await s.afterTax({kinds:['brokerage']});
  assert.equal(complete.rows[0].taxOnWithdrawal.value,11000);
  assert.equal(complete.rows[0].afterTax.value,49000);
});

test('missing hypothetical basis stays unavailable and no loss tax credit is invented',async t => {
  const s = await setup(t);
  const missing = await s.afterTax({hypothetical:[{ treatment:'taxable',value:owner(15000000,'$15 million') }]});
  assert.equal(missing.rows[0].afterTax.value,null);
  assert.ok(missing.gaps.some(g => g.code === 'no_cost_basis'));
  const loss = await s.afterTax({hypothetical:[{ treatment:'taxable',value:owner(1000),basis:owner(2000) }]});
  assert.equal(loss.rows[0].unrealizedGain.value,-1000);
  assert.equal(loss.rows[0].taxOnWithdrawal.value,0);
});

test('Roth qualification uses the later age and five-year dates, naming missing facts',async t => {
  const s = await setup(t);
  s.account('roth','roth','owner');
  await s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run('roth','2026-10-31',10000);
  const missing = await s.afterTax({accounts:['roth']});
  assert.equal(missing.rows[0].afterTax.value,10000);
  assert.equal(missing.rows[0].qualifiedFrom.value,null);
  assert.ok(missing.rows[0].whenTaxed.includes('qualified'));
  await s.fact('household.ownerBirthDate','1970-01-01');
  await s.fact('accounts.rothFirstContributionYear',{roth:2026});
  await s.fact('accounts.planType',{roth:'roth_ira'});
  const known = await s.afterTax({accounts:['roth']});
  assert.equal(known.rows[0].treatment,'roth_ira');
  assert.equal(known.rows[0].qualifiedFrom.value,'2031-01-01');
  await assertRefsResolve(known,s.ctx);
  await s.fact('accounts.rothFirstContributionYear',{roth:2000});
  await s.fact('household.ownerBirthDate','1970-08-31');
  const monthEnd = await s.afterTax({accounts:['roth']});
  assert.equal(monthEnd.rows[0].qualifiedFrom.value,'2030-02-28');
  await s.fact('household.ownerBirthDate','1964-08-31');
  const leap = await s.afterTax({accounts:['roth']});
  assert.equal(leap.rows[0].qualifiedFrom.value,'2024-02-29');
  await assertRefsResolve(leap,s.ctx);
});

test('HSA presents both purposes, with age-dependent additional tax and missing-age gaps',async t => {
  const s = await setup(t);
  s.account('health','hsa','owner');
  await s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run('health','2026-10-31',10000);
  let out = await s.afterTax({accounts:['health']});
  assert.equal(out.rows[0].afterTaxMedical.value,10000);
  assert.equal(out.rows[0].afterTaxNonmedical.value,null);
  assert.equal(out.rows[0].afterTax.value,null);
  await s.fact('household.ownerBirthDate','1980-01-01');
  out = await s.afterTax({accounts:['health']});
  assert.equal(out.rows[0].afterTaxNonmedical.value,5100);
  assert.ok(out.gaps.some(g => /purpose|choose/i.test(g.message)));
  await s.fact('household.ownerBirthDate','1960-01-01');
  out = await s.afterTax({accounts:['health']});
  assert.equal(out.rows[0].afterTaxNonmedical.value,7100);
  await assertRefsResolve(out,s.ctx);
});

test('generic retirement needs plan type; rates resolve calculate refs without defaults',async t => {
  const s = await setup(t);
  s.account('pension','retirement','owner');
  await s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run('pension','2026-10-31',10000);
  const unknown = await s.afterTax({accounts:['pension']});
  assert.equal(unknown.rows[0].afterTax.value,null);
  assert.ok(unknown.gaps.some(g=>g.code==='missing_fact' && g.fact==='accounts.planType'));
  await s.fact('accounts.planType',{pension:'401k'});
  const computed = await callTool('calculate',{operation:'add',operands:[{assumption:{...rate(0.1),name:'base',unit:'ratio'}},{assumption:{...rate(0.14),name:'extra',unit:'ratio'}}],label:'Ordinary rate'},s.ctx);
  const out = await s.afterTax({accounts:['pension'],ordinaryRate:{ref:computed.figure.ref}});
  assert.equal(out.rows[0].afterTax.value,round(10000 * (1 - 0.24 - 0.05)));
  await assertRefsResolve(out,s.ctx);
  for (const args of [
    {ordinaryRate:0.24}, {ordinaryRate:rate(0.61)}, {stateRate:{value:0.05,source:'default'}},
    {accounts:['pension'],hypothetical:[{treatment:'pretax',value:owner(1)}]},
  ]) await assert.rejects(s.afterTax(args),e=>e.code==='bad_input');
  await assert.rejects(callTool('retirement',{operation:'after_tax'},s.ctx),e=>e.code==='bad_input');
});

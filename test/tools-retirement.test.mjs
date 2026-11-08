import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore, custom } from './helpers/spending.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';
import { callTool, instructions } from '../src/tools/index.mjs';
import { independencePlan, monthsToReach, spendingInputs, TARGET_PARAMETERS } from '../src/calc/targets.mjs';
import { futureValue, requiredMonthly } from '../src/calc/growth.mjs';
import { round } from '../src/calc/figure.mjs';
import { readInput } from '../src/tools/catalog/spending.mjs';
import { createRegistryServer } from '../src/engine/tools.mjs';
import { tools } from '../src/tools/index.mjs';
import { loadCases } from '../evals/cases.mjs';
import { runCases } from '../evals/harness.mjs';

const owner = (value, evidence = `$${value}`) => ({ value, source: 'owner', evidence });
const rate = value => owner(value, `${value * 100} percent`);
async function setup(t) {
  const s = await spendingStore(t);
  s.ctx.channel = 'mcp';
  s.account('investments', 'taxable');
  s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run('investments','2026-10-31',10000);
  return { ...s, retirement: (operation, args = {}, ctx = s.ctx) => callTool('retirement', { operation, ...args }, ctx) };
}

test('target chains Q01 spending and matches independencePlan, with provenance and replayable refs', async t => {
  const s = await setup(t);
  const spending = await s.call('total', { ...custom, definition: 'core_living', annualize: true });
  const args = { spending: spending.total.ref, withdrawalRate: rate(0.04) };
  const out = await s.retirement('target', args);
  const sp = spendingInputs(readInput(s.ctx));
  const plan = independencePlan({ spending: { ...sp, annualSpend: spending.total.value }, invested: { total: 10000, held: [], left: [] }, horizon: 'now', clock: s.ctx.clock, withdrawalRate: 0.04 });
  assert.equal(out.target.value, Math.ceil(spending.total.value / 0.04 / 1000) * 1000);
  assert.equal(out.target.value, plan.target);
  assert.equal(out.gap.value, Math.max(0,plan.target - 10000));
  assert.equal(out.months.value, plan.months);
  assert.equal(out.projectedDate.value, plan.targetDate);
  assert.equal(out.status, 'projected');
  assert.equal(out.monthlySavings.value, sp.monthlySavings);
  assert.ok(out.target.provenance.inputs.some(i => i.ref?.tool === 'spending'));
  assert.ok(out.target.provenance.assumptions.some(a => a.name === 'withdrawalRate' && a.source === 'owner'));
  assert.ok(out.gaps.some(g => g.code === 'account_no_history'));
  assert.equal(out.investedNow.asOf, '2026-10-31');
  await assertRefsResolve(out, s.ctx);
});

test('target covers each projection status and explicit selectors exclude business accounts', async t => {
  const s = await setup(t);
  const initial = await s.retirement('target');
  assert.equal(initial.target.value, Math.ceil((await s.call('total',{ annualize: true, definition: 'household_spending' })).total.value / 0.04 / 1000) * 1000);
  s.db.prepare('UPDATE balances SET amount=? WHERE account_id=?').run(1000000,'investments');
  const covered = await s.retirement('target');
  assert.equal(covered.status, 'covered');
  assert.equal(covered.months.value, 0);
  assert.equal(covered.gap.value, 0);
  assert.equal(covered.projectedDate.value, '2026-11-05');
  s.db.prepare('UPDATE balances SET amount=0 WHERE account_id=?').run('investments');
  const noSavings = await s.retirement('target',{ monthlySavings: owner(0) });
  assert.equal(noSavings.status,'no_savings');
  assert.equal(noSavings.months,null);
  assert.equal(noSavings.projectedDate,null);
  const tooLong = await s.retirement('target',{ monthlySavings: owner(1), realReturn: rate(0) });
  assert.equal(tooLong.status,'too_long');
  assert.equal(tooLong.projectedDate,null);
  const selected = await s.retirement('target',{ invested: { accounts: ['investments'], treatments: ['taxable'] }, roundTo: 1 });
  assert.equal(selected.target.value,Math.ceil((await s.call('total',{ annualize:true })).total.value / 0.04));
  assert.ok(selected.investedNow.provenance.accounts.every(a => a.id === 'investments'));
  s.account('company-investment','taxable','Business');
  s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run('company-investment','2026-10-31',9000000);
  assert.equal((await s.retirement('target')).investedNow.value,0);
});

test('growth solves balance, months and monthly using shared deterministic calculators', async t => {
  const s = await setup(t);
  const common = { balance: owner(10000), realReturn: rate(0.04) };
  const balance = await s.retirement('growth',{ ...common, solve:'balance', monthlyContribution: owner(200), years:10 });
  assert.equal(balance.figure.value,round(futureValue({ balance:10000, monthly:200, annualRate:0.04, months:120 })));
  const months = await s.retirement('growth',{ ...common, solve:'months', monthlyContribution:owner(200), target:owner(50000) });
  assert.equal(months.figure.value,Math.ceil(monthsToReach({ target:50000, invested:10000, monthly:200, monthlyRate:0.04/12 })-1e-9));
  const monthly = await s.retirement('growth',{ ...common, solve:'monthly', target:owner(50000), byDate:'2036-11-05' });
  assert.equal(monthly.figure.value,round(requiredMonthly({ target:50000,balance:10000,annualRate:0.04,months:120 })));
  assert.ok(balance.figure.provenance.steps.length);
  assert.ok(balance.figure.provenance.assumptions.some(a => a.name === 'realReturn'));
  for (const result of [balance,months,monthly]) await assertRefsResolve(result,s.ctx);
  assert.equal((await s.retirement('growth',{ solve:'balance',balance:owner(10000),years:0 })).figure.value,10000);
  assert.equal((await s.retirement('growth',{ solve:'months',balance:owner(10000),target:owner(50000) })).figure.value,Math.ceil(Math.log(5)/Math.log(1+0.04/12)-1e-9));
});

test('growth byAge reports missing facts, uses birth dates and flags year precision', async t => {
  const s = await setup(t);
  const args = { solve:'monthly',balance:owner(10000),target:owner(50000),byAge:{ person:'owner',age:55 } };
  const missing = await s.retirement('growth',args);
  assert.equal(missing.figure.value,null);
  assert.ok(missing.figure.gaps.some(g => g.code === 'missing_fact'));
  s.fact('household.ownerBirthDate','1981-11-05');
  assert.equal((await s.retirement('growth',args)).figure.value,round(requiredMonthly({ target:50000,balance:10000,annualRate:0.04,months:120 })));
  s.db.prepare('DELETE FROM facts WHERE key=?').run('household.ownerBirthDate');
  s.fact('household.birthYears',{ owner:1981 });
  const approximate = await s.retirement('growth',args);
  assert.ok(approximate.figure.value > 0);
  assert.ok(approximate.figure.gaps.some(g => /precision/i.test(g.message)));
  await assertRefsResolve(approximate,s.ctx);
});

test('retirement validates typed inputs and checks owner statements at the Ask boundary', async t => {
  const s = await setup(t);
  for (const args of [
    { withdrawalRate:rate(0.01) }, { realReturn:rate(0.11) }, { monthlySavings:50 },
    { definition:'core_living',spending:{ tool:'spending',args:{operation:'total',annualize:true},path:'total' } },
    { invested:{accounts:['missing']} },
  ]) await assert.rejects(s.retirement('target',args),e => ['bad_input','not_found'].includes(e.code));
  await assert.rejects(s.retirement('growth',{ solve:'balance',balance:owner(1),years:1,target:owner(10) }),e => e.code === 'bad_input');
  await assert.rejects(s.retirement('growth',{ solve:'balance',balance:owner(1),years:1,realReturn:0.04 }),e => e.code === 'bad_input');
  const server = createRegistryServer(tools,{ purpose:'chat',ctx:{ ...s.ctx,channel:'ask',ownerStatements:()=>['4 percent'] } });
  await assert.rejects(s.retirement('target',{ withdrawalRate:rate(0.04) },{ ...s.ctx,channel:'ask',ownerStatements:()=>['hello'] }),e => e.code === 'bad_input');
  const good = await s.retirement('target',{ withdrawalRate:rate(0.04) },{ ...s.ctx,channel:'ask',ownerStatements:()=>['4 percent'] });
  assert.ok(good.target.value > 0);
  assert.ok(server.names.includes('retirement'));
  assert.match(instructions,/Comparisons by account type.*where tax shows up.*never say which to choose/);
});

test('C6 scripted questions run through Ask with validated calls, grounding and no paid engine',async () => {
  const cases=(await loadCases()).filter(c=>c.turns.some(t=>t.required.some(r=>r.name==='retirement' && ['target','growth','after_tax'].includes(r.operation))));
  assert.equal(cases.length,10);
  assert.ok(cases.every(c=>!c.expectedFail));
  const result=await runCases({cases});
  assert.equal(result.costUsd,0);
  assert.deepEqual(result.cases.filter(c=>c.status!=='pass').map(c=>({id:c.id,status:c.status,checks:c.failingChecks})),[]);
  for (const c of result.cases) for (const turn of c.turns) {
    assert.equal(turn.grounding.ok,true,c.id);
    assert.ok(turn.tools.some(t=>t.name==='retirement'),c.id);
  }
});

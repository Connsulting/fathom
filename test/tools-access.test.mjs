import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore } from './helpers/spending.mjs';
import { callTool } from '../src/tools/index.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';
async function setup(t){
 const s=await spendingStore(t);s.ctx.channel='mcp';
 for(const [id,kind,amount] of [['plan','retirement',50000],['ira','ira',20000],['roth','roth',30000],['broker','taxable',40000],['cash','cash',10000],['hsa','hsa',5000]]){
  s.account(id,kind,'owner');s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run(id,'2026-10-31',amount);
 }
 s.fact('household.ownerBirthDate','1980-06-15');s.fact('household.spouseBirthDate','1982-08-31');
 s.fact('accounts.planType',{plan:'401k',ira:'traditional_ira',roth:'roth_ira'});
 s.fact('accounts.separationDate',{plan:'2035-01-01',ira:'2035-01-01'});
 s.fact('accounts.rothBasis',{roth:12000});s.fact('accounts.rothFirstContributionYear',{roth:2020});
 return {...s,call:(operation,args={})=>callTool('retirement',{operation,...args},s.ctx)};
}
test('access separates accounts and birth rules, uses real separation dates, and excludes Roth RMDs',async t=>{
 const s=await setup(t),out=await s.call('access');
 const p=out.people.find(p=>p.person==='owner');
 const event=name=>p.milestones.filter(m=>m.event===name);
 assert.equal(event('penalty_free_59_half')[0].date.value,'2039-12-15');
 assert.equal(event('rule_of_55')[0].date.value,'2035-01-01');
 assert.deepEqual(event('rule_of_55')[0].accounts.map(a=>a.id),['plan']);
 assert.equal(event('rmd_start')[0].age.value,75);
 assert.ok(event('rmd_start')[0].accounts.every(a=>a.id!=='roth'));
 assert.equal(event('roth_earnings_qualified')[0].date.value,'2039-12-15');
 assert.equal(event('hsa_nonmedical_no_penalty_65')[0].date.value,'2045-06-15');
 await assertRefsResolve(out,s.ctx);
 s.fact('accounts.separationDate',{plan:'2034-12-31'});
 assert.ok(!(await s.call('access')).people[0].milestones.some(m=>m.event==='rule_of_55'));
 s.db.prepare("DELETE FROM facts WHERE key='accounts.separationDate'").run();
 assert.ok((await s.call('access')).gaps.some(g=>g.message.includes('accounts.separationDate')));
});

test('RMD birth cohorts and age-only precision are explicit; missing birth facts leave dates unavailable',async t=>{
 const s=await setup(t);
 for(const [birth,age] of [['1950-12-31',72],['1955-01-01',73],['1960-01-01',75]]){
  s.fact('household.ownerBirthDate',birth);
  assert.equal((await s.call('access',{people:'owner'})).people[0].milestones.find(m=>m.event==='rmd_start').age.value,age);
 }
 s.db.prepare("DELETE FROM facts WHERE key='household.ownerBirthDate'").run();
 s.fact('household.birthYears',{owner:1980});
 let out=await s.call('access',{people:'owner'});
 assert.ok(out.gaps.some(g=>/precision/.test(g.message)));
 assert.ok(out.people[0].milestones.filter(m=>m.event!=='rule_of_55').every(m=>m.date.value?.endsWith('-12-31')));
 s.db.prepare("DELETE FROM facts WHERE key='household.birthYears'").run();
 out=await s.call('access',{people:'owner'});
 assert.ok(out.people[0].milestones.every(m=>m.date.value===null));
});

test('bridge counts stored basis, taxable and cash, gates employer money on separation, and recomputes gaps',async t=>{
 const s=await setup(t);
 const args={retireAge:{value:50,source:'owner',evidence:'retire at 50'}};
 let out=await s.call('bridge',args);
 assert.equal(out.yearsToAccess.value,9.5);
 assert.equal(out.accessible.taxable.value,40000);
 assert.equal(out.accessible.cash.value,10000);
 assert.equal(out.accessible.rothContributions.value,12000);
 assert.equal(out.accessible.ruleOf55.value,0);
 const total=62000,needed=out.spendingUntilAccess.value;
 assert.equal(out.shortfall.value,Math.max(0,Math.round((needed-total)*100)/100));
 assert.equal(out.surplus.value,Math.max(0,Math.round((total-needed)*100)/100));
 assert.equal(out.exceptions.length,2);
 await assertRefsResolve(out,s.ctx);
 out=await s.call('bridge',{retireAge:{value:55,source:'owner',evidence:'retire at 55'}});
 assert.equal(out.accessible.ruleOf55.value,50000);
 s.db.prepare("DELETE FROM facts WHERE key='accounts.rothBasis'").run();
 out=await s.call('bridge',args);
 assert.equal(out.accessible.rothContributions.value,0);
 assert.ok(out.gaps.some(g=>g.message.includes('accounts.rothBasis')));
 await assert.rejects(s.call('bridge',{retireAge:{value:50,source:'owner',evidence:'age 55'}}),e=>e.code==='bad_input');
});

test('Roth qualification waits for the later clock and missing facts stay unavailable',async t=>{
 const s=await setup(t);
 s.fact('household.ownerBirthDate','1960-02-29');
 s.fact('accounts.rothFirstContributionYear',{roth:2025});
 const out=await s.call('access',{people:'owner'});
 assert.equal(out.people[0].milestones.find(m=>m.event==='roth_earnings_qualified').date.value,'2030-01-01');
 s.db.prepare("DELETE FROM facts WHERE key='accounts.rothFirstContributionYear'").run();
 const missing=await s.call('access',{people:'owner'});
 assert.equal(missing.people[0].milestones.find(m=>m.event==='roth_earnings_qualified').date.value,null);
 assert.ok(missing.gaps.some(g=>g.message.includes('accounts.rothFirstContributionYear')));
});

test('bridge uses the person-scoped retirement fact, excludes spouse and business balances and exposes missing balances',async t=>{
 const s=await setup(t);
 s.fact('household.retireAge',{owner:55,spouse:50});
 s.account('spouse-cash','cash','spouse');s.account('company-cash','cash','business');
 for(const id of ['spouse-cash','company-cash'])s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run(id,'2026-10-31',999999);
 const out=await s.call('bridge');
 assert.equal(out.yearsToAccess.value,4.5);
 assert.equal(out.accessible.cash.value,10000);
 s.db.prepare("DELETE FROM balances WHERE account_id='broker'").run();
 const missing=await s.call('bridge');
 assert.equal(missing.accessible.taxable.value,null);
 assert.equal(missing.shortfall.value,null);
 assert.ok(missing.gaps.some(g=>g.code==='missing_fact'));
 s.db.prepare("DELETE FROM facts WHERE key='household.retireAge'").run();
 assert.equal((await s.call('bridge')).yearsToAccess.value,null);
});

test('accessible Roth contributions cannot exceed the current account value',async t=>{
 const s=await setup(t);
 s.fact('accounts.rothBasis',{roth:40000});
 const out=await s.call('bridge',{retireAge:{value:50,source:'owner',evidence:'retire at 50'}});
 assert.equal(out.accessible.rothContributions.value,30000);
 s.db.prepare("DELETE FROM balances WHERE account_id='roth'").run();
 const missing=await s.call('bridge',{retireAge:{value:50,source:'owner',evidence:'retire at 50'}});
 assert.equal(missing.accessible.rothContributions.value,null);
 assert.equal(missing.shortfall.value,null);
});

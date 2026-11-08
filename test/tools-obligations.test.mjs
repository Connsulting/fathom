import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore } from './helpers/spending.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';
const mortgage = {balance:10000,rate:0,monthlyPayment:500,escrowMonthly:100};

test('mortgage payoff uses the stated date, then amortization net of escrow, with missing facts explicit',async t=>{
 const s=await spendingStore(t);
 s.fact('obligations.mortgage',{...mortgage,payoffDate:'2028-02-01'});
 let out=await s.call('obligations',{obligations:['mortgage']});
 assert.equal(out.obligations[0].endDate.value,'2028-02-01');
 assert.equal(out.obligations[0].monthly.value,500);
 assert.equal(out.obligations[0].changes[0].newMonthly.value,100);
 assert.equal(out.obligations[0].changes[0].derivedFrom,'fact');
 await assertRefsResolve(out,s.ctx);
 s.fact('obligations.mortgage',mortgage);
 out=await s.call('obligations',{obligations:['mortgage']});
 assert.equal(out.obligations[0].endDate.value,'2028-12-05');
 assert.equal(out.obligations[0].changes[0].derivedFrom,'amortization');
 s.fact('obligations.mortgage',{...mortgage,rate:0.12,monthlyPayment:150});
 assert.ok((await s.call('obligations',{obligations:['mortgage']})).gaps.some(g=>g.code==='missing_fact'));
 s.db.prepare("DELETE FROM facts WHERE key='obligations.mortgage'").run();
 out=await s.call('obligations',{obligations:['mortgage']});
 assert.equal(out.obligations[0].endDate.value,null);
 assert.ok(out.gaps.some(g=>g.message.includes('obligations.mortgage')));
});

test('child dates use school cutoff, age thirteen and college age with pack citations',async t=>{
 const s=await spendingStore(t);
 s.fact('household.dependentBirthDates',['2022-09-02','2020-06-10']);
 s.fact('obligations.childcare',{schoolAgeMonthly:200});
 const out=await s.call('obligations',{obligations:['childcare','plan529']});
 const care=out.obligations[0],college=out.obligations[1];
 assert.ok(care.changes.some(c=>c.date.value==='2028-09-01'&&c.stage==='school_age'));
 assert.ok(care.changes.some(c=>c.date.value==='2033-06-10'&&c.stage==='after_care_end'&&c.newMonthly.value===0));
 assert.ok(college.changes.some(c=>c.date.value==='2038-06-10'));
 assert.ok(care.changes.every(c=>c.date.provenance.packRefs.length));
 await assertRefsResolve(out,s.ctx);
 s.db.prepare("DELETE FROM facts WHERE key='household.dependentBirthDates'").run();
 s.fact('household.dependentAges',[3]);
 assert.ok((await s.call('obligations',{obligations:['childcare']})).gaps.some(g=>/precision/.test(g.message)));
});

test('projection preserves excluded mortgage and applies only the in-base amount with escrow remaining',async t=>{
 const s=await spendingStore(t);
 s.fact('obligations.mortgage',{...mortgage,payoffDate:'2027-01-01'});
 const core=await s.call('total',{definition:'core_living',annualize:true});
 const all=await s.call('total',{annualize:true});
 const out=await s.call('projection',{years:3,obligations:['mortgage']});
 assert.equal(out.years[1].spending.value,all.total.value-2400);
 assert.equal(out.years[2].spending.value,out.years[1].spending.value);
 assert.equal((await s.call('projection',{definition:'core_living',years:3,obligations:['mortgage']})).years[1].spending.value,core.total.value);
 await assertRefsResolve(out,s.ctx);
 const limited=await s.call('total',{include:{categories:['Groceries']},annualize:true});
 assert.equal((await s.call('projection',{base:limited.total.ref,years:3,obligations:['mortgage']})).years[1].spending.value,limited.total.value);
 await assert.rejects(s.call('projection',{base:{tool:'household',args:{operation:'figures'},path:'0'}}),e=>e.code==='bad_input');
});

test('unstated school care amount is unavailable and never applied; owner assumption is checked',async t=>{
 const s=await spendingStore(t); s.ctx.channel='mcp';
 for(let m=1;m<=10;m++)s.tx('checking',`2026-${String(m).padStart(2,'0')}-15`,-600,'Childcare');
 s.fact('household.dependentBirthDates',['2022-04-01']);
 const out=await s.call('projection',{years:3,obligations:['childcare']});
 const change=out.years[1].changes.find(c=>c.stage==='school_age');
 assert.equal(change.applied,false);
 assert.ok(out.gaps.some(g=>g.message.includes('obligations.childcare')));
 const changed=await s.call('projection',{years:3,obligations:['childcare'],changes:[{kind:'childcare',stage:'school_age',newMonthly:{value:200,source:'owner',evidence:'$200 a month'}}]});
 assert.ok(changed.years[1].changes.some(c=>c.applied));
 await assert.rejects(s.call('obligations',{changes:[{kind:'childcare',newMonthly:{value:200,source:'owner',evidence:'$300'}}]}),e=>e.code==='bad_input');
});

test('amortization with interest matches monthly payoff simulation, and changes honor the projection date',async t=>{
 const s=await spendingStore(t);
 const loan={balance:18000,rate:0.048,monthlyPayment:850,escrowMonthly:100};
 s.fact('obligations.mortgage',loan);
 let balance=loan.balance,n=0;
 while(balance>0){balance=balance*(1+loan.rate/12)-(loan.monthlyPayment-loan.escrowMonthly);n++;}
 const expected=new Date(Date.UTC(2026,10+n,5)).toISOString().slice(0,10);
 const amortized=await s.call('obligations',{obligations:['mortgage']});
 assert.equal(amortized.obligations[0].endDate.value,expected);
 s.fact('obligations.mortgage',{...loan,payoffDate:'2027-07-01'});
 const base=await s.call('total',{annualize:true});
 const out=await s.call('projection',{years:3,obligations:['mortgage']});
 const share=(Date.parse('2028-01-01')-Date.parse('2027-07-01'))/(Date.parse('2028-01-01')-Date.parse('2027-01-01'));
 assert.equal(out.years[0].spending.value,base.total.value);
 assert.equal(out.years[1].spending.value,Math.round((base.total.value-2400*share)*100)/100);
 assert.equal(out.years[2].spending.value,base.total.value-2400);
});

test('definition selectors and referenced totals produce identical projections without duplicate child drops',async t=>{
 const s=await spendingStore(t);
 s.fact('obligations.mortgage',{...mortgage,payoffDate:'2027-01-01'});
 const base=await s.call('total',{annualize:true,definition:'household_spending'});
 const a=await s.call('projection',{base:base.total.ref,years:3,obligations:['mortgage']});
 const b=await s.call('projection',{definition:'household_spending',years:3,obligations:['mortgage']});
 assert.deepEqual(a.years.map(y=>y.spending.value),b.years.map(y=>y.spending.value));
 await assert.rejects(s.call('projection',{base:base.total.ref,definition:'core_living'}),e=>e.code==='bad_input');
 await assert.rejects(s.call('obligations',{changes:[{kind:'mortgage',newMonthly:{value:0,source:'default'}}]}),e=>e.code==='bad_input');
});

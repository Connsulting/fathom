import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore } from './helpers/spending.mjs';
import { recordFactAnswers, FactAnswerError } from '../src/facts/answers.mjs';
import { callTool } from '../src/tools/index.mjs';
import { answerShape, questionFor } from '../src/jobs/triggers/common.mjs';

const now = '2026-11-05T12:00:00Z';
test('C7 facts accept their declared shapes and reject malformed neighbors atomically', async t => {
  const s = await spendingStore(t);
  await s.account('ret','retirement','Owner'); await s.account('roth','roth','Spouse'); await s.account('ira','ira','Owner');
  const cases = [
    ['household.dependentAges',[3,8],[-1]],
    ['household.dependentBirthDates',['2021-09-02','2018-02-28'],['2021-02-29']],
    ['household.ownerBirthDate','1980-02-29','1980-02-30'],
    ['household.spouseBirthDate','1982-06-15','soon'],
    ['household.retireAge',{owner:50,spouse:59.5},{child:50}],
    ['obligations.mortgage',{balance:10000,rate:0,monthlyPayment:500,escrowMonthly:100,payoffDate:'2028-06-01'},{monthlyPayment:-1}],
    ['obligations.childcare',{schoolAgeMonthly:400,afterCareEndMonthly:0},{schoolAgeMonthly:-1}],
    ['obligations.childcareChangeDate','2030-09-01','2030-13-01'],
    ['accounts.planType',{ret:'401k',ira:'roth_ira'},{checking:'401k'}],
    ['accounts.rothFirstContributionYear',{roth:2020},{roth:2027}],
    ['accounts.rothBasis',{roth:2500},{ret:2500}],
    ['accounts.separationDate',{ret:'2035-01-01'},{ira:'2035-01-01'}],
  ];
  for (const [key,value,invalid] of cases) {
    assert.ok(answerShape(key));
    const words = v => v && typeof v === 'object' ? Object.values(v).flatMap(words) : [String(v)];
    const evidence = words(value).join(' ');
    const out = await callTool('answer',{operation:'fact',key,value,evidence},{...s.ctx,actorId:'synthetic-actor',ownerText:evidence});
    assert.ok(out.receipt);
    assert.deepEqual(out.value,value);
    const before=(await s.db.prepare('SELECT value FROM facts WHERE key=?').get(key)).value;
    await assert.rejects(async ()=>await recordFactAnswers(s.db,[{key,value:invalid}],{now}),FactAnswerError,key);
    assert.equal((await s.db.prepare('SELECT value FROM facts WHERE key=?').get(key)).value,before);
  }
  await recordFactAnswers(s.db,[{key:'accounts.rothFirstContributionYear',value:{ira:2021}}],{now});
  await assert.rejects(async ()=>await recordFactAnswers(s.db,[{key:'household.dependentBirthDates',value:[]}],{now}),FactAnswerError);
  await assert.rejects(async ()=>await recordFactAnswers(s.db,[{key:'household.dependentAges',value:[1.5]}],{now}),FactAnswerError);
  const q=questionFor(['accounts.separationDate'],{accounts:await s.db.prepare('SELECT * FROM accounts').all(),facts:{'accounts.planType':{ret:'401k',ira:'roth_ira'}}});
  assert.deepEqual(q.fields.map(f=>f.path[0]),['ret']);
});

test('account eligibility follows the plan type in the same atomic answer batch in either order',async t=>{
 const s=await spendingStore(t);await s.account('plan','retirement','owner');
 const separation={key:'accounts.separationDate',value:{plan:'2035-01-01'}};
 const plan={key:'accounts.planType',value:{plan:'401k'}};
 await recordFactAnswers(s.db,[separation,plan],{now});
 await s.db.prepare("DELETE FROM facts WHERE key IN ('accounts.planType','accounts.separationDate')").run();
 await recordFactAnswers(s.db,[plan,separation],{now});
 await assert.rejects(async ()=>await recordFactAnswers(s.db,[{...plan,value:{plan:'traditional_ira'}},separation],{now}),FactAnswerError);
 assert.equal(JSON.parse((await s.db.prepare("SELECT value FROM facts WHERE key='accounts.planType'").get()).value).plan,'401k');
});

test('answer.fact collects Roth basis for accounts identified by plan type and bridge counts it',async t=>{
 const s=await spendingStore(t);
 for(const [id,kind] of [['ira-plan','ira'],['workplace-ira','retirement']])await s.account(id,kind,'owner');
 await s.fact('accounts.planType',{'ira-plan':'roth_ira','workplace-ira':'roth_ira'});
 for(const id of ['ira-plan','workplace-ira']) {
  await s.db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run(id,'2026-10-31',10000);
  const evidence='My Roth contribution basis is $2500.';
  const out=await callTool('answer',{operation:'fact',key:'accounts.rothBasis',value:{[id]:2500},evidence},{...s.ctx,actorId:'synthetic-actor',ownerText:evidence});
  assert.equal(out.value[id],2500);
 }
 const bridge=await callTool('retirement',{operation:'bridge',retireAge:{value:50,source:'owner',evidence:'retire at 50'}},{...s.ctx,channel:'mcp'});
 assert.equal(bridge.accessible.rothContributions.value,5000);
 assert.ok(!bridge.gaps.some(g=>g.message.includes('accounts.rothBasis')));
});

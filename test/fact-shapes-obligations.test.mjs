import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingStore } from './helpers/spending.mjs';
import { recordFactAnswers, FactAnswerError } from '../src/facts/answers.mjs';
import { answerShape, questionFor } from '../src/jobs/triggers/common.mjs';

const now = '2026-11-05T12:00:00Z';
test('C7 facts accept their declared shapes and reject malformed neighbors atomically', async t => {
  const s = await spendingStore(t);
  s.account('ret','retirement','Owner'); s.account('roth','roth','Spouse'); s.account('ira','ira','Owner');
  const cases = [
    ['household.dependentAges',[3,8],[-1]],
    ['household.dependentBirthDates',['2021-09-02','2018-02-28'],['2021-02-29']],
    ['household.ownerBirthDate','1980-02-29','1980-02-30'],
    ['household.spouseBirthDate','1982-06-15','soon'],
    ['household.retireAge',{owner:50,spouse:59.5},{child:50}],
    ['obligations.mortgage',{balance:10000,rate:0,monthlyPayment:500,escrowMonthly:100,payoffDate:'2028-06-01'},{balance:10000,rate:0,monthlyPayment:500}],
    ['obligations.childcare',{schoolAgeMonthly:400,afterCareEndMonthly:0},{schoolAgeMonthly:-1}],
    ['obligations.childcareChangeDate','2030-09-01','2030-13-01'],
    ['accounts.planType',{ret:'401k',ira:'roth_ira'},{checking:'401k'}],
    ['accounts.rothFirstContributionYear',{roth:2020},{roth:2027}],
    ['accounts.rothBasis',{roth:2500},{ret:2500}],
    ['accounts.separationDate',{ret:'2035-01-01'},{ira:'2035-01-01'}],
  ];
  for (const [key,value,invalid] of cases) {
    assert.ok(answerShape(key));
    recordFactAnswers(s.db,[{key,value}],{now});
    const before=s.db.prepare('SELECT value FROM facts WHERE key=?').get(key).value;
    assert.throws(()=>recordFactAnswers(s.db,[{key,value:invalid}],{now}),FactAnswerError,key);
    assert.equal(s.db.prepare('SELECT value FROM facts WHERE key=?').get(key).value,before);
  }
  recordFactAnswers(s.db,[{key:'accounts.rothFirstContributionYear',value:{ira:2021}}],{now});
  assert.throws(()=>recordFactAnswers(s.db,[{key:'household.dependentBirthDates',value:[]}],{now}),FactAnswerError);
  assert.throws(()=>recordFactAnswers(s.db,[{key:'household.dependentAges',value:[1.5]}],{now}),FactAnswerError);
  const q=questionFor(['accounts.separationDate'],{accounts:s.db.prepare('SELECT * FROM accounts').all(),facts:{'accounts.planType':{ret:'401k',ira:'roth_ira'}}});
  assert.deepEqual(q.fields.map(f=>f.path[0]),['ret']);
});

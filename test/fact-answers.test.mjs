import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, addFact } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { answerFacts, FactAnswerError } from '../src/facts/answers.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { recAction } from '../src/api/handlers.mjs';

const s = scratch('fathom-question-');
after(() => s.cleanup());
const now = '2026-11-05T12:00:00.000Z';

test('answers validate atomically, preserve confirmed data and replan to a figured action', async () => {
  const db = await s.store({ variant: { facts: { 'accounts.va529': undefined } } });
  await planRun(db);
  const account = db.prepare("SELECT id FROM accounts WHERE kind = '529'").get();
  const before = db.prepare("SELECT def FROM recs WHERE id = 'va529'").get();
  assert.ok(JSON.parse(before.def).question);
  let replans = 0;
  const replan = async () => { replans++; return planRun(db); };
  await assert.rejects(answerFacts(db, [{ key: 'household.ownerAge', value: 43 }, { key: 'accounts.va529', value: { [account.id]: { virginiaPlan: true, ownerAge70Plus: false, carryforward: -1 } } }], { now, replan }), FactAnswerError);
  assert.notEqual(getFacts(db)['household.ownerAge'], 43);
  assert.equal(replans, 0);
  db.prepare("UPDATE recs SET status = 'snoozed' WHERE id = 'va529'").run();
  await answerFacts(db, [{ key: 'accounts.va529', value: { [account.id]: { virginiaPlan: true, ownerAge70Plus: false, carryforward: 0 } } }], { now, replan, recId: 'va529' });
  assert.equal(replans, 1);
  const f = db.prepare("SELECT * FROM facts WHERE key = 'accounts.va529'").get();
  assert.equal(f.confirmed, 1);
  assert.equal(f.as_of, '2026-11-05');
  assert.match(db.prepare('SELECT label FROM sources WHERE id = ?').get(f.src).label, /you answered on 2026-11-05/);
  const rec = buildScenario(db).recs.find(r => r.id === 'va529');
  assert.equal(rec.status, 'proposed');
  assert.equal(rec.question, undefined);
  assert.match(rec.title, /Use the rest/);
  assert.ok(rec.mine.some(x => x.fig === 'va529.deductionLeft'));
  assert.ok(buildScenario(db).fig['va529.deductionLeft'].v > 0);
});

test('all typed facts reject malformed values and accept their valid neighbors', async () => {
  const db = await s.store();
  const cases = [
    ['business.cashBasis', 'yes', false],
    ['household.ownerAge', '42', 42],
    ['household.spouseAge', 40.5, 40],
    ['benefits.hsaCoverage', 'all', 'family'],
    ['business.salaryRange', { min: 50, max: 10 }, { min: 10, max: 50 }],
    ['household.expectedDate', '2026-02-30', '2026-12-30'],
    ['retirement.priorYearFicaWages', 20, { owner: 20 }],
    ['retirement.otherPlanDeferrals', { owner: { deferral: -1 } }, { owner: { deferral: 0, catchUp: 0 } }],
    ['not.a.fact', true, undefined],
  ];
  for (const [key, bad, good] of cases) {
    await assert.rejects(answerFacts(db, [{ key, value: bad }], { now, replan: async () => {} }), FactAnswerError);
    if (good !== undefined) await answerFacts(db, [{ key, value: good }], { now, replan: async () => {} });
  }
});

test('per-account writes preserve unrelated entries and reject unknown accounts and fields', async () => {
  const db = await s.store();
  const id = db.prepare("SELECT id FROM accounts WHERE kind = '529'").get().id;
  addFact(db, 'accounts.va529', { other: { virginiaPlan: false } });
  await answerFacts(db, [{ key: 'accounts.va529', value: { [id]: { virginiaPlan: false } } }], { now, replan: async () => {} });
  assert.equal(getFacts(db)['accounts.va529'].other.virginiaPlan, false);
  for (const value of [{ unknown: { virginiaPlan: false } }, { [id]: { virginiaPlan: false, typo: true } }, { [id]: { virginiaPlan: true } }]) {
    await assert.rejects(answerFacts(db, [{ key: 'accounts.va529', value }], { now, replan: async () => {} }), FactAnswerError);
  }
});

test('planning failure retains the answers and is reported for retry', async () => {
  const db = await s.store();
  await assert.rejects(answerFacts(db, [{ key: 'business.cashBasis', value: false }], { now, replan: async () => { throw new Error('unavailable'); } }), /saved.*planning/i);
  assert.equal(getFacts(db)['business.cashBasis'], false);
  await answerFacts(db, [{ key: 'business.cashBasis', value: false }], { now, replan: async () => {} });
});

test('college accounts recognized by name accept answers and produce deduction room', async () => {
  const db = await s.store({ variant: { facts: { 'accounts.va529': undefined } } });
  const id = db.prepare("SELECT id FROM accounts WHERE kind = '529'").get().id;
  db.prepare("UPDATE accounts SET kind = 'taxable', name = '529 College Savings' WHERE id = ?").run(id);
  await planRun(db);
  await answerFacts(db, [{ key: 'accounts.va529', value: { [id]: { virginiaPlan: true, ownerAge70Plus: false, carryforward: 0 } } }], { now, replan: () => planRun(db), recId: 'va529' });
  const scenario = buildScenario(db);
  assert.equal(scenario.recs.find(r => r.id === 'va529').question, undefined);
  assert.ok(scenario.fig['va529.deductionLeft'].v > 0);
});

test('supplemental catch-up answers preserve the action, checklist and owner completion', async () => {
  const db = await s.store({ variant: { facts: { 'household.ownerAge': 55 } } });
  await planRun(db);
  const rec = buildScenario(db).recs.find(r => r.id === 'year-end-retirement');
  assert.equal(rec.question.primary, false);
  assert.equal(rec.question.fields.length, 1);
  const ctx = { db, config: { clock: '2026-11-05' }, params: { id: rec.id }, body: { action: 'task', arg: 0 } };
  assert.equal(recAction(ctx).scenario.recs.find(r => r.id === rec.id).tasks[0].done, true);
  ctx.body = { action: 'complete' };
  assert.equal(recAction(ctx).scenario.recs.find(r => r.id === rec.id).status, 'done');
  await answerFacts(db, [{ key: 'retirement.priorYearFicaWages', value: { owner: 50000 } }], { now, replan: () => planRun(db), recId: rec.id });
  const after = buildScenario(db).recs.find(r => r.id === rec.id);
  assert.equal(after.status, 'done');
  assert.equal(after.tasks[0].done, true);
});

test('a salary answer does not require or overwrite the other participant deferrals', async () => {
  const spouse = { deferral: 12000, catchUp: 0 };
  const db = await s.store({ variant: { facts: { 'retirement.otherPlanDeferrals': { owner: { deferral: -1 }, spouse } } } });
  await planRun(db);
  const rec = buildScenario(db).recs.find(r => r.id === 'scorp-salary');
  assert.deepEqual(rec.question.keys, ['retirement.otherPlanDeferrals']);
  assert.ok(rec.question.fields.every(f => f.path[0] === 'owner'));
  await answerFacts(db, [{ key: 'retirement.otherPlanDeferrals', value: { owner: { deferral: 0, catchUp: 0 } } }], { now, replan: () => planRun(db), recId: rec.id });
  assert.deepEqual(getFacts(db)['retirement.otherPlanDeferrals'].spouse, spouse);
  assert.equal(buildScenario(db).recs.find(r => r.id === rec.id).question, undefined);
});

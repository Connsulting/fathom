import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, addFact } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { answerFacts, FactAnswerError } from '../src/facts/answers.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';

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

// Question recs: answered collapse, plain blockers on waiting recs, missing-data titles and links,
// the Virginia-plan inference, birth years as the one source of ages, and the shared SimpleFIN
// coverage rule. Every household, institution and amount here is synthetic.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { questionFor, ANSWER_SHAPES, CONFIRM_TASKS } from '../src/jobs/triggers/common.mjs';
import { evaluateCatalog, evaluateTriggers } from '../src/jobs/triggers/index.mjs';
import { writeProse } from '../src/jobs/planner/prose.mjs';
import { answerFacts } from '../src/facts/answers.mjs';
import { ageAtYearEnd, accountOwnerAge } from '../src/shared/ages.mjs';
import { inferVirginiaPlan } from '../src/shared/va529-plan.mjs';
import { coveredFileSources, connectedAccountIds } from '../src/ingest/coverage.mjs';
import { ingestState } from '../src/ingest/freshness.mjs';
import * as recAnswers from '../web/horizon/screens/rec-answers.js';
import * as recBlocker from '../web/horizon/screens/rec-blocker.js';
import { planRun } from './helpers/plan.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { scratch, addFact, accountIdByMask, recRow, MASKS } from './helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-rec-questions-');
after(() => S.cleanup());

const acct = (extra = {}) => ({ id: 'plan-a', kind: '529', name: 'manual', mask: '3333', display_name: 'College fund', inst: '', ...extra });
const FIELD = (q, name) => q.fields.find(f => f.path.at(-1) === name);

// ---------------------------------------------------------------- answered collapse

test('a question whose active fields all hold saved values is answered; a missing one is not', () => {
  const facts = { 'accounts.va529': { 'plan-a': { virginiaPlan: true, carryforward: 0 } }, 'household.birthYears': { owner: 1981 } };
  const done = questionFor(['accounts.va529', 'household.birthYears'], { accounts: [acct()], facts });
  assert.equal(done.answered, true);
  const open = questionFor(['accounts.va529'], { accounts: [acct()], facts: { 'accounts.va529': { 'plan-a': { virginiaPlan: true } } } });
  assert.equal(open.answered, false);
  const no = questionFor(['accounts.va529'], { accounts: [acct()], facts: { 'accounts.va529': { 'plan-a': { virginiaPlan: false } } } });
  assert.equal(no.answered, true, 'a field behind a No answer is not active');
});

const kit = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), snoozeLabel: () => 'Nov 19', recById: () => null, draw() {}, api: {} };

test('an answered question renders as Answered with an Edit answers link and no controls', () => {
  recAnswers.reset();
  recAnswers.bind(kit);
  const question = questionFor(['accounts.va529'], { accounts: [acct()], facts: { 'accounts.va529': { 'plan-a': { virginiaPlan: false } } } });
  const html = recAnswers.html({ id: 'va529', question }, 'plan');
  assert.match(html, /Answered/);
  assert.match(html, /Edit answers/);
  assert.doesNotMatch(html, /<input|<select|type="submit"/);
});

test('an unanswered question still renders its controls', () => {
  recAnswers.reset();
  recAnswers.bind(kit);
  const question = questionFor(['accounts.va529'], { accounts: [acct()], facts: {} });
  const html = recAnswers.html({ id: 'va529', question }, 'plan');
  assert.match(html, /<input/);
  assert.doesNotMatch(html, /Edit answers/);
});

// ---------------------------------------------------------------- Virginia plan inference and wording

test('Invest529 and Virginia529 are inferred Virginia plans, shown as answered with evidence and Undo', () => {
  assert.equal(inferVirginiaPlan({ inst: 'Invest529' }).value, true);
  assert.equal(inferVirginiaPlan({ inst: 'Virginia 529' }).value, true);
  const q = questionFor(['accounts.va529'], { accounts: [acct({ inst: 'Invest529' })], facts: {} });
  const plan = FIELD(q, 'virginiaPlan');
  assert.equal(plan.value, true);
  assert.match(plan.inferred.evidence, /Invest529/);
  assert.equal(plan.inferred.accountId, 'plan-a');
  assert.equal(FIELD(q, 'ownerAge70Plus'), undefined, 'the age comes from birth years, never per account');
  assert.ok(FIELD(q, 'carryforward'));
  recAnswers.reset();
  recAnswers.bind(kit);
  const html = recAnswers.html({ id: 'va529', question: q }, 'plan');
  assert.match(html, /Invest529/);
  assert.match(html, /Undo/);
});

test('another institution or another state plan is inferred not a Virginia plan', () => {
  const other = inferVirginiaPlan({ inst: 'Example State College Savings' });
  assert.equal(other.value, false);
  assert.match(other.evidence, /Example State College Savings/);
  assert.equal(inferVirginiaPlan({ inst: '' }), null);
  assert.equal(inferVirginiaPlan({}), null);
});

test('with no institution the question asks the pinned wording; Undo returns to asking', () => {
  const q = questionFor(['accounts.va529'], { accounts: [acct()], facts: {} });
  assert.equal(FIELD(q, 'virginiaPlan').label, "Is this Virginia's own 529 program (Invest529), which is the only kind Virginia deducts?");
  assert.equal(FIELD(q, 'virginiaPlan').inferred, undefined);
  const undone = questionFor(['accounts.va529'], { accounts: [acct({ inst: 'Invest529' })], facts: { 'accounts.va529Inference': { 'plan-a': { undone: true } } } });
  assert.equal(FIELD(undone, 'virginiaPlan').inferred, undefined);
  assert.equal(FIELD(undone, 'virginiaPlan').value, undefined);
});

// ---------------------------------------------------------------- birth years

test('birth years give every age from one fact', () => {
  assert.ok(ANSWER_SHAPES['household.birthYears']);
  assert.equal(CONFIRM_TASKS['household.ownerAge'], undefined);
  assert.equal(ANSWER_SHAPES['household.ownerAge'], undefined);
  const years = { owner: 1950, spouse: 1983, dependents: [2018] };
  assert.equal(ageAtYearEnd(years, 'owner', 2026), 76);
  assert.equal(ageAtYearEnd(years, 'spouse', 2026), 43);
  assert.equal(ageAtYearEnd(years, { dependent: 0 }, 2026), 8);
  assert.equal(ageAtYearEnd({}, 'owner', 2026), null);
  assert.equal(ageAtYearEnd(null, 'owner', 2026), null);
  assert.equal(accountOwnerAge(years, 'owner', 2026), 76);
  assert.equal(accountOwnerAge(years, null, 2026), 43, 'an account with no known person uses the youngest adult');
  assert.equal(accountOwnerAge({ spouse: 1950 }, 'owner', 2026), null);
});

test('birth years are asked once as owner and spouse, and the answerer validates the years', async () => {
  const q = questionFor(['household.birthYears'], { accounts: [], facts: { 'household.filingStatus': 'mfj' } });
  assert.deepEqual(q.fields.map(f => f.path), [['owner'], ['spouse']]);
  assert.equal(questionFor(['household.birthYears'], { accounts: [], facts: {} }).fields.length, 1);
  const db = await S.store();
  const replan = async () => {};
  await answerFacts(db, [{ key: 'household.birthYears', value: { owner: 1981, spouse: 1983, dependents: [2018, 2021] } }], { now: '2026-11-05T00:00:00.000Z', replan });
  for (const bad of [{ owner: 1850 }, { owner: 3000 }, { owner: 1981.5 }, { spouse: 1983 }, { owner: 1981, typo: 1 }, { owner: 1981, dependents: [1] }]) {
    await assert.rejects(answerFacts(db, [{ key: 'household.birthYears', value: bad }], { now: '2026-11-05T00:00:00.000Z', replan }), /answer type/i);
  }
});

// ---------------------------------------------------------------- waiting names its blocker

const baseCtx = extra => ({ clock: NOW, year: 2026, facts: {}, owner: {}, fig: {}, names: {}, model: {}, data: { accounts: [acct()] }, packs: [], packStatus: {}, warnings: [], freshness: [], info: { blocked: [], confirm: {} }, ...extra });

test('va529 blocked by the Virginia projection carries the blocker the planner already computed', () => {
  const ctx = baseCtx({
    facts: { 'accounts.has529': true, 'household.state': 'VA', 'accounts.va529': { 'plan-a': { virginiaPlan: true, carryforward: 0 } } },
    info: { blocked: [], confirm: {}, va529: { accounts: 1, missing: [], age70: [], eligible: 1 }, vaBlocked: 'va_itemized_missing' },
  });
  const result = evaluateCatalog(ctx).find(r => r.trigger.id === 'va529');
  assert.equal(result.state, 'blocked');
  assert.equal(result.reason, 'va_itemized_missing');
  assert.equal(result.blocker.code, 'va_itemized_missing');
  assert.match(result.blocker.text, /Virginia needs your Virginia itemized estimate/);
  assert.match(result.blocker.task, /Enter your Virginia itemized deduction estimate/);
  assert.ok(['ask', 'upload', 'confirm', 'accounts'].includes(result.blocker.link));
});

test('a rec waiting on missing data names the blocker on the card and in the dialog', async () => {
  const db = await S.store();
  await planRun(db, { now: NOW });
  assert.equal(recRow(db, 'va529').status, 'proposed');
  addFact(db, 'tax.itemizedEstimate', 90000);
  await planRun(db, { now: NOW });
  const row = recRow(db, 'va529');
  assert.equal(row.status, 'waiting');
  const rec = buildScenario(db, { clock: NOW }).recs.find(r => r.id === 'va529');
  assert.equal(rec.status, 'waiting');
  assert.equal(rec.blocker.code, 'va_itemized_missing');
  recBlocker.bind(kit);
  for (const surface of ['plan', 'dialog']) {
    const html = recBlocker.html(rec, surface);
    assert.match(html, /Waiting on/);
    assert.match(html, /Virginia needs your Virginia itemized estimate/);
    assert.match(html, /Enter your Virginia itemized deduction estimate/);
    assert.match(html, /href="#\/|data-ask-next/);
  }
  addFact(db, 'tax.vaItemizedEstimate', 80000);
  await planRun(db, { now: NOW });
  const after = buildScenario(db, { clock: NOW }).recs.find(r => r.id === 'va529');
  assert.notEqual(after.status, 'waiting');
  assert.equal(after.blocker, undefined);
  assert.equal(recBlocker.html(after, 'plan'), '');
});

test('answering the Virginia questions while the projection is blocked leaves a recorded answer, not an open form', async () => {
  const db = await S.store();
  await planRun(db, { now: NOW });
  addFact(db, 'tax.itemizedEstimate', 90000);
  await planRun(db, { now: NOW });
  const rec = buildScenario(db, { clock: NOW }).recs.find(r => r.id === 'va529');
  if (rec.question) assert.equal(rec.question.answered, true);
});

// ---------------------------------------------------------------- missing-data title, summary and links

test('missing data names its items in the title and summary, and each task links to where it is done', async () => {
  const ctx = baseCtx({
    warnings: ['filing_status_assumed'],
    info: { blocked: ['paystub_ytd_missing', 'tax_year_unconfirmed'], confirm: {}, payrollBlocks: [{ code: 'paystub_ytd_missing', employer: 'Example Employer Inc' }] },
    questionKeys: new Set(),
  });
  const hit = evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data');
  assert.equal(hit.rec.title, 'Answer 2 tax questions and upload a paystub');
  const prose = await writeProse(hit, ctx);
  assert.match(prose.fields.summary, /Answer 2 tax questions and upload a paystub/);
  const linked = hit.rec.tasks.filter(t => t.link);
  assert.ok(linked.some(t => t.link === 'upload' && /paystub/i.test(t.t)));
  assert.ok(linked.some(t => t.link === 'ask'), 'a question with no form opens Ask with the rec attached');
});

test('missing data that is only uploads is titled as uploads', () => {
  const ctx = baseCtx({ freshness: [{ id: 'balances', label: 'Account balances', state: 'stale' }, { id: 'transactions', label: 'Account transactions', state: 'missing' }] });
  const hit = evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data');
  assert.equal(hit.rec.title, 'Upload 2 files');
  assert.ok(hit.rec.tasks.filter(t => t.link === 'upload').length >= 2);
});

// ---------------------------------------------------------------- SimpleFIN coverage

test('a file source whose accounts SimpleFIN covers is not stale anywhere', async () => {
  const db = await S.store();
  const file = db.prepare("SELECT source_id FROM files WHERE source_id IS NOT NULL LIMIT 1").get();
  assert.ok(file, 'the synthetic store has a file source');
  const before = ingestState(db, { clock: '2027-06-01' });
  const staleBefore = before.sources.filter(s => s.state === 'stale').map(s => s.id);
  assert.ok(staleBefore.length, 'file sources are stale by mid 2027');
  assert.deepEqual(before.staleNotes.map(n => n.text.split(' data is')[0]).length > 0, true);
  const mapped = db.prepare('INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const a of db.prepare('SELECT id FROM accounts').all()) mapped.run(`sf-${a.id}`, a.id, 'mapped', 'Synthetic', NOW);
  assert.ok(connectedAccountIds(db).size > 0);
  assert.ok(coveredFileSources(db).size > 0);
  const state = ingestState(db, { clock: '2027-06-01' });
  assert.deepEqual(state.sources.filter(s => s.state === 'stale' && !s.kind.startsWith('tax')).filter(s => coveredFileSources(db).has(s.id)), []);
  for (const s of state.sources.filter(x => coveredFileSources(db).has(x.id))) assert.equal(s.state, 'covered');
  assert.ok(state.staleNotes.length < before.staleNotes.length, 'the covered sources drop out of the Cash card notes');
});

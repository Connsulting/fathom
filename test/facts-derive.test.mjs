import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRecFacts, prepareRecFacts } from '../src/facts/derive.mjs';
import { questionFor } from '../src/jobs/triggers/common.mjs';
import { evaluate, listTitle } from '../src/jobs/triggers/missing-data.mjs';
import { nameKey } from '../src/ingest/extract.mjs';
import { openDb, migrate } from '../src/store/db.mjs';
import { upsertFact, getFacts } from '../src/store/facts.mjs';
import { answerFacts } from '../src/facts/answers.mjs';

const date = '2026-11-05';
const entity = { name: 'Example Studio', slug: 'example-studio', owner: 'owner', type: 's_corp', classified: true, lines: [] };
const base = () => ({ clock: date, year: 2026, taxYear: 2026, documents: [], accounts: [], transactions: [], pnl: [], withholding: [], confirm: [], conflictArchive: [], aliases: [] });
const doc = (id, year, employer, person, fields = {}) => ({ id, docType: 'w2', taxYear: year, fileId: `file-${id}`, fields: { taxYear: year, employerName: employer, wages: 51000, medicareWages: 56000, socialSecurityWages: 56000, box12: [], ...fields }, person });
function payroll(data, d) {
  data.documents.push(d);
  data.confirm.push({ kind: 'employer_recipient', subject: nameKey(d.fields.employerName), status: 'answered', answer: d.person });
}
function derived(data, facts = {}) { return deriveRecFacts(data, facts, { entities: [entity] }); }
function fact(result, key, expected) {
  assert.deepEqual(result[key]?.value, expected);
  assert.equal(result[key].src, `derived:${date}`);
  assert.ok(result[key].provenance.locator.rule);
  assert.ok(result[key].provenance.locator.rows.length);
}

test('prior-year Social Security wages use box three, scoped to person and sponsor', () => {
  const data = base();
  payroll(data, doc(1, 2025, entity.name, 'owner', { socialSecurityWages: 67000 }));
  payroll(data, doc(2, 2025, 'Other Employer', 'owner', { socialSecurityWages: 91000 }));
  fact(derived(data), 'retirement.priorYearFicaWages', { owner: 67000 });
});

test('missing or conflicting Social Security evidence gives no fact', () => {
  const data = base();
  payroll(data, doc(1, 2025, entity.name, 'owner', { socialSecurityWages: undefined }));
  assert.equal(derived(data)['retirement.priorYearFicaWages'], undefined);
  data.documents[0].fields.socialSecurityWages = 50000;
  payroll(data, doc(2, 2025, entity.name, 'owner', { socialSecurityWages: 60000 }));
  assert.equal(derived(data)['retirement.priorYearFicaWages'], undefined);
});

test('other workplace deferrals use box twelve and preserve person attribution', () => {
  const data = base();
  payroll(data, doc(1, 2026, 'Other Employer', 'spouse', { box12: [{ code: 'D', amount: 9000 }, { code: 'AA', amount: 2000 }, { code: 'G', amount: 1500 }] }));
  fact(derived(data), 'retirement.otherPlanDeferrals', { spouse: { deferral: 11000, catchUp: 0 } });
});

test('no outside employer gives zero only with positive employment evidence', () => {
  const data = base();
  assert.equal(derived(data)['retirement.otherPlanDeferrals'], undefined);
  payroll(data, doc(1, 2026, entity.name, 'owner'));
  fact(derived(data), 'retirement.otherPlanDeferrals', { owner: { deferral: 0, catchUp: 0 } });
  payroll(data, doc(2, 2026, 'Other Employer', 'owner', { box12: undefined }));
  assert.equal(derived(data)['retirement.otherPlanDeferrals'], undefined);
});

test('business W-2 recipients establish only-employee status and unknown recipients keep the question', () => {
  const data = base();
  payroll(data, doc(1, 2026, entity.name, 'owner'));
  fact(derived(data), 'business.onlyEmployee', true);
  payroll(data, doc(2, 2026, entity.name, 'spouse'));
  data.confirm[0].answer = 'both';
  assert.equal(derived(data)['business.onlyEmployee'], undefined);
});

test('Virginia itemized estimate sums eligible categories and excludes state income tax and principal', () => {
  const data = base();
  data.accounts.push({ id: 'checking', kind: 'checking' });
  data.transactions = [
    ['Charitable Donations', -2200], ['Mortgage Interest', -5100], ['Real Estate Tax', -1900],
    ['State Income Tax', -800], ['Mortgage', -10000], ['Groceries', -400], ['Charitable Donations', 200],
  ].map(([category, amount], i) => ({ id: i + 1, account_id: 'checking', category, amount, date: '2026-10-01' }));
  fact(derived(data, { 'household.state': 'VA' }), 'tax.vaItemizedEstimate', 9000);
});

test('family HSA coverage requires household and contributions above the self-only limit', () => {
  const data = base();
  data.accounts.push({ id: 'hsa', kind: 'hsa', owner: 'owner' });
  data.transactions.push({ id: 1, account_id: 'hsa', date: '2026-10-01', amount: 6000, category: 'HSA Contribution' });
  fact(derived(data, { 'household.dependents': 1 }), 'benefits.hsaCoverage', 'family');
  assert.equal(derived(data)['benefits.hsaCoverage'], undefined);
  data.transactions[0].amount = 2000;
  assert.equal(derived(data, { 'household.dependents': 1 })['benefits.hsaCoverage'], undefined);
});

test('empty data gives no derived facts and the unanswered question stays', () => {
  assert.deepEqual(derived(base()), {});
  const q = questionFor(['retirement.priorYearFicaWages']);
  assert.equal(q.answered, false);
  assert.equal(q.fields.length, 1);
});

test('defaults carry assumptions and Undo survives rederivation', async () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    upsertFact(db, { key: 'household.birthYears', value: { owner: 1980, spouse: 1982 }, confirmed: true });
    upsertFact(db, { key: 'business.entities', value: [entity], confirmed: true });
    let result = prepareRecFacts(db, base());
    assert.equal(result.values['household.filingStatus'], 'mfj');
    assert.equal(result.values['business.cashBasis'], true);
    assert.ok(result.assumptions.every(a => /assum/i.test(a.evidence)));
    result.write();
    assert.equal(getFacts(db)['household.filingStatus'], 'mfj');
    await answerFacts(db, [{ key: 'household.filingStatusDefault', value: true }], { now: `${date}T12:00:00Z`, replan: async () => {} });
    result = prepareRecFacts(db, base());
    assert.equal(result.values['household.filingStatus'], undefined);
  } finally { db.close(); }
});

test('advisor keys are absent from owner questions and missing-data counts', () => {
  const keys = ['retirement.planTermsConfirmed', 'retirement.aggregationConfirmed', 'business.salaryRange'];
  assert.deepEqual(questionFor(keys).fields, []);
  const ctx = { clock: date, year: 2026, facts: {}, freshness: [], warnings: [], info: { blocked: [...keys, 'tax.vaItemizedEstimate'] } };
  const hit = evaluate(ctx);
  assert.deepEqual(hit.questions || hit.confirm, ['tax.vaItemizedEstimate']);
  assert.equal(listTitle(hit.items), 'Answer a question');
});

test('Virginia carryforward defaults preserve confirmed plan answers and Undo is account scoped', async () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    db.prepare("INSERT INTO accounts (id, kind, inst) VALUES ('college', '529', 'Invest529')").run();
    upsertFact(db, { key: 'accounts.va529', value: { college: { virginiaPlan: true } }, src: 'you', confirmed: true });
    const data = base();
    data.accounts.push({ id: 'college', kind: '529', inst: 'Invest529' });
    let prepared = prepareRecFacts(db, data);
    prepared.write();
    assert.equal(prepared.values['accounts.va529'].college.carryforward, 0);
    assert.equal(getFacts(db)['accounts.va529'].college.carryforward, undefined);
    fact({ carry: { value: getFacts(db)['accounts.va529Carryforward'], ...db.prepare("SELECT src FROM facts WHERE key = 'accounts.va529Carryforward'").get(), provenance: { locator: JSON.parse(db.prepare("SELECT locator FROM facts WHERE key = 'accounts.va529Carryforward'").get().locator) } } }, 'carry', { college: 0 });
    assert.equal(questionFor(['accounts.va529'], { accounts: data.accounts, facts: getFacts(db) }).answered, true);
    await answerFacts(db, [{ key: 'accounts.va529CarryforwardDefault', value: { college: { undone: true } } }], { now: `${date}T12:00:00Z`, replan: async () => {} });
    prepared = prepareRecFacts(db, data);
    prepared.write();
    assert.equal(prepared.values['accounts.va529'].college.carryforward, undefined);
    assert.equal(questionFor(['accounts.va529'], { accounts: data.accounts, facts: getFacts(db) }).answered, false);
  } finally { db.close(); }
});

test('a derived fact is refreshed and removed with its evidence, while an owner answer wins', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    upsertFact(db, { key: 'household.state', value: 'VA', confirmed: true });
    const data = base();
    data.accounts.push({ id: 'checking', kind: 'checking' });
    data.transactions.push({ id: 1, date, account_id: 'checking', amount: -200, category: 'Charitable Donations' });
    prepareRecFacts(db, data).write();
    assert.equal(getFacts(db)['tax.vaItemizedEstimate'], 200);
    data.transactions[0].amount = -300;
    prepareRecFacts(db, data).write();
    assert.equal(getFacts(db)['tax.vaItemizedEstimate'], 300);
    data.transactions = [];
    prepareRecFacts(db, data).write();
    assert.equal(getFacts(db)['tax.vaItemizedEstimate'], undefined);
    upsertFact(db, { key: 'tax.vaItemizedEstimate', value: 700, src: 'you', confirmed: true });
    prepareRecFacts(db, data).write();
    assert.equal(getFacts(db)['tax.vaItemizedEstimate'], 700);
  } finally { db.close(); }
});

import { scratch, addFact, recRow } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { buildPacketHtml } from '../src/advisor/packet.mjs';
import { recAnswers as answerRec } from '../src/api/fact-answers.mjs';
import * as recAnswerView from '../web/horizon/screens/rec-answers.js';

test('planner routes professional judgments to waiting advisor packets and retains salary of record', async () => {
  const s = scratch('derive-advisor-');
  try {
    const db = await s.store({ variant: { facts: { 'business.salaryRange': undefined, 'retirement.planTermsConfirmed': undefined, 'retirement.aggregationConfirmed': undefined } } });
    await planRun(db);
    const scenario = buildScenario(db);
    const waiting = scenario.recs.filter(r => r.advisorQuestions?.length);
    assert.ok(waiting.length);
    assert.ok(waiting.some(r => r.advisorQuestions.includes('business.salaryRange')));
    for (const rec of waiting) {
      assert.equal(rec.status, 'waiting');
      assert.equal(recRow(db, rec.id).waiting_on, 'advisor');
      assert.ok(scenario.advisor.pending.includes(rec.id));
      assert.ok(!rec.question?.fields.some(f => ['business.salaryRange', 'retirement.planTermsConfirmed', 'retirement.aggregationConfirmed'].includes(f.key)));
    }
    const packet = buildPacketHtml(scenario);
    assert.match(packet, /annual salary range is reasonable/);
    assert.match(packet, /related businesses share retirement plan limits/);
    assert.match(packet, /salary of record as an assumption/);
    assert.ok(scenario.fig['pnl.northwind-advisory.salaryProj'].v > 0);
    addFact(db, 'business.salaryRange', { min: 50000, max: 110000 });
    addFact(db, 'retirement.planTermsConfirmed', true);
    addFact(db, 'retirement.aggregationConfirmed', true);
    await planRun(db);
    assert.notEqual(recRow(db, 'scorp-salary').status, 'waiting');
  } finally { s.cleanup(); }
});

test('planner defaults are visible with Undo and API Undo restores the question without redefaulting', async () => {
  const s = scratch('derive-default-');
  try {
    const db = await s.store({ variant: { facts: { 'business.cashBasis': undefined, 'household.filingStatus': undefined } } });
    await planRun(db);
    const scenario = buildScenario(db);
    const rec = scenario.recs.find(r => r.assumptions?.some(a => a.key === 'business.cashBasis'));
    assert.ok(rec);
    recAnswerView.bind({ esc: x => String(x ?? '').replaceAll('<', '&lt;'), snoozeLabel: () => 'Later' });
    const html = recAnswerView.html(rec, 'plan');
    assert.match(html, /Assumption: the business uses cash-basis books/);
    assert.match(html, /data-default-undo/);
    const result = await answerRec({ db, config: { clock: date }, params: { id: rec.id }, body: { answers: [{ key: 'business.cashBasisDefault', value: true }] }, scheduler: { runNow: () => planRun(db) } });
    assert.ok(result.scenario);
    assert.equal(getFacts(db)['business.cashBasis'], undefined);
    assert.equal(getFacts(db)['household.filingStatus'], 'mfj');
    await planRun(db);
    assert.equal(getFacts(db)['business.cashBasis'], undefined);
    assert.ok(buildScenario(db).recs.some(r => r.question?.fields.some(f => f.key === 'business.cashBasis')));
  } finally { s.cleanup(); }
});

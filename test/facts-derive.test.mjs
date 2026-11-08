import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRecFacts, prepareRecFacts } from '../src/facts/derive.mjs';
import { questionFor } from '../src/jobs/triggers/common.mjs';
import { evaluate, listTitle } from '../src/jobs/triggers/missing-data.mjs';
import { openDb, migrate } from '../src/store/db.mjs';
import { upsertFact, getFacts } from '../src/store/facts.mjs';
import { answerFacts } from '../src/facts/answers.mjs';

const date = '2026-11-05';
const entity = { name: 'Example Studio', slug: 'example-studio', owner: 'owner', type: 's_corp', classified: true, lines: [] };
const base = () => ({ clock: date, year: 2026, taxYear: 2026, documents: [], accounts: [], transactions: [], pnl: [], withholding: [], confirm: [], conflictArchive: [], aliases: [] });
const doc = (id, year, employer, person, fields = {}) => ({ id, docType: 'w2', taxYear: year, fileId: `file-${id}`, fields: { taxYear: year, employerName: employer, wages: 51000, medicareWages: 56000, socialSecurityWages: 56000, box12: [], ...fields }, person });
function payroll(data, d) {
  data.documents.push(d);
  data.confirm.push({ kind: 'employer_recipient', subject: d.fields.employerName.toLowerCase(), status: 'answered', answer: d.person });
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

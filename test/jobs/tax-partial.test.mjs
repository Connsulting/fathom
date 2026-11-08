import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, addPayroll, addFact, w2Doc, paystubDoc, figureRow, factRow, householdOf } from '../helpers/real-store.mjs';
import { planRun, claimPlanRun } from '../helpers/plan.mjs';
import { runPlanning } from '../../src/jobs/planner.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { payrollRecords } from '../../src/jobs/planner/payroll.mjs';
import { getFacts } from '../../src/store/facts.mjs';
import { answerFacts } from '../../src/facts/answers.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import { createEngine } from '../../src/engine/index.mjs';
import { createLiveAnswerer } from '../../src/api/answerer.mjs';
import { threadCreate } from '../../src/api/handlers.mjs';
import { callTool } from '../../src/tools/index.mjs';

const s = scratch('fathom-tax-partial-');
after(() => s.cleanup());
const now = '2026-11-05';
const poor = { employerName: 'Cedar Labs', payDate: '2026-10-31', net: 1600, state: 'VA', confidence: 0.5 };
async function store({ missing = true, household = true, ...variant } = {}) {
  const db = await s.store({ variant: { files: false, entities: [], facts: { 'business.entities': [], 'income.sCorp': true, 'household.dependents': 0, 'household.birthYears': { owner: 1981, spouse: 1983 } }, ...variant } });
  if (household) await addPayroll(db, w2Doc({ employerName: 'Juniper Studio', person: 'owner', relation: 'household', wages: 72000, medicareWages: 72000, box12: [] }));
  if (missing) await addPayroll(db, paystubDoc({ ...poor, person: 'spouse', relation: 'outside' }));
  await addPayroll(db, paystubDoc({ employerName: 'Maple Works', person: 'spouse', relation: 'outside', payDate: '2026-10-31', gross: 4000, ytdGross: 40000 }));
  return db;
}
const payroll = db => { const data = loadPlanningData(db, now); const facts = getFacts(db); return payrollRecords(data, resolveEntities(data, facts), facts); };
const projection = db => {
  const f = figureRow(db, 'tax.fed.proj');
  assert.ok(f && !f.unavailable_reason, 'federal projection is usable');
  assert.ok(figureRow(db, 'tax.va.proj'), 'state projection exists');
  return f;
};

test('AC1: one unreadable paystub leaves partial federal, state and downstream figures with named provenance', async () => {
  const db = await store();
  await planRun(db);
  const fed = projection(db);
  for (const key of ['tax.fed.proj', 'tax.va.proj', 'agi.est', 'sh.fed.currentTarget', 'sh.va.required']) {
    const f = figureRow(db, key);
    assert.equal(f.locator.partial, true, key);
    assert.match(f.label, /partial/i);
    assert.ok(f.locator.notes.some(n => /Cedar Labs.*not included.*year-to-date/i.test(n)), key);
    assert.ok(f.locator.inputs || f.locator.rows || f.locator.parts, 'figure retains its calculation provenance');
  }
  assert.equal(fed.locator.parts.wages.reduce((sum, r) => sum + r.agi, 0), 120000);
  const rec = buildScenario(db).recs.find(r => r.id === 'missing-data');
  assert.match(JSON.stringify(rec), /Cedar Labs/);
  assert.doesNotMatch(JSON.stringify(rec), /tax projections are on hold/);
});

test('AC2: household employer creates an evidenced inferred entity and Undo prevents reinference', async () => {
  const db = await store({ missing: false });
  await planRun(db);
  const f = factRow(db, 'business.entities');
  assert.deepEqual(f.value, [{ name: 'Juniper Studio', type: 's_corp', owner: 'owner' }]);
  assert.equal(f.confirmed, 0);
  assert.match(f.src, /^derived:/);
  assert.ok(f.locator.rows.some(r => r.table === 'documents'));
  const rec = buildScenario(db).recs.find(r => r.assumptions?.some(a => a.undoKey === 'business.entitiesDefault'));
  assert.ok(rec, 'inference exposes existing assumption Undo');
  await answerFacts(db, [{ key: 'business.entitiesDefault', value: true }], { replan: () => planRun(db), now });
  assert.equal(getFacts(db)['business.entities'], undefined);
  assert.ok(payroll(db).blocks.some(b => b.code === 'household_employer_unmatched'));
  assert.equal(projection(db).locator.partial, true);
});

test('AC2: one stated business is preserved and two candidates keep one specific question', async () => {
  const entities = [{ name: 'Juniper Holdings', type: 's_corp', owner: 'spouse' }];
  const db = await store({ missing: false });
  addFact(db, 'business.entities', entities);
  await planRun(db);
  assert.deepEqual(getFacts(db)['business.entities'], entities);
  assert.equal(payroll(db).blocks.length, 0);
  addFact(db, 'business.entities', [...entities, { name: 'Aspen Studio', type: 's_corp', owner: 'owner' }]);
  await planRun(db);
  assert.equal(payroll(db).blocks.filter(b => b.code === 'household_employer_unmatched').length, 1);
  assert.equal(projection(db).locator.partial, true);
  const rec = buildScenario(db).recs.find(r => r.id === 'missing-data');
  assert.match(JSON.stringify(rec), /Juniper Studio/);
});

test('AC3: earlier YTD stub for the same employer and person supplies the projection', async () => {
  const db = await store();
  await addPayroll(db, paystubDoc({ employerName: 'Cedar Labs', person: 'spouse', relation: 'outside', payDate: '2026-09-30', gross: 3000, ytdGross: 27000 }));
  await planRun(db);
  assert.ok(!projection(db).locator.partial);
  const r = payroll(db).records.find(r => r.employer === 'Cedar Labs');
  assert.equal(r.wages, 36000);
  assert.equal(r.ytdWages, 27000);
  assert.equal(r.payrollProvenance.asOf, '2026-09-30');
  assert.deepEqual(r.docIds, [db.prepare("SELECT id FROM documents WHERE json_extract(fields, '$.payDate') = '2026-09-30'").get().id]);
});

test('AC4: per-period gross uses recorded pay-period dates and carries its inferred assumption', async () => {
  const db = await store({ missing: false });
  await addPayroll(db, paystubDoc({ ...poor, person: 'spouse', relation: 'outside', gross: 1500, periodStart: '2026-10-18', periodEnd: '2026-10-31' }));
  await planRun(db);
  const r = payroll(db).records.find(r => r.employer === 'Cedar Labs');
  assert.equal(r.wages, 39000);
  assert.equal(r.ytdWages, 31500);
  assert.equal(r.payrollProvenance.assumption, true);
  assert.ok(projection(db).locator.notes.some(n => /Cedar Labs.*gross.*pay periods/i.test(n)));
  assert.ok(projection(db).locator.gaps.some(g => g.code === 'paystub_gross_assumed'));
});

test('AC5: scripted Ask records YTD with a receipt, removes the partial mark, and Undo restores it', async () => {
  const db = await store();
  await planRun(db);
  assert.equal(projection(db).locator.partial, true);
  const words = 'For spouse, my YTD gross at Cedar Labs is $30,000 as of 2026-10-31.';
  const args = { operation: 'fact', key: 'income.payrollYtd', value: { 'Cedar Labs': { person: 'spouse', asOf: '2026-10-31', ytdGross: 30000 } }, evidence: words };
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
    ? Promise.resolve({ text: 'Payroll update', toolResults: [] })
    : transport.call({ ...request, fake: [{ toolCalls: [{ name: 'answer', args }] }, { text: 'Your payroll amount is saved.' }] }) };
  const home = householdOf(db);
  const answerer = createLiveAnswerer({ engine, root: home.root, services: { ...home.services, engine, config: { dataDir: home.root } } });
  const out = await threadCreate({ db, config: { clock: now }, identity: { id: 'person-a' }, scheduler: { runNow: () => planRun(db) }, answerer, body: { text: words } });
  assert.equal(getFacts(db)['income.payrollYtd']['Cedar Labs'].ytdGross, 30000);
  assert.ok(!projection(db).locator.partial);
  assert.equal(payroll(db).records.find(r => r.employer === 'Cedar Labs').wages, 36000);
  const receipt = buildScenario(db).live.conversations[out.thread.key].flatMap(m => m.provenance?.actions || [])[0];
  assert.ok(receipt && !receipt.undone);
  await callTool('undo', { operation: 'undo', id: receipt.id }, { db, actorId: 'person-a', channel: 'mcp', scopes: ['write:facts'], replan: () => planRun(db) });
  assert.equal(projection(db).locator.partial, true);
});

test('AC6 amended: no usable income gives a rough estimate, zero wages remain usable, and net never supplies gross', async () => {
  const db = await s.store({ variant: { files: false, entities: [], priorReturn: false, facts: { 'household.dependents': 0 } } });
  await addPayroll(db, paystubDoc({ ...poor, person: 'owner', relation: 'outside' }));
  await planRun(db);
  assert.equal(figureRow(db, 'tax.fed.proj').v, 0);
  assert.equal(figureRow(db, 'tax.fed.proj').locator.rough, true);
  assert.equal(payroll(db).records.length, 0);
  await addPayroll(db, paystubDoc({ employerName: 'Zero Works', person: 'owner', relation: 'outside', payDate: '2026-10-31', ytdGross: 0 }));
  await planRun(db);
  assert.equal(figureRow(db, 'tax.fed.proj').v, 0);
});

test('low-confidence incomplete extraction retries the stored file once before fallbacks', async () => {
  const db = await store();
  let calls = 0;
  const engine = { isOn: () => true, async extract() { calls++; return [{ ...poor, gross: 3000, ytdGross: 30000, confidence: 0.95 }]; } };
  const plan = () => runPlanning(db, engine, { now, runId: claimPlanRun(db), household: householdOf(db) });
  await plan();
  assert.equal(calls, 1);
  assert.ok(!projection(db).locator.partial);
  assert.equal(payroll(db).records.find(r => r.employer === 'Cedar Labs').wages, 36000);
  await plan();
  assert.equal(calls, 1);
});

test('an unsuccessful extraction is attempted only once and retains other usable income', async () => {
  const db = await store();
  let calls = 0;
  const engine = { isOn: () => true, async extract() { calls++; return [poor]; } };
  const plan = () => runPlanning(db, engine, { now, runId: claimPlanRun(db), household: householdOf(db) });
  await plan();
  await plan();
  assert.equal(calls, 1);
  assert.equal(projection(db).locator.partial, true);
});

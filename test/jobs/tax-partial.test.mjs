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
import { nameKey } from '../../src/ingest/extract.mjs';
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
  assert.deepEqual(factRow(db, 'business.employerEntity').value, { 'Juniper Studio': 'Juniper Holdings' });
  assert.ok(buildScenario(db).recs.some(r => r.assumptions?.some(a => a.undoKey === 'business.employerEntityDefault')));
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

test('every former payroll and income block produces federal and state estimates with an actionable gap', async t => {
  const db = await store({ missing: false });
  await planRun(db);
  const base = loadPlanningData(db, now), initial = getFacts(db);
  const { computeFigures } = await import('../../src/jobs/planner/figures.mjs');
  const { docPayer } = await import('../../src/jobs/planner/payroll.mjs');
  const cases = {
    paystub_ytd_missing(d) { delete d.documents.find(x => x.docType === 'paystub').fields.ytdGross; delete d.documents.find(x => x.docType === 'paystub').fields.gross; },
    paystub_deferrals_unknown(d) { d.documents.find(x => x.docType === 'paystub').fields.retirementDeferral = 200; },
    deferral_split_unknown(d, f) {
      const w = d.documents.find(x => x.docType === 'w2'); w.fields.box12 = [{ code: 'D', amount: 30000 }];
      const copy = structuredClone(w); copy.id = 901; copy.fileId = 'synthetic-outside'; copy.fields.employerName = 'Second Plan'; copy.fields.box12 = [{ code: 'D', amount: 5000 }];
      d.documents.push(copy); d.confirm.push({ kind: 'employer_recipient', subject: nameKey('Second Plan'), status: 'answered', answer: 'owner' }); delete f['retirement.otherPlanDeferrals'];
    },
    w2_box12_unreadable(d) { delete d.documents.find(x => x.docType === 'w2').fields.box12; },
    w2_wages_missing(d) { delete d.documents.find(x => x.docType === 'w2').fields.wages; },
    w2_medicare_wages_missing(d) { delete d.documents.find(x => x.docType === 'w2').fields.medicareWages; },
    w2_recipient_unknown(d) { const w = d.documents.find(x => x.docType === 'w2'); d.withholding = d.withholding.filter(x => x.file_id !== w.fileId); d.confirm = d.confirm.filter(x => !['employer_recipient', 'document_recipient'].includes(x.kind)); },
    payroll_recipient_conflict(d) { const w = d.documents.find(x => x.docType === 'w2'); d.withholding.push({ file_id: w.fileId, payer: docPayer(w), recipient: 'spouse' }); },
    w2_duplicate_unresolved(d) { const copy = structuredClone(d.documents.find(x => x.docType === 'w2')); copy.id = 901; copy.fileId = 'synthetic-newer'; copy.fields.wages = 80000; d.documents.push(copy); },
    w2_correction_pending(d) { cases.w2_duplicate_unresolved(d); const w = d.documents.filter(x => x.docType === 'w2'); d.confirm.push({ kind: 'withholding_conflict', status: 'pending', context: { first: { fileId: w[0].fileId }, second: { fileId: w[1].fileId } } }); },
    w2_correction_conflicting(d) { cases.w2_duplicate_unresolved(d); const [a,b] = d.documents.filter(x => x.docType === 'w2'); d.conflictArchive = [{ fileId: a.fileId, supersededBy: b.fileId, row: { payer: docPayer(a) } }, { fileId: b.fileId, supersededBy: a.fileId, row: { payer: docPayer(b) } }]; },
    household_employer_unmatched(d, f) { f['business.entities'] = [{ name: 'First Candidate', type: 's_corp', owner: 'owner' }, { name: 'Second Candidate', type: 's_corp', owner: 'owner' }]; },
    employer_relation_pending(d) { d.confirm.find(x => x.kind === 'employer_relation' && x.subject === nameKey('Maple Works')).status = 'pending'; },
    entity_unclassified(d) { d.pnl.push({ id: 902, file_id: null, entity: 'Unclassified Studio', period: '2026-10', category: 'Income', amount: 30000 }); },
    partnership_incomplete(d, f) { f['business.entities'].push({ name: 'Partnership Studio', type: 'partnership', owner: 'owner' }); },
    k1_unmatched(d, f) { cases.partnership_incomplete(d, f); for (let id = 903; id < 905; id++) d.documents.push({ id, docType: 'k1', taxYear: 2026, fields: { entityKind: 'partnership', ordinaryIncome: 20000, guaranteedPayments: 0, selfEmploymentEarnings: 20000 } }); },
    k1_scorp_unmatched(d) { d.documents.push({ id: 905, docType: 'k1', taxYear: 2026, fields: { entityKind: 's_corp', ordinaryIncome: 20000 } }); },
    retirement_contribution_unattributed(d, f) { f['retirement.contributions'] = [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', entity: 'Unknown Sponsor', amount: 3000 }]; },
  };
  for (const [code, mutate] of Object.entries(cases)) await t.test(code, () => {
    const data = structuredClone(base), facts = structuredClone(initial);
    mutate(data, facts);
    const computed = computeFigures(data, facts, { clock: now, entities: resolveEntities(data, facts), owner: facts });
    const gap = computed.info.gaps.find(g => g.code.split(':')[0] === code);
    assert.ok(gap, `${code} scenario actually triggered`);
    for (const key of ['tax.fed.proj', 'tax.va.proj']) {
      assert.ok(Number.isFinite(computed.figures[key]?.v), key);
      assert.ok(computed.figures[key].locator.gaps.some(g => g.code === gap.code), key);
      assert.match(computed.figures[key].locator.completeness, /^estimate with \d+ gaps$/);
    }
    assert.ok(gap.message && gap.action.label);
    assert.ok(['upload', 'ask'].includes(gap.action.screen));
  });
});

test('every missing-data task code targets an existing upload kind or an accepted answer shape', async () => {
  const { MISSING_TASK_CODES, fixForCode } = await import('../../src/jobs/triggers/missing-data.mjs');
  const { HOWTO } = await import('../../src/ingest/howto.mjs');
  const { answerShape } = await import('../../src/jobs/triggers/common.mjs');
  for (const code of MISSING_TASK_CODES) {
    const fix = fixForCode(code);
    assert.ok(fix.label, code);
    if (fix.screen === 'upload') assert.ok(Object.hasOwn(HOWTO, fix.kind), `${code}: upload kind exists`);
    else { assert.equal(fix.screen, 'ask', code); assert.ok(answerShape(fix.key), code); assert.ok(fix.prompt, code); }
  }
  assert.throws(() => fixForCode('unknown_missing_task'), /No missing-data fix/);
});

test('retrying missing gross keeps a document recipient when both people share the employer', async () => {
  const db = await store({ missing: false });
  await addPayroll(db, { ...paystubDoc({ ...poor, person: 'both', relation: 'outside' }), document: 'owner' });
  const engine = { isOn: () => true, async extract() { return [{ ...poor, gross: 3000, ytdGross: 30000, confidence: 0.95 }]; } };
  await runPlanning(db, engine, { now, runId: claimPlanRun(db), household: householdOf(db) });
  const r = payroll(db).records.find(r => r.employer === 'Cedar Labs');
  assert.equal(r.person, 'owner');
  assert.equal(r.wages, 36000);
  assert.ok(!payroll(db).blocks.some(b => b.code === 'w2_recipient_unknown'));
});

test('typed Ask corrections for business classification and contribution sponsors remove their gaps', async () => {
  const db = await s.store();
  addFact(db, 'retirement.contributions', [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', amount: 2000, entity: 'Unmatched Business' }]);
  await planRun(db);
  assert.ok(projection(db).locator.gaps.some(g => g.code === 'retirement_contribution_unattributed'));
  const entries = getFacts(db)['business.entities'];
  const entity = entries.find(e => e.type === 's_corp').name;
  const words = `Replace the retirement contributions list with owner deferral $2000 to ${entity}.`;
  await assert.rejects(callTool('answer', { operation: 'fact', key: 'retirement.contributions', value: [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', amount: 2500, entity }], evidence: words }, { db, ownerText: words, actorId: 'person-a', conversationKey: 'ask:0123456789ab', turnId: 'turn-a' }), /Use a value you stated/);
  assert.equal(getFacts(db)['retirement.contributions'][0].entity, 'Unmatched Business');
  const result = await callTool('answer', { operation: 'fact', key: 'retirement.contributions', value: [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', amount: 2000, entity }], evidence: words }, { db, ownerText: words, actorId: 'person-a', conversationKey: 'ask:0123456789ab', turnId: 'turn-a', replan: () => planRun(db) });
  assert.ok(result.receipt);
  assert.ok(!projection(db).locator.gaps.some(g => g.code === 'retirement_contribution_unattributed'));
  db.prepare("INSERT INTO pnl_lines (entity, period, category, amount, locator) VALUES ('CypressStudio', '2026-10', 'Income', 20000, ?)").run(JSON.stringify({ sheet: "Cypress Studio's Income" }));
  await planRun(db);
  assert.ok(projection(db).locator.gaps.some(g => g.code.startsWith('entity_unclassified:')));
  await answerFacts(db, [{ key: 'business.entityTypes', value: { "Cypress Studio's": 'sole_prop' } }], { now, replan: () => planRun(db) });
  assert.ok(!projection(db).locator.gaps.some(g => g.code.startsWith('entity_unclassified:')));
});

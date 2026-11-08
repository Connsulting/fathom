import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, addPayroll, addFact, removeFact, w2Doc, paystubDoc, figureRow, factRow, householdOf, answerPending } from '../helpers/real-store.mjs';
import { planRun, claimPlanRun } from '../helpers/plan.mjs';
import { runPlanning } from '../../src/jobs/planner.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { payrollRecords } from '../../src/jobs/planner/payroll.mjs';
import { getFacts } from '../../src/store/facts.mjs';
import { answerFacts } from '../../src/facts/answers.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import { seedHistoricalDocument } from '../helpers/historical-import.mjs';
import { writeXlsx } from '../helpers/xlsx.mjs';
import { createHash } from 'node:crypto';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { createEngine } from '../../src/engine/index.mjs';
import { createLiveAnswerer } from '../../src/api/answerer.mjs';
import { threadCreate } from '../../src/api/handlers.mjs';
import { nameKey } from '../../src/ingest/extract.mjs';
import { callTool } from '../../src/tools/index.mjs';
import { figureInputs, inputsOf } from '../../src/shared/rec-inputs.mjs';

const s = scratch('fathom-tax-partial-');
after(async () => await s.cleanup());
const now = '2026-11-05';
const poor = { employerName: 'Cedar Labs', payDate: '2026-10-31', net: 1600, state: 'VA', confidence: 0.5 };
async function store({ missing = true, household = true, ...variant } = {}) {
  const db = await s.store({ variant: { files: false, entities: [], facts: { 'business.entities': [], 'income.sCorp': true, 'household.dependents': 0, 'household.birthYears': { owner: 1981, spouse: 1983 } }, ...variant } });
  if (household) await addPayroll(db, w2Doc({ employerName: 'Juniper Studio', person: 'owner', relation: 'household', wages: 72000, medicareWages: 72000, box12: [] }));
  if (missing) await legacyStub(db);
  await addPayroll(db, paystubDoc({ employerName: 'Maple Works', person: 'spouse', relation: 'outside', payDate: '2026-10-31', gross: 4000, ytdGross: 40000 }));
  return db;
}
async function legacyStub(db, person = 'spouse') {
  const readable = { payDate: poor.payDate, employerName: poor.employerName, net: poor.net, state: poor.state, federalWithholding: 0, gross: 3000, ytdGross: 30000 };
  const file = { name: 'synthetic-paystub.xlsx', bytes: writeXlsx([{ name: 'Paystub', rows: [Object.keys(readable), Object.values(readable)] }]) };
  const result = await seedHistoricalDocument({ db, household: householdOf(db) }, file, [[{ docType: 'paystub' }], [{ ...poor, federalWithholding: 0 }]]);
  const key = nameKey(poor.employerName);
  await answerPending(db, 'employer_relation', 'outside', i => i.subject === key);
  await answerPending(db, 'employer_recipient', person, i => i.subject === key);
  if (person === 'both') await answerPending(db, 'document_recipient', 'owner', i => i.fileId === result.fileId);
  return { fileId: result.fileId, file, readable };
}
async function retryEngine(db, { valid = true } = {}) {
  const file = { name: 'synthetic-paystub.xlsx', bytes: writeXlsx([{ name: 'Paystub', rows: [
    ['payDate', 'employerName', 'net', 'state', 'federalWithholding', 'gross', 'ytdGross'],
    [poor.payDate, poor.employerName, poor.net, poor.state, 0, 3000, 30000],
  ] }]) };
  const fileId = 'f-' + createHash('sha256').update(file.bytes).digest('hex').slice(0, 24);
  const source = await indexSource({ ...file, fileId, format: 'xlsx' });
  const values = { payDate: poor.payDate, employerName: poor.employerName, net: poor.net, state: poor.state, federalWithholding: 0, gross: 3000, ytdGross: 30000 };
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { refs: [Object.keys(source.values).find(id => source.values[id] === value)], transform: { op: 'identity' } }]));
  const output = { rows: [{ target: 'document', docType: 'paystub', fields }], coverage: source.regions.map(regionId => ({ regionId, refs: source.inventory[regionId].refs, disposition: 'imported_detail' })), completeness: 'complete' };
  const transport = await createRuntimeEngine({ db, config: { engine: 'fake' } });
  let calls = 0;
  const engine = { ...transport, async call(request) {
    if (request.purpose === 'extract') calls++;
    return await transport.call({ ...request, fake: [{ text: request.purpose === 'extract' && valid ? JSON.stringify(output) : '{}', costUsd: 0 }] });
  } };
  return { engine, household: { ...householdOf(db), engine }, calls: () => calls };
}
const payroll = async db => { const data = await loadPlanningData(db, now); const facts = await getFacts(db); return payrollRecords(data, resolveEntities(data, facts), facts); };
const projection = async db => {
  const f = await figureRow(db, 'tax.fed.proj');
  assert.ok(f && !f.unavailable_reason, 'federal projection is usable');
  assert.ok(await figureRow(db, 'tax.va.proj'), 'state projection exists');
  return f;
};

test('AC1: one unreadable paystub leaves partial federal, state and downstream figures with named provenance', async () => {
  const db = await store();
  await planRun(db);
  const fed = await projection(db);
  for (const key of ['tax.fed.proj', 'tax.va.proj', 'agi.est', 'sh.fed.currentTarget', 'sh.va.required']) {
    const f = await figureRow(db, key);
    assert.equal(f.locator.partial, true, key);
    assert.match(f.label, /partial/i);
    assert.ok(f.locator.notes.some(n => /Cedar Labs.*not included.*year-to-date/i.test(n)), key);
    assert.ok(f.locator.inputs || f.locator.rows || f.locator.parts, 'figure retains its calculation provenance');
  }
  assert.equal(fed.locator.parts.wages.reduce((sum, r) => sum + r.agi, 0), 120000);
  const rec = (await buildScenario(db)).recs.find(r => r.id === 'missing-data');
  assert.match(JSON.stringify(rec), /Cedar Labs/);
  assert.doesNotMatch(JSON.stringify(rec), /tax projections are on hold/);
});

test('AC2: household employer creates an evidenced inferred entity and Undo prevents reinference', async () => {
  const db = await store({ missing: false });
  await planRun(db);
  const f = await factRow(db, 'business.entities');
  assert.ok(f.value.some(e => e.name === 'Juniper Studio' && e.type === 's_corp' && e.owner === 'owner' && e.inferred));
  assert.ok(f.value.find(e => e.name === 'Juniper Studio').inferred);
  assert.match(f.src, /^inferred:/);
  assert.ok(f.locator.rows.some(r => r.table === 'documents'));
  const rec = (await buildScenario(db)).recs.find(r => r.assumptions?.some(a => a.undoKey === 'business.entityInference'));
  assert.ok(rec, 'inference exposes existing assumption Undo');
  await answerFacts(db, [{ key: 'business.entityInference', value: { 'Juniper Studio': { undone: true } } }], { replan: async () => planRun(db), now });
  assert.ok(!(await getFacts(db))['business.entities'].some(e => e.name === 'Juniper Studio'));
  assert.ok((await payroll(db)).blocks.some(b => b.code === 'household_employer_unmatched'));
  assert.equal((await projection(db)).locator.partial, true);
});

test('AC2: owner-entered businesses are preserved and declined inference leaves a labeled question', async () => {
  const entities = [{ name: 'Juniper Studio', type: 's_corp', owner: 'owner' }];
  const db = await store({ missing: false });
  await addFact(db, 'business.entities', entities);
  await planRun(db);
  assert.deepEqual((await getFacts(db))['business.entities'], entities);
  assert.equal((await payroll(db)).blocks.length, 0);
  await addFact(db, 'business.entities', [{ name: 'First Candidate', type: 's_corp', owner: 'owner' }, { name: 'Second Candidate', type: 's_corp', owner: 'owner' }]);
  await addFact(db, 'business.entityInference', { 'Juniper Studio': { undone: true } });
  await planRun(db);
  assert.ok((await projection(db)).locator.gaps.some(g => g.code === 'household_employer_unmatched'));
  assert.match(JSON.stringify((await buildScenario(db)).recs.find(r => r.id === 'missing-data')), /Juniper Studio/);
});

test('AC3: earlier YTD stub for the same employer and person supplies the projection', async () => {
  const db = await store();
  await addPayroll(db, paystubDoc({ employerName: 'Cedar Labs', person: 'spouse', relation: 'outside', payDate: '2026-09-30', gross: 3000, ytdGross: 27000 }));
  await planRun(db);
  assert.ok(!(await projection(db)).locator.partial);
  const r = (await payroll(db)).records.find(r => r.employer === 'Cedar Labs');
  assert.equal(r.wages, 36000);
  assert.equal(r.ytdWages, 27000);
  assert.equal(r.payrollProvenance.asOf, '2026-09-30');
  assert.deepEqual(r.docIds, [(await db.prepare("SELECT id FROM documents WHERE json_extract(fields, '$.payDate') = '2026-09-30'").get()).id]);
});

test('AC4: per-period gross uses recorded pay-period dates and carries its inferred assumption', async () => {
  const db = await store({ missing: false });
  await addPayroll(db, paystubDoc({ ...poor, person: 'spouse', relation: 'outside', gross: 1500, periodStart: '2026-10-18', periodEnd: '2026-10-31' }));
  await planRun(db);
  const r = (await payroll(db)).records.find(r => r.employer === 'Cedar Labs');
  assert.equal(r.wages, 39000);
  assert.equal(r.ytdWages, 31500);
  assert.equal(r.payrollProvenance.assumption, true);
  assert.equal((await figureRow(db, 'inc.ytd.w2')).kind, 'e');
  assert.equal((await figureRow(db, 'inc.ytd.total')).kind, 'e');
  assert.ok((await projection(db)).locator.notes.some(n => /Cedar Labs.*gross.*pay periods/i.test(n)));
  assert.ok((await projection(db)).locator.gaps.some(g => g.code === 'paystub_gross_assumed'));
});

test('AC5: scripted Ask records YTD with a receipt, removes the partial mark, and Undo restores it', async () => {
  const db = await store();
  await planRun(db);
  assert.equal((await projection(db)).locator.partial, true);
  const words = 'My YTD gross at Cedar Labs is $30,000 as of 2026-10-31.';
  const args = { operation: 'fact', key: 'income.payrollYtd', value: { 'Cedar Labs': { asOf: '2026-10-31', ytdGross: 30000 } }, evidence: words };
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
    ? Promise.resolve({ text: 'Payroll update', toolResults: [] })
    : transport.call({ ...request, fake: [{ toolCalls: [{ name: 'answer', args }] }, { text: 'Your payroll amount is saved.' }] }) };
  const home = householdOf(db);
  const answerer = createLiveAnswerer({ engine, root: home.root, services: { ...home.services, engine, config: { dataDir: home.root } } });
  const out = await threadCreate({ db, config: { clock: now }, identity: { id: 'person-a' }, scheduler: { runNow: async () => planRun(db) }, answerer, body: { text: words } });
  assert.equal((await getFacts(db))['income.payrollYtd']['Cedar Labs'].ytdGross, 30000);
  assert.ok(!(await projection(db)).locator.partial);
  assert.equal((await payroll(db)).records.find(r => r.employer === 'Cedar Labs').wages, 36000);
  const receipt = (await buildScenario(db)).live.conversations[out.thread.key].flatMap(m => m.provenance?.actions || [])[0];
  assert.ok(receipt && !receipt.undone);
  await callTool('undo', { operation: 'undo', id: receipt.id }, { db, actorId: 'person-a', channel: 'mcp', scopes: ['write:facts'], replan: async () => planRun(db) });
  assert.equal((await projection(db)).locator.partial, true);
});

test('AC6 amended: no usable income gives a rough estimate, zero wages remain usable, and net never supplies gross', async () => {
  const db = await s.store({ variant: { files: false, entities: [], priorReturn: false, facts: { 'household.dependents': 0 } } });
  await addPayroll(db, paystubDoc({ ...poor, person: 'owner', relation: 'outside' }));
  await planRun(db);
  assert.equal((await figureRow(db, 'tax.fed.proj')).v, 0);
  assert.equal((await figureRow(db, 'tax.fed.proj')).locator.rough, true);
  assert.equal((await payroll(db)).records.length, 0);
  await addPayroll(db, paystubDoc({ employerName: 'Zero Works', person: 'owner', relation: 'outside', payDate: '2026-10-31', ytdGross: 0 }));
  await planRun(db);
  assert.equal((await figureRow(db, 'tax.fed.proj')).v, 0);
});

test('low-confidence incomplete extraction retries the stored file once before fallbacks', async () => {
  const db = await store();
  const retry = await retryEngine(db);
  const plan = async () => runPlanning(db, retry.engine, { now, runId: await claimPlanRun(db), household: retry.household });
  await plan();
  assert.equal(retry.calls(), 1);
  assert.ok(!(await projection(db)).locator.partial);
  assert.equal((await payroll(db)).records.find(r => r.employer === 'Cedar Labs').wages, 36000);
  await plan();
  assert.equal(retry.calls(), 1);
});

test('an unsuccessful extraction is attempted only once and retains other usable income', async () => {
  const db = await store();
  const retry = await retryEngine(db, { valid: false });
  const plan = async () => runPlanning(db, retry.engine, { now, runId: await claimPlanRun(db), household: retry.household });
  await plan();
  await plan();
  assert.equal(retry.calls(), 1);
  assert.equal((await projection(db)).locator.partial, true);
});

test('every former payroll and income block produces federal and state estimates with an actionable gap', async t => {
  const db = await store({ missing: false });
  await planRun(db);
  const base = await loadPlanningData(db, now), initial = await getFacts(db);
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
    retirement_contribution_unattributed(d, f) { f['business.entities'].push({ name: 'Second Sponsor', type: 's_corp', owner: 'owner' }); f['retirement.contributions'] = [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', entity: 'Unknown Sponsor', amount: 3000 }]; },
    retirement_contribution_over_limit(d, f) { f['retirement.contributions'] = [{ person: 'owner', plan: 'own-corp-401k', type: 'employer', entity: 'Juniper Studio', amount: 100000 }]; },
    va_itemized_missing(d, f) { f['tax.itemizedEstimate'] = 100000; delete f['tax.vaItemizedEstimate']; },
    va529_answers_missing(d, f) { d.accounts.push({ id: 'college', name: 'College savings', kind: '529', owner: 'owner', inst: '', latest: null }); f['accounts.va529'] = {}; },
    ctc_refundable_unsupported(d, f) { for (const doc of d.documents.filter(x => ['w2', 'paystub'].includes(x.docType))) Object.assign(doc.fields, { wages: 0, medicareWages: 0, gross: 0, ytdGross: 0 }); f['household.birthYears'].dependents = [2023]; },
    no_income_inputs(d) { d.documents = []; },
    filing_status_assumed(d, f) { delete f['household.filingStatus']; },
    tax_payment_kind_unknown(d) { d.taxPayments.push({ id: 906, jurisdiction: 'federal', kind: 'unknown', amount: 5000, date: '2026-10-31' }); },
    withholding_state_unknown(d) { d.taxPayments.push({ id: 906, jurisdiction: 'state', kind: 'withholding', recipient: 'owner', amount: 5000, date: '2026-10-31' }); },
    withholding_recipient_unknown(d, f) { f['household.filingStatus'] = 'single'; d.taxPayments.push({ id: 906, jurisdiction: 'federal', kind: 'withholding', recipient: 'unknown', amount: 5000, date: '2026-10-31' }); },
    withholding_conflict_pending(d) { d.taxPayments.push({ id: 906, jurisdiction: 'federal', kind: 'withholding', recipient: 'owner', amount: 5000, date: '2026-10-31' }); d.confirm.push({ kind: 'withholding_conflict', status: 'pending', context: { first: { id: 906 }, second: { id: 907 } } }); },
    tax_year_unconfirmed(d) { d.taxPayments.push({ id: 906, jurisdiction: 'federal', kind: 'paid', tax_year_basis: 'sheet_label', payer: 'owner', amount: 5000, date: '2026-10-31' }); },
    estimated_payer_unknown(d, f) { f['household.filingStatus'] = 'single'; for (const [id,payer] of [[906,'one'],[907,'two']]) d.taxPayments.push({ id, jurisdiction: 'federal', kind: 'paid', tax_year_basis: 'owner', payer, amount: 5000, date: '2026-10-31' }); },

  };
  for (const [code, mutate] of Object.entries(cases)) await t.test(code, () => {
    const data = structuredClone(base), facts = structuredClone(initial);
    mutate(data, facts);
    const computed = computeFigures(data, facts, { clock: now, entities: resolveEntities(data, facts), owner: facts });
    const gap = computed.info.gaps.find(g => g.code.split(':')[0] === code);
    assert.ok(gap, `${code} scenario actually triggered`);
    for (const key of ['tax.fed.proj', 'tax.va.proj']) assert.ok(Number.isFinite(computed.figures[key]?.v), key);
    // RQ2: a dependent figure carries the gap exactly when it is computed from the gapped input
    // (payment gaps reach the safe-harbor targets, not the projections; Virginia gaps stay off
    // federal figures), and every gap reaches at least one tax figure.
    const affected = inputsOf(gap.code);
    let carried = 0;
    for (const key of ['tax.fed.proj', 'tax.va.proj', 'sh.fed.required', 'sh.fed.remaining', 'sh.va.required', 'sh.va.remaining']) {
      const figure = computed.figures[key];
      if (!figure) continue;
      const reads = figureInputs(key).some(i => affected.includes(i));
      assert.equal(figure.locator.gaps.some(g => g.code === gap.code), reads, `${key} carries ${code}: ${reads}`);
      if (reads) { carried += 1; assert.match(figure.locator.completeness, /^estimate with \d+ gaps?$/); }
    }
    assert.ok(carried > 0, `${code} reaches a tax figure`);
    if (['withholding_conflict_pending', 'tax_year_unconfirmed', 'estimated_payer_unknown'].includes(code)) {
      const payment = code === 'withholding_conflict_pending' ? 'tax.fed.withheld' : 'tax.fed.paid';
      assert.equal(computed.figures[payment]?.v, 0, 'ambiguous credits are excluded');
      assert.ok(computed.figures[payment].locator.gaps.some(g => g.code === code), 'excluded credits carry their gap');
      assert.match(computed.figures[payment].locator.completeness, /^estimate with/);
      assert.equal(computed.figures['sh.fed.currentTarget'].locator.inputs.currentYearTax, computed.figures['tax.fed.proj'].v);
    }
    assert.ok(gap.message && gap.action.label);
    assert.ok(['upload', 'ask'].includes(gap.action.screen));
    if (code === 'tax_payment_kind_unknown') for (const key of ['tax.fed.paid', 'tax.fed.withheld']) {
      assert.ok(computed.figures[key].locator.gaps.some(g => g.code === code), `${key} explains the excluded unlabeled payment`);
    }
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
  await legacyStub(db, 'both');
  const retry = await retryEngine(db);
  await runPlanning(db, retry.engine, { now, runId: await claimPlanRun(db), household: retry.household });
  const r = (await payroll(db)).records.find(r => r.employer === 'Cedar Labs');
  assert.equal(r.person, 'owner');
  assert.equal(r.wages, 36000);
  assert.ok(!(await payroll(db)).blocks.some(b => b.code === 'w2_recipient_unknown'));
});

test('typed Ask corrections for business classification and contribution sponsors remove their gaps', async () => {
  const db = await s.store();
  await addFact(db, 'business.entities', [...(await getFacts(db))['business.entities'], { name: 'Second Sponsor', type: 's_corp', owner: 'owner' }]);
  await addFact(db, 'retirement.contributions', [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', amount: 2000, entity: 'Unmatched Business' }]);
  await planRun(db);
  assert.ok((await projection(db)).locator.gaps.some(g => g.code === 'retirement_contribution_unattributed'));
  const entries = (await getFacts(db))['business.entities'];
  const entity = entries.find(e => e.type === 's_corp').name;
  const words = `Replace the retirement contributions list with owner deferral $2000 to ${entity}.`;
  await assert.rejects(callTool('answer', { operation: 'fact', key: 'retirement.contributions', value: [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', amount: 2500, entity }], evidence: words }, { db, ownerText: words, actorId: 'person-a', conversationKey: 'ask:0123456789ab', turnId: 'turn-a' }), /Use a value you stated/);
  assert.equal((await getFacts(db))['retirement.contributions'][0].entity, 'Unmatched Business');
  const result = await callTool('answer', { operation: 'fact', key: 'retirement.contributions', value: [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', amount: 2000, entity }], evidence: words }, { db, ownerText: words, actorId: 'person-a', conversationKey: 'ask:0123456789ab', turnId: 'turn-a', replan: async () => planRun(db) });
  assert.ok(result.receipt);
  assert.ok(!(await projection(db)).locator.gaps.some(g => g.code === 'retirement_contribution_unattributed'));
  await db.prepare("INSERT INTO pnl_lines (entity, period, category, amount, locator) VALUES ('CypressStudio', '2026-10', 'Income', 20000, ?)").run(JSON.stringify({ sheet: "Cypress Studio's Income" }));
  await addFact(db, 'business.entityInference', { CypressStudio: { undone: true } });
  await planRun(db);
  assert.ok((await projection(db)).locator.gaps.some(g => g.code.startsWith('entity_unclassified:')));
  await answerFacts(db, [{ key: 'business.entities', value: [{ name: 'CypressStudio', type: 'sole_prop', owner: 'owner' }] }], { now, replan: async () => planRun(db) });
  assert.ok(!(await projection(db)).locator.gaps.some(g => g.code.startsWith('entity_unclassified:')));
});

test('a sole business receives its owner contribution with an explicit sponsor assumption', async () => {
  const db = await store({ missing: false });
  const contribution = { person: 'owner', plan: 'own-corp-401k', type: 'deferral', amount: 3000, entity: 'Mistyped Sponsor' };
  await addFact(db, 'retirement.contributions', [contribution]);
  await planRun(db);
  const assumed = await projection(db);
  const gap = assumed.locator.gaps.find(g => g.code === 'retirement_sponsor_assumed');
  assert.match(gap?.message || '', /Juniper Studio.*owner/);
  assert.equal(gap?.action.key, 'retirement.contributions');
  assert.ok(!assumed.locator.gaps.some(g => g.code === 'retirement_contribution_unattributed'));
  await addFact(db, 'retirement.contributions', [{ ...contribution, entity: 'Juniper Studio' }]);
  await planRun(db);
  const stated = await projection(db);
  assert.equal(stated.v, assumed.v, 'assumed sponsor uses the same recorded contribution');
  assert.ok(!stated.locator.gaps.some(g => g.code === 'retirement_sponsor_assumed'));
});


test('no-income estimates remain visible without asserting absent income as a household fact', async () => {
  const db = await s.store({ variant: { files: false, entities: [] } });
  await removeFact(db, 'income.agiEstimate');
  await planRun(db);
  assert.ok((await projection(db)).locator.gaps.some(g => g.code === 'no_income_inputs'));
  assert.equal((await getFacts(db))['income.agiEstimate'], undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/store/db.mjs';
import { getFacts, upsertFact } from '../src/store/facts.mjs';
import { prepareRecFacts, deriveRecFacts } from '../src/facts/derive.mjs';
import { answerFacts } from '../src/facts/answers.mjs';
import { questionFor, answerShape } from '../src/jobs/triggers/common.mjs';
import { loadPlanningData, resolveEntities } from '../src/jobs/planner/data.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { scratch, addFile, pnlWorkbook, SCORP } from './helpers/real-store.mjs';
import { nameKey } from '../src/ingest/extract.mjs';
import { gapControl } from '../web/core/gap-control.js';
import { readInput } from '../src/tools/catalog/spending.mjs';
import { callTool } from '../src/tools/index.mjs';
import { planRun } from './helpers/plan.mjs';
import * as answersView from '../web/horizon/screens/rec-answers.js';

const clock = '2026-11-05';
const entity = { name: 'Example Studio', type: 's_corp', owner: 'owner', classified: true };
const base = () => ({ clock, year: 2026, taxYear: 2026, accounts: [], pnl: [], pnlHistory: [], documents: [], transactions: [], confirm: [], withholding: [], conflictArchive: [], aliases: [] });
const answer = (db, key, value) => answerFacts(db, [{ key, value }], { now: `${clock}T12:00:00Z`, replan: async () => {} });
const prepare = (db, data) => { const p = prepareRecFacts(db, data); p.write(); return p; };

test('account plan inference is stored with evidence, refreshes, and Undo preserves owner answers', async t => {
  const db = openDb(':memory:'); migrate(db); t.after(() => db.close());
  db.prepare("INSERT INTO accounts (id,kind,name,inst) VALUES ('solo','retirement','Solo 401(k)','Sample Custodian'), ('sep','retirement','SEP IRA','Sample Custodian')").run();
  const data = base();
  data.accounts = db.prepare('SELECT * FROM accounts').all();
  let p = prepare(db, data);
  assert.equal(getFacts(db)['accounts.planType']?.solo, 'solo_401k');
  assert.equal(getFacts(db)['accounts.planType']?.sep, 'sep_ira');
  assert.equal(readInput({ db, clock }).facts['accounts.planType'].solo, 'solo_401k');
  db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('solo','2026-10-31',18000)").run();
  const netWorth = await callTool('accounts', { operation: 'net_worth', accounts: ['solo'], groupBy: 'treatment' }, { db, clock });
  assert.equal(netWorth.groups[0].key, 'pretax');
  assert.ok(!netWorth.gaps.some(g => g.code === 'missing_fact'));
  const source = db.prepare("SELECT parser,locator FROM facts WHERE key='accounts.planTypeInferred'").get();
  assert.equal(source.parser, 'derive');
  assert.ok(JSON.parse(source.locator).rows.some(r => r.table === 'accounts' && r.id === 'solo'));
  assert.ok(p.assumptions.some(a => a.key === 'accounts.planType' && a.path[0] === 'solo' && /account|institution/i.test(a.evidence)));
  assert.equal(prepareRecFacts(db, data).write(), 0);
  await answer(db, 'accounts.separationDate', { solo: '2026-04-01' });
  assert.equal(getFacts(db)['accounts.separationDate'].solo, '2026-04-01');
  await answer(db, 'accounts.planType', { sep: 'traditional_ira' });
  p = prepare(db, data);
  assert.deepEqual(getFacts(db)['accounts.planType'], { solo: 'solo_401k', sep: 'traditional_ira' });
  assert.ok(!p.assumptions.some(a => a.key === 'accounts.planType' && a.path[0] === 'sep'));
  await answer(db, 'accounts.planTypeInference', { solo: { undone: true } });
  p = prepare(db, data);
  assert.equal(getFacts(db)['accounts.planType']?.solo, undefined);
  assert.equal(questionFor(['accounts.planType'], { accounts: data.accounts, facts: p.values }).answered, false);
  await answer(db, 'accounts.planType', { solo: '401k' });
  assert.equal(prepare(db, data).values['accounts.planType'].solo, '401k');
});

test('answering another account stores only owner answers and leaves inferred plan Undo effective', async t => {
  const db = openDb(':memory:'); migrate(db); t.after(() => db.close());
  db.prepare("INSERT INTO accounts (id,kind,name) VALUES ('a','retirement','Solo 401(k)'), ('b','retirement','Retirement savings')").run();
  const data = base();
  data.accounts = db.prepare('SELECT * FROM accounts').all();
  prepare(db, data);
  assert.equal(getFacts(db)['accounts.planType'].a, 'solo_401k');
  await answer(db, 'accounts.planType', { b: '401k' });
  const stored = db.prepare("SELECT value,confirmed FROM facts WHERE key='accounts.planType'").get();
  assert.deepEqual(JSON.parse(stored.value), { b: '401k' });
  assert.equal(stored.confirmed, 1);
  await answer(db, 'accounts.planTypeInference', { a: { undone: true } });
  assert.deepEqual(getFacts(db)['accounts.planType'], { b: '401k' });
  prepare(db, data);
  assert.deepEqual(getFacts(db)['accounts.planType'], { b: '401k' });
});

test('recognizable plan names infer plain choices while ambiguous accounts remain gaps', t => {
  const db = openDb(':memory:'); migrate(db); t.after(() => db.close());
  const data = base();
  data.accounts = [
    { id: 'rollover', name: 'Rollover IRA', kind: 'retirement' },
    { id: 'roth', name: 'Roth IRA', kind: 'ira' },
    { id: 'work', name: 'Workplace 401(k)', kind: 'retirement' },
    { id: 'institution', name: '', inst: 'Sample Custodian Individual 401(k)', kind: 'retirement' },
    { id: 'cash', name: 'Solo 401(k)', kind: 'checking' },
    { id: 'ambiguous', name: 'Retirement savings', inst: 'Sample Custodian', kind: 'retirement' },
  ];
  const p = prepare(db, data);
  assert.equal(p.values['accounts.planType']?.rollover, 'traditional_ira');
  assert.equal(p.values['accounts.planType']?.roth, 'roth_ira');
  assert.equal(p.values['accounts.planType']?.work, '401k');
  assert.equal(p.values['accounts.planType']?.ambiguous, undefined);
  assert.equal(p.values['accounts.planType']?.institution, 'solo_401k');
  assert.equal(p.values['accounts.planType']?.cash, undefined);
  assert.ok(answerShape('accounts.planType').choices.every(c => !c.label.includes('_')));
  data.accounts = [];
  prepare(db, data);
  assert.equal(getFacts(db)['accounts.planType']?.work, undefined);
});

test('no other-plan records means a labelled zero assumption that Undo does not reinstate', async t => {
  const db = openDb(':memory:'); migrate(db); t.after(() => db.close());
  upsertFact(db, { key: 'business.entities', value: [entity], src: 'you', confirmed: true });
  const data = base();
  let p = prepare(db, data);
  assert.deepEqual(p.values['retirement.otherPlanDeferrals'], { owner: { deferral: 0, catchUp: 0 } });
  const loc = JSON.parse(db.prepare("SELECT locator FROM facts WHERE key='retirement.otherPlanDeferralsInferred'").get().locator);
  assert.equal(loc.assumption, true);
  const assumption = p.assumptions.find(a => a.key === 'retirement.otherPlanDeferrals');
  assert.ok(assumption?.evidence.includes('Assumption:'));
  await answer(db, assumption.undoKey, { owner: { undone: true } });
  assert.equal(prepare(db, data).values['retirement.otherPlanDeferrals']?.owner, undefined);
  await answer(db, 'retirement.otherPlanDeferrals', { owner: { deferral: 4000, catchUp: 0 } });
  assert.equal(prepare(db, data).values['retirement.otherPlanDeferrals'].owner.deferral, 4000);
});

test('prior-year P&L officer salary supplies sponsor wages, with row provenance and W-2 priority', () => {
  const data = base();
  data.pnlHistory = [
    { id: 1, entity: entity.name, period: '2025-02', category: 'Officer salary', amount: -43000, file_id: 'prior-pnl' },
    { id: 2, entity: entity.name, period: '2025-09', category: 'Officer salary', amount: -44000, file_id: 'prior-pnl' },
    { id: 3, entity: entity.name, period: '2026-02', category: 'Officer salary', amount: -55000 },
    { id: 4, entity: 'Other business', period: '2025-02', category: 'Officer salary', amount: -11000 },
  ];
  let facts = deriveRecFacts(data, {}, { entities: [entity] });
  assert.deepEqual(facts['retirement.priorYearFicaWages']?.value, { owner: 87000 });
  assert.deepEqual(facts['retirement.priorYearFicaWages'].provenance.locator.rows.map(r => r.id), [1, 2]);
  assert.equal(facts['retirement.priorYearFicaWages'].provenance.fileId, 'prior-pnl');
  data.documents = [{ id: 5, docType: 'w2', taxYear: 2025, fields: { employerName: entity.name, socialSecurityWages: 81000 } }];
  data.confirm = [{ kind: 'employer_recipient', subject: nameKey(entity.name), status: 'answered', answer: 'owner' }];
  facts = deriveRecFacts(data, {}, { entities: [entity] });
  assert.deepEqual(facts['retirement.priorYearFicaWages'].value, { owner: 81000 });
  data.documents = [];
  data.pnlHistory = [];
  assert.equal(deriveRecFacts(data, {}, { entities: [entity] })['retirement.priorYearFicaWages'], undefined);
});

test('production planner builds the salary game with pending advisor assumptions and a salary-range fix', async () => {
  const s = scratch('dmw-t1-');
  try {
    const db = await s.store({ variant: { entities: [SCORP], facts: {
      'retirement.planTermsConfirmed': undefined, 'retirement.aggregationConfirmed': undefined,
      'household.birthYears': { owner: 1971 }, 'household.filingStatus': 'single',
    } } });
    const account = db.prepare("SELECT id FROM accounts WHERE kind='retirement'").get();
    db.prepare("UPDATE accounts SET name='Solo 401(k)' WHERE id=?").run(account.id);
    await addFile(db, pnlWorkbook([SCORP], [], { year: 2025, months: 12 }));
    await planRun(db);
    let scenario = buildScenario(db);
    assert.equal(getFacts(db)['accounts.planType'][account.id], 'solo_401k');
    assert.equal(getFacts(db)['retirement.priorYearFicaWages'].owner, 60000);
    assert.deepEqual(getFacts(db)['retirement.otherPlanDeferrals'].owner, { deferral: 0, catchUp: 0 });
    assert.ok(scenario.wargame.salary?.points.length > 1, JSON.stringify(scenario.wargame.notBuilt));
    assert.match(scenario.wargame.salary.takeaway, /plan terms.*pending/i);
    assert.match(scenario.wargame.salary.takeaway, /related business.*pending/i);
    const point = scenario.wargame.salary.points[0];
    assert.ok(scenario.fig[`wg.salary.${point.id}.x`].notes.some(n => /pending/i.test(n)));
    const rec = scenario.recs.find(r => r.assumptions?.some(a => a.key === 'accounts.planType'));
    assert.ok(rec);
    answersView.bind({ esc: x => String(x ?? '').replaceAll('<', '&lt;'), snoozeLabel: () => 'Later' });
    assert.match(answersView.html(rec, 'plan'), /data-default-undo/);
    await answerFacts(db, [{ key: 'retirement.otherPlanDeferralsDefault', value: { owner: { undone: true } } }], { now: `${clock}T12:00:00Z`, replan: () => planRun(db) });
    scenario = buildScenario(db);
    assert.ok(scenario.wargame.salary.unavailable);
    await answerFacts(db, [{ key: 'retirement.otherPlanDeferrals', value: { owner: { deferral: 0, catchUp: 0 } } }], { now: `${clock}T12:00:00Z`, replan: () => planRun(db) });
    assert.ok(!buildScenario(db).wargame.salary.unavailable);
    db.prepare("DELETE FROM facts WHERE key='business.salaryRange'").run();
    db.prepare("DELETE FROM content WHERE key='wargame'").run();
    await planRun(db);
    scenario = buildScenario(db);
    assert.equal(getFacts(db)['business.salaryRange'], undefined);
    assert.equal(scenario.wargame.notBuilt.salary.code, 'business.salaryRange');
    assert.match(scenario.wargame.notBuilt.salary.text, /salary range/i);
    assert.equal(scenario.wargame.notBuilt.salary.fix.key, 'business.salaryRange');
    assert.equal(scenario.wargame.notBuilt.salary.fix.screen, 'ask');
    assert.match(gapControl(scenario.wargame.notBuilt.salary.fix, x => String(x)), /Enter salary range/);
    const fixRec = scenario.recs.find(r => r.id === 'scorp-salary');
    assert.ok(fixRec.advisorQuestions.includes('business.salaryRange'));
    const data = loadPlanningData(db, clock);
    assert.ok(resolveEntities(data, getFacts(db)).some(e => e.type === 's_corp'));
  } finally { s.cleanup(); }
});

test('outside-plan evidence prevents a zero assumption and owner sponsor wages take precedence', t => {
  const db = openDb(':memory:'); migrate(db); t.after(() => db.close());
  upsertFact(db, { key: 'business.entities', value: [entity], src: 'you', confirmed: true });
  const data = base();
  data.documents = [{ id: 1, docType: 'w2', taxYear: 2026, fields: { employerName: 'Outside Employer', wages: 75000, medicareWages: 75000, socialSecurityWages: 75000, box12: [{ code: 'D', amount: 6000 }] } }];
  data.confirm = [{ kind: 'employer_recipient', subject: nameKey('Outside Employer'), status: 'answered', answer: 'owner' }];
  let p = prepare(db, data);
  assert.equal(p.values['retirement.otherPlanDeferrals'].owner.deferral, 6000);
  assert.ok(!p.assumptions.some(a => a.key === 'retirement.otherPlanDeferrals'));
  data.documents[0].fields.box12 = undefined;
  p = prepare(db, data);
  assert.equal(p.values['retirement.otherPlanDeferrals'], undefined);
  data.documents = []; data.confirm = [];
  upsertFact(db, { key: 'retirement.contributions', value: [{ person: 'owner', plan: 'outside-401k', type: 'deferral', amount: 2000 }], src: 'you', confirmed: true });
  assert.equal(prepare(db, data).values['retirement.otherPlanDeferrals'], undefined);
  data.pnlHistory = [{ id: 1, entity: entity.name, period: '2025-12', category: 'Officer salary', amount: -60000 }];
  upsertFact(db, { key: 'retirement.priorYearFicaWages', value: { owner: 80000 }, src: 'you', confirmed: false });
  assert.equal(prepare(db, data).values['retirement.priorYearFicaWages'].owner, 80000);
  db.prepare("DELETE FROM facts WHERE key='retirement.priorYearFicaWages'").run();
  assert.equal(prepare(db, data).values['retirement.priorYearFicaWages'].owner, 60000);
  data.pnlHistory = [];
  prepare(db, data);
  assert.equal(getFacts(db)['retirement.priorYearFicaWages'], undefined);
});

test('one person answering deferrals does not turn the other person assumption into an owner answer', async t => {
  const db = openDb(':memory:'); migrate(db); t.after(() => db.close());
  upsertFact(db, { key: 'business.entities', value: [entity], src: 'you', confirmed: true });
  upsertFact(db, { key: 'household.birthYears', value: { owner: 1980, spouse: 1982 }, src: 'you', confirmed: true });
  const data = base();
  prepare(db, data);
  await answer(db, 'retirement.otherPlanDeferrals', { owner: { deferral: 4000, catchUp: 0 } });
  let p = prepare(db, data);
  assert.deepEqual(getFacts(db)['retirement.otherPlanDeferrals'], { spouse: { deferral: 0, catchUp: 0 }, owner: { deferral: 4000, catchUp: 0 } });
  assert.ok(p.assumptions.some(a => a.key === 'retirement.otherPlanDeferrals' && a.path[0] === 'spouse'));
  assert.ok(!p.assumptions.some(a => a.key === 'retirement.otherPlanDeferrals' && a.path[0] === 'owner'));
  await answer(db, 'retirement.otherPlanDeferralsDefault', { spouse: { undone: true } });
  p = prepare(db, data);
  assert.equal(p.values['retirement.otherPlanDeferrals'].spouse, undefined);
  assert.equal(p.values['retirement.otherPlanDeferrals'].owner.deferral, 4000);
});

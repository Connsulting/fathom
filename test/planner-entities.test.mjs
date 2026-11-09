import test from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore, closeRealStore, addFact, addPayroll, w2Doc } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { loadPlanningData, resolveEntities } from '../src/jobs/planner/data.mjs';
import { prepareRecFacts } from '../src/facts/derive.mjs';
import { computeFigures } from '../src/jobs/planner/figures.mjs';
import { personalSummaryInput } from '../src/spending/summaries.mjs';
import { items, stepOf } from '../src/jobs/triggers/missing-data.mjs';
import { taxGap } from '../src/shared/tax-gaps.mjs';

const clock = '2026-11-05';
const tabs = [["Aster's Summary", 'owner', 28, 14, 79, 7], ['Birch Summary', 'spouse', 20, 12, 51, 4]];
const personal = ['Medical', 'Healthcare', 'Shopping', 'Groceries', 'HSA', 'Dining', 'Restaurants',
  'Food', 'Entertainment', 'Clothing', 'Personal care', 'Childcare', 'Pets', 'Household'];
const other = ['Mortgage', 'Utilities', 'Insurance', 'Education', 'Subscriptions', 'Gifts',
  'Charity', 'Debt payment', 'Savings', 'Repairs', 'Fuel', 'Fees'];

async function fixture(t, { manual = [] } = {}) {
  const s = scratch('named-summary-');
  const db = await createRealStore(s.dir());
  t.after(async () => { await closeRealStore(db); await s.cleanup(); });
  for (const [key, value] of Object.entries({
    'household.names': { owner: 'Aster', spouse: 'Birch' },
    'household.filingStatus': 'mfj', 'household.state': 'VA',
    'household.birthYears': { owner: 1985, spouse: 1986 },
    'income.sCorp': true, 'business.entities': [{ name: 'Example Studio', type: 's_corp', owner: 'owner' }, ...manual],
  })) await addFact(db, key, value);
  const insert = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount,locator) VALUES (?,?,?,?,?)');
  for (const [name, , count, spending, lines, months] of tabs) {
    const categories = ['Wages', 'Interest income', ...personal.slice(0, spending), ...other.slice(0, count - spending - 2)];
    for (let i = 0; i < lines; i++) {
      const category = categories[i % categories.length];
      const month = String(11 - months + i % months).padStart(2, '0');
      await insert.run(name, `2026-${month}`, category, i % categories.length < 2 ? 1000 : -30, JSON.stringify({ sheet: name }));
    }
  }
  for (const [category, amount] of [['Income', 9000], ['Officer salary', -2000]]) {
    await insert.run('Example Studio', '2026-10', category, amount, JSON.stringify({ sheet: 'Example Studio' }));
  }
  return db;
}

async function productionPattern(db) {
  const insert = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount,locator) VALUES (?,?,?,?,?)');
  for (const [name, person, count, spending, lines, months] of tabs) {
    await db.prepare('DELETE FROM pnl_lines WHERE entity=?').run(name);
    const rows = person === 'owner'
      ? [['Venmo credits', ['04', '05', '06', '07'], 1000], ['Zelle credits', ['10'], 1000]]
      : [['Wages', ['07', '08', '09', '10'], 1000], ['Glim', ['07', '08', '09'], 100]];
    const expenses = [...personal.slice(0, spending), ...other.slice(0, count - spending - 2)];
    const entries = rows.flatMap(([category, periods, amount]) => periods.map(month => [month, category, amount]));
    for (let i = 0; entries.length < lines; i++) entries.push([String(11 - months + i % months).padStart(2, '0'), expenses[i % expenses.length], -30]);
    for (const [month, category, amount] of entries) await insert.run(name, `2026-${month}`, category, amount, JSON.stringify({ sheet: name }));
  }
}


const classifySteps = async db => (await buildScenario(db)).recs.find(r => r.id === 'missing-data')?.tasks.filter(t => t.code?.startsWith('entity_unclassified:')) || [];
const taxKeys = async db => (await db.prepare("SELECT key FROM figures WHERE key LIKE 'tax.%' OR key LIKE 'sh.%' OR key='agi.est' ORDER BY key").all()).map(r => r.key);
const entityCodes = info => [...info.blocked, ...(info.heldReasons || []), ...info.gaps.map(g => g.code), ...Object.values(info.wargameInvalid)].filter(c => c?.startsWith('entity_unclassified:'));
const signature = entities => entities.map(e => [e.name, e.type, e.classified, !!e.payrollEmployer]);

for (const [state, setup, expected] of [
  ['classified', async db => await addFact(db, 'business.entities', [
    ...(await getFacts(db))['business.entities'], ...tabs.map(([name, owner]) => ({ name, owner, type: 'personal' })),
  ]), 0],
  ['inferred personal summary', async db => await productionPattern(db), 0],
  ['unclassified payroll employer', async db => {
    await addFact(db, 'income.sCorp', false);
    await addPayroll(db, w2Doc({ person: 'spouse', relation: 'household', employerName: 'Pending Payroll',
      wages: 12000, medicareWages: 12000, socialSecurityWages: 12000, box12: [] }));
  }, 1],
  ['unclassified non-payroll', async db => {
    await db.prepare("INSERT INTO pnl_lines(entity,period,category,amount) VALUES ('Pending Studio','2026-10','Revenue',2500)").run();
  }, 1],
]) test(`SUM1c: planner and read-side entities agree for ${state}`, async t => {
  const db = await fixture(t);
  await setup(db);
  await planRun(db, { now: clock });
  const data = await loadPlanningData(db, clock), facts = await getFacts(db);
  const prepared = await prepareRecFacts(db, data);
  const entities = resolveEntities(data, facts);
  assert.deepEqual(signature(resolveEntities(data, prepared.values)), signature(entities));
  assert.equal(entities.filter(e => !e.classified).length, expected);
  if (state === 'unclassified payroll employer') assert.ok(entities.some(e => e.name === 'Pending Payroll' && e.payrollEmployer));
  assert.equal((await classifySteps(db)).length, expected);
  const out = computeFigures(data, facts, { clock, entities: resolveEntities(data, facts), owner: facts });
  if (!expected) assert.deepEqual(entityCodes(out.info), []);
});

test('SUM1c: a populated plan drops old classification steps after personal inference', async t => {
  const db = await fixture(t);
  await productionPattern(db);
  await addFact(db, 'business.entityInference', Object.fromEntries(tabs.map(([name]) => [name, { undone: true }])));
  await planRun(db, { now: clock });
  const before = { taxFigures: (await taxKeys(db)).length, missingSteps: (await buildScenario(db)).recs.find(r => r.id === 'missing-data').tasks.length };
  const old = JSON.parse((await db.prepare("SELECT def FROM recs WHERE id='missing-data'").get()).def);
  const step = old.tasks.find(t => t.code?.startsWith('entity_unclassified:'));
  assert.ok(step);
  // Reproduce a persisted pre-dedupe recommendation with optional and required slug steps.
  old.tasks.push({ ...step, code: 'entity_unclassified:birch-summary', optional: false });
  await db.prepare("UPDATE recs SET def=? WHERE id='missing-data'").run(JSON.stringify(old));
  await addFact(db, 'business.entityInference', { [tabs[1][0]]: { undone: true } });
  await planRun(db, { now: clock });
  assert.equal((await classifySteps(db)).length, 1, 'one remaining business cannot retain a second slug step');
  await addFact(db, 'business.entityInference', {});
  await planRun(db, { now: clock });
  const data = await loadPlanningData(db, clock), facts = await getFacts(db);
  assert.deepEqual(resolveEntities(data, facts).map(e => e.name), ['Example Studio']);
  assert.equal(personalSummaryInput(data, facts, data.categoryInput).lines.length, 130);
  const computed = computeFigures(data, facts, { clock, entities: resolveEntities(data, facts), owner: facts });
  assert.deepEqual(entityCodes(computed.info), []);
  assert.ok((await taxKeys(db)).length >= before.taxFigures);
  assert.ok((await taxKeys(db)).includes('tax.fed.proj'));
  const after = { taxFigures: (await taxKeys(db)).length, missingSteps: (await buildScenario(db)).recs.find(r => r.id === 'missing-data').tasks.length };
  t.diagnostic(JSON.stringify({ before, after, classifySteps: (await classifySteps(db)).length }));
  assert.equal((await classifySteps(db)).length, 0);
  await planRun(db, { now: clock });
  assert.equal((await classifySteps(db)).length, 0);
});

test('SUM1c: optional gaps, held payroll and blocked business reasons produce one classify step', () => {
  const entities = [{ name: 'Pending Studio', slug: 'pending-studio', classified: false },
    { name: 'Pending Payroll', slug: 'pending-payroll', classified: false, payrollEmployer: true }];
  for (const blocked of [[], ['entity_unclassified:pending-studio']]) {
    const ctx = { facts: {}, entities, data: { pnl: [], accounts: [] }, warnings: [], freshness: [],
      info: { blocked, heldReasons: ['entity_unclassified:pending-payroll'],
        gaps: entities.map(e => taxGap(`entity_unclassified:${e.slug}`, { employer: e.name })) } };
    const tasks = items(ctx).map(stepOf).filter(t => t.code?.startsWith('entity_unclassified:'));
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].t, /Pending Studio/);
    assert.match(tasks[0].t, /Pending Payroll/);
  }
});

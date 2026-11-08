import test from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore, closeRealStore, addFact, factRow } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { recordFactAnswers } from '../src/facts/answers.mjs';
import { loadPlanningData } from '../src/jobs/planner/data.mjs';
import { personalSummaryInput } from '../src/spending/summaries.mjs';
import { looksLikeSpending } from '../src/pnl/ledgers.mjs';

const clock = '2026-11-05';
const tabs = [["Aster's Summary", 'owner', 28, 14, 79, 7], ['Birch Summary', 'spouse', 20, 12, 51, 4]];
const personal = ['Medical', 'Healthcare', 'Shopping', 'Groceries', 'HSA', 'Dining', 'Restaurants',
  'Food', 'Entertainment', 'Clothing', 'Personal care', 'Childcare', 'Pets', 'Household'];
const other = ['Mortgage', 'Utilities', 'Insurance', 'Education', 'Subscriptions', 'Gifts',
  'Charity', 'Debt payment', 'Savings', 'Repairs', 'Fuel', 'Fees'];

async function fixture(t, { manual = [] } = {}) {
  const s = scratch('named-summary-');
  const db = await createRealStore(s.dir());
  t.after(() => { closeRealStore(db); s.cleanup(); });
  for (const [key, value] of Object.entries({
    'household.names': { owner: 'Aster', spouse: 'Birch' },
    'household.filingStatus': 'mfj', 'household.state': 'VA',
    'household.birthYears': { owner: 1985, spouse: 1986 },
    'income.sCorp': true, 'business.entities': [{ name: 'Example Studio', type: 's_corp', owner: 'owner' }, ...manual],
  })) addFact(db, key, value);
  const insert = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount,locator) VALUES (?,?,?,?,?)');
  for (const [name, , count, spending, lines, months] of tabs) {
    const categories = ['Wages', 'Interest income', ...personal.slice(0, spending), ...other.slice(0, count - spending - 2)];
    for (let i = 0; i < lines; i++) {
      const category = categories[i % categories.length];
      const month = String(11 - months + i % months).padStart(2, '0');
      insert.run(name, `2026-${month}`, category, i % categories.length < 2 ? 1000 : -30, JSON.stringify({ sheet: name }));
    }
  }
  for (const [category, amount] of [['Income', 9000], ['Officer salary', -2000]]) {
    insert.run('Example Studio', '2026-10', category, amount, JSON.stringify({ sheet: 'Example Studio' }));
  }
  return db;
}

const questions = db => buildScenario(db).recs.find(r => r.id === 'missing-data')?.tasks.filter(t => t.kind === 'classify') || [];
const summaries = db => {
  const data = loadPlanningData(db, clock);
  return personalSummaryInput(data, getFacts(db), data.categoryInput).lines;
};

test('SUM1b AC1: mixed named tabs infer personal ownership, evidence and Undo and enter summary aggregation', async t => {
  const db = await fixture(t);
  assert.equal(getFacts(db)['pnl.ledgers'], undefined);
  assert.equal(getFacts(db)['pnl.ledgersInferred'], undefined);
  for (const [name, , count, spending, lines, months] of tabs) {
    const rows = db.prepare('SELECT * FROM pnl_lines WHERE entity=?').all(name);
    assert.equal(rows.length, lines);
    assert.equal(new Set(rows.map(l => l.category)).size, count);
    assert.equal(new Set(rows.map(l => l.period)).size, months);
    assert.equal(new Set(rows.filter(l => personal.includes(l.category)).map(l => l.category)).size, spending);
    assert.equal(new Set(rows.filter(l => l.amount > 0).map(l => l.category)).size, 2);
    if (spending * 2 === count) assert.equal(looksLikeSpending({ name, lines: rows }, getFacts(db)), false);
  }
  const result = await planRun(db);
  assert.ok(!result.warnings.includes('entity_unclassified'));
  assert.equal(questions(db).length, 0);
  const row = factRow(db, 'business.entities');
  assert.match(row.src, /inferred/);
  for (const [name, person, , , lines] of tabs) {
    const entry = row.value.find(e => e.name === name);
    assert.equal(entry?.type, 'personal');
    assert.equal(entry.owner, person);
    assert.equal(entry.personSource, 'household_names');
    assert.equal(entry.inferred, true);
    assert.equal(entry.evidence.rule, `Per-person summary for ${person === 'owner' ? 'you' : 'your spouse'}: personal income and household spending by month.`);
    const assumption = buildScenario(db).recs.flatMap(r => r.assumptions || []).find(a => a.key === 'business.entities' && a.path[0] === name);
    assert.equal(assumption?.undoKey, 'business.entityInference');
    assert.equal(summaries(db).filter(l => l.person === person).length, lines);
  }
});

test('SUM1b AC2: a named tab with consulting fees stays unclassified with one question', async t => {
  const db = await fixture(t);
  db.prepare("UPDATE pnl_lines SET category='Consulting fees' WHERE entity=? AND category='Wages'").run(tabs[0][0]);
  const result = await planRun(db);
  assert.ok(result.warnings.includes('entity_unclassified'));
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === tabs[0][0]));
  assert.equal(questions(db).length, 1);
  assert.match(questions(db)[0].t, /Aster/);
  assert.ok(!summaries(db).some(l => l.person === 'owner'));
});

test('SUM1b AC3: inference Undo returns the named tab to unclassified through later plans', async t => {
  const db = await fixture(t);
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === tabs[0][0])?.type, 'personal');
  const assumption = buildScenario(db).recs.flatMap(r => r.assumptions || []).find(a => a.key === 'business.entities' && a.path[0] === tabs[0][0]);
  recordFactAnswers(db, [{ key: assumption.undoKey, value: { [tabs[0][0]]: { undone: true } } }], { now: clock });
  for (let i = 0; i < 2; i++) {
    const result = await planRun(db);
    assert.ok(result.warnings.includes('entity_unclassified'));
    assert.ok(!getFacts(db)['business.entities'].some(e => e.name === tabs[0][0]));
    assert.equal(questions(db).length, 1);
    assert.ok(!summaries(db).some(l => l.person === 'owner'));
    assert.equal(summaries(db).filter(l => l.person === 'spouse').length, 51);
  }
});

test('SUM1b AC4: an owner business classification survives named-summary inference', async t => {
  const manual = { name: tabs[0][0], type: 'sole_prop', owner: 'spouse' };
  const db = await fixture(t, { manual: [manual] });
  await planRun(db);
  assert.deepEqual(getFacts(db)['business.entities'].find(e => e.name === manual.name), manual);
  assert.ok(!summaries(db).some(l => l.person === 'owner'));
  assert.equal(summaries(db).filter(l => l.person === 'spouse').length, 51);
});

test('SUM1b: exactly one third household categories qualify before inactive inference', async t => {
  const db = await fixture(t);
  const insert = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount) VALUES (?,\'2025-01\',?,-10)');
  for (let i = 0; i < 14; i++) insert.run(tabs[0][0], `Other expense ${i}`);
  db.prepare("UPDATE pnl_lines SET period='2025-01' WHERE entity=?").run(tabs[0][0]);
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === tabs[0][0])?.type, 'personal');
  assert.equal(summaries(db).filter(l => l.person === 'owner').length, 93);
});

test('SUM1b: named-summary inference requires household attribution, personal income and enough household categories', async t => {
  for (const [label, change] of [
    ['unknown person', db => addFact(db, 'household.names', { owner: 'Cedar', spouse: 'Birch' })],
    ['ambiguous person', db => addFact(db, 'household.names', { owner: 'Aster', spouse: 'Aster' })],
    ['owner answer only', db => {
      addFact(db, 'household.names', { owner: 'Cedar', spouse: 'Birch' });
      addFact(db, 'pnl.people', { [tabs[0][0]]: 'owner' });
    }],
    ['non-income positive total', db => db.prepare("UPDATE pnl_lines SET amount=100 WHERE entity=? AND category='Mortgage'").run(tabs[0][0])],
    ['officer expense', db => db.prepare("UPDATE pnl_lines SET category='Officer salary' WHERE entity=? AND category='Mortgage'").run(tabs[0][0])],
    ['below one third', db => {
      const insert = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount) VALUES (?,\'2026-10\',?,-10)');
      for (let i = 0; i < 15; i++) insert.run(tabs[0][0], `Other expense ${i}`);
    }],
    ['owner ledger classification', db => addFact(db, 'pnl.ledgers', { [tabs[0][0]]: { kind: 'business' } })],
    ['linked business account', db => {
      db.prepare("INSERT INTO accounts(id,name,kind,owner,parser) VALUES ('linked','Business checking','business','You','aggregator')").run();
      addFact(db, 'accounts.businessEntity', { linked: tabs[0][0] });
      db.prepare("INSERT INTO transactions(account_id,date,amount,category,parser) VALUES ('linked','2026-10-15',-30,'Software','aggregator')").run();
    }],
  ]) await t.test(label, async t => {
    const db = await fixture(t);
    change(db);
    await planRun(db);
    assert.ok(!getFacts(db)['business.entities'].some(e => e.name === tabs[0][0] && e.type === 'personal'));
    assert.equal(questions(db).length, 1);
  });
});

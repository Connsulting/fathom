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
import { callTool } from '../src/tools/index.mjs';
import { businessPnl } from '../src/pnl/index.mjs';

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

function productionPattern(db) {
  const insert = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount,locator) VALUES (?,?,?,?,?)');
  for (const [name, person, count, spending, lines, months] of tabs) {
    db.prepare('DELETE FROM pnl_lines WHERE entity=?').run(name);
    const rows = person === 'owner'
      ? [['Venmo credits', ['04', '05', '06', '07'], 1000], ['Zelle credits', ['10'], 1000]]
      : [['Wages', ['07', '08', '09', '10'], 1000], ['Glim', ['07', '08', '09'], 100]];
    const expenses = [...personal.slice(0, spending), ...other.slice(0, count - spending - 2)];
    const entries = rows.flatMap(([category, periods, amount]) => periods.map(month => [month, category, amount]));
    for (let i = 0; entries.length < lines; i++) entries.push([String(11 - months + i % months).padStart(2, '0'), expenses[i % expenses.length], -30]);
    for (const [month, category, amount] of entries) insert.run(name, `2026-${month}`, category, amount, JSON.stringify({ sheet: name }));
  }
}

const income = db => callTool('spending', { operation: 'total', measure: 'income', from: '2026-04', to: '2026-10', groupBy: 'category' }, { db, clock });

test('SUM1b amendment: production-shaped transfers are excluded and one unknown income has provenance and inference Undo', async t => {
  const db = await fixture(t);
  productionPattern(db);
  for (const [name, , count, spending, lines, months] of tabs) {
    const rows = db.prepare('SELECT * FROM pnl_lines WHERE entity=?').all(name);
    assert.equal(rows.length, lines);
    assert.equal(new Set(rows.map(l => l.category)).size, count);
    assert.equal(new Set(rows.map(l => l.period)).size, months);
    assert.equal(new Set(rows.filter(l => personal.includes(l.category)).map(l => l.category)).size, spending);
    assert.equal(looksLikeSpending({ name, lines: rows }, getFacts(db)), false);
  }
  for (const [category, count] of [['Venmo credits', 4], ['Zelle credits', 1], ['Glim', 3]]) {
    assert.equal(db.prepare('SELECT count(DISTINCT period) n FROM pnl_lines WHERE category=? AND amount>0').get(category).n, count);
  }
  const result = await planRun(db);
  assert.ok(!result.warnings.includes('entity_unclassified'));
  assert.equal(questions(db).length, 0);
  const rows = summaries(db);
  assert.equal(rows.length, 130);
  const transfers = rows.filter(l => /Venmo|Zelle/.test(l.category));
  assert.equal(transfers.length, 5);
  assert.ok(transfers.every(l => l.bucket === 'transfer' && l.income === false));
  assert.equal(rows.filter(l => l.person === 'spouse' && l.income).reduce((n, l) => n + l.amount, 0), 4300);
  const stated = "Counted Glim as your spouse's other income from the summary sheet";
  const total = await income(db);
  assert.equal(total.total.value, 4300);
  assert.equal(total.byPerson.find(p => p.person === 'owner'), undefined);
  const assumption = total.total.provenance.assumptions.find(a => a.stated === stated);
  assert.equal(assumption?.undoKey, 'business.entityInference');
  assert.deepEqual(assumption.path, [tabs[1][0]]);
  assert.equal(total.groups.find(g => g.key === 'Glim').figure.value, 300);
  const cash = await callTool('spending', { operation: 'cash_flow', from: '2026-04', to: '2026-10' }, { db, clock });
  assert.equal(cash.totals.household.inflow.value, 4300);
  assert.ok(cash.totals.household.inflow.provenance.assumptions.some(a => a.stated === stated));
  const scenario = buildScenario(db);
  assert.equal(scenario.fig['inc.ytd.summary-owner'], undefined);
  assert.equal(scenario.fig['inc.ytd.summary-spouse'].v, 4300);
  assert.equal(scenario.fig['inc.ytd.total'].v, 13300);
  assert.ok(scenario.fig['inc.ytd.summary-spouse'].notes.includes(stated));
  assert.ok(scenario.fig['inc.ytd.total'].notes.includes(stated));
  const ownerView = businessPnl({ db, entity: tabs[0][0], from: '2026-04', to: '2026-10', clock });
  assert.equal(ownerView.income.total, null);
  const spouseView = businessPnl({ db, entity: tabs[1][0], from: '2026-04', to: '2026-10', clock });
  assert.equal(spouseView.figures[spouseView.income.total].v, 4300);
  assert.ok(spouseView.figures[spouseView.income.total].notes.includes(stated));
  assert.ok(scenario.recs.flatMap(r => r.assumptions || []).some(a => a.undoKey === assumption.undoKey && a.path[0] === tabs[1][0] && a.evidence.includes(stated)));
  recordFactAnswers(db, [{ key: assumption.undoKey, value: Object.fromEntries(tabs.map(([name]) => [name, { undone: true }])) }], { now: clock });
  for (let i = 0; i < 2; i++) {
    await planRun(db);
    assert.equal(summaries(db).length, 0);
    assert.equal((await income(db)).total.value, 0);
    assert.equal(buildScenario(db).fig['inc.ytd.summary-spouse'], undefined);
  }
});

test('SUM1b amendment: two unknown positive categories keep one classification question', async t => {
  const db = await fixture(t);
  productionPattern(db);
  db.prepare("UPDATE pnl_lines SET category='Tarn' WHERE entity=? AND category='Wages'").run(tabs[1][0]);
  const result = await planRun(db);
  assert.ok(result.warnings.includes('entity_unclassified'));
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === tabs[1][0]));
  assert.equal(questions(db).length, 1);
  assert.ok(!summaries(db).some(l => l.person === 'spouse'));
  assert.equal((await income(db)).total.value, 0);
});

test('SUM1b amendment: transfer buckets and transfer-name variants do not consume the unknown-income allowance', async t => {
  const db = await fixture(t);
  productionPattern(db);
  const rows = db.prepare('SELECT id FROM pnl_lines WHERE entity=? AND amount>0 ORDER BY id').all(tabs[0][0]);
  for (const [i, category] of ['Credit Card Payment', 'PayPal credits', 'Inbound transfer', 'VENMO credits', 'Zelle credits'].entries()) {
    db.prepare('UPDATE pnl_lines SET category=? WHERE id=?').run(category, rows[i].id);
  }
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === tabs[0][0])?.type, 'personal');
  assert.ok(summaries(db).filter(l => l.person === 'owner' && l.amount > 0).every(l => l.bucket === 'transfer' && !l.income));
  assert.equal((await income(db)).total.value, 4300);
});

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
    ['two non-income positive totals', db => db.prepare("UPDATE pnl_lines SET amount=100 WHERE entity=? AND category IN ('Mortgage','Utilities')").run(tabs[0][0])],
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

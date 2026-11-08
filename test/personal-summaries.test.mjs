import test from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore, closeRealStore, addFact, addPayroll, w2Doc, paystubDoc, householdOf } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { recordFactAnswers } from '../src/facts/answers.mjs';
import { householdSpending, householdSpendingRows } from '../src/pnl/index.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate } from '../src/api/handlers.mjs';

const clock = '2026-11-05';
const period = { from: '2026-08', to: '2026-10' };
async function fixture(t, { bank = [], manual = [] } = {}) {
  const s = scratch('summary-');
  const db = await createRealStore(s.dir());
  t.after(() => { closeRealStore(db); s.cleanup(); });
  for (const [key, value] of Object.entries({
    'household.names': { owner: 'Aster', spouse: 'Birch' },
    'household.filingStatus': 'mfj', 'household.state': 'VA',
    'household.birthYears': { owner: 1985, spouse: 1986 },
    'income.sCorp': true, 'business.entities': [{ name: 'Example Studio', type: 's_corp', owner: 'owner' }, ...manual],
  })) addFact(db, key, value);
  db.prepare("INSERT INTO files(id,name,uploaded_at,status) VALUES ('summary-book','Synthetic household workbook.xlsx',?,'imported')").run(clock);
  const insert = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount,file_id,locator) VALUES (?,?,?,?,?,?)');
  for (const month of ['08', '09', '10']) {
    for (const [entity, sheet, categories] of [
      ['Example Studio', 'Example Studio', [['Income', 9000], ['Officer salary', -2000]]],
      ["Aster's Summary", "Aster's Summary", [['Wages', 1000], ['Groceries', -100], ['Medical', -40], ['Shopping', -60]]],
      ['Birch Summary', 'Birch Summary', [['Income', 800], ['Groceries', -70], ['Medical', -30], ['Shopping', -50]]],
    ]) for (const [category, amount] of categories) insert.run(entity, `2026-${month}`, category, amount, 'summary-book', JSON.stringify({ sheet, row: 2, column: month }));
  }
  db.prepare("INSERT INTO accounts(id,name,kind,owner,parser) VALUES ('owner-card','Personal card','card','You','aggregator')").run();
  for (const [month, category, amount, owner = 'You'] of bank) {
    const id = owner === 'Your spouse' ? 'spouse-card' : owner === 'Joint' ? 'joint-card' : 'owner-card';
    db.prepare("INSERT OR IGNORE INTO accounts(id,name,kind,owner,parser) VALUES (?,?,'card',?,'aggregator')").run(id, id, owner);
    db.prepare('INSERT INTO transactions(account_id,date,amount,category,parser) VALUES (?,?,?,?,?)').run(id, `2026-${month}-15`, amount, category, 'aggregator');
  }
  const ctx = { db, clock, now: `${clock}T12:00:00Z`, actorId: 'synthetic-owner', replan: () => planRun(db) };
  const total = (measure = 'spending', args = {}) => callTool('spending', { operation: 'total', ...period, measure, ...args }, ctx);
  return { db, ctx, total };
}

test('AC1/AC2: named mixed summaries infer their people with evidence and Undo, feed tools and household figures', async t => {
  const { db, total } = await fixture(t);
  await planRun(db);
  const listed = getFacts(db)['business.entities'];
  for (const [name, person] of [["Aster's Summary", 'owner'], ['Birch Summary', 'spouse']]) {
    const entry = listed.find(e => e.name === name);
    assert.equal(entry.type, 'personal');
    assert.equal(entry.owner, person);
    assert.equal(entry.inferred, true);
    assert.equal(entry.evidence.lineCount, 12);
    assert.ok(!JSON.stringify(entry.evidence).includes('800'));
  }
  const scenario = buildScenario(db);
  const missing = scenario.recs.find(r => r.id === 'missing-data');
  assert.ok(!missing?.tasks.some(task => ['business_unclassified', 'pnl_people_unknown'].includes(task.code)));
  assert.ok(scenario.recs.some(r => r.assumptions?.some(a => a.key === 'business.entities' && a.path[0] === 'Birch Summary')));
  const spending = await total();
  assert.equal(spending.total.value, 1050);
  assert.equal(spending.byPerson.find(p => p.person === 'spouse').total.value, 450);
  assert.ok(spending.total.provenance.sources.some(s => s.table === 'pnl_lines' && s.sheets.includes('Birch Summary')));
  assert.match(spending.total.provenance.formula, /spreadsheet summary for months without bank data/);
  const income = await total('income');
  assert.equal(income.total.value, 5400);
  assert.equal(income.byPerson.find(p => p.person === 'spouse').total.value, 2400);
  assert.equal(scenario.fig['inc.ytd.summary-spouse'].v, 2400);
  assert.equal(scenario.fig['inc.ytd.total'].v, 32400);
  assert.equal(scenario.fig['cash.monthlyOut'].v, 350);
  const view = householdSpending({ db, ...period, clock });
  assert.equal(view.figures[view.total].v, spending.total.value);
  assert.equal(view.figures[view.total].src, 'spend:workbook');
  const detail = householdSpendingRows({ db, ...period, clock, bucket: 'household', category: 'Groceries' });
  assert.equal(detail.total, 6);
  assert.ok(detail.items.every(i => i.kind === 'workbook'));
  const cash = await callTool('spending', { operation: 'cash_flow', ...period }, { db, clock });
  assert.equal(cash.totals.household.outflow.value, spending.total.value);
  assert.equal(cash.totals.household.inflow.value, income.total.value);
  recordFactAnswers(db, [{ key: 'business.entityInference', value: { 'Birch Summary': { undone: true } } }], { now: clock });
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === 'Birch Summary'));
  assert.equal((await total()).byPerson.find(p => p.person === 'spouse'), undefined);
});

test('AC3: bank coverage wins only for the covered person, month and category', async t => {
  const cases = [
    ['no bank', [], 1050, 600, 450],
    ['one overlapping category', [['08', 'Groceries', -25]], 975, 525, 450],
    ['all months one category', ['08', '09', '10'].map(m => [m, 'Groceries', -25]), 825, 375, 450],
    ['different category', [['08', 'Dining', -25]], 1075, 625, 450],
    ['other person', [['08', 'Groceries', -25, 'Your spouse']], 1005, 600, 405],
    ['joint coverage', [['08', 'Groceries', -25, 'Joint']], 905, 500, 380],
    ['income does not cover spending', [['08', 'Income', 1000]], 1050, 600, 450],
    ['outside month', [['07', 'Groceries', -25]], 1050, 600, 450],
    ['refund is category coverage', [['08', 'Groceries', 10]], 950, 500, 450],
  ];
  for (const [label, bank, expected, owner, spouse] of cases) await t.test(label, async t => {
    const { db, total } = await fixture(t, { bank });
    await planRun(db);
    const result = await total();
    assert.equal(result.total.value, expected);
    assert.equal(result.byPerson.find(p => p.person === 'owner').total.value, owner);
    assert.equal(result.byPerson.find(p => p.person === 'spouse').total.value, spouse);
    const joint = result.byPerson.find(p => p.person === 'joint')?.total.value ?? 0;
    assert.equal(owner + spouse + joint, expected);
    const view = householdSpending({ db, ...period, clock });
    assert.equal(view.figures[view.total].v, expected - (label.startsWith('refund') ? 10 : 0));
    assert.equal(buildScenario(db).fig['cash.monthlyOut'].v, Math.round(expected / 3 * 100) / 100);
  });
});

test('AC4: a W-2 replaces the same person summary wages without dropping the spouse income', async t => {
  const { db, total } = await fixture(t);
  await addPayroll(db, w2Doc({ person: 'owner', relation: 'outside', employerName: 'Synthetic Employer', wages: 12000, medicareWages: 12000, socialSecurityWages: 12000, box12: [] }));
  await planRun(db);
  const scenario = buildScenario(db);
  assert.ok(!scenario.fig['inc.ytd.summary-owner']);
  assert.equal(scenario.fig['inc.ytd.summary-spouse'].v, 2400);
  assert.equal(scenario.fig['inc.ytd.total'].v, 41400);
  const result = await total('income', { from: '2026-01', to: '2026-12' });
  assert.equal(result.total.value, 14400);
  assert.ok(result.byPerson.find(p => p.person === 'owner').total.provenance.sources.some(s => s.table === 'documents'));
  const partial = await total('income');
  assert.equal(partial.total.value, 2400);
  assert.ok(partial.gaps.some(g => g.detail === 'payroll_period_unallocated'));
});

test('AC4: paystub YTD covers through its month and the summary fills later months', async t => {
  const { db, total } = await fixture(t);
  await addPayroll(db, paystubDoc({ person: 'owner', relation: 'outside', employerName: 'Synthetic Employer', payDate: '2026-08-31', ytdGross: 8000, gross: 1000, periodStart: '2026-08-01', periodEnd: '2026-08-31' }));
  await planRun(db);
  const scenario = buildScenario(db);
  assert.equal(scenario.fig['inc.ytd.summary-owner'].v, 2000);
  assert.equal(scenario.fig['inc.ytd.summary-spouse'].v, 2400);
  const result = await total('income', { from: '2026-01', to: '2026-10' });
  assert.equal(result.total.value, 12400);
});

test('AC5: owner classifications win over summary signals across repeated planning', async t => {
  const { db, total } = await fixture(t, { manual: [{ name: "Aster's Summary", type: 'sole_prop', owner: 'spouse' }] });
  await planRun(db);
  await planRun(db);
  const entry = getFacts(db)['business.entities'].find(e => e.name === "Aster's Summary");
  assert.deepEqual(entry, { name: "Aster's Summary", type: 'sole_prop', owner: 'spouse' });
  assert.equal((await total()).total.value, 450);
});

test('Ask reads per-person figures and delivers sheet provenance through its registered spending tool', async t => {
  const { db, ctx } = await fixture(t, { bank: [['08', 'Groceries', -25]] });
  await planRun(db);
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
    ? Promise.resolve({ text: 'Household summaries', toolResults: [] })
    : transport.call({ ...request, fake: [
      { toolCalls: [{ name: 'spending', args: { operation: 'total', ...period, measure: 'spending' } }] },
      { text: "Your spouse spent $450 from the Birch Summary sheet. You spent $525, using connected transactions first and the spreadsheet summary for months without bank data." },
    ] }) };
  const household = householdOf(db), root = household.root;
  const answerer = createLiveAnswerer({ engine, root, services: { ...household.services, engine, config: { dataDir: root } } });
  const out = await threadCreate({ db, config: { clock }, identity: { id: ctx.actorId }, answerer,
    body: { text: 'How much did each of us spend from August through October, and where did it come from?' } });
  assert.match(out.message.text, /\$450.*Birch Summary/);
  assert.match(out.message.text, /\$525/);
  assert.ok(out.message.provenance.tools.some(c => c.name === 'spending' && !c.isError));
});

test('sheet and transaction detail figures keep independent row identities', async t => {
  const { db } = await fixture(t, { bank: [['08', 'Groceries', -25]] });
  await planRun(db);
  const line = db.prepare("SELECT id FROM pnl_lines WHERE entity='Birch Summary' AND category='Groceries' LIMIT 1").get();
  db.prepare('UPDATE transactions SET id=?').run(line.id);
  const detail = householdSpendingRows({ db, ...period, clock, bucket: 'household', category: 'Groceries' });
  assert.equal(new Set(detail.items.map(i => i.fig)).size, detail.items.length);
  for (const item of detail.items) assert.equal(detail.figures[item.fig].v, item.value);
});

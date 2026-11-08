import test from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore, closeRealStore, addFact, householdOf, factRow, figureRow, addPayroll } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { recordFactAnswers, FactAnswerError } from '../src/facts/answers.mjs';
import { callTool } from '../src/tools/index.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate, proposalDecide } from '../src/api/handlers.mjs';
import { writePreference } from '../src/actions/preferences.mjs';
import { loadPlanningData, resolveEntities } from '../src/jobs/planner/data.mjs';
import { pnlEntities, businessPnl, businessPnlRows } from '../src/pnl/index.mjs';

const now = '2026-11-05T12:00:00Z';
async function store(t) {
  const s = scratch('inference-');
  const db = await createRealStore(s.dir());
  t.after(() => { closeRealStore(db); s.cleanup(); });
  const ctx = { db, clock: now.slice(0, 10), now, actorId: 'synthetic-owner', replan: () => planRun(db) };
  return { db, ctx };
}
function entities(db, count = 1) {
  addFact(db, 'income.sCorp', true);
  addFact(db, 'household.filingStatus', 'single');
  addFact(db, 'household.state', 'VA');
  addFact(db, 'tax.vaItemizedEstimate', 0);
  addFact(db, 'household.birthYears', { owner: 1985 });
  addFact(db, 'business.entities', []);
  const line = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount) VALUES (?,?,?,?)');
  for (let m = 1; m <= 10; m++) {
    const period = `2026-${String(m).padStart(2, '0')}`;
    for (const name of ['Family card', 'Household ledger']) {
      for (const category of ['Groceries', 'Medical', 'Shopping']) line.run(name, period, category, -180);
    }
    for (let n = 0; n < count; n++) {
      const name = n ? 'Second Studio' : 'Example Studio';
      line.run(name, period, 'Income', 18000);
      line.run(name, period, 'Officer salary', -4000);
      line.run(name, period, 'Payroll taxes', -306);
    }
  }
}
function loan(db, { months = 12, matched = true, escrow = 0 } = {}) {
  const account = db.prepare("INSERT INTO accounts(id,inst,name,kind) VALUES (?, 'Example lender', ?, ?)");
  account.run('cash', 'Checking', 'checking');
  account.run('loan', 'Example home mortgage', 'loan');
  account.run('card', 'Credit card', 'card');
  let balance = 20000;
  const rate = 0.048, payment = 900;
  const snapshot = db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)');
  const tx = db.prepare('INSERT INTO transactions(account_id,date,amount,category,description) VALUES (?,?,?,?,?)');
  const classify = id => db.prepare("INSERT INTO transaction_category_corrections(transaction_id,category,bucket,updated_at) VALUES (?,'Mortgage','household',?)").run(id, now);
  snapshot.run('loan', '2025-10-31', -balance);
  for (let m = 0; m < months; m++) {
    const end = new Date(Date.UTC(2025, 11 + m, 0)).toISOString().slice(0, 10);
    balance = Math.round((balance * (1 + rate / 12) - payment) * 100) / 100;
    snapshot.run('loan', end, -balance);
    const date = `${end.slice(0, 7)}-15`;
    if (matched) {
      classify(tx.run('cash', date, -payment - escrow, 'Mortgage', 'Example home mortgage payment').lastInsertRowid);
      tx.run('loan', date, payment, 'Internal Transfers', 'Loan payment');
    }
    classify(tx.run('cash', date, -2100, 'Mortgage', 'Credit card payment').lastInsertRowid);
    tx.run('card', date, 2100, 'Credit Card Payment', 'Card payment');
  }
  return { balance, payment, rate };
}

function budgetAndBusiness(db, { named = true, knownPeople = true } = {}) {
  addFact(db, 'income.sCorp', true);
  if (knownPeople) addFact(db, 'household.names', { owner: 'Aster', spouse: 'Birch' });
  addFact(db, 'household.filingStatus', 'single');
  addFact(db, 'household.state', 'VA');
  addFact(db, 'tax.vaItemizedEstimate', 0);
  addFact(db, 'household.birthYears', { owner: 1985 });
  addFact(db, 'business.entities', []);
  const line = db.prepare('INSERT INTO pnl_lines(entity,period,category,amount,parser,locator) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 22; i++) {
    const period = new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7);
    for (const person of ['Aster', 'Birch']) {
      for (const category of ['Income', 'Groceries', 'Medical', 'Shopping']) line.run(person, period, category, category === 'Income' ? 2500 : -300,
        i % 2 ? 'retired-format' : null, JSON.stringify({ sheet: `${person} Expenses` }));
    }
  }
  for (const period of ['2025-01', '2025-02', '2025-03']) {
    line.run('Former Studio', period, 'Client income', 4000, 'retired-format', null);
  }
  db.prepare("INSERT INTO files(id,name,uploaded_at,status) VALUES ('budget-current','Synthetic household budget.xlsx',?,'imported'),('budget-history','Synthetic personal budget history.xlsx',?,'imported')").run(now, now);
  db.prepare("UPDATE pnl_lines SET file_id=CASE WHEN period<'2026-01' THEN 'budget-history' ELSE 'budget-current' END").run();
  db.prepare("INSERT INTO accounts(id,name,kind,parser) VALUES ('business-cash','Business checking','business','aggregator')").run();
  if (named) addFact(db, 'accounts.businessEntity', { 'business-cash': 'Current Studio' });
  for (let m = 1; m <= 10; m++) {
    const date = `2026-${String(m).padStart(2, '0')}-15`;
    db.prepare("INSERT INTO transactions(account_id,date,amount,category,description,parser) VALUES ('business-cash',?,12000,'Income','Client payment','aggregator')").run(date);
    db.prepare("INSERT INTO transactions(account_id,date,amount,category,description,parser) VALUES ('business-cash',?,-1000,'Business','Operating expense','aggregator')").run(date);
  }
}

test('AC9/AC10/AC11: personal budget tabs and an inactive past business leave the account-backed S corp as the current business', async t => {
  const { db, ctx } = await store(t);
  budgetAndBusiness(db);
  const rawBefore = db.prepare('SELECT * FROM pnl_lines ORDER BY id').all();
  await planRun(db);
  const listed = getFacts(db)['business.entities'];
  assert.equal(listed.find(e => e.name === 'Aster').type, 'personal');
  assert.equal(listed.find(e => e.name === 'Birch').type, 'personal');
  assert.equal(listed.find(e => e.name === 'Aster').owner, 'owner');
  assert.equal(listed.find(e => e.name === 'Birch').owner, 'spouse');
  assert.equal(listed.find(e => e.name === 'Former Studio').type, 'income_history');
  assert.equal(listed.find(e => e.name === 'Former Studio').owner, 'owner');
  assert.equal(listed.find(e => e.name === 'Current Studio').type, 's_corp');
  assert.deepEqual(listed.find(e => e.name === 'Current Studio').accountIds, ['business-cash']);
  const model = resolveEntities(loadPlanningData(db, '2026-11-05'), getFacts(db));
  assert.deepEqual(model.map(e => e.name), ['Current Studio']);
  const business = await callTool('business', { operation: 'pnl' }, ctx);
  assert.deepEqual(business.entities.map(e => e.entity.label), ['Current Studio']);
  assert.equal(business.totals.profit.value, 110000);
  const views = pnlEntities({ db, clock: '2026-11-05' });
  assert.ok(views.filter(e => ['Aster', 'Birch'].includes(e.label)).every(e => e.kind === 'spending'));
  assert.equal(views.find(e => e.label === 'Aster').person, 'owner');
  assert.equal(views.find(e => e.label === 'Birch').person, 'spouse');
  assert.equal(views.find(e => e.label === 'Former Studio').kind, 'income_history');
  assert.equal(views.find(e => e.label === 'Former Studio').person, 'owner');
  assert.equal(views.find(e => e.label === 'Former Studio').inactive, true);
  const history = businessPnl({ db, entity: 'Former Studio', clock: '2026-11-05' });
  assert.equal(history.from, '2025-01');
  assert.equal(history.to, '2025-03');
  assert.equal(history.figures[history.income.total].v, 12000);
  const spouse = businessPnl({ db, entity: 'entity:birch', from: '2025-01', to: '2026-10', clock: '2026-11-05' });
  assert.equal(spouse.figures[spouse.income.total].v, 55000);
  assert.equal(spouse.figures[spouse.expenses.total].v, 19800);
  const spouseRows = businessPnlRows({ db, entity: 'entity:birch', from: '2025-01', to: '2026-10', section: 'income', category: 'Income', clock: '2026-11-05' });
  assert.equal(spouseRows.items.length, 22);
  assert.deepEqual(db.prepare('SELECT * FROM pnl_lines ORDER BY id').all(), rawBefore, 'classification never rewrites or drops personal or income-history rows');
  const scenario = buildScenario(db);
  assert.equal(scenario.fig['pnl.current-studio.net'].v, 110000);
  assert.equal(figureRow(db, 'pnl.current-studio.net').locator.rows.table, 'transactions');
  assert.ok(!scenario.fig['pnl.former-studio.net']);
  assert.ok(!scenario.fig['pnl.aster.net']);
  assert.equal(scenario.wargame.notBuilt.salary.code, 'business.salaryRange');
  const rec = scenario.recs.find(r => r.assumptions?.some(a => a.key === 'business.entities' && a.path[0] === 'Former Studio'));
  assert.ok(rec);
  recordFactAnswers(db, [{ key: 'business.entityInference', value: { 'Current Studio': { undone: true } } }], { now });
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === 'Current Studio'), 'account-backed S corp inference is undoable');
  recordFactAnswers(db, [{ key: 'business.entities', value: [{ name: 'Current Studio', type: 's_corp' }] }], { now });
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Current Studio').inferred, undefined, 'owner classification wins after Undo');
  recordFactAnswers(db, [{ key: 'business.entityInference', value: { 'Former Studio': { undone: true } } }], { now });
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === 'Former Studio'));
  recordFactAnswers(db, [{ key: 'business.entities', value: [{ name: 'Former Studio', type: 'sole_prop' }] }], { now });
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Former Studio').type, 'sole_prop');
});

test('unclear personal attribution asks once, accepts an owner answer with Undo, and never merges summaries into connected-account totals', async t => {
  const { db, ctx } = await store(t);
  budgetAndBusiness(db, { knownPeople: false });
  db.prepare("INSERT INTO accounts(id,name,kind,owner,parser) VALUES ('personal-cash','Personal checking','checking','You','aggregator')").run();
  for (const month of ['08', '09', '10']) db.prepare("INSERT INTO transactions(account_id,date,amount,category,parser) VALUES ('personal-cash',?,-90,'Groceries','aggregator')").run(`2026-${month}-15`);
  const selection = { operation: 'total', from: '2026-08', to: '2026-10' };
  const before = await callTool('spending', selection, ctx);
  await planRun(db);
  let scenario = buildScenario(db);
  const questions = scenario.recs.find(r => r.id === 'missing-data').tasks.filter(t => t.code === 'pnl_people_unknown');
  assert.equal(questions.length, 1);
  assert.match(questions[0].t, /Aster.*Birch/);
  assert.equal(pnlEntities({ db, clock: '2026-11-05' }).find(e => e.label === 'Birch').person, null);
  const text = 'Aster is my summary and Birch is my spouse\'s summary';
  const out = await callTool('answer', { operation: 'fact', key: 'pnl.people', value: { Aster: 'owner', Birch: 'spouse' }, evidence: text }, { ...ctx, ownerText: text });
  assert.ok(out.receipt);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Birch').owner, 'spouse');
  scenario = buildScenario(db);
  assert.ok(!scenario.recs.find(r => r.id === 'missing-data')?.tasks.some(t => t.code === 'pnl_people_unknown' && !t.done));
  const after = await callTool('spending', selection, ctx);
  assert.equal(after.total.value, before.total.value);
  assert.equal(after.total.value, 270, 'only the connected account contributes to household spending');
  await callTool('undo', { operation: 'undo', id: out.receipt.id }, { ...ctx, scopes: ['write:facts'], channel: 'mcp' });
  assert.equal(pnlEntities({ db, clock: '2026-11-05' }).find(e => e.label === 'Birch').person, null);
  assert.ok(buildScenario(db).recs.find(r => r.id === 'missing-data').tasks.some(t => t.code === 'pnl_people_unknown'));
});

test('an unnamed account-backed S corp asks once for its business name, then uses the answer and preserves the receipt Undo', async t => {
  const { db, ctx } = await store(t);
  budgetAndBusiness(db, { named: false });
  await planRun(db);
  let scenario = buildScenario(db);
  const question = scenario.recs.find(r => r.id === 'missing-data').question;
  assert.ok(question.keys.includes('accounts.businessEntity'));
  assert.equal(question.fields.filter(f => f.key === 'accounts.businessEntity' && f.value === undefined).length, 1);
  assert.match(scenario.wargame.notBuilt.salary.text, /business name/i);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.type === 's_corp'));
  const text = 'My business name is Current Studio';
  const out = await callTool('answer', { operation: 'fact', key: 'accounts.businessEntity', value: { 'business-cash': 'Current Studio' }, evidence: text }, { ...ctx, ownerText: text });
  assert.ok(out.receipt);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Current Studio').type, 's_corp');
  scenario = buildScenario(db);
  assert.equal(scenario.wargame.notBuilt.salary.code, 'business.salaryRange');
  await callTool('undo', { operation: 'undo', id: out.receipt.id }, { ...ctx, scopes: ['write:facts'], channel: 'mcp' });
  assert.ok(!getFacts(db)['accounts.businessEntity']);
  assert.ok(buildScenario(db).recs.find(r => r.id === 'missing-data').question.keys.includes('accounts.businessEntity'));
});

test('an owner-provided entity name grounds the account-backed business name across replanning and classification Undo', async t => {
  const { db } = await store(t);
  budgetAndBusiness(db, { named: false });
  addFact(db, 'business.entities', [{ name: 'Known Studio', owner: 'owner' }]);
  await planRun(db);
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Known Studio')?.type, 's_corp');
  assert.ok(!buildScenario(db).recs.some(r => r.question?.keys.includes('accounts.businessEntity')));
  recordFactAnswers(db, [{ key: 'business.entityInference', value: { 'Known Studio': { undone: true } } }], { now });
  await planRun(db);
  assert.deepEqual(getFacts(db)['business.entities'].find(e => e.name === 'Known Studio'), { name: 'Known Studio', owner: 'owner' });
});

test('AC1: planner infers personal ledgers and the sole S corp with evidence, Undo and the real salary unlock', async t => {
  const { db, ctx } = await store(t);
  entities(db);
  await planRun(db);
  const row = factRow(db, 'business.entities');
  const types = Object.fromEntries(row.value.map(e => [e.name, e.type]));
  assert.deepEqual(types, { 'Family card': 'personal', 'Household ledger': 'personal', 'Example Studio': 's_corp' });
  assert.match(row.src, /inferred/);
  assert.ok(row.locator.rows.every(r => !Object.hasOwn(r, 'amount')));
  assert.ok(row.value.every(e => e.inferred && e.evidence.lineCount > 0 && e.evidence.kinds.length));
  const business = await callTool('business', { operation: 'pnl' }, ctx);
  assert.deepEqual(business.entities.map(e => e.entity.label), ['Example Studio']);
  assert.equal(business.totals.profit.value, 136940);
  const scenario = buildScenario(db);
  assert.equal(scenario.wargame.notBuilt.salary.code, 'business.salaryRange');
  assert.match(scenario.wargame.notBuilt.salary.text, /advisor.*salary range/i);
  const recs = scenario.recs;
  assert.ok(!JSON.stringify(recs).includes('entity_unclassified:'));
  const assumption = recs.flatMap(r => r.assumptions || []).find(a => a.key === 'business.entities' && a.path[0] === 'Example Studio');
  assert.ok(assumption, 'inference is visible beside the existing Undo control');
  assert.match(assumption.evidence, /Not right\? Tell Fathom/);
  recordFactAnswers(db, [{ key: assumption.undoKey, value: { 'Example Studio': { undone: true } } }], { now });
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === 'Example Studio'));
  assert.match(buildScenario(db).wargame.notBuilt.salary.text, /Example Studio.*classif|classif.*Example Studio/i);
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === 'Example Studio'), 'Undo survives replanning');
});

test('owner classifications and corrections win while other entities can still be inferred', async t => {
  const { db } = await store(t);
  entities(db);
  addFact(db, 'business.entities', [{ name: 'Example Studio', type: 'sole_prop', owner: 'spouse' }]);
  await planRun(db);
  const list = getFacts(db)['business.entities'];
  assert.deepEqual(list.find(e => e.name === 'Example Studio'), { name: 'Example Studio', type: 'sole_prop', owner: 'spouse' });
  assert.equal(list.filter(e => e.type === 'personal').length, 2);
  recordFactAnswers(db, [{ key: 'business.entities', value: [{ name: 'Family card', type: 'sole_prop' }] }], { now });
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Family card').type, 'sole_prop');
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Example Studio').owner, 'spouse');
});

for (const count of [0, 2]) test(`AC5: ${count} S corp candidates produce one classification question without guessing an S corp`, async t => {
  const { db } = await store(t);
  entities(db, count);
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.type === 's_corp'));
  const scenario = buildScenario(db);
  const task = scenario.recs.find(r => r.id === 'missing-data').tasks.filter(t => t.kind === 'classify');
  assert.equal(task.length, 1);
  for (const text of ['S corp', 'sole proprietorship', 'partnership', 'personal spending', 'not mine']) assert.ok(task[0].t.includes(text), text);
  assert.ok(task[0].t.includes(count ? 'Example Studio' : 'Family card'));
  if (count) assert.ok(task[0].t.includes('Second Studio'));
  if (!count) assert.match(scenario.wargame.notBuilt.salary.text, /identify the S corp.*Family card/);
});

test('AC2: scripted Ask records an S corp classification with a receipt and exact Undo', async t => {
  const { db, ctx } = await store(t);
  const text = 'Example Studio is my S corp';
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
    ? Promise.resolve({ text: 'Business classification', toolResults: [] })
    : transport.call({ ...request, fake: [{ toolCalls: [{ name: 'answer', args: {
      operation: 'fact', key: 'business.entities', value: [{ name: 'Example Studio', type: 's_corp' }], evidence: text,
    } }] }, { text: 'Your business classification is saved.' }] }) };
  const root = householdOf(db).root;
  const answerer = createLiveAnswerer({ engine, root, services: { ...householdOf(db).services, engine, config: { dataDir: root } } });
  const out = await threadCreate({ db, config: {}, identity: { id: ctx.actorId }, scheduler: { runNow: () => planRun(db) }, answerer, body: { text } });
  assert.equal(getFacts(db)['business.entities'][0].type, 's_corp');
  const receipts = buildScenario(db).live.conversations[out.thread.key].flatMap(m => m.provenance?.actions || []);
  assert.equal(receipts.length, 1);
  await callTool('undo', { operation: 'undo', id: receipts[0].id }, { ...ctx, channel: 'mcp', scopes: ['write:facts'] });
  assert.equal(getFacts(db)['business.entities'], undefined);
  assert.throws(() => recordFactAnswers(db, [{ key: 'business.entities', value: [{ name: 'Example Studio', type: 'invented' }] }], { now }), FactAnswerError);
});

test('AC3/AC4: mortgage uses matched payments and balance snapshots, infers rate and payoff, and asks only escrow', async t => {
  const { db, ctx } = await store(t);
  const fixture = loan(db);
  const out = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  const row = out.obligations[0];
  assert.equal(row.observedMonthly.value, fixture.payment);
  assert.equal(row.monthly.value, fixture.payment);
  const debt = await callTool('spending', { operation: 'total', include: { classes: ['debt_service'] } }, ctx);
  assert.match(debt.perMonth.label, /All debt payments/);
  assert.ok(Math.abs(row.terms.rate.value - fixture.rate) < 0.00002, row.terms.rate.value);
  assert.equal(row.terms.balance.value, fixture.balance);
  assert.match(row.endDate.value, /^202[67]-/);
  assert.deepEqual(row.missing, ['obligations.mortgage.escrowMonthly']);
  assert.ok(out.gaps.every(g => /escrow/i.test(g.message)));
  assert.ok(row.endDate.provenance.assumptions.length);
  assert.ok(row.terms.rate.provenance.sources.some(s => s.table === 'balances'));
  assert.ok(row.monthly.provenance.sources.some(s => s.table === 'transactions'));
  assert.match(row.note, /inferred.*correct/i);
  await planRun(db);
  const question = buildScenario(db).recs.find(r => r.id === 'missing-data').question;
  const missingFields = question.fields.filter(f => f.key === 'obligations.mortgage' && f.value === undefined);
  assert.deepEqual(missingFields.map(f => f.path), [['escrowMonthly']]);
  assert.deepEqual(question.fields.filter(f => f.key === 'obligations.mortgage').map(f => f.path), [['escrowMonthly']], 'inferred values cannot be silently confirmed by submitting the missing escrow');
  recordFactAnswers(db, [{ key: 'obligations.mortgage', value: { escrowMonthly: 0 } }], { now });
  const complete = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  assert.deepEqual(complete.obligations[0].missing, []);
});

test('unmatched payments do not establish a mortgage or use all debt payments', async t => {
  const { db, ctx } = await store(t);
  loan(db, { months: 2, matched: false });
  const out = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  assert.equal(out.obligations.length, 0);
  assert.ok(out.gaps.some(g => /match.*payment/i.test(g.message)));
  const recent = await store(t);
  loan(recent.db, { months: 2 });
  const row = (await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, recent.ctx)).obligations[0];
  assert.equal(row.monthly.value, 900);
  assert.equal(row.terms.rate.value, null, 'a matched loan with too little history cannot establish a rate');
  assert.deepEqual(row.missing, ['obligations.mortgage.rate', 'obligations.mortgage.escrowMonthly']);
});

test('AC6/AC8: a paid-off mortgage memory overrides stale positive loan data throughout planner, Ask and projections', async t => {
  const { db, ctx } = await store(t);
  loan(db);
  addFact(db, 'obligations.mortgage', { balance: 19000, monthlyPayment: 1300 });
  await planRun(db);
  assert.ok(buildScenario(db).recs.some(r => r.question?.keys.includes('obligations.mortgage')));
  const text = 'Our mortgage is already paid off.';
  const memory = writePreference({ ...ctx, ownerText: text }, { text, evidence: text }, { fromAsk: true });
  const out = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  assert.equal(out.obligations.length, 0);
  assert.deepEqual(out.gaps, []);
  assert.equal(out.inactive[0].status, 'paid_off');
  assert.match(out.inactive[0].message, /mortgage is paid off/i);
  assert.ok(out.inactive[0].provenance.sources.some(s => s.table === 'preferences' && s.ids.includes(memory.preference.id)));
  const summary = await callTool('household', { operation: 'summary' }, ctx);
  assert.equal(summary.mortgage.status, 'paid_off');
  assert.deepEqual(summary.facts['obligations.mortgage'], { paidOff: true });
  assert.ok(!buildScenario(db).recs.some(r => r.question?.keys.includes('obligations.mortgage')), 'a saved memory clears an old payoff question immediately');
  await planRun(db);
  assert.ok(!buildScenario(db).recs.some(r => r.question?.keys.includes('obligations.mortgage')));
  const base = await callTool('spending', { operation: 'total', annualize: true }, ctx);
  const projection = await callTool('spending', { operation: 'projection', years: 3, obligations: ['mortgage'] }, ctx);
  assert.ok(projection.years.every(y => y.spending.value === base.total.value && !y.changes.some(c => c.kind === 'mortgage')));

  const calls = [], transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => {
    calls.push(request);
    return transport.call({ ...request, fake: [{ toolCalls: [{ name: 'spending', args: { operation: 'obligations', obligations: ['mortgage'] } }] },
      { text: 'Your mortgage is paid off. There is no mortgage obligation or future mortgage payoff to project. Other debt payments are not a mortgage payment.' }] });
  } };
  const reply = await createLiveAnswerer({ engine, root: householdOf(db).root, services: { ...householdOf(db).services, engine } })
    .answer({ db, key: 'ask:0123456789ab', text: 'When does our mortgage end?' });
  assert.match(reply.paragraphs.join(' '), /mortgage is paid off/i);
  assert.ok(calls.some(r => r.systemDynamic?.includes(text)), 'Ask receives the existing household memory');
  assert.ok(!/\$/.test(reply.paragraphs.join(' ')), 'no debt aggregate is quoted as a mortgage payment');
});

test('AC7: zero balances and a paid-off structured fact yield no mortgage obligation even with historical payments', async t => {
  const { db, ctx } = await store(t);
  loan(db);
  db.prepare("INSERT INTO balances(account_id,date,amount) VALUES ('loan','2026-11-04',0)").run();
  let out = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  assert.equal(out.obligations.length, 0);
  assert.deepEqual(out.gaps, []);
  await planRun(db);
  assert.ok(!buildScenario(db).recs.some(r => r.question?.keys.includes('obligations.mortgage')));
  db.prepare("DELETE FROM balances WHERE date='2026-11-04'").run();
  addFact(db, 'obligations.mortgage', { paidOff: true, balance: 18000, rate: 0.05, monthlyPayment: 1200 });
  out = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  assert.equal(out.obligations.length, 0);
  assert.equal(out.inactive[0].status, 'paid_off');
});

test('paid-off memory matching rejects negation, plans, questions and someone else\'s mortgage', async t => {
  const { db, ctx } = await store(t);
  loan(db);
  for (const text of ['Our mortgage is not paid off.', 'We plan to pay off our mortgage.', 'If our mortgage is paid off, we could retire.', 'Is our mortgage paid off?', "My parents' mortgage is paid off.", 'Our mortgage will be paid off next year.']) {
    db.prepare('DELETE FROM preferences').run();
    writePreference({ ...ctx, ownerText: text }, { text, evidence: text }, { fromAsk: true });
    assert.equal((await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx)).obligations.length, 1, text);
  }
  for (const text of ['The mortgage is paid off.', 'We have paid off our mortgage.', 'I paid off my mortgage.', 'Our mortgage was fully paid off in 2024.']) {
    db.prepare('DELETE FROM preferences').run();
    writePreference({ ...ctx, ownerText: text }, { text, evidence: text }, { fromAsk: true });
    assert.equal((await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx)).obligations.length, 0, text);
  }
});

test('projection removes only the mortgage portion, preserves other debts, and honors a selection excluding the loan', async t => {
  const { db, ctx } = await store(t);
  const fixture = loan(db);
  addFact(db, 'obligations.mortgage', { escrowMonthly: 0 });
  const base = await callTool('spending', { operation: 'total', annualize: true }, ctx);
  const projection = await callTool('spending', { operation: 'projection', years: 3, obligations: ['mortgage'] }, ctx);
  assert.equal(projection.years[2].spending.value, base.total.value - 12 * fixture.payment);
  assert.ok(base.total.value > 12 * fixture.payment, 'the fixture includes other debt spending');
  const selected = await callTool('spending', { operation: 'total', annualize: true, include: { merchants: ['Credit card payment'] } }, ctx);
  const excluding = await callTool('spending', { operation: 'projection', base: selected.total.ref, years: 3, obligations: ['mortgage'] }, ctx);
  assert.equal(excluding.years[2].spending.value, selected.total.value);
});

test('stated escrow and payment corrections override inferred mortgage terms and an ambiguous loan match asks instead', async t => {
  const { db, ctx } = await store(t);
  const fixture = loan(db, { escrow: 120 });
  recordFactAnswers(db, [{ key: 'obligations.mortgage', value: { escrowMonthly: 120 } }], { now });
  let row = (await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx)).obligations[0];
  assert.equal(row.monthly.value, fixture.payment + 120);
  assert.ok(Math.abs(row.terms.rate.value - fixture.rate) < 0.00002);
  assert.equal(row.changes[0].newMonthly.value, 120);
  recordFactAnswers(db, [{ key: 'obligations.mortgage', value: { monthlyPayment: 1200, rate: 0.03, balance: 12000 } }], { now });
  row = (await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx)).obligations[0];
  assert.equal(row.monthly.value, 1200);
  assert.equal(row.terms.rate.value, 0.03);
  assert.equal(row.terms.balance.value, 12000);
  db.prepare("DELETE FROM facts WHERE key='obligations.mortgage'").run();
  db.prepare("INSERT INTO accounts(id,name,kind) VALUES ('second-loan','Other home mortgage','loan')").run();
  const ambiguous = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  assert.equal(ambiguous.obligations.length, 1, 'a second loan without a positive balance is not an active mortgage candidate');
  db.prepare("INSERT INTO balances(account_id,date,amount) VALUES ('second-loan','2026-10-31',20000)").run();
  assert.equal((await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx)).obligations.length, 0);
});


test('AC15-AC19: one missing-data Ask proposal records owner S corp, spouse LLC and final-year partnership with ledger link and Undo', async t => {
  const { db, ctx } = await store(t);
  budgetAndBusiness(db, { named: false });
  await addPayroll(db, { docType: 'w2', fields: { taxYear: 2026, employerName: 'Current Studio', wages: 40000, medicareWages: 40000, federalWithheld: 4000, box12: [] }, recipient: 'owner', relation: 'household' });
  await planRun(db);
  const before = getFacts(db)['business.entities'];
  assert.match(JSON.stringify(buildScenario(db).recs), /does not match any business on file/);
  const text = "mine is an S-Corp, the spouse's is an LLC; the spouse left a K-1 partnership this year and has to file a final K-1.";
  const value = [
    { name: 'Current Studio', type: 's_corp', owner: 'owner', status: 'active', accountId: 'business-cash' },
    { name: 'Spouse LLC', type: 'llc_single', owner: 'spouse', status: 'active' },
    { name: 'Spouse partnership', type: 'partnership', owner: 'spouse', status: 'final_year', finalYear: 2026 },
  ];
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
    ? Promise.resolve({ text: 'Household businesses', toolResults: [] })
    : transport.call({ ...request, fake: [
      { toolCalls: [{ name: 'household', args: { operation: 'fact_shapes' } }, { name: 'household', args: { operation: 'summary' } }] },
      { toolCalls: [{ name: 'answer', args: { operation: 'fact', key: 'business.entities', value, evidence: text, propose: true } }] },
      { text: 'Record your S corp linked to business checking, your spouse’s single-member LLC taxed on Schedule C, and the partnership’s final year? Confirm below. Tell Fathom if the LLC has multiple members or a corporate tax election.' },
    ] }) };
  const root = householdOf(db).root;
  const answerer = createLiveAnswerer({ engine, root, services: { ...householdOf(db).services, engine, config: { dataDir: root } } });
  const api = { db, config: { clock: '2026-11-05' }, identity: { id: ctx.actorId }, scheduler: { runNow: () => planRun(db) }, answerer };
  const out = await threadCreate({ ...api, body: { recId: 'missing-data', text } });
  const pending = out.message.provenance.pendingAction;
  assert.deepEqual(pending.args.value, value);
  assert.deepEqual(getFacts(db)['business.entities'], before, 'proposal does not save before confirmation');
  assert.ok(out.message.provenance.tools.some(c => c.args.operation === 'fact_shapes' && !c.isError));
  const shapes = await callTool('household', { operation: 'fact_shapes' }, ctx);
  assert.ok(shapes['business.entities'].items.fields.status);
  assert.ok(shapes['business.entities'].items.fields.accountId);
  const saved = await proposalDecide({ ...api, params: { id: out.thread.id, messageId: out.message.id }, body: { decision: 'confirm' } });
  const listed = getFacts(db)['business.entities'];
  for (const entry of value) assert.deepEqual(listed.find(e => e.name === entry.name), entry);
  assert.equal(listed.find(e => e.name === 'Aster').type, 'personal');
  assert.equal(listed.find(e => e.name === 'Birch').type, 'personal');
  assert.deepEqual(pnlEntities({ db, clock: '2026-11-05' }).find(e => e.label === 'Current Studio').accounts.map(a => a.id), ['business-cash']);
  assert.ok(!JSON.stringify(saved.scenario.recs).includes('does not match any business on file'));
  const tasks = saved.scenario.recs.find(r => r.id === 'missing-data').tasks.filter(t => !t.done);
  assert.ok(tasks.some(t => /final K-1.*Spouse partnership|Spouse partnership.*final K-1/.test(t.t)));
  assert.ok(!tasks.some(t => /how (?:Aster|Birch) is taxed/i.test(t.t)));
  assert.ok(!tasks.some(t => t.kind === 'classify'));
  const receipt = saved.message.provenance.actions[0];
  await callTool('undo', { operation: 'undo', id: receipt.id }, { ...ctx, channel: 'mcp', scopes: ['write:facts'] });
  assert.deepEqual(getFacts(db)['business.entities'], before);
  assert.match(JSON.stringify(buildScenario(db).recs), /does not match any business on file/);
});

test('entity status and account links validate atomically without accepting missing final years or personal accounts', async t => {
  const { db } = await store(t);
  budgetAndBusiness(db);
  db.prepare("INSERT INTO accounts(id,name,kind) VALUES ('personal-account','Personal checking','checking')").run();
  for (const entry of [
    { name: 'Current Studio', type: 's_corp', accountId: 'personal-account' },
    { name: 'Past partnership', type: 'partnership', status: 'final_year' },
    { name: 'Past partnership', type: 'partnership', status: 'active', finalYear: 2026 },
    { name: 'Current Studio', type: 's_corp', accountId: 'missing-account' },
  ]) assert.throws(() => recordFactAnswers(db, [{ key: 'business.entities', value: [entry] }], { now }), FactAnswerError);
  recordFactAnswers(db, [{ key: 'business.entities', value: [{ name: 'Past partnership', type: 'partnership', owner: 'spouse', status: 'final_year', finalYear: 2025 }] }], { now });
  assert.ok(!resolveEntities(loadPlanningData(db, '2026-11-05'), getFacts(db)).some(e => e.name === 'Past partnership'), 'prior final years do not enter current business calculations');
  recordFactAnswers(db, [{ key: 'business.entities', value: [{ name: 'Final partnership', type: 'partnership', owner: 'spouse', status: 'final_year', finalYear: 2026 }] }], { now });
  assert.ok(resolveEntities(loadPlanningData(db, '2027-01-10'), getFacts(db)).some(e => e.name === 'Final partnership'), 'the final tax year remains in the filing-season plan');
});


test('an expense-only unmatched business account does not invent a second business or block a classified business', async t => {
  const { db } = await store(t);
  budgetAndBusiness(db);
  db.prepare("DELETE FROM transactions WHERE amount > 0").run();
  addFact(db, 'business.entities', [{ name: 'Actual Studio', type: 's_corp', owner: 'owner' }]);
  await planRun(db);
  const resolved = resolveEntities(loadPlanningData(db, '2026-11-05'), getFacts(db));
  assert.deepEqual(resolved.map(e => e.name), ['Actual Studio']);
});


test('synthetic household variants keep their account-backed ledger attached to the selected business', async t => {
  const s = scratch('inference-variant-');
  t.after(() => s.cleanup());
  const db = await s.store({ variant: { entities: [{ name: 'Replacement Studio', type: 'sole_prop', owner: 'owner', income: 5000, expenses: {} }] } });
  await planRun(db);
  const resolved = resolveEntities(loadPlanningData(db, '2026-11-05'), getFacts(db));
  assert.deepEqual(resolved.map(e => e.name), ['Replacement Studio']);
  assert.equal(resolved[0].type, 'sole_prop');
});


test('business evidence accepts stored ledger names but refuses invented names and final-year dates', async t => {
  const { db, ctx } = await store(t);
  budgetAndBusiness(db);
  const evidence = "mine is an S-Corp, the spouse's is an LLC; the spouse left a K-1 partnership this year and has to file a final K-1.";
  for (const value of [
    [{ name: 'Invented corporation', type: 's_corp', owner: 'owner' }],
    [{ name: 'Spouse partnership', type: 'partnership', owner: 'spouse', status: 'final_year', finalYear: 2027 }],
  ]) await assert.rejects(callTool('answer', { operation: 'fact', key: 'business.entities', value, evidence }, { ...ctx, channel: 'mcp', scopes: ['write:facts'], ownerText: evidence }), e => e.code === 'bad_input');
  const saved = await callTool('answer', { operation: 'fact', key: 'business.entities', value: [{ name: 'Current Studio', type: 's_corp', owner: 'owner', status: 'active', accountId: 'business-cash' }], evidence }, { ...ctx, channel: 'mcp', scopes: ['write:facts'], ownerText: evidence });
  assert.ok(saved.receipt);
});


for (const scorp of [true, false]) test(`AC20/AC21: a household payroll employer becomes an undoable business and tax projections run (S corp ${scorp})`, async t => {
  const { db, ctx } = await store(t);
  budgetAndBusiness(db, { named: false });
  addFact(db, 'income.sCorp', scorp);
  await addPayroll(db, { docType: 'w2', fields: { taxYear: 2026, employerName: 'Payroll Studio', wages: 40000, medicareWages: 40000, federalWithheld: 4000, box12: [] }, recipient: 'owner', relation: 'household' });
  await addPayroll(db, { docType: 'paystub', fields: { employerName: 'Payroll Studio', payDate: '2026-10-15', gross: 4000, ytdGross: 40000, federalWithholding: 400, retirementDeferral: 0, hsaDeferral: 0 }, recipient: 'owner', relation: 'household' });
  await planRun(db);
  const entity = getFacts(db)['business.entities'].find(e => e.name === 'Payroll Studio');
  assert.ok(entity, 'the known household employer creates the entity');
  assert.equal(entity.inferred, true);
  assert.equal(entity.owner, 'owner');
  assert.equal(entity.type, scorp ? 's_corp' : null);
  assert.equal(entity.accountId, 'business-cash');
  assert.ok(figureRow(db, 'agi.est'));
  assert.ok(figureRow(db, 'tax.fed.proj'));
  const scenario = buildScenario(db);
  assert.ok(!JSON.stringify(scenario.recs).includes('does not match any business on file'));
  assert.ok(!figureRow(db, 'agi.est').unavailable_reason);
  const questions = scenario.recs.find(r => r.id === 'missing-data')?.tasks.filter(t => !t.done && t.kind === 'classify') || [];
  assert.equal(questions.length, scorp ? 0 : 1);
  if (!scorp) {
    assert.match(questions[0].t, /Payroll Studio/);
    assert.match(JSON.stringify(figureRow(db, 'agi.est').locator), /pending.*tax|tax.*pending/i);
  }
  const rec = scenario.recs.find(r => r.assumptions?.some(a => a.key === 'business.entities' && a.path[0] === 'Payroll Studio'));
  assert.ok(rec, 'the inferred employer exposes Undo');
  recordFactAnswers(db, [{ key: 'business.entityInference', value: { 'Payroll Studio': { undone: true } } }], { now });
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.name === 'Payroll Studio'));
  recordFactAnswers(db, [{ key: 'business.entities', value: [{ name: 'Payroll Studio', type: 's_corp', owner: 'owner', accountId: 'business-cash' }] }], { now });
  await planRun(db);
  assert.equal(getFacts(db)['business.entities'].find(e => e.name === 'Payroll Studio').inferred, undefined);
});

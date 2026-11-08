import test from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore, closeRealStore, addFact, householdOf, factRow } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { recordFactAnswers, FactAnswerError } from '../src/facts/answers.mjs';
import { callTool } from '../src/tools/index.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate } from '../src/api/handlers.mjs';

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
  snapshot.run('loan', '2025-10-31', -balance);
  for (let m = 0; m < months; m++) {
    const end = new Date(Date.UTC(2025, 11 + m, 0)).toISOString().slice(0, 10);
    balance = Math.round((balance * (1 + rate / 12) - payment) * 100) / 100;
    snapshot.run('loan', end, -balance);
    const date = `${end.slice(0, 7)}-15`;
    if (matched) {
      tx.run('cash', date, -payment - escrow, 'Mortgage', 'Example home mortgage payment');
      tx.run('loan', date, payment, 'Internal Transfers', 'Loan payment');
    }
    tx.run('cash', date, -2100, 'Mortgage', 'Credit card payment');
    tx.run('card', date, 2100, 'Credit Card Payment', 'Card payment');
  }
  return { balance, payment, rate };
}

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
  if (!count) db.prepare("INSERT INTO pnl_lines(entity,period,category,amount) VALUES ('Unknown venture','2026-10','Rent',-10)").run();
  await planRun(db);
  assert.ok(!getFacts(db)['business.entities'].some(e => e.type === 's_corp'));
  const scenario = buildScenario(db);
  const task = scenario.recs.find(r => r.id === 'missing-data').tasks.filter(t => t.kind === 'classify');
  assert.equal(task.length, 1);
  for (const text of ['S corp', 'sole proprietorship', 'partnership', 'personal spending', 'not mine']) assert.ok(task[0].t.includes(text), text);
  assert.ok(task[0].t.includes(count ? 'Example Studio' : 'Unknown venture'));
  if (count) assert.ok(task[0].t.includes('Second Studio'));
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
  recordFactAnswers(db, [{ key: 'obligations.mortgage', value: { escrowMonthly: 0 } }], { now });
  const complete = await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx);
  assert.deepEqual(complete.obligations[0].missing, []);
});

test('unmatched payments and too little history ask for missing fields without using all debt payments', async t => {
  const { db, ctx } = await store(t);
  loan(db, { months: 2, matched: false });
  const row = (await callTool('spending', { operation: 'obligations', obligations: ['mortgage'] }, ctx)).obligations[0];
  assert.equal(row.observedMonthly.value, null);
  assert.equal(row.endDate.value, null);
  assert.deepEqual(row.missing.sort(), ['rate', 'monthlyPayment', 'escrowMonthly'].map(k => `obligations.mortgage.${k}`).sort());
  assert.equal(row.terms.balance.value, 18356.72);
});

test('projection removes only the mortgage portion, preserves other debts, and honors a selection excluding the loan', async t => {
  const { db, ctx } = await store(t);
  const fixture = loan(db);
  addFact(db, 'obligations.mortgage', { escrowMonthly: 0 });
  const base = await callTool('spending', { operation: 'total', annualize: true }, ctx);
  const projection = await callTool('spending', { operation: 'projection', years: 3, obligations: ['mortgage'] }, ctx);
  assert.equal(projection.years[2].spending.value, base.total.value - 12 * fixture.payment);
  const selected = await callTool('spending', { operation: 'total', annualize: true, include: { merchants: ['Credit card payment'] } }, ctx);
  const excluding = await callTool('spending', { operation: 'projection', base: selected.total.ref, years: 3, obligations: ['mortgage'] }, ctx);
  assert.equal(excluding.years[2].spending.value, selected.total.value);
});

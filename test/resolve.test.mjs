import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { ask, KIND_OPTIONS, getItem, autoInfo, reopenItem } from '../src/ingest/confirm.mjs';
import { questionFor } from '../src/jobs/triggers/common.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { resolvePending } from '../src/resolve/index.mjs';

const NOW = '2032-03-10T12:00:00.000Z';
async function store(fn) {
  const t = await tempDb();
  setSetting(t.db, 'mode', 'real');
  try { await fn(t.db); } finally { t.db.close(); rmSync(t.dataDir, { recursive: true, force: true }); }
}
function account(db, name = 'Synthetic reserve') {
  db.prepare('INSERT INTO accounts (id,name,inst,mask,kind,owner) VALUES (?,?,?,?,?,?)').run('synthetic-a', name, 'Example Bank', '1234', null, 'You');
  return ask(db, { kind: 'account_kind', subject: 'synthetic-a', question: 'What kind of account is this?', options: KIND_OPTIONS, now: NOW }).id;
}
function model(db, answer) {
  const runtime = createRuntimeEngine({ db, config: { engine: 'fake' }, now: () => new Date(NOW) });
  const calls = [];
  return { mode: 'fake', isOn: () => runtime.isOn(), status: () => runtime.status(), calls,
    async call(req) {
      calls.push(req);
      const payload = JSON.parse(req.messages[0].content);
      const answers = typeof answer === 'function' ? answer(payload) : answer;
      return runtime.call({ ...req, fake: [{ text: JSON.stringify({ answers }), costUsd: 0.001 }] });
    } };
}
const options = { now: NOW, packDirs: [], allowed: () => true, funded: () => true };
const prediction = id => ({ item: id, option: 'cash', basis: 'account_name', refs: ['accounts:synthetic-a'] });

test('a scripted household engine answers an account kind with grounded evidence and Undo', () => store(async db => {
  const id = account(db);
  const engine = model(db, [prediction(id)]);
  const out = await resolvePending(db, engine, options);
  assert.equal(out.answered, 1);
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].purpose, 'job');
  assert.equal(db.prepare('SELECT kind FROM accounts').get().kind, 'cash');
  assert.match(autoInfo(db, id).evidence.text, /Fathom.*Synthetic reserve/);
  assert.deepEqual(autoInfo(db, id).evidence.refs, ['accounts:synthetic-a']);
  assert.equal(autoInfo(db, id).rule, 'resolver');
  reopenItem(db, id, { now: NOW });
  assert.equal(getItem(db, id).status, 'pending');
  assert.ok(db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(id));
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal(db.prepare('SELECT kind FROM accounts').get().kind, null);
}));

test('missing, absent and unrelated refs are rejected while the item stays pending', () => store(async db => {
  const id = account(db);
  for (const refs of [['accounts:missing'], [], ['packs:missing']]) {
    const engine = model(db, [{ ...prediction(id), refs }]);
    await resolvePending(db, engine, options);
    assert.equal(getItem(db, id).status, 'pending');
  }
}));

test('engine off still applies deterministic account-name rules without calls', () => store(async db => {
  const id = account(db, 'Synthetic Checking');
  rec(db, ['benefits.hsaEligible']);
  const engine = { isOn: () => false, call() { assert.fail('engine called'); } };
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, id).answer, 'cash');
  assert.equal(db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind='resolver_fact'").get().n, 0);
  reopenItem(db, id, { now: NOW });
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, id).status, 'pending');
}));

function rec(db, keys) {
  const question = questionFor(keys);
  db.prepare("INSERT INTO recs (id,def,status,updated_at,sort) VALUES (?,?,'proposed','2032-03-10',0)").run('synthetic-rec', JSON.stringify({ id: 'synthetic-rec', question }));
}
test('number and date shaped rec keys and numeric fact checks are never sent to a model', () => store(async db => {
  rec(db, ['tax.vaItemizedEstimate', 'household.expectedDate', 'household.birthYears']);
  ask(db, { kind: 'fact_check', subject: 'numeric', question: 'Check amount', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], context: { key: 'tax.vaItemizedEstimate', value: 1500 }, now: NOW });
  const engine = model(db, []);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM facts').get().n, 0);
}));

test('a yes/no recommendation is answered through resolver provenance and replans; Undo declines it', () => store(async db => {
  rec(db, ['benefits.hsaEligible']);
  db.prepare("INSERT INTO facts (key,value,confirmed,updated_at) VALUES ('benefits.planDescription',?,0,'2032-03-10')").run(JSON.stringify('Synthetic HSA eligible health plan'));
  let planned = 0;
  const engine = model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'true', basis: 'stored_fact', refs: ['facts:benefits.planDescription'] })));
  await resolvePending(db, engine, { ...options, replan: async () => { planned++; } });
  assert.equal(planned, 1);
  const fact = db.prepare("SELECT * FROM facts WHERE key='benefits.hsaEligible'").get();
  assert.equal(fact.value, 'true');
  assert.equal(fact.parser, 'resolver');
  assert.doesNotMatch(db.prepare('SELECT label FROM sources WHERE id=?').get(fact.src).label, /you told|MCP/);
  const item = db.prepare("SELECT id FROM confirm_items WHERE kind='resolver_fact'").get();
  reopenItem(db, item.id, { now: NOW });
  assert.equal(db.prepare("SELECT * FROM facts WHERE key='benefits.hsaEligible'").get(), undefined);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
}));

test('monthly and per-run caps refuse before any call, and sufficient budget permits progress', () => store(async db => {
  const id = account(db);
  const engine = model(db, [prediction(id)]);
  setSetting(db, 'cap', { usd: 0.001 });
  assert.equal((await resolvePending(db, engine, options)).stopped, 'budget');
  assert.equal(engine.calls.length, 0);
  setSetting(db, 'cap', { usd: 200 });
  setSetting(db, 'resolver', { maxCostUsd: 0 });
  assert.equal((await resolvePending(db, engine, options)).stopped, 'budget');
  assert.equal(engine.calls.length, 0);
  setSetting(db, 'resolver', { maxCostUsd: 2 });
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, id).status, 'answered');
}));

test('paused outbound engine and unavailable funding stop dispatch', () => store(async db => {
  account(db);
  const engine = model(db, []);
  for (const gate of [{ allowed: () => false }, { funded: () => false }]) {
    await resolvePending(db, engine, { ...options, ...gate });
  }
  assert.equal(engine.calls.length, 0);
}));

test('fixed-choice categorizer guesses apply only at the policy threshold with plain evidence', () => store(async db => {
  const id = account(db);
  db.prepare('INSERT INTO confirm_guesses VALUES (?,?,?,?,?)').run(id, 'cash', JSON.stringify({ confidence: 0.95 }), 'jev-1.14.0', NOW);
  const engine = { isOn: () => false };
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, id).answer, 'cash');
  assert.equal(autoInfo(db, id).evidence.text, "Fathom's categorization");
}));

test('a low-confidence categorizer proposal stays open and falls through to the household engine', () => store(async db => {
  const id = account(db);
  db.prepare('INSERT INTO confirm_guesses VALUES (?,?,?,?,?)').run(id, 'cash', JSON.stringify({ confidence: 0.85 }), 'jev-1.14.0', NOW);
  const engine = model(db, [prediction(id)]);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal(getItem(db, id).answer, 'cash');
}));

test('evidence changed during a model call is rejected', () => store(async db => {
  const id = account(db);
  const engine = model(db, () => {
    db.prepare("UPDATE accounts SET name='Changed synthetic account' WHERE id='synthetic-a'").run();
    return [prediction(id)];
  });
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, id).status, 'pending');
}));

test('the run ceiling stops later batches and leaves the remaining item pending', () => store(async db => {
  const id = account(db);
  db.prepare("INSERT INTO accounts (id,name) VALUES ('synthetic-b','Synthetic reserve B')").run();
  const other = ask(db, { kind: 'account_kind', subject: 'synthetic-b', question: 'What kind?', options: KIND_OPTIONS, now: NOW }).id;
  const engine = model(db, [prediction(id)]);
  const call = engine.call.bind(engine);
  engine.call = async req => {
    const out = await call(req);
    setSetting(db, 'resolver', { maxCostUsd: 0.001 });
    return out;
  };
  const out = await resolvePending(db, engine, { ...options, batchSize: 1 });
  assert.equal(engine.calls.length, 1);
  assert.equal(getItem(db, id).status, 'answered');
  assert.equal(getItem(db, other).status, 'pending');
  assert.equal(out.stopped, 'budget');
}));

test('the engine rechecks a call budget after serialized competing spend', async () => {
  const { createEngine, createMemoryLedger, BudgetExceededError } = await import('../src/engine/index.mjs');
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, capUsd: 0.10, now: () => new Date(NOW) });
  const req = { purpose: 'job', messages: [{ role: 'user', content: 'Synthetic classification' }], maxTokens: 100, budget: { maxCostUsd: 0.10 } };
  await engine.call({ ...req, fake: [{ text: '{}', costUsd: 0.09 }] });
  await assert.rejects(engine.call({ ...req, fake: [{ text: '{}', costUsd: 0.001 }] }), BudgetExceededError);
  assert.equal(ledger.entries.length, 1);
});

test('independent automatic facts retain their own source after either answer is undone', () => store(async db => {
  rec(db, ['benefits.hsaEligible', 'business.cashBasis']);
  db.prepare("INSERT INTO facts (key,value,confirmed,updated_at) VALUES ('synthetic.note','true',0,?)").run(NOW);
  const engine = model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'true', basis: 'stored_fact', refs: ['facts:synthetic.note'] })));
  await resolvePending(db, engine, options);
  const items = db.prepare("SELECT id,subject FROM confirm_items WHERE kind='resolver_fact' ORDER BY id").all();
  assert.equal(items.length, 2);
  db.prepare('UPDATE ingest_epoch SET n=n+1 WHERE id=1').run();
  reopenItem(db, items[0].id, { now: NOW });
  const other = db.prepare('SELECT src FROM facts WHERE key=?').get(items[1].subject);
  assert.ok(db.prepare('SELECT 1 FROM sources WHERE id=?').get(other.src));
  reopenItem(db, items[1].id, { now: NOW });
}));

test('a recommendation answered elsewhere retires its pending resolver item and does not call again', () => store(async db => {
  rec(db, ['benefits.hsaEligible']);
  const engine = model(db, []);
  await resolvePending(db, engine, options);
  const { answerFacts } = await import('../src/facts/answers.mjs');
  await answerFacts(db, [{ key: 'benefits.hsaEligible', value: false }], { now: NOW, replan: async () => {} });
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal(db.prepare("SELECT status FROM confirm_items WHERE kind='resolver_fact'").get().status, 'answered');
  assert.equal(db.prepare("SELECT value FROM facts WHERE key='benefits.hsaEligible'").get().value, 'false');
}));

test('declined Confirm items are never sent to the categorizer again', () => store(async db => {
  const id = account(db);
  const engine = model(db, [prediction(id)]);
  await resolvePending(db, engine, options);
  reopenItem(db, id, { now: NOW });
  const { guessClosedOptions } = await import('../src/ingest/jev.mjs');
  await guessClosedOptions(db, { isOn: () => true, choose() { assert.fail('declined item sent'); } }, { now: NOW });
  assert.equal(getItem(db, id).status, 'pending');
}));

test('account numbers are masked in questions, context, detail and household rows', () => store(async db => {
  const number = '9876543210123456';
  account(db, `Synthetic reserve ${number}`);
  db.prepare('UPDATE confirm_items SET question=?,context=?').run(`Account ${number}?`, JSON.stringify({ hint: number }));
  const engine = model(db, []);
  await resolvePending(db, engine, options);
  assert.doesNotMatch(engine.calls[0].messages[0].content, new RegExp(number));
  assert.match(engine.calls[0].messages[0].content, /XXXX/);
}));

function categoryTransaction(db, category) {
  setSetting(db, 'clock', '2032-03-10');
  db.prepare("INSERT INTO accounts (id,name,kind,owner) VALUES ('synthetic-spending','Synthetic spending','cash','You')").run();
  return Number(db.prepare("INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES ('synthetic-spending','2032-03-09',-150,'Synthetic market',?,'aggregator')").run(category).lastInsertRowid);
}
test('remaining transaction choices use the resolver without learning automatic answers as personal history', () => store(async db => {
  const transactionId = categoryTransaction(db, 'Uncategorized');
  db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)').run(transactionId, JSON.stringify({ category: 'Groceries', confidence: 0.85 }), 'jev-1.14.0', NOW);
  const engine = model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'Groceries', basis: 'imported_values', refs: [`transactions:${transactionId}`] })));
  await resolvePending(db, engine, options);
  assert.ok(engine.calls.length);
  const { loadCategoryInputs } = await import('../src/categories/store.mjs');
  const { resolveCategories, createHistoryIndex } = await import('../src/categories/resolve.mjs');
  const inputs = loadCategoryInputs(db);
  assert.equal(resolveCategories(inputs).get(transactionId).layer, 'guess');
  assert.ok(inputs.corrections[0].auto);
  assert.equal(createHistoryIndex(inputs).size, 0);
  const payload = JSON.parse(engine.calls[0].messages[0].content);
  assert.ok(payload.items.every(i => i.options.every(o => !o.id.startsWith('always:'))));
  const item = db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category'").get();
  reopenItem(db, item.id, { now: NOW });
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
}));

test('source category mappings retain automatic provenance and do not train household history', () => store(async db => {
  const transactionId = categoryTransaction(db, 'Synthetic essentials');
  const engine = model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'household', basis: 'imported_values', refs: [`transactions:${transactionId}`] })));
  await resolvePending(db, engine, options);
  const { loadCategoryInputs } = await import('../src/categories/store.mjs');
  const { resolveCategories, createHistoryIndex } = await import('../src/categories/resolve.mjs');
  const inputs = loadCategoryInputs(db);
  assert.ok(inputs.sourceRules[0].auto);
  assert.equal(resolveCategories(inputs).get(transactionId).layer, 'guess');
  assert.equal(createHistoryIndex(inputs).size, 0);
  const item = db.prepare("SELECT id FROM confirm_items WHERE kind='category_mapping'").get();
  reopenItem(db, item.id, { now: NOW });
  assert.equal(db.prepare('SELECT count(*) AS n FROM category_source_rules').get().n, 0);
}));

test('the scheduled resolver answers HSA eligibility and runs the actual planner', () => store(async db => {
  rec(db, ['benefits.hsaEligible']);
  db.prepare("INSERT INTO facts (key,value,confirmed,updated_at) VALUES ('synthetic.planDescription',?,0,?)").run(JSON.stringify('HSA eligible health plan'), NOW);
  const engine = model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'true', basis: 'stored_fact', refs: ['facts:synthetic.planDescription'] })));
  const { createScheduler, defaultHandlers } = await import('../src/jobs/scheduler.mjs');
  const handlers = defaultHandlers();
  const scheduler = createScheduler({ db, config: { clock: '2032-03-10' }, engine, handlers: { 'confirm-guess': handlers['confirm-guess'] },
    household: () => ({ outbound: { enabled: () => true }, funded: () => true }), now: () => new Date(NOW), log: { log() {} } });
  try {
    const run = await scheduler.runNow('confirm-guess');
    assert.equal(run.status, 'ok');
    assert.equal(db.prepare("SELECT value FROM facts WHERE key='benefits.hsaEligible'").get().value, 'true');
    assert.ok(db.prepare('SELECT 1 FROM planner_recs WHERE last_run=?').get(run.id), 'the actual planner persisted recommendations for the resolver run');
  } finally { await scheduler.stop(); }
}));

test('unchanged unresolved inputs are paid for once, while changed evidence permits another attempt', () => store(async db => {
  account(db);
  const engine = model(db, []);
  await resolvePending(db, engine, options);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  db.prepare("UPDATE accounts SET name='Synthetic new evidence' WHERE id='synthetic-a'").run();
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 2);
}));

test('a malformed paid response is remembered and is not bought again on unchanged inputs', () => store(async db => {
  account(db);
  let calls = 0;
  const engine = { isOn: () => true, async call() { calls++; return { text: 'invalid JSON', costUsd: 0.001 }; } };
  assert.equal((await resolvePending(db, engine, options)).stopped, 'bad_response');
  await resolvePending(db, engine, options);
  assert.equal(calls, 1);
}));

test('references are checked again after an earlier answer in the same batch changes an account', () => store(async db => {
  const kind = account(db);
  const owner = ask(db, { kind: 'account_owner', subject: 'synthetic-a', question: 'Whose account?',
    options: [{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Spouse' }], now: NOW }).id;
  const engine = model(db, [prediction(kind), { item: owner, option: 'owner', basis: 'imported_values', refs: ['accounts:synthetic-a'] }]);
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, kind).status, 'answered');
  assert.equal(getItem(db, owner).status, 'pending');
}));

test('unresolved recommendation questions do not duplicate the Confirm deck', () => store(async db => {
  rec(db, ['benefits.hsaEligible']);
  const engine = model(db, []);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal(db.prepare("SELECT status FROM confirm_items WHERE kind='resolver_fact'").get().status, 'pending');
  const { ingestState } = await import('../src/ingest/freshness.mjs');
  assert.equal(ingestState(db, { clock: NOW.slice(0, 10) }).items.some(item => item.kind === 'resolver_fact'), false);
}));

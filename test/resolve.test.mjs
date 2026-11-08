import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb, tempInstance } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { ask, KIND_OPTIONS, getItem, autoInfo, reopenItem } from '../src/ingest/confirm.mjs';
import { questionFor } from '../src/jobs/triggers/common.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { resolvePending } from '../src/resolve/index.mjs';

const NOW = '2032-03-10T12:00:00.000Z';
async function store(fn) {
  const t = await tempDb();
  await setSetting(t.db, 'mode', 'real');
  try { await fn(t.db); } finally { await t.db.close(); rmSync(t.dataDir, { recursive: true, force: true }); }
}
async function account(db, name = 'Synthetic reserve') {
  await db.prepare('INSERT INTO accounts (id,name,inst,mask,kind,owner) VALUES (?,?,?,?,?,?)').run('synthetic-a', name, 'Example Bank', '1234', null, 'You');
  return (await ask(db, { kind: 'account_kind', subject: 'synthetic-a', question: 'What kind of account is this?', options: KIND_OPTIONS, now: NOW })).id;
}
async function model(db, answer) {
  const runtime = await createRuntimeEngine({ db, config: { engine: 'fake' }, now: () => new Date(NOW) });
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

test('a scripted household engine answers an account kind with grounded evidence and Undo', async () => store(async db => {
  const id = await account(db);
  const engine = await model(db, [prediction(id)]);
  const out = await resolvePending(db, engine, options);
  assert.equal(out.answered, 1);
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].purpose, 'job');
  assert.equal((await db.prepare('SELECT kind FROM accounts').get()).kind, 'cash');
  assert.match((await autoInfo(db, id)).evidence.text, /Fathom.*Synthetic reserve/);
  assert.deepEqual((await autoInfo(db, id)).evidence.refs, ['accounts:synthetic-a']);
  assert.equal((await autoInfo(db, id)).rule, 'resolver');
  await reopenItem(db, id, { now: NOW });
  assert.equal((await getItem(db, id)).status, 'pending');
  assert.ok(await db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(id));
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal((await db.prepare('SELECT kind FROM accounts').get()).kind, null);
}));

test('ambiguous bank tax payments stay in Confirm even when a grounded model would answer them', async () => store(async db => {
  const id = (await ask(db, { kind: 'transaction_payment', subject: 'synthetic-payment', question: 'Is this an estimated tax payment?',
    options: [{ id: 'estimate', label: 'Estimated payment' }, { id: 'not_estimate', label: 'Not an estimate' }],
    context: {}, now: NOW })).id;
  const engine = await model(db, [{ item: id, option: 'estimate', basis: 'stored_fact', refs: ['accounts:synthetic-a'] }]);
  await resolvePending(db, engine, options);
  assert.equal((await getItem(db, id)).status, 'pending');
  assert.equal(engine.calls.length, 0);
}));

test('missing, absent and unrelated refs are rejected while the item stays pending', async () => store(async db => {
  const id = await account(db);
  for (const refs of [['accounts:missing'], [], ['packs:missing']]) {
    const engine = await model(db, [{ ...prediction(id), refs }]);
    await resolvePending(db, engine, options);
    assert.equal((await getItem(db, id)).status, 'pending');
  }
}));

test('engine off still applies deterministic account-name rules without calls', async () => store(async db => {
  const id = await account(db, 'Synthetic Checking');
  await rec(db, ['benefits.hsaEligible']);
  const engine = { isOn: () => false, call() { assert.fail('engine called'); } };
  await resolvePending(db, engine, options);
  assert.equal((await getItem(db, id)).answer, 'cash');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind='resolver_fact'").get()).n, 0);
  await reopenItem(db, id, { now: NOW });
  await resolvePending(db, engine, options);
  assert.equal((await getItem(db, id)).status, 'pending');
}));

async function rec(db, keys) {
  const question = questionFor(keys);
  await db.prepare("INSERT INTO recs (id,def,status,updated_at,sort) VALUES (?,?,'proposed','2032-03-10',0)").run('synthetic-rec', JSON.stringify({ id: 'synthetic-rec', question }));
}
test('number and date shaped rec keys and numeric fact checks are never sent to a model', async () => store(async db => {
  await rec(db, ['tax.vaItemizedEstimate', 'household.expectedDate', 'household.birthYears']);
  await ask(db, { kind: 'fact_check', subject: 'numeric', question: 'Check amount', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], context: { key: 'tax.vaItemizedEstimate', value: 1500 }, now: NOW });
  const engine = await model(db, []);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM facts').get()).n, 0);
}));

test('a yes/no recommendation is answered through resolver provenance and replans; Undo declines it', async () => store(async db => {
  await rec(db, ['benefits.hsaEligible']);
  await db.prepare("INSERT INTO facts (key,value,confirmed,updated_at) VALUES ('benefits.planDescription',?,0,'2032-03-10')").run(JSON.stringify('Synthetic HSA eligible health plan'));
  let planned = 0;
  const engine = await model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'true', basis: 'stored_fact', refs: ['facts:benefits.planDescription'] })));
  await resolvePending(db, engine, { ...options, replan: async () => { planned++; } });
  assert.equal(planned, 1);
  const fact = await db.prepare("SELECT * FROM facts WHERE key='benefits.hsaEligible'").get();
  assert.equal(fact.value, 'true');
  assert.equal(fact.parser, 'resolver');
  assert.doesNotMatch((await db.prepare('SELECT label FROM sources WHERE id=?').get(fact.src)).label, /you told|MCP/);
  const item = await db.prepare("SELECT id FROM confirm_items WHERE kind='resolver_fact'").get();
  await reopenItem(db, item.id, { now: NOW });
  assert.equal(await db.prepare("SELECT * FROM facts WHERE key='benefits.hsaEligible'").get(), undefined);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
}));

test('monthly and per-run caps refuse before any call, and sufficient budget permits progress', async () => store(async db => {
  const id = await account(db);
  const engine = await model(db, [prediction(id)]);
  await setSetting(db, 'cap', { usd: 0.001 });
  assert.equal((await resolvePending(db, engine, options)).stopped, 'budget');
  assert.equal(engine.calls.length, 0);
  await setSetting(db, 'cap', { usd: 200 });
  await setSetting(db, 'resolver', { maxCostUsd: 0 });
  assert.equal((await resolvePending(db, engine, options)).stopped, 'budget');
  assert.equal(engine.calls.length, 0);
  await setSetting(db, 'resolver', { maxCostUsd: 2 });
  await resolvePending(db, engine, options);
  assert.equal((await getItem(db, id)).status, 'answered');
}));

test('paused outbound engine and unavailable funding stop dispatch', async () => store(async db => {
  await account(db);
  const engine = await model(db, []);
  for (const gate of [{ allowed: () => false }, { funded: () => false }]) {
    await resolvePending(db, engine, { ...options, ...gate });
  }
  assert.equal(engine.calls.length, 0);
}));

test('fixed-choice categorizer guesses apply only at the policy threshold with plain evidence', async () => store(async db => {
  const id = await account(db);
  await db.prepare('INSERT INTO confirm_guesses VALUES (?,?,?,?,?)').run(id, 'cash', JSON.stringify({ confidence: 0.95 }), 'jev-1.14.0', NOW);
  const engine = { isOn: () => false };
  await resolvePending(db, engine, options);
  assert.equal((await getItem(db, id)).answer, 'cash');
  assert.equal((await autoInfo(db, id)).evidence.text, "Fathom's categorization");
}));

test('a low-confidence categorizer proposal stays open and falls through to the household engine', async () => store(async db => {
  const id = await account(db);
  await db.prepare('INSERT INTO confirm_guesses VALUES (?,?,?,?,?)').run(id, 'cash', JSON.stringify({ confidence: 0.85 }), 'jev-1.14.0', NOW);
  const engine = await model(db, [prediction(id)]);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal((await getItem(db, id)).answer, 'cash');
}));

test('evidence changed during a model call is rejected', async () => store(async db => {
  const id = await account(db);
  const engine = await model(db, async () => {
    await db.prepare("UPDATE accounts SET name='Changed synthetic account' WHERE id='synthetic-a'").run();
    return [prediction(id)];
  });
  await resolvePending(db, engine, options);
  assert.equal((await getItem(db, id)).status, 'pending');
}));

test('the run ceiling stops later batches and leaves the remaining item pending', async () => store(async db => {
  const id = await account(db);
  await db.prepare("INSERT INTO accounts (id,name) VALUES ('synthetic-b','Synthetic reserve B')").run();
  const other = (await ask(db, { kind: 'account_kind', subject: 'synthetic-b', question: 'What kind?', options: KIND_OPTIONS, now: NOW })).id;
  const engine = await model(db, [prediction(id)]);
  const call = engine.call.bind(engine);
  engine.call = async req => {
    const out = await call(req);
    await setSetting(db, 'resolver', { maxCostUsd: 0.001 });
    return out;
  };
  const out = await resolvePending(db, engine, { ...options, batchSize: 1 });
  assert.equal(engine.calls.length, 1);
  assert.equal((await getItem(db, id)).status, 'answered');
  assert.equal((await getItem(db, other)).status, 'pending');
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

test('independent automatic facts retain their own source after either answer is undone', async () => store(async db => {
  await rec(db, ['benefits.hsaEligible', 'business.cashBasis']);
  await db.prepare("INSERT INTO facts (key,value,confirmed,updated_at) VALUES ('synthetic.note','true',0,?)").run(NOW);
  const engine = await model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'true', basis: 'stored_fact', refs: ['facts:synthetic.note'] })));
  await resolvePending(db, engine, options);
  const items = await db.prepare("SELECT id,subject FROM confirm_items WHERE kind='resolver_fact' ORDER BY id").all();
  assert.equal(items.length, 2);
  await db.prepare('UPDATE ingest_epoch SET n=n+1 WHERE id=1').run();
  await reopenItem(db, items[0].id, { now: NOW });
  const other = await db.prepare('SELECT src FROM facts WHERE key=?').get(items[1].subject);
  assert.ok(await db.prepare('SELECT 1 FROM sources WHERE id=?').get(other.src));
  await reopenItem(db, items[1].id, { now: NOW });
}));

test('a recommendation answered elsewhere retires its pending resolver item and does not call again', async () => store(async db => {
  await rec(db, ['benefits.hsaEligible']);
  const engine = await model(db, []);
  await resolvePending(db, engine, options);
  const { answerFacts } = await import('../src/facts/answers.mjs');
  await answerFacts(db, [{ key: 'benefits.hsaEligible', value: false }], { now: NOW, replan: async () => {} });
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal((await db.prepare("SELECT status FROM confirm_items WHERE kind='resolver_fact'").get()).status, 'answered');
  assert.equal((await db.prepare("SELECT value FROM facts WHERE key='benefits.hsaEligible'").get()).value, 'false');
}));

test('declined Confirm items are never sent to the categorizer again', async () => store(async db => {
  const id = await account(db);
  const engine = await model(db, [prediction(id)]);
  await resolvePending(db, engine, options);
  await reopenItem(db, id, { now: NOW });
  const { guessClosedOptions } = await import('../src/ingest/jev.mjs');
  await guessClosedOptions(db, { isOn: () => true, choose() { assert.fail('declined item sent'); } }, { now: NOW });
  assert.equal((await getItem(db, id)).status, 'pending');
}));

test('account numbers are masked in questions, context, detail and household rows', async () => store(async db => {
  const number = '9876543210123456';
  await account(db, `Synthetic reserve ${number}`);
  await db.prepare('UPDATE confirm_items SET question=?,context=?').run(`Account ${number}?`, JSON.stringify({ hint: number }));
  const engine = await model(db, []);
  await resolvePending(db, engine, options);
  assert.doesNotMatch(engine.calls[0].messages[0].content, new RegExp(number));
  assert.match(engine.calls[0].messages[0].content, /XXXX/);
}));

async function categoryTransaction(db, category) {
  await setSetting(db, 'clock', '2032-03-10');
  await db.prepare("INSERT INTO accounts (id,name,kind,owner) VALUES ('synthetic-spending','Synthetic spending','cash','You')").run();
  return Number((await db.prepare("INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES ('synthetic-spending','2032-03-09',-150,'Synthetic market',?,'aggregator')").run(category)).lastInsertRowid);
}
test('remaining transaction choices use the resolver without learning automatic answers as personal history', async () => store(async db => {
  const transactionId = await categoryTransaction(db, 'Uncategorized');
  await db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)').run(transactionId, JSON.stringify({ category: 'Groceries', confidence: 0.85 }), 'jev-1.14.0', NOW);
  const engine = await model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'Groceries', basis: 'imported_values', refs: [`transactions:${transactionId}`] })));
  await resolvePending(db, engine, options);
  assert.ok(engine.calls.length);
  const { loadCategoryInputs } = await import('../src/categories/store.mjs');
  const { resolveCategories, createHistoryIndex } = await import('../src/categories/resolve.mjs');
  const inputs = await loadCategoryInputs(db);
  assert.equal(resolveCategories(inputs).get(transactionId).layer, 'guess');
  assert.ok(inputs.corrections[0].auto);
  assert.equal(createHistoryIndex(inputs).size, 0);
  const payload = JSON.parse(engine.calls[0].messages[0].content);
  assert.ok(payload.items.every(i => i.options.every(o => !o.id.startsWith('always:'))));
  const item = await db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category'").get();
  await reopenItem(db, item.id, { now: NOW });
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
}));

test('source category mappings retain automatic provenance and do not train household history', async () => store(async db => {
  const transactionId = await categoryTransaction(db, 'Synthetic essentials');
  const engine = await model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'household', confidence: 0.92, basis: 'imported_values', refs: [`transactions:${transactionId}`] })));
  await resolvePending(db, engine, options);
  const { loadCategoryInputs } = await import('../src/categories/store.mjs');
  const { resolveCategories, createHistoryIndex } = await import('../src/categories/resolve.mjs');
  const inputs = await loadCategoryInputs(db);
  assert.ok(inputs.sourceRules[0].auto);
  assert.equal(resolveCategories(inputs).get(transactionId).layer, 'guess');
  assert.equal(createHistoryIndex(inputs).size, 0);
  const item = await db.prepare("SELECT id FROM confirm_items WHERE kind='category_mapping'").get();
  await reopenItem(db, item.id, { now: NOW });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM category_source_rules').get()).n, 0);
}));

test('the scheduled resolver answers HSA eligibility and runs the actual planner', async () => {
  const instance = await tempInstance();
  const { db } = instance;
  let scheduler;
  try {
    await rec(db, ['benefits.hsaEligible']);
    await db.prepare("INSERT INTO sources(id,label,kind,as_of) VALUES ('ing:synthetic-reserve','Synthetic reserve','balances','2031-01-01')").run();
    await db.prepare("INSERT INTO accounts(id,name,inst,kind,owner,source_id) VALUES ('reserve','Reserve','Example Bank','cash','You','ing:synthetic-reserve')").run();
    await db.prepare("INSERT INTO balances(account_id,date,amount) VALUES ('reserve','2031-01-01',100)").run();
    await db.prepare("INSERT INTO facts (key,value,confirmed,updated_at) VALUES ('synthetic.planDescription',?,0,?)").run(JSON.stringify('HSA eligible health plan'), NOW);
    await instance.platform.prepare('INSERT OR REPLACE INTO platform_settings (key,value,updated_at) VALUES (?,?,?)')
      .run('instance_model_cap_usd', '1', Date.now());
    const engine = await model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'true', basis: 'stored_fact', refs: ['facts:synthetic.planDescription'] })));
    const household = await instance.household({ clock: '2032-03-10', engine: 'fake' }, { engine });
    scheduler = household.scheduler;
    const run = await scheduler.runNow('confirm-guess');
    assert.equal(run.status, 'ok');
    assert.equal((await db.prepare("SELECT value FROM facts WHERE key='benefits.hsaEligible'").get()).value, 'true');
    await scheduler.stop();
    const plan = await db.prepare("SELECT id,status,trigger FROM job_runs WHERE job_id='plan' ORDER BY id DESC LIMIT 1").get();
    assert.ok(plan, 'the resolver queued a plan through its household scheduler');
    assert.notEqual(plan.id, run.id, 'planning has its own local claim');
    assert.equal(plan.trigger, 'resolve');
    assert.equal(plan.status, 'ok');
    assert.ok(await db.prepare('SELECT 1 FROM planner_recs WHERE last_run=?').get(plan.id), 'the actual planner persisted recommendations for the queued plan run');
    assert.equal(engine.calls.length, 1, 'follow-up planning makes no additional model call');
  } finally {
    await scheduler?.stop();
    instance.close();
    rmSync(instance.dataDir, { recursive: true, force: true });
  }
});

test('unchanged unresolved inputs are paid for once, while changed evidence permits another attempt', async () => store(async db => {
  await account(db);
  const engine = await model(db, []);
  await resolvePending(db, engine, options);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  await db.prepare("UPDATE accounts SET name='Synthetic new evidence' WHERE id='synthetic-a'").run();
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 2);
}));

test('a malformed paid response is remembered and is not bought again on unchanged inputs', async () => store(async db => {
  await account(db);
  let calls = 0;
  const engine = { isOn: () => true, async call() { calls++; return { text: 'invalid JSON', costUsd: 0.001 }; } };
  assert.equal((await resolvePending(db, engine, options)).stopped, 'bad_response');
  await resolvePending(db, engine, options);
  assert.equal(calls, 1);
}));

test('references are checked again after an earlier answer in the same batch changes an account', async () => store(async db => {
  const kind = await account(db);
  const owner = (await ask(db, { kind: 'account_owner', subject: 'synthetic-a', question: 'Whose account?',
    options: [{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Spouse' }], now: NOW })).id;
  const engine = await model(db, [prediction(kind), { item: owner, option: 'owner', basis: 'imported_values', refs: ['accounts:synthetic-a'] }]);
  await resolvePending(db, engine, options);
  assert.equal((await getItem(db, kind)).status, 'answered');
  assert.equal((await getItem(db, owner)).status, 'pending');
}));

test('unresolved recommendation questions do not duplicate the Confirm deck', async () => store(async db => {
  await rec(db, ['benefits.hsaEligible']);
  const engine = await model(db, []);
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.equal((await db.prepare("SELECT status FROM confirm_items WHERE kind='resolver_fact'").get()).status, 'pending');
  const { ingestState } = await import('../src/ingest/freshness.mjs');
  assert.equal((await ingestState(db, { clock: NOW.slice(0, 10) })).items.some(item => item.kind === 'resolver_fact'), false);
}));

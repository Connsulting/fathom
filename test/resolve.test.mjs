import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { ask, KIND_OPTIONS, getItem, autoInfo, reopen } from '../src/ingest/confirm.mjs';
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
  assert.match(autoInfo(db, id).evidence.text, /Fathom/);
  assert.deepEqual(autoInfo(db, id).evidence.refs, ['accounts:synthetic-a']);
  assert.equal(autoInfo(db, id).rule, 'resolver');
  reopen(db, id, { now: NOW });
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
  const engine = { isOn: () => false, call() { assert.fail('engine called'); } };
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, id).answer, 'checking');
  reopen(db, id, { now: NOW });
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, id).status, 'pending');
}));

function rec(db, keys) {
  const question = questionFor(keys);
  db.prepare("INSERT INTO recs (id,def,status,sort) VALUES (?,?,'proposed',0)").run('synthetic-rec', JSON.stringify({ id: 'synthetic-rec', question }));
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
  db.prepare("INSERT INTO facts (key,value,confirmed) VALUES ('benefits.planDescription',?,0)").run(JSON.stringify('Synthetic HSA eligible health plan'));
  let planned = 0;
  const engine = model(db, ({ items }) => items.map(i => ({ item: i.id, option: 'true', basis: 'stored_fact', refs: ['facts:benefits.planDescription'] })));
  await resolvePending(db, engine, { ...options, replan: async () => { planned++; } });
  assert.equal(planned, 1);
  const fact = db.prepare("SELECT * FROM facts WHERE key='benefits.hsaEligible'").get();
  assert.equal(fact.value, 'true');
  assert.equal(fact.parser, 'resolver');
  assert.doesNotMatch(db.prepare('SELECT label FROM sources WHERE id=?').get(fact.src).label, /you told|MCP/);
  const item = db.prepare("SELECT id FROM confirm_items WHERE kind='resolver_fact'").get();
  reopen(db, item.id, { now: NOW });
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

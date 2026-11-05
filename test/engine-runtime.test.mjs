// AC5: the frozen runtime engine seam (src/engine/runtime.mjs): a gateway engine over the store's
// spend_ledger that honors the engine on/off setting and re-reads the monthly cap on every call,
// with fake responses for tests and a live mode that never leaks its credential.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { EngineOffError, BudgetExceededError, ModelCallError } from '../src/engine/index.mjs';
import { setSetting } from '../src/store/db.mjs';
import { scratch, createRealStore } from './helpers/real-store.mjs';

const S = scratch('fathom-runtime-');
after(() => S.cleanup());
const fresh = () => S.track(createRealStore(S.dir()));
const req = { purpose: 'job', system: 'Synthetic test system prompt.', messages: [{ role: 'user', content: 'Say hello.' }], maxTokens: 64 };
const month = () => new Date().toISOString().slice(0, 7);
const fakeConfig = { engine: 'fake', claudeCredentialFile: null };

function spend(db, usd) {
  db.prepare("INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, 'chat', ?, 'fake', '{}')")
    .run(new Date().toISOString(), month(), usd);
}

test('AC5: the runtime engine reports its mode and answers fake calls in order', async () => {
  const db = fresh();
  const engine = createRuntimeEngine({ db, config: fakeConfig, responses: [{ text: 'first reply', costUsd: 0.01 }, { text: 'second reply', costUsd: 0.02 }] });
  assert.equal(engine.mode, 'fake');
  assert.equal(typeof engine.extract, 'function');
  assert.equal((await engine.call(req)).text, 'first reply');
  assert.equal((await engine.call(req)).text, 'second reply');
});

test('AC5: each call is recorded in spend_ledger with a YYYY-MM month and its cost, purpose, model and tokens', async () => {
  const db = fresh();
  const engine = createRuntimeEngine({ db, config: fakeConfig, responses: [{ text: 'ok', costUsd: 0.25, tokens: { input: 10, output: 5 } }] });
  await engine.call(req);
  const rows = db.prepare('SELECT * FROM spend_ledger').all();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.match(r.yyyymm, /^\d{4}-\d{2}$/);
  assert.equal(r.yyyymm, r.ts.slice(0, 7));
  assert.equal(r.cost_usd, 0.25);
  assert.equal(r.purpose, 'job');
  assert.equal(r.model, 'fake');
  assert.deepEqual(JSON.parse(r.tokens), { input: 10, output: 5 });
});

test('AC5: month spend is read from the ledger by YYYY-MM, so a spent month blocks calls at the cap', async () => {
  const db = fresh();
  setSetting(db, 'cap', { usd: 5 });
  spend(db, 5);
  const engine = createRuntimeEngine({ db, config: fakeConfig, responses: [{ text: 'not reached' }] });
  await assert.rejects(engine.call(req), BudgetExceededError);
  // liveness: a cap above this month's spend lets the call through
  const ok = fresh();
  setSetting(ok, 'cap', { usd: 10 });
  spend(ok, 5);
  const live = createRuntimeEngine({ db: ok, config: fakeConfig, responses: [{ text: 'reached' }] });
  assert.equal((await live.call(req)).text, 'reached');
});

test('AC5: the engine setting off throws EngineOffError before any call, on again calls', async () => {
  const db = fresh();
  const engine = createRuntimeEngine({ db, config: fakeConfig, responses: [{ text: 'after on' }] });
  setSetting(db, 'engine', { on: false });
  await assert.rejects(engine.call(req), EngineOffError);
  await assert.rejects(engine.extract({ document: { type: 'text', text: 'x' }, schema: { type: 'object' } }), EngineOffError);
  assert.equal(db.prepare('SELECT count(*) AS n FROM spend_ledger').get().n, 0, 'nothing spent while off');
  setSetting(db, 'engine', { on: true });
  assert.equal((await engine.call(req)).text, 'after on');
});

test('AC5: the cap is re-read on every call', async () => {
  const db = fresh();
  const engine = createRuntimeEngine({ db, config: fakeConfig, responses: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] });
  setSetting(db, 'cap', { usd: 0 });
  await assert.rejects(engine.call(req), BudgetExceededError);
  setSetting(db, 'cap', { usd: 200 });
  const r = await engine.call(req);
  assert.equal(typeof r.text, 'string');
  assert.ok(r.text.length > 0);
});

test('AC5: an unusable cap setting falls back to 200', async () => {
  const db = fresh();
  setSetting(db, 'cap', { usd: 'lots' });
  spend(db, 150);
  const engine = createRuntimeEngine({ db, config: fakeConfig, responses: [{ text: 'under the default cap' }] });
  assert.equal((await engine.call(req)).text, 'under the default cap');
  spend(db, 60);
  await assert.rejects(engine.call(req), BudgetExceededError, 'over 200 this month');
});

test('AC5: live mode without a readable credential fails calls with ModelCallError and never echoes the secret', async () => {
  const dir = S.dir();
  const file = join(dir, 'credential');
  const secret = 'synthetic-secret-token-for-test';
  writeFileSync(file, secret);
  chmodSync(file, 0o644); // not private, so loadCredential refuses it
  const db = fresh();
  const engine = createRuntimeEngine({ db, config: { engine: 'live', claudeCredentialFile: file } });
  assert.equal(engine.mode, 'live');
  await assert.rejects(engine.call(req), err => {
    assert.ok(err instanceof ModelCallError, `ModelCallError, got ${err && err.name}`);
    assert.equal(err.message, 'Claude credential unavailable');
    assert.ok(!String(err.stack).includes(secret) && !String(err.message).includes(file));
    return true;
  });
  const missing = createRuntimeEngine({ db, config: { engine: 'live', claudeCredentialFile: join(dir, 'absent') } });
  await assert.rejects(missing.call(req), err => err instanceof ModelCallError && err.message === 'Claude credential unavailable');
  assert.equal(db.prepare('SELECT count(*) AS n FROM spend_ledger').get().n, 0, 'nothing recorded');
});

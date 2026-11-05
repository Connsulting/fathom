// AC6 over HTTP: POST /api/engine/cap validates and persists the monthly cap, the budget figures
// follow it, and the scenario lists the latest spend ledger rows (no prompt or token fields) with a
// provenance figure per row cost.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_TIMEOUT, spawnServer, withServer, request, postJson, getScenario, openStore } from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const T2 = { timeout: SERVER_TIMEOUT * 2 };
const FAKE = { FATHOM_ENGINE: 'fake' };
const cents = n => Math.round(n * 100) / 100;

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.ok(r.json && r.json.scenario, 'response carries the scenario');
  return r.json;
}

async function readDb(file, fn) {
  const db = await openStore(file);
  try { return await fn(db); } finally { db.close(); }
}

test('cap validation rejects non-numbers, negatives, over 10000 and NaN, and accepts the bounds', T, () => withServer({ env: FAKE }, async s => {
  const bad = [{ usd: '5' }, { usd: -1 }, { usd: -0.01 }, { usd: 10000.01 }, { usd: 'NaN' }, { usd: null }, { usd: true }, {}, { usd: [5] }];
  for (const body of bad) {
    const r = await postJson(s.baseUrl, '/api/engine/cap', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
    assert.equal(typeof r.json?.error, 'string');
  }
  const raw = await postJson(s.baseUrl, '/api/engine/cap', '{"usd": NaN}');
  assert.equal(raw.status, 400);
  const before = await getScenario(s.baseUrl);
  assert.equal(before.engine.budget.monthly, 200, 'refused bodies change nothing');
  assert.equal((await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 0 }))).scenario.engine.budget.monthly, 0);
  assert.equal((await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 10000 }))).scenario.engine.budget.monthly, 10000);
  assert.equal((await request(s.baseUrl, { path: '/api/engine/cap' })).status, 405);
}));

test('the cap is rounded to cents, persisted across a restart, and drives the budget figures', T2, async () => {
  const s = await spawnServer({ env: FAKE });
  try {
    const { scenario } = await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 12.346 }));
    assert.equal(scenario.engine.budget.monthly, 12.35);
    assert.equal(scenario.fig['engine.budget.monthly'].v, 12.35);
    assert.equal(scenario.fig['engine.budget.left'].v, Math.max(0, cents(12.35 - scenario.engine.budget.used)));
  } finally {
    await s.stop();
  }
  const setting = await readDb(s.dbFile, db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'cap'").get().value));
  assert.deepEqual(setting, { usd: 12.35 });
  await withServer({ dataDir: s.dataDir, env: FAKE }, async s2 => {
    const sc = await getScenario(s2.baseUrl);
    assert.equal(sc.engine.budget.monthly, 12.35);
    assert.equal(sc.fig['engine.budget.monthly'].v, 12.35);
    const raised = await ok(postJson(s2.baseUrl, '/api/engine/cap', { usd: 250 }));
    assert.equal(raised.scenario.fig['engine.budget.left'].v, Math.max(0, cents(250 - raised.scenario.engine.budget.used)));
  });
});

test('the scenario ledger lists the latest 8 spend rows without prompt or token fields', T, () => withServer({ env: FAKE }, async s => {
  const first = await getScenario(s.baseUrl);
  assert.ok(Array.isArray(first.engine.ledger));
  assert.ok(first.engine.ledger.length > 0, 'the demo seed has spend');
  const month = first.meta.clock.slice(0, 7);
  await readDb(s.dbFile, db => {
    const insert = db.prepare("INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, 'job', ?, 'fake', ?)");
    for (let i = 0; i < 10; i++) {
      insert.run(`${first.meta.clock}T00:00:0${i}.000Z`, month, 0.11 + i / 100, JSON.stringify({ input_tokens: 5, prompt: 'SYNTHETIC-PROMPT-TEXT' }));
    }
  });
  await ok(postJson(s.baseUrl, '/api/ask', { key: 'ask', questionId: 'leave' }));
  const sc = await getScenario(s.baseUrl);
  const ledger = sc.engine.ledger;
  assert.equal(ledger.length, 8);
  for (const row of ledger) assert.deepEqual(Object.keys(row).sort(), ['cost', 'id', 'model', 'purpose', 'ts']);
  assert.ok(ledger.some(r => r.purpose === 'chat' && r.model === 'fake'), 'the newest chat spend is listed');
  const raw = (await request(s.baseUrl, { path: '/api/scenario' })).text;
  assert.ok(!raw.includes('SYNTHETIC-PROMPT-TEXT'), 'token JSON never reaches the scenario');
  assert.ok(!JSON.stringify(sc.engine.ledger).includes('tokens'));
}));

test('each listed ledger row has a provenance figure for its cost', T, () => withServer({ env: FAKE }, async s => {
  await ok(postJson(s.baseUrl, '/api/ask', { key: 'ask', questionId: 'leave' }));
  const sc = await getScenario(s.baseUrl);
  assert.ok(sc.engine.ledger.length > 0);
  for (const row of sc.engine.ledger) {
    const fig = sc.fig[`engine.ledger.${row.id}.cost`];
    assert.ok(fig, `figure for ledger row ${row.id}`);
    assert.equal(fig.v, row.cost);
    assert.equal(fig.kind, 'a');
    assert.equal(fig.src, 'spend-ledger');
    assert.equal(fig.label, `${row.purpose}, ${row.ts}`);
    assert.match(row.ts, /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/, 'ts is a display label');
  }
}));

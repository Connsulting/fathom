// Suggested goal targets through the HTTP API (plan feat-suggested-goal-targets, Interface
// contract, Routes): GET /api/goals/suggestions, POST /api/goals/:id/suggestion, and accepting a
// suggestion through the existing POST /api/goals/:id. The router runs in process over a temp real
// store with a session (serveAppFixture, as test/yearend.test.mjs does), so the owner gate applies.
//
// Synthetic household, clock 2026-11-05: Joint checking takes in 4,005 on the 10th and pays 3,005
// on the 15th of every month January to August (window Feb to Jul, spending 3,005 a month, savings
// 1,000); cash 7,000 across checking and savings; investments 500,000. Cushion target 18,100;
// independence target 36,060 / 0.04 -> 902,000, / 0.03 -> 1,202,000.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDb, serveAppFixture, request, postJson } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';

const CLOCK = '2026-11-05';
const pad = n => String(n).padStart(2, '0');

async function household(db) {
  const account = db.prepare("INSERT INTO accounts (id, inst, name, kind) VALUES (?, 'Example Bank', ?, ?)");
  await account.run('chk', 'Joint checking', 'checking');
  await account.run('sav', 'High yield savings', 'savings');
  await account.run('brk', 'Taxable brokerage', 'taxable');
  await account.run('ret', 'Rollover IRA', 'retirement');
  const txn = db.prepare("INSERT INTO transactions (account_id, date, amount, description, parser, locator) VALUES ('chk', ?, ?, ?, 'fixture', 'row')");
  for (let m = 1; m <= 8; m++) {
    await txn.run(`2026-${pad(m)}-10`, 4005, 'Paycheck');
    await txn.run(`2026-${pad(m)}-15`, -3005, 'Rent');
  }
  const balance = db.prepare("INSERT INTO balances (account_id, date, amount, parser, locator) VALUES (?, '2026-10-31', ?, 'fixture', 'balance')");
  await balance.run('chk', 2000);
  await balance.run('sav', 5000);
  await balance.run('ret', 200000);
  await db.prepare("INSERT INTO positions (account_id, as_of, symbol, value, parser, locator) VALUES ('brk', '2026-10-31', 'FUNDA', 300000, 'fixture', 'row')").run();
}

async function serve(t) {
  const s = await tempDb();
  await setSetting(s.db, 'clock', CLOCK);
  await setSetting(s.db, 'mode', 'real');
  await setSetting(s.db, 'onboarding', { done: true, step: 6 });
  await household(s.db);
  const srv = await serveAppFixture({ authenticated: true, db: s.db, config: { clock: CLOCK, dataDir: s.dataDir }, answerer: null });
  t.after(async () => { await srv.close(); await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  return { ...srv, db: s.db };
}

async function ok(p) {
  const r = await p;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}
async function fails(p, status) {
  const r = await p;
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.equal(typeof r.json?.error, 'string', 'error body is { error }');
}

const create = async (srv, body) => (await ok(srv.postJson('/api/goals', body))).goal.id;
const suggestion = (srv, id, body) => srv.postJson(`/api/goals/${encodeURIComponent(id)}/suggestion`, body);
const recOf = (list, id) => list.find(s => s.goalId === id);

async function goals(srv) {
  const cushion = await create(srv, { title: 'A cash cushion', horizon: '1-3y' });
  const free = await create(srv, { title: 'Work less, on our terms', horizon: '3-10y' });
  const kids = await create(srv, { title: 'Kids and family' });
  const boat = await create(srv, { title: 'A cash cushion for the boat', target: 10000, targetDate: '2028-01-01', track: { accounts: ['sav'] } });
  await srv.db.prepare("INSERT INTO goals (id, def, sort, origin, created_at, updated_at) VALUES ('seedgoal', ?, 99, 'seed', ?, ?)")
    .run(JSON.stringify({ id: 'seedgoal', title: 'A cash reserve', prose: 'Seed prose.' }), CLOCK, CLOCK);
  return { cushion, free, kids, boat, seed: 'seedgoal' };
}

test('GET /api/goals/suggestions: one record per untargeted owner goal, behind the owner gate', async t => {
  const srv = await serve(t);
  const g = await goals(srv);

  assert.equal((await request(srv.baseUrl, { path: '/api/goals/suggestions' })).status, 401, 'no session, no suggestions');
  assert.equal((await postJson(srv.baseUrl, `/api/goals/${g.cushion}/suggestion`, { action: 'dismiss' })).status, 401, 'no session, no dismiss');

  const body = await ok(srv.request({ path: '/api/goals/suggestions' }));
  assert.equal(body.clock, CLOCK);
  // Fathom adopted the cushion and work-optional targets on create; only the question remains.
  assert.deepEqual(body.suggestions.map(s => s.goalId), [g.kids]);
  const kids = recOf(body.suggestions, g.kids);
  assert.equal(kids.state, 'question');
  assert.equal(kids.accept, null);

  // The same records ride on the scenario, next to the adopted targets.
  const sc = await srv.getScenario();
  assert.deepEqual(sc.suggestions, body.suggestions);
  assert.equal(sc.fig[`goal.${g.cushion}.target`].v, 18100);
  assert.equal(sc.fig[`goal.${g.free}.target`].v, 902000);
  assert.equal(sc.fig[`goal.${g.boat}.target`].src, 'goal-target', 'a typed target is untouched');
});

test('POST /api/goals/:id/suggestion undoes an adopted target; bad input is refused', async t => {
  const srv = await serve(t);
  const g = await goals(srv);

  for (const bad of [{ withdrawalRate: 0.03 }, { action: 'dismiss' }, { action: 'restore' }, { action: 'explode' },
    { action: 'undo', withdrawalRate: 0.03 }, {}]) {
    await fails(suggestion(srv, g.free, bad), 400);
  }
  assert.equal((await srv.getScenario()).fig[`goal.${g.free}.target`].v, 902000, 'refused bodies change nothing');
  const { scenario } = await ok(suggestion(srv, g.free, { action: 'undo' }));
  assert.equal(recOf(scenario.suggestions, g.free).state, 'declined');
  assert.equal(scenario.fig[`goal.${g.free}.target`], undefined);
  await fails(suggestion(srv, 'gnosuchgoal0', { action: 'undo' }), 404);
  await fails(suggestion(srv, g.seed, { action: 'undo' }), 409);
  await fails(suggestion(srv, g.boat, { action: 'undo' }), 409);
});

test('an adopted target puts the goal on pace with calculator provenance', async t => {
  const srv = await serve(t);
  const g = await goals(srv);
  const scenario = await srv.getScenario();
  const pace = scenario.pace.goals.find(p => p.id === g.cushion);
  assert.ok(pace, 'the adopted goal is on pace');
  assert.equal(pace.target.v, 18100);
  assert.equal(scenario.fig[`goal.${g.cushion}.target`].src, 'calc:targets');
  assert.equal(scenario.src['calc:targets'].label, 'Suggested target calculator');
});


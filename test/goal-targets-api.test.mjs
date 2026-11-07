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

function household(db) {
  const account = db.prepare("INSERT INTO accounts (id, inst, name, kind) VALUES (?, 'Example Bank', ?, ?)");
  account.run('chk', 'Joint checking', 'checking');
  account.run('sav', 'High yield savings', 'savings');
  account.run('brk', 'Taxable brokerage', 'taxable');
  account.run('ret', 'Rollover IRA', 'retirement');
  const txn = db.prepare("INSERT INTO transactions (account_id, date, amount, description, parser, locator) VALUES ('chk', ?, ?, ?, 'fixture', 'row')");
  for (let m = 1; m <= 8; m++) {
    txn.run(`2026-${pad(m)}-10`, 4005, 'Paycheck');
    txn.run(`2026-${pad(m)}-15`, -3005, 'Rent');
  }
  const balance = db.prepare("INSERT INTO balances (account_id, date, amount, parser, locator) VALUES (?, '2026-10-31', ?, 'fixture', 'balance')");
  balance.run('chk', 2000);
  balance.run('sav', 5000);
  balance.run('ret', 200000);
  db.prepare("INSERT INTO positions (account_id, as_of, symbol, value, parser, locator) VALUES ('brk', '2026-10-31', 'FUNDA', 300000, 'fixture', 'row')").run();
}

async function serve(t) {
  const s = await tempDb();
  setSetting(s.db, 'clock', CLOCK);
  setSetting(s.db, 'mode', 'real');
  setSetting(s.db, 'onboarding', { done: true, step: 6 });
  household(s.db);
  const srv = await serveAppFixture({ authenticated: true, db: s.db, config: { clock: CLOCK, dataDir: s.dataDir }, answerer: null });
  t.after(async () => { await srv.close(); s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
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
  srv.db.prepare("INSERT INTO goals (id, def, sort, origin, created_at, updated_at) VALUES ('seedgoal', ?, 99, 'seed', ?, ?)")
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
  assert.deepEqual(body.suggestions.map(s => s.goalId).sort(), [g.cushion, g.free, g.kids].sort());
  const cushion = recOf(body.suggestions, g.cushion);
  assert.equal(cushion.state, 'suggested');
  assert.equal(cushion.accept.target, 18100);
  assert.equal(recOf(body.suggestions, g.free).accept.target, 902000);
  const kids = recOf(body.suggestions, g.kids);
  assert.equal(kids.state, 'question');
  assert.equal(kids.accept, null);

  // The same records ride on the scenario.
  const sc = await srv.getScenario();
  assert.deepEqual(sc.suggestions, body.suggestions);
});

test('POST /api/goals/:id/suggestion dismisses, restores and sets the withdrawal rate; bad input is refused', async t => {
  const srv = await serve(t);
  const g = await goals(srv);

  let { scenario } = await ok(suggestion(srv, g.cushion, { action: 'dismiss' }));
  assert.equal(recOf(scenario.suggestions, g.cushion).state, 'dismissed');
  assert.equal(recOf((await ok(srv.request({ path: '/api/goals/suggestions' }))).suggestions, g.cushion).state, 'dismissed', 'the dismissal persists');
  ({ scenario } = await ok(suggestion(srv, g.cushion, { action: 'restore' })));
  assert.equal(recOf(scenario.suggestions, g.cushion).state, 'suggested');

  ({ scenario } = await ok(suggestion(srv, g.free, { withdrawalRate: 0.03 })));
  const free = recOf(scenario.suggestions, g.free);
  assert.equal(free.params.withdrawalRate, 0.03);
  assert.equal(scenario.fig[free.figures.target].v, 1202000, '36,060 / 0.03');
  assert.equal(free.accept.target, 1202000);

  for (const bad of [{ withdrawalRate: 0.5 }, { withdrawalRate: 0.01 }, { withdrawalRate: '0.03' }, { action: 'explode' },
    { action: 'dismiss', withdrawalRate: 0.03 }, {}]) {
    await fails(suggestion(srv, g.free, bad), 400);
  }
  assert.equal(recOf((await srv.getScenario()).suggestions, g.free).params.withdrawalRate, 0.03, 'refused bodies change nothing');
  await fails(suggestion(srv, 'gnosuchgoal0', { action: 'dismiss' }), 404);
  await fails(suggestion(srv, g.seed, { action: 'dismiss' }), 409);
});

test('accepting a suggestion through POST /api/goals/:id targets the goal and its pace', async t => {
  const srv = await serve(t);
  const g = await goals(srv);
  const before = await srv.getScenario();
  const record = recOf(before.suggestions, g.cushion);
  assert.equal(before.fig[`suggest.${g.free}.target`].src, 'calc:targets');
  assert.equal(before.fig[record.figures.target].src, 'calc:targets');
  assert.equal(before.src['calc:targets'].label, 'Suggested target calculator');

  const { scenario } = await ok(srv.postJson(`/api/goals/${g.cushion}`, record.accept));
  assert.equal(recOf(scenario.suggestions, g.cushion), undefined, 'an accepted goal has a target and no suggestion');
  const pace = scenario.pace.goals.find(p => p.id === g.cushion);
  assert.ok(pace, 'the accepted goal is on pace');
  assert.equal(pace.target.v, 18100);
  assert.equal(pace.targetDate, record.accept.targetDate);
  assert.ok(recOf(scenario.suggestions, g.free), 'other suggestions remain');
  assert.equal(scenario.fig[`suggest.${g.free}.target`].src, 'calc:targets');
  assert.equal(scenario.src['calc:targets'].label, 'Suggested target calculator');
});

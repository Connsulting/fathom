// Goals without forms (SX3): Fathom adopts a suggested target by itself, records it as "Fathom set
// this target" with Undo, and a declined suggestion is never adopted again. The withdrawal rate
// comes from a remembered preference (default 4%), not an input. A done goal archives itself.
//
// Synthetic household, clock 2026-11-05 (the same one test/goal-targets-api.test.mjs uses): Joint
// checking takes in 4,005 on the 10th and pays 3,005 on the 15th of every month January to August;
// cash 7,000 across checking and savings; investments 500,000. Cushion target 18,100; independence
// target 36,060 / 0.04 -> 902,000, / 0.03 -> 1,202,000.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDb, serveAppFixture } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { adoptSuggestions } from '../src/goals/write.mjs';
import { callTool } from '../src/tools/index.mjs';

const CLOCK = '2026-11-05';
const NOW = '2026-11-05T12:00:00.000Z';
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

async function serve(t, { data = true } = {}) {
  const s = await tempDb();
  setSetting(s.db, 'clock', CLOCK);
  setSetting(s.db, 'mode', 'real');
  setSetting(s.db, 'onboarding', { done: true, step: 6 });
  if (data) household(s.db);
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
}

const create = async (srv, body) => ok(srv.postJson('/api/goals', body));
const undo = (srv, id) => srv.postJson(`/api/goals/${encodeURIComponent(id)}/suggestion`, { action: 'undo' });
const scenarioOf = async srv => ok(srv.request({ path: '/api/scenario' }));
const goalOf = (sc, id) => sc.goals.find(g => g.id === id);
const recOf = (sc, id) => sc.suggestions.find(s => s.goalId === id);
const remember = (db, text) => db.prepare("INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)")
  .run('p' + Math.random().toString(16).slice(2), text, NOW, NOW);

test('a new goal gets the calculator target at once, marked as set by Fathom, with calc:targets provenance', async t => {
  const srv = await serve(t);
  const { scenario, goal } = await create(srv, { title: 'A cash cushion', horizon: '1-3y' });
  assert.equal(goal.target, 18100, 'the suggested cushion target is adopted');
  assert.deepEqual(goal.track, { accounts: ['chk', 'sav'] });
  assert.ok(goal.adopted && typeof goal.adopted.at === 'string', 'the goal records that Fathom set its target');
  const fig = scenario.fig[`goal.${goal.id}.target`];
  assert.equal(fig.v, 18100);
  assert.equal(fig.src, 'calc:targets', 'an adopted target keeps the calculator provenance');
  assert.ok(scenario.src['calc:targets'], 'the calc:targets source is described');
  assert.equal(recOf(scenario, goal.id), undefined, 'an adopted goal has no pending suggestion');
  const g = goalOf(scenario, goal.id);
  assert.ok(g.progress || g.trackWaiting, JSON.stringify(g));
});

test('Undo restores the previous values and declines the suggestion', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'A cash cushion', horizon: '1-3y', targetDate: '2027-06-30', track: { accounts: ['sav'] } });
  assert.equal(goal.target, 18100);
  const { scenario } = await ok(undo(srv, goal.id));
  const after = goalOf(scenario, goal.id);
  assert.equal(after.target ?? null, null, 'the target is gone again');
  assert.equal(after.targetDate, '2027-06-30', 'the owner date is back');
  assert.deepEqual(after.track, { accounts: ['sav'] }, 'the owner track is back');
  assert.equal(after.adopted ?? null, null);
  assert.equal(scenario.fig[`goal.${goal.id}.target`], undefined, 'no target figure');
  assert.equal(recOf(scenario, goal.id).state, 'declined');
  await fails(undo(srv, goal.id), 409);
});

test('a declined suggestion is never adopted again, even when the goal or its inputs change', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'A cash cushion', horizon: '1-3y' });
  await ok(undo(srv, goal.id));
  assert.deepEqual(adoptSuggestions(srv.db, { now: NOW, clock: CLOCK }), [], 'the planner pass adopts nothing');
  const edited = await ok(srv.postJson(`/api/goals/${goal.id}`, { title: 'A bigger cash cushion', horizon: 'now' }));
  assert.equal(edited.goal.target ?? null, null, 'an edit does not bring it back');
  srv.db.prepare("INSERT INTO transactions (account_id, date, amount, description, parser, locator) VALUES ('chk', '2026-09-15', -5000, 'Roof', 'fixture', 'row')").run();
  assert.deepEqual(adoptSuggestions(srv.db, { now: NOW, clock: CLOCK }), []);
  const sc = await scenarioOf(srv);
  assert.equal(goalOf(sc, goal.id).target ?? null, null);
  assert.equal(recOf(sc, goal.id).state, 'declined');
});

test('the planner pass adopts a goal once its data arrives; an owner target is never replaced', async t => {
  const srv = await serve(t, { data: false });
  const { goal } = await create(srv, { title: 'A cash cushion', horizon: '1-3y' });
  assert.equal(goal.target ?? null, null, 'no data, no target');
  const typed = (await create(srv, { title: 'An emergency fund', target: 5000 })).goal;
  household(srv.db);
  assert.deepEqual(adoptSuggestions(srv.db, { now: NOW, clock: CLOCK }), [goal.id]);
  const sc = await scenarioOf(srv);
  assert.equal(goalOf(sc, goal.id).target, 18100);
  assert.equal(goalOf(sc, typed.id).target, 5000);
  assert.equal(sc.fig[`goal.${typed.id}.target`].src, 'goal-target', 'a typed target stays the owner\'s');
  assert.deepEqual(adoptSuggestions(srv.db, { now: NOW, clock: CLOCK }), [], 'a second pass changes nothing');
});

test('an owner edit of the target takes it over: no Undo, owner provenance', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'A cash cushion', horizon: '1-3y' });
  const { scenario } = await ok(srv.postJson(`/api/goals/${goal.id}`, { target: 20000 }));
  const g = goalOf(scenario, goal.id);
  assert.equal(g.target, 20000);
  assert.equal(g.adopted ?? null, null);
  assert.equal(scenario.fig[`goal.${goal.id}.target`].src, 'goal-target');
  await fails(undo(srv, goal.id), 409);
});

test('the withdrawal rate comes from a remembered preference, default 4%; a Fathom-set target follows it', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'Work less, on our terms', horizon: '3-10y' });
  assert.equal(goal.target, 902000, '4% by default');
  remember(srv.db, 'Use a 3% withdrawal rate for retirement math');
  assert.deepEqual(adoptSuggestions(srv.db, { now: NOW, clock: CLOCK }), [goal.id]);
  const sc = await scenarioOf(srv);
  assert.equal(goalOf(sc, goal.id).target, 1202000);
  assert.ok(goalOf(sc, goal.id).adopted, 'still set by Fathom');
  assert.match(sc.fig[`goal.${goal.id}.target`].notes.join(' '), /Withdrawal rate: 3% a year/);
  // Undo still restores the owner's value from before the first adoption.
  const { scenario } = await ok(undo(srv, goal.id));
  assert.equal(goalOf(scenario, goal.id).target ?? null, null);
  // The old per-goal rate input is gone.
  await fails(srv.postJson(`/api/goals/${goal.id}/suggestion`, { withdrawalRate: 0.03 }), 400);
});

test('marking a goal done archives it; restoring reopens it', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'Kids and family' });
  const done = (await ok(srv.postJson(`/api/goals/${goal.id}`, { status: 'done' }))).scenario;
  assert.equal(goalOf(done, goal.id).archived, true);
  assert.ok(goalOf(done, goal.id).doneAt);
  const back = (await ok(srv.postJson(`/api/goals/${goal.id}/archive`, { archived: false }))).scenario;
  assert.equal(goalOf(back, goal.id).archived, false);
  assert.equal(goalOf(back, goal.id).status, 'open');
});

test('the effort curve defaults to "Do not make me think"', async t => {
  const srv = await serve(t);
  const sc = await scenarioOf(srv);
  assert.equal(sc.curve.find(c => c.id === 'effort').value, 1);
});

// Ask's tools, as the owner's turn calls them (test/goal-kinds-api.test.mjs uses the same context).
const toolCtx = (db, ownerText) => ({ db, now: NOW, actorId: 'person-a', ownerText, conversationKey: 'ask:0123456789ab', turnId: 'turn-a' });
const undoReceipt = (ctx, id) => callTool('undo', { operation: 'undo', id }, { ...ctx, channel: 'mcp' });

test('a goal Ask creates gets its target before the receipt is written, so Undo on the receipt works', async t => {
  const srv = await serve(t);
  const ctx = toolCtx(srv.db, 'Add a goal: A cash cushion for the next few years');
  const out = await callTool('update_goal', { operation: 'create', title: 'A cash cushion for the next few years', horizon: '1-3y' }, ctx);
  assert.equal(out.goal.target, 18100, 'the created goal already carries the adopted target');
  assert.ok(out.goal.adopted);
  await undoReceipt(ctx, out.receipt.id);
  assert.equal(goalOf(await scenarioOf(srv), out.goal.id), undefined, 'undoing the create removes the goal');
});

test('remembering and undoing a withdrawal rate both move a target Fathom set', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'Work less, on our terms', horizon: '3-10y' });
  const ctx = toolCtx(srv.db, 'Remember this: Use a 3% withdrawal rate');
  const out = await callTool('update_preferences', { operation: 'remember', text: 'Use a 3% withdrawal rate', evidence: 'Use a 3% withdrawal rate' }, ctx);
  assert.equal(goalOf(await scenarioOf(srv), goal.id).target, 1202000);
  await undoReceipt(ctx, out.receipt.id);
  assert.equal(goalOf(await scenarioOf(srv), goal.id).target, 902000, 'back to the default rate');
});

test('a new date on a Fathom-set target keeps the target Fathom\'s and the date the owner\'s', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'A cash cushion', horizon: '1-3y' });
  const { scenario } = await ok(srv.postJson(`/api/goals/${goal.id}`, { targetDate: '2028-01-31' }));
  const g = goalOf(scenario, goal.id);
  assert.ok(g.adopted, 'still set by Fathom');
  assert.equal(g.targetDate, '2028-01-31');
  assert.equal(scenario.fig[`goal.${goal.id}.target`].src, 'calc:targets');
  remember(srv.db, 'Use a 3% withdrawal rate');
  srv.db.prepare("INSERT INTO transactions (account_id, date, amount, description, parser, locator) VALUES ('chk', '2026-07-20', -600, 'Repair', 'fixture', 'row')").run();
  adoptSuggestions(srv.db, { now: NOW, clock: CLOCK });
  const later = goalOf(await scenarioOf(srv), goal.id);
  assert.notEqual(later.target, 18100, 'the target follows the calculator');
  assert.equal(later.targetDate, '2028-01-31', 'a later pass keeps the owner date');
  const after = goalOf((await ok(undo(srv, goal.id))).scenario, goal.id);
  assert.equal(after.target ?? null, null);
  assert.equal(after.targetDate, '2028-01-31', 'Undo keeps the date the owner set');
});

test('a goal that stops being a balance goal leaves adoption behind', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'A cash cushion', horizon: '1-3y' });
  const { scenario } = await ok(srv.postJson(`/api/goals/${goal.id}`, { kind: 'range', targetLow: 10000, targetHigh: 20000 }));
  assert.equal(goalOf(scenario, goal.id).adopted ?? null, null);
  await fails(undo(srv, goal.id), 409);
});

test('a goal created done is archived too', async t => {
  const srv = await serve(t);
  const { goal } = await create(srv, { title: 'Kids and family', status: 'done' });
  assert.equal(goal.archived, true);
  assert.equal(goal.status, 'done');
});

test('a remembered preference that names one end of a tradeoff moves that axis', async t => {
  const srv = await serve(t);
  remember(srv.db, 'We would rather keep cash flexible');
  remember(srv.db, 'Optimize everything you can');
  const sc = await scenarioOf(srv);
  const at = id => sc.curve.find(c => c.id === id).value;
  assert.equal(at('tax_cash'), 1);
  assert.equal(at('effort'), 0);
  assert.equal(at('human'), 0.5, 'an axis no memory names keeps its position');
});

test('a negated tradeoff end is not read as a choice of that end', async t => {
  const srv = await serve(t);
  remember(srv.db, 'I do not want to optimize everything');
  remember(srv.db, 'Max retirement room over lifestyle now');
  const sc = await scenarioOf(srv);
  const at = id => sc.curve.find(c => c.id === id).value;
  assert.equal(at('effort'), 1, 'the default stays: the negated end is skipped');
  assert.equal(at('ret_life'), 0, 'the end the owner chose wins; the one after "over" is not a choice');
});

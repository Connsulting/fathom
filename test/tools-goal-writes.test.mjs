import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, householdOf } from './helpers/real-store.mjs';
import { serveAppFixture } from './helpers/server.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';
import { createGoal } from '../src/goals/write.mjs';
import { getSetting, setSetting } from '../src/store/db.mjs';
import { CURVE_AXES } from '../src/shared/goals.mjs';

const S = scratch('fathom-goal-writes-');
after(() => S.cleanup());
const CLOCK = '2026-11-05';
const NOW = CLOCK + 'T12:00:00.000Z';
async function store() {
  const db = await S.store();
  const household = householdOf(db);
  return { db, household, services: household.services, actorId: 'owner-test', channel: 'mcp', clock: CLOCK, now: NOW };
}
const call = (ctx, operation, args) => callTool('update_goal', { operation, ...args }, ctx);
const add = (ctx, fields = {}) => createGoal(ctx.db, { title: 'Work less, on our terms', ...fields }, { now: NOW });
const undo = (ctx, result) => callTool('undo', result.undo.args, ctx);

test('archive matches HTTP and Undo preserves completion and all goal fields', async t => {
  const ctx = await store();
  const row = add(ctx, { title: 'Kitchen remodel', target: 12000, status: 'done' });
  const result = await call(ctx, 'archive', { id: row.id });
  assert.deepEqual(result.goal, { id: row.id, archived: true });
  await undo(ctx, result);
  const restored = ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id);
  assert.equal(restored.archived_at, null);
  assert.equal(restored.done_at, row.done_at);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const route = await srv.postJson(`/api/goals/${row.id}/archive`);
  assert.equal(route.status, 200, route.text);
  assert.equal(route.json.goal.archived, true);
});

test('delete restores every column and refuses a later row or a seed goal', async t => {
  const ctx = await store();
  const row = add(ctx, { title: 'Reserve floor', kind: 'floor', floor: 9000, track: { accounts: [ctx.db.prepare('SELECT id FROM accounts LIMIT 1').get().id] }, status: 'done' });
  const result = await call(ctx, 'delete', { id: row.id });
  assert.equal(result.deleted, row.id);
  assert.equal(ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id), undefined);
  await undo(ctx, result);
  assert.deepEqual(ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id), row);
  const later = await call(ctx, 'delete', { id: row.id });
  const columns = Object.keys(row);
  ctx.db.prepare(`INSERT INTO goals (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(k => row[k]));
  await assert.rejects(undo(ctx, later), { code: 'conflict' });
  ctx.db.prepare("UPDATE goals SET origin = 'seed' WHERE id = ?").run(row.id);
  await assert.rejects(call(ctx, 'delete', { id: row.id }), { code: 'conflict' });
  ctx.db.prepare("UPDATE goals SET origin = 'owner' WHERE id = ?").run(row.id);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  assert.equal((await srv.postJson(`/api/goals/${row.id}/delete`)).status, 200);
  assert.equal(ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id), undefined);
});

test('suggestions match HTTP; dismiss, restore and sourced rates undo settings', async t => {
  const ctx = await store();
  const row = add(ctx);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const list = await callTool('goals', { operation: 'suggestions' }, ctx);
  const route = await srv.request({ path: '/api/goals/suggestions' });
  assert.equal(route.status, 200);
  assert.deepEqual(list, route.json);
  assert.ok(list.suggestions.some(g => g.goalId === row.id));
  const dismissed = await call(ctx, 'suggestion', { id: row.id, action: 'dismiss' });
  assert.equal(dismissed.suggestion.dismissed, true);
  const restored = await call(ctx, 'suggestion', { id: row.id, action: 'restore' });
  assert.equal(restored.suggestion.dismissed, false);
  await undo(ctx, restored);
  assert.ok(getSetting(ctx.db, 'goals.suggestions')[row.id].dismissed);
  await undo(ctx, dismissed);
  assert.equal(getSetting(ctx.db, 'goals.suggestions', null), null);
  const rate = await call(ctx, 'suggestion', { id: row.id, withdrawalRate: { value: 0.035, source: 'owner', evidence: '3.5 percent' } });
  assert.equal(rate.suggestion.withdrawalRate, 0.035);
  await undo(ctx, rate);
  assert.equal(getSetting(ctx.db, 'goals.suggestions', null), null);
  assert.equal((await srv.postJson(`/api/goals/${row.id}/suggestion`, { withdrawalRate: 0.035 })).status, 200);
  assert.equal(getSetting(ctx.db, 'goals.suggestions')[row.id].withdrawalRate, 0.035);
});

test('suggestion validation refuses ambiguous, fabricated, unavailable and out of range changes', async () => {
  const ctx = await store();
  const row = add(ctx);
  for (const args of [{}, { action: 'dismiss', withdrawalRate: { value: 0.04, source: 'default' } },
    { withdrawalRate: { value: 0.07, source: 'owner', evidence: '7 percent' } },
    { withdrawalRate: { value: 0.035, source: 'owner', evidence: '4 percent' } }]) {
    await assert.rejects(call(ctx, 'suggestion', { id: row.id, ...args }), { code: 'bad_input' });
  }
  await assert.rejects(call({ ...ctx, channel: 'ask' }, 'suggestion', { id: row.id, withdrawalRate: { value: 0.035, source: 'owner', evidence: '3.5 percent' } }),
    { code: 'bad_input' }, 'Ask needs owner statements');
  const valid = { ...ctx, channel: 'ask', ownerStatements: () => ['Use 3.5 percent for this goal.'] };
  await call(valid, 'suggestion', { id: row.id, withdrawalRate: { value: 0.035, source: 'owner', evidence: '3.5 percent' } });
  const target = add(ctx, { target: 1000 });
  await assert.rejects(call(ctx, 'suggestion', { id: target.id, action: 'dismiss' }), { code: 'conflict' });
});

test('curve matches the route, merges known axes, rounds and undoes the full setting', async t => {
  const ctx = await store();
  const axis = CURVE_AXES[0].id;
  const result = await callTool('update_preferences', { operation: 'curve', positions: { [axis]: 0.735 } }, ctx);
  assert.equal(result.positions[axis], 0.74);
  await undo(ctx, result);
  assert.equal(getSetting(ctx.db, 'curve.positions', null), null);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  assert.equal((await srv.postJson('/api/curve', { positions: { [axis]: 0.735 } })).status, 200);
  assert.equal((await srv.postJson('/api/curve', { id: [axis], value: 0.5 })).status, 400);
  assert.deepEqual(getSetting(ctx.db, 'curve.positions'), result.positions);
  for (const positions of [{}, { nonexistent: 0.5 }, { [axis]: 2 }]) {
    await assert.rejects(callTool('update_preferences', { operation: 'curve', positions }, ctx), { code: 'bad_input' });
  }
});

test('goal proposal basis covers settings and suggestions inputs, and proposals write nothing', async () => {
  const ctx = await store();
  const row = add(ctx);
  let pending;
  const tool = proposalTools([getTool('update_goal')])[0];
  await tool.handler({ operation: 'suggestion', id: row.id, action: 'dismiss', propose: true }, { ...ctx, onProposal: p => { pending = p; } });
  assert.equal(getSetting(ctx.db, 'goals.suggestions', null), null);
  setSetting(ctx.db, 'goals.suggestions', { [row.id]: { dismissed: 'later' } });
  assert.notEqual(proposalBasis(ctx.db, pending.tool, pending.scopes, pending.args), pending.basis);
  const basis = () => proposalBasis(ctx.db, 'update_preferences', ['write:preferences'], { positions: { [CURVE_AXES[0].id]: 0.7 } });
  const before = basis();
  setSetting(ctx.db, 'curve.positions', { [CURVE_AXES[0].id]: 0.2 });
  assert.notEqual(basis(), before);
});

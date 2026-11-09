import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, householdOf } from './helpers/real-store.mjs';
import { serveAppFixture } from './helpers/server.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';
import { createGoal, adoptSuggestions } from '../src/goals/write.mjs';
import { getSetting, setSetting } from '../src/store/db.mjs';
import { CURVE_AXES } from '../src/shared/goals.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { loadCurve, loadContent, buildScenario } from '../src/scenario/build.mjs';

const S = scratch('fathom-goal-writes-');
after(async () => await S.cleanup());
const CLOCK = '2026-11-05';
const NOW = CLOCK + 'T12:00:00.000Z';
async function store() {
  const db = await S.store();
  const household = householdOf(db);
  return { db, household, services: household.services, actorId: 'owner-test', channel: 'mcp', clock: CLOCK, now: NOW };
}
const call = (ctx, operation, args) => callTool('update_goal', { operation, ...args }, ctx);
const add = async (ctx, fields = {}) => await createGoal(ctx.db, { title: 'Work less, on our terms', ...fields }, { now: NOW });
const undo = (ctx, result) => callTool('undo', result.undo.args, ctx);

test('archive matches HTTP and Undo preserves completion and all goal fields', async t => {
  const ctx = await store();
  const row = await add(ctx, { title: 'Kitchen remodel', target: 12000 });
  await ctx.db.prepare('UPDATE goals SET done_at = ? WHERE id = ?').run(NOW, row.id);
  row.done_at = NOW;
  const result = await call(ctx, 'archive', { id: row.id });
  assert.deepEqual(result.goal, { id: row.id, archived: true });
  await undo(ctx, result);
  const restored = await ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id);
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
  const row = await add(ctx, { title: 'Reserve floor', kind: 'floor', floor: 9000, track: { accounts: [(await ctx.db.prepare('SELECT id FROM accounts LIMIT 1').get()).id] }, status: 'done' });
  const result = await call(ctx, 'delete', { id: row.id });
  assert.equal(result.deleted, row.id);
  assert.equal(await ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id), undefined);
  await undo(ctx, result);
  assert.deepEqual(await ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id), row);
  const later = await call(ctx, 'delete', { id: row.id });
  const columns = Object.keys(row);
  await ctx.db.prepare(`INSERT INTO goals (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(k => row[k]));
  await assert.rejects(undo(ctx, later), { code: 'conflict' });
  await ctx.db.prepare("UPDATE goals SET origin = 'seed' WHERE id = ?").run(row.id);
  await assert.rejects(call(ctx, 'delete', { id: row.id }), { code: 'conflict' });
  await ctx.db.prepare("UPDATE goals SET origin = 'owner' WHERE id = ?").run(row.id);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  assert.equal((await srv.postJson(`/api/goals/${row.id}/delete`)).status, 200);
  assert.equal(await ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id), undefined);
});

test('suggestion Undo matches HTTP, restores prior values and remains declined across adoption passes', async t => {
  const ctx = await store();
  const row = await add(ctx);
  assert.ok(JSON.parse(row.def).adopted);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const list = await callTool('goals', { operation: 'suggestions' }, ctx);
  assert.deepEqual(list, (await srv.request({ path: '/api/goals/suggestions' })).json);
  const result = await call(ctx, 'suggestion', { id: row.id, action: 'undo' });
  assert.deepEqual(result.suggestion, { goalId: row.id, adopted: false, declined: true });
  const declined = JSON.parse((await ctx.db.prepare('SELECT def FROM goals WHERE id = ?').get(row.id)).def);
  assert.equal(declined.target ?? null, null);
  assert.equal(declined.adopted ?? null, null);
  assert.equal((await getSetting(ctx.db, 'goals.suggestions'))[row.id].declined, true);
  await adoptSuggestions(ctx.db, { now: NOW, clock: CLOCK });
  assert.equal(JSON.parse((await ctx.db.prepare('SELECT def FROM goals WHERE id = ?').get(row.id)).def).target ?? null, null);
  await undo(ctx, result);
  assert.deepEqual(await ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(row.id), row);
  assert.equal(await getSetting(ctx.db, 'goals.suggestions', null), null);
  const route = await srv.postJson(`/api/goals/${row.id}/suggestion`, { action: 'undo' });
  assert.equal(route.status, 200, route.text);
  assert.equal((await getSetting(ctx.db, 'goals.suggestions'))[row.id].declined, true);
  assert.deepEqual(JSON.parse((await ctx.db.prepare('SELECT def FROM goals WHERE id = ?').get(row.id)).def), declined);
});

test('suggestion operations refuse removed inputs and goals with no Fathom-set target', async () => {
  const ctx = await store();
  const row = await add(ctx);
  for (const args of [{}, { action: 'dismiss' }, { action: 'restore' }, { withdrawalRate: { value: 0.035, source: 'owner' } }]) {
    await assert.rejects(call(ctx, 'suggestion', { id: row.id, ...args }), { code: 'bad_input' });
  }
  const target = await add(ctx, { target: 1000 });
  await assert.rejects(call(ctx, 'suggestion', { id: target.id, action: 'undo' }), { code: 'conflict' });
  const result = await call(ctx, 'suggestion', { id: row.id, action: 'undo' });
  await ctx.db.prepare("UPDATE goals SET updated_at = 'later' WHERE id = ?").run(row.id);
  await assert.rejects(undo(ctx, result), { code: 'conflict' });
});

test('curve writes remembered positions, matches HTTP and undoes without a second store', async t => {
  const ctx = await store();
  const axis = CURVE_AXES[0].id;
  const result = await callTool('update_preferences', { operation: 'curve', positions: { [axis]: 0.735 } }, ctx);
  assert.equal(result.positions[axis], 0.74);
  await undo(ctx, result);
  assert.equal(await getSetting(ctx.db, 'curve.positions', null), null);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  assert.equal((await srv.postJson('/api/curve', { positions: { [axis]: 0.735 } })).status, 200);
  assert.equal((await srv.postJson('/api/curve', { id: [axis], value: 0.5 })).status, 400);
  const actual = Object.fromEntries((await loadCurve(ctx.db, await loadContent(ctx.db))).map(a => [a.id, a.value]));
  assert.deepEqual(actual, result.positions);
  assert.equal(await getSetting(ctx.db, 'curve.positions', null), null);
  assert.ok((await ctx.db.prepare('SELECT text FROM preferences').all()).some(p => p.text.includes(CURVE_AXES[0].right)));
  assert.equal((await buildScenario(ctx.db, { clock: CLOCK })).onboarding.priorities.find(p => p.id === axis).value, 0.74);
  for (const positions of [{}, { nonexistent: 0.5 }, { [axis]: 2 }]) {
    await assert.rejects(callTool('update_preferences', { operation: 'curve', positions }, ctx), { code: 'bad_input' });
  }
});

test('goal proposal basis covers settings and suggestions inputs, and proposals write nothing', async () => {
  const ctx = await store();
  const row = await add(ctx);
  let pending;
  const tool = proposalTools([getTool('update_goal')])[0];
  await tool.handler({ operation: 'suggestion', id: row.id, action: 'undo', propose: true }, { ...ctx, onProposal: p => { pending = p; } });
  assert.equal(await getSetting(ctx.db, 'goals.suggestions', null), null);
  await setSetting(ctx.db, 'ask.titleRejects', { unparsable: 1 });
  await setSetting(ctx.db, 'ask.titleRetried.ask:0123456789ab', true);
  assert.equal(await proposalBasis(ctx.db, pending.tool, pending.scopes, pending.args), pending.basis);
  await setSetting(ctx.db, 'goals.suggestions', { [row.id]: { declined: true } });
  assert.notEqual(await proposalBasis(ctx.db, pending.tool, pending.scopes, pending.args), pending.basis);
  const basis = async () => await proposalBasis(ctx.db, 'update_preferences', ['write:preferences'], { positions: { [CURVE_AXES[0].id]: 0.7 } });
  const before = await basis();
  await setSetting(ctx.db, 'ask.titleRejects', { unparsable: 2 });
  assert.equal(await basis(), before);
  await ctx.db.prepare("INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES ('curve-prior', 'Keep cash flexible', 'owner-test', ?, ?)").run(NOW, NOW);
  assert.notEqual(await basis(), before);
});

test('curve changes override remembered ends, preserve negation handling and Undo restores the earlier memory', async () => {
  const ctx = await store();
  const axis = CURVE_AXES[0];
  const value = async () => (await loadCurve(ctx.db, await loadContent(ctx.db))).find(a => a.id === axis.id).value;
  const insert = ctx.db.prepare('INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  await insert.run('prior', axis.left, ctx.actorId, NOW, NOW);
  assert.equal(await value(), 0);
  const result = await callTool('update_preferences', { operation: 'curve', positions: { [axis.id]: 0.63 } }, ctx);
  assert.equal(await value(), 0.63);
  await insert.run('negated', `I do not want ${axis.right}`, ctx.actorId, NOW, NOW);
  assert.equal(await value(), 0.63);
  await undo(ctx, result);
  assert.equal(await value(), 0);
  assert.ok(await ctx.db.prepare("SELECT 1 FROM preferences WHERE id = 'prior'").get());
  assert.ok(await ctx.db.prepare("SELECT 1 FROM preferences WHERE id = 'negated'").get());
  assert.equal(await getSetting(ctx.db, 'curve.positions', null), null);
});

test('curve writes validate the whole batch and honor the shared preference limit', async () => {
  const ctx = await store();
  const axis = CURVE_AXES[0].id;
  await assert.rejects(callTool('update_preferences', { operation: 'curve', positions: { [axis]: 0.2, nonexistent: 0.5 } }, ctx), { code: 'bad_input' });
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM preferences').get()).n, 0);
  const insert = ctx.db.prepare('INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 100; i++) await insert.run(`pref-${i}`, 'Synthetic preference', ctx.actorId, NOW, NOW);
  await assert.rejects(callTool('update_preferences', { operation: 'curve', positions: { [axis]: 0.2 } }, ctx), { code: 'bad_input' });
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM preferences').get()).n, 100);
  await ctx.db.prepare("DELETE FROM preferences WHERE id = 'pref-0'").run();
  const result = await callTool('update_preferences', { operation: 'curve', positions: { [axis]: 0.2 } }, ctx);
  assert.equal(result.positions[axis], 0.2);
});

test('a thread-title settings write between an archive proposal and HTTP confirmation does not make it stale', async t => {
  const ctx = await store();
  const row = await add(ctx, { title: 'Kitchen remodel' });
  const transport = createEngine({ mode: 'fake' });
  let chatCalls = 0;
  const engine = { mode: 'fake', isOn: () => true, async call(request) {
    if (request.purpose !== 'chat') return Promise.resolve({ text: 'not a title response', toolResults: [] });
    chatCalls++;
    return await transport.call({ ...request, fake: [
      { toolCalls: [{ name: 'update_goal', args: { operation: 'archive', id: row.id, propose: true } }] },
      { text: 'I can archive the kitchen remodel goal. Confirm below.' },
    ] });
  } };
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true, engine });
  t.after(() => srv.close());
  const first = await srv.postJson('/api/threads', { text: 'Archive the kitchen remodel goal.' });
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.message.provenance.pendingAction);
  assert.ok(await getSetting(ctx.db, 'ask.titleRejects', null));
  await setSetting(ctx.db, `ask.titleRetried.${first.json.thread.key}`, true);
  assert.equal((await ctx.db.prepare('SELECT archived_at FROM goals WHERE id = ?').get(row.id)).archived_at, null);
  const calls = chatCalls;
  const confirmed = await srv.postJson(`/api/threads/${first.json.thread.id}/proposals/${first.json.message.id}`, { decision: 'confirm' });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(chatCalls, calls);
  assert.ok((await ctx.db.prepare('SELECT archived_at FROM goals WHERE id = ?').get(row.id)).archived_at);
});

for (const operation of ['create','edit']) test(`goal ${operation} proposals ignore unrelated settings and transactions`, async () => {
 const ctx=await store(),row=await add(ctx),tool=proposalTools([getTool('update_goal')])[0];let pending;
 await tool.handler({operation,...(operation==='edit'?{id:row.id}:{}),title:'Synthetic reserve',target:5000,propose:true},{...ctx,onProposal:p=>{pending=p;}});
 const basis=async ()=>await proposalBasis(ctx.db,pending.tool,pending.scopes,pending.args);
 await setSetting(ctx.db,'ask.titleRejects',{unparsable:7});
 const account=(await ctx.db.prepare('SELECT id FROM accounts LIMIT 1').get()).id;
 await ctx.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES (?,'2026-11-05',-10,'Unrelated posting')").run(account);
 assert.equal(await basis(),pending.basis);
 if(operation==='edit')await ctx.db.prepare("UPDATE goals SET updated_at='later' WHERE id=?").run(row.id);
 else await setSetting(ctx.db,'goals.suggestions',{[row.id]:{declined:true}});
 assert.notEqual(await basis(),pending.basis);
});

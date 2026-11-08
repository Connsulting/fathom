import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, householdOf, factRow } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { serveAppFixture } from './helpers/server.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';
import { buildScenario, loadContent } from '../src/scenario/build.mjs';
import { getSetting, setSetting } from '../src/store/db.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { findIndexSeries } from '../src/shared/series.mjs';

const S = scratch('fathom-rec-writes-');
after(async () => await S.cleanup());
const CLOCK = '2026-11-05';
const NOW = CLOCK + 'T12:00:00.000Z';
async function store() {
  const db = await S.store();
  await planRun(db, { now: CLOCK });
  const household = householdOf(db);
  return { db, household, services: household.services, actorId: 'owner-test', channel: 'mcp', clock: CLOCK, now: NOW,
    queuePlan() {} };
}
const call = (ctx, operation, args) => callTool('act_on_recommendation', { operation, ...args }, ctx);
const undo = (ctx, result) => callTool('undo', result.undo.args, ctx);
const decision = async db => await db.prepare("SELECT * FROM decisions WHERE id = 'salary-2026'").get();

test('decide, undo, revisit and undo use the prior point and remove the decided fact', async () => {
  const ctx = await store();
  const points = (await loadContent(ctx.db)).wargame.salary.points;
  const decided = await call(ctx, 'decide', { decisionId: 'salary-2026', point: points[1].id });
  assert.equal(decided.decision.status, 'decided');
  assert.match(decided.decision.decidedLine, /You decided/);
  assert.equal((await factRow(ctx.db, 'business.salaryDecided')).locator.point, points[1].id);
  assert.equal(decided.receipt.scope, 'write:decisions');
  await undo(ctx, decided);
  assert.equal((await decision(ctx.db)).status, 'open');
  assert.equal(await factRow(ctx.db, 'business.salaryDecided'), null);
  await call(ctx, 'decide', { decisionId: 'salary-2026', point: 1 });
  const revisited = await call(ctx, 'revisit', { decisionId: 'salary-2026' });
  assert.equal(revisited.decidedIndex, 1);
  assert.equal(revisited.decision.status, 'open');
  assert.equal(await factRow(ctx.db, 'business.salaryDecided'), null);
  await undo(ctx, revisited);
  assert.equal((await decision(ctx.db)).status, 'decided');
  assert.equal((await factRow(ctx.db, 'business.salaryDecided')).locator.point, points[1].id);
});

test('decision and pick writes match the HTTP routes on a real store', async t => {
  const ctx = await store();
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const picked = await call(ctx, 'pick_point', { name: 'salary', point: 1 });
  assert.equal(picked.picked.index, 1);
  assert.ok(picked.picked.label);
  const expected = await getSetting(ctx.db, 'wargame.picks');
  await undo(ctx, picked);
  assert.equal((await srv.postJson('/api/wargame/salary/pick', { index: 1 })).status, 200);
  assert.deepEqual(await getSetting(ctx.db, 'wargame.picks'), expected);
  const chosen = await call(ctx, 'decide', { decisionId: 'salary-2026' });
  const line = (await decision(ctx.db)).decided_line;
  const fact = (await factRow(ctx.db, 'business.salaryDecided')).value;
  await undo(ctx, chosen);
  const route = await srv.postJson('/api/decisions/salary-2026/decide', { index: 1 });
  assert.equal(route.status, 200, route.text);
  assert.equal((await decision(ctx.db)).decided_line, line);
  assert.deepEqual((await factRow(ctx.db, 'business.salaryDecided')).value, fact);
  assert.equal((await srv.postJson('/api/decisions/salary-2026/revisit')).status, 200);
  assert.equal((await decision(ctx.db)).status, 'open');
});

test('start over detaches only attached threads, matches its route and undoes', async t => {
  const ctx = await store();
  const id = (await ctx.db.prepare("SELECT id FROM recs WHERE status != 'hidden' LIMIT 1").get()).id;
  const insert = ctx.db.prepare('INSERT INTO conversations (key, created_at, rec_id, rec_detached_at) VALUES (?, ?, ?, ?)');
  await insert.run('ask:0123456789ab', NOW, id, null);
  await insert.run('ask:0123456789ac', NOW, id, '2026-10-01');
  const result = await call(ctx, 'start_over', { id });
  assert.equal(result.detached.value, 1);
  assert.equal(result.detached.unit, 'count');
  await undo(ctx, result);
  const rows = async () => await ctx.db.prepare('SELECT key, rec_detached_at FROM conversations ORDER BY key').all();
  assert.equal((await rows())[0].rec_detached_at, null);
  assert.equal((await rows())[1].rec_detached_at, '2026-10-01');
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  assert.equal((await srv.postJson(`/api/recs/${id}/start-over`)).status, 200);
  assert.ok((await rows())[0].rec_detached_at);
  assert.equal((await rows())[1].rec_detached_at, '2026-10-01');
});

test('refused choices, hidden recs and changed decision receipts write nothing', async () => {
  const ctx = await store();
  await assert.rejects(call(ctx, 'decide', { decisionId: 'missing' }), { code: 'not_found' });
  await assert.rejects(call(ctx, 'decide', { decisionId: 'salary-2026', point: 999 }), { code: 'bad_input' });
  await assert.rejects(call(ctx, 'revisit', { decisionId: 'salary-2026' }), { code: 'conflict' });
  await assert.rejects(call(ctx, 'start_over', { id: 'missing' }), { code: 'not_found' });
  const chosen = await call(ctx, 'decide', { decisionId: 'salary-2026', point: 1 });
  await assert.rejects(call(ctx, 'decide', { decisionId: 'salary-2026' }), { code: 'conflict' });
  await ctx.db.prepare("UPDATE decisions SET decided_line = 'Later change' WHERE id = 'salary-2026'").run();
  await assert.rejects(undo(ctx, chosen), { code: 'conflict' });
  assert.equal((await decision(ctx.db)).decided_line, 'Later change');
});

test('decision proposals do not write and their basis covers decision, game, picks and attached threads', async () => {
  const ctx = await store();
  let pending;
  const tool = proposalTools([getTool('act_on_recommendation')])[0];
  await tool.handler({ operation: 'decide', decisionId: 'salary-2026', point: 1, propose: true }, { ...ctx, onProposal: p => { pending = p; } });
  assert.equal((await decision(ctx.db)).status, 'open');
  assert.equal(pending.scopes[0], 'write:decisions');
  const basis = async () => await proposalBasis(ctx.db, pending.tool, pending.scopes, pending.args);
  const before = await basis();
  await ctx.db.prepare("UPDATE decisions SET title = title || ' changed' WHERE id = 'salary-2026'").run();
  assert.notEqual(await basis(), before);
  const picks = await basis();
  await setSetting(ctx.db, 'wargame.picks', { salary: 0 });
  assert.notEqual(await basis(), picks);
  const game = await basis();
  await ctx.db.prepare("UPDATE content SET updated_at = 'later' WHERE key = 'wargame'").run();
  assert.notEqual(await basis(), game);
  const id = (await ctx.db.prepare("SELECT id FROM recs WHERE status != 'hidden' LIMIT 1").get()).id;
  const threads = async () => await proposalBasis(ctx.db, 'act_on_recommendation', ['write:recs'], { id });
  const prior = await threads();
  await ctx.db.prepare('INSERT INTO conversations (key, created_at, rec_id) VALUES (?, ?, ?)').run('ask:0123456789ab', NOW, id);
  assert.notEqual(await threads(), prior);
});

test('HTTP Ask confirms a decision without another model call and rejects a changed basis', async t => {
  const ctx = await store();
  const transport = createEngine({ mode: 'fake' });
  let chatCalls = 0;
  let operation = 'decide';
  const engine = { mode: 'fake', isOn: () => true, call(request) {
    if (request.purpose !== 'chat') return Promise.resolve({ text: '{"title":"Salary choice"}', toolResults: [] });
    chatCalls++;
    return transport.call({ ...request, fake: [
      { toolCalls: [{ name: 'act_on_recommendation', args: { operation, decisionId: 'salary-2026', ...(operation === 'decide' ? { point: 1 } : {}), propose: true } }] },
      { text: 'I can record this change to the salary decision. Confirm below.' },
    ] });
  } };
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true, engine });
  t.after(() => srv.close());
  const first = await srv.postJson('/api/threads', { text: 'Lock in the middle salary option.' });
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.message.provenance.pendingAction);
  assert.equal((await decision(ctx.db)).status, 'open');
  const count = chatCalls;
  const path = `/api/threads/${first.json.thread.id}/proposals/${first.json.message.id}`;
  const confirmed = await srv.postJson(path, { decision: 'confirm' });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(chatCalls, count);
  assert.equal((await decision(ctx.db)).status, 'decided');
  assert.ok(await factRow(ctx.db, 'business.salaryDecided'));
  assert.equal((await srv.postJson(path, { decision: 'confirm' })).status, 409);
  operation = 'revisit';
  const second = await srv.postJson('/api/threads', { text: 'Revisit the salary decision.' });
  assert.ok(second.json.message.provenance.pendingAction);
  await setSetting(ctx.db, 'wargame.picks', { salary: 0 });
  const stale = await srv.postJson(`/api/threads/${second.json.thread.id}/proposals/${second.json.message.id}`, { decision: 'confirm' });
  assert.equal(stale.status, 200, stale.text);
  assert.equal((await decision(ctx.db)).status, 'decided');
  const pending = JSON.parse((await ctx.db.prepare('SELECT provenance FROM messages WHERE id = ?').get(Number(second.json.message.id.slice(1)))).provenance).pendingAction;
  assert.equal(pending.resolved.status, 'stale');
});

test('deferral decisions undo, replan through the hook, and revisit still works when inputs become unavailable', async () => {
  const ctx = await store();
  let replans = 0;
  ctx.replan = async () => { replans++; return { status: 'ok' }; };
  const id = (await ctx.db.prepare("SELECT id FROM decisions WHERE wargame = 'deferral' AND status = 'open'").get()).id;
  const result = await call(ctx, 'decide', { decisionId: id, point: 1 });
  assert.equal(replans, 1);
  assert.ok(await factRow(ctx.db, 'business.deferralDecided'));
  await undo(ctx, result);
  assert.equal(replans, 2);
  assert.equal(await factRow(ctx.db, 'business.deferralDecided'), null);
  await call(ctx, 'decide', { decisionId: id, point: 1 });
  const game = (await loadContent(ctx.db)).wargame;
  game.deferral.unavailable = 'Inputs changed';
  await ctx.db.prepare("UPDATE content SET value = ? WHERE key = 'wargame'").run(JSON.stringify(game));
  const reopened = await call(ctx, 'revisit', { decisionId: id });
  assert.equal(reopened.decision.status, 'open');
  await assert.rejects(undo(ctx, reopened), { code: 'conflict' });
});

test('decide and revisit remain undoable after their real planning runs rewrite war-game figures', async () => {
  const ctx = await store();
  const original = (await ctx.db.prepare("SELECT v FROM figures WHERE key = 'pnl.northwind-advisory.salaryProj'").get()).v;
  const points = (await loadContent(ctx.db)).wargame.salary.points;
  const point = await findIndexSeries(points, async p => (await ctx.db.prepare('SELECT v FROM figures WHERE key = ?').get(`wg.salary.${p.id}.salary`)).v !== original);
  assert.ok(point >= 0);
  const deferral = async () => await ctx.db.prepare("SELECT key, v FROM figures WHERE key LIKE 'wg.deferral.%' ORDER BY key").all();
  const before = await deferral();
  ctx.replan = async () => planRun(ctx.db, { now: CLOCK });
  const chosen = await call(ctx, 'decide', { decisionId: 'salary-2026', point });
  assert.notDeepEqual(await deferral(), before, 'the action really changed the planner-derived figures');
  await undo(ctx, chosen);
  assert.equal((await decision(ctx.db)).status, 'open');
  assert.equal(await factRow(ctx.db, 'business.salaryDecided'), null);
  assert.deepEqual(await deferral(), before);
  await call(ctx, 'decide', { decisionId: 'salary-2026', point });
  const revisited = await call(ctx, 'revisit', { decisionId: 'salary-2026' });
  assert.equal((await decision(ctx.db)).status, 'open');
  assert.equal(await factRow(ctx.db, 'business.salaryDecided'), null);
  await undo(ctx, revisited);
  assert.equal((await decision(ctx.db)).status, 'decided');
  assert.equal((await factRow(ctx.db, 'business.salaryDecided')).locator.point, points[point].id);
  assert.notDeepEqual(await deferral(), before);
});

test('writes require an actor and Undo keeps its receipt scope and actor', async () => {
  const ctx = await store();
  await assert.rejects(call({ ...ctx, actorId: null }, 'decide', { decisionId: 'salary-2026' }), { code: 'forbidden' });
  assert.equal((await decision(ctx.db)).status, 'open');
  const result = await call(ctx, 'decide', { decisionId: 'salary-2026', point: 1 });
  await assert.rejects(undo({ ...ctx, scopes: ['write:recs'] }, result), { code: 'forbidden' });
  await assert.rejects(undo({ ...ctx, actorId: 'someone-else' }, result), { code: 'forbidden' });
  await undo({ ...ctx, scopes: ['write:decisions'] }, result);
  assert.equal((await decision(ctx.db)).status, 'open');
});

test('the three C9 eval scripts register as required passes and validate all their proposed calls', async t => {
  const { loadCases } = await import('../evals/cases.mjs');
  const { createEvalStore } = await import('../evals/harness.mjs');
  const s = await createEvalStore();
  t.after(async () => await s.close());
  const cases = await loadCases();
  for (const id of ['q62-decide-salary-option', 'q63-archive-goal', 'q64-send-to-advisor']) {
    assert.equal(cases.find(c => c.id === id).expectedFail, undefined);
    const { script } = await import(`../evals/scripts/${id}.mjs`);
    const rounds = await script({ db: s.db, clock: CLOCK });
    for (const round of rounds) for (const call of round.toolCalls ?? []) {
      const { propose, ...args } = call.args;
      assert.doesNotThrow(() => getTool(call.name).validateArgs(args));
      if (getTool(call.name).kind === 'write') assert.equal(propose, true);
    }
  }
});

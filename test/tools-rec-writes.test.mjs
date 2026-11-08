import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, householdOf, factRow } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { serveAppFixture } from './helpers/server.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';
import { buildScenario, loadContent } from '../src/scenario/build.mjs';
import { getSetting, setSetting } from '../src/store/db.mjs';

const S = scratch('fathom-rec-writes-');
after(() => S.cleanup());
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
const decision = db => db.prepare("SELECT * FROM decisions WHERE id = 'salary-2026'").get();

test('decide, undo, revisit and undo use the prior point and remove the decided fact', async () => {
  const ctx = await store();
  const points = loadContent(ctx.db).wargame.salary.points;
  const decided = await call(ctx, 'decide', { decisionId: 'salary-2026', point: points[1].id });
  assert.equal(decided.decision.status, 'decided');
  assert.match(decided.decision.decidedLine, /You decided/);
  assert.equal(factRow(ctx.db, 'business.salaryDecided').locator.point, points[1].id);
  assert.equal(decided.receipt.scope, 'write:decisions');
  await undo(ctx, decided);
  assert.equal(decision(ctx.db).status, 'open');
  assert.equal(factRow(ctx.db, 'business.salaryDecided'), null);
  await call(ctx, 'decide', { decisionId: 'salary-2026', point: 1 });
  const revisited = await call(ctx, 'revisit', { decisionId: 'salary-2026' });
  assert.equal(revisited.decidedIndex, 1);
  assert.equal(revisited.decision.status, 'open');
  assert.equal(factRow(ctx.db, 'business.salaryDecided'), null);
  await undo(ctx, revisited);
  assert.equal(decision(ctx.db).status, 'decided');
  assert.equal(factRow(ctx.db, 'business.salaryDecided').locator.point, points[1].id);
});

test('decision and pick writes match the HTTP routes on a real store', async t => {
  const ctx = await store();
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const picked = await call(ctx, 'pick_point', { name: 'salary', point: 1 });
  assert.equal(picked.picked.index, 1);
  assert.ok(picked.picked.label);
  const expected = getSetting(ctx.db, 'wargame.picks');
  await undo(ctx, picked);
  assert.equal((await srv.postJson('/api/wargame/salary/pick', { index: 1 })).status, 200);
  assert.deepEqual(getSetting(ctx.db, 'wargame.picks'), expected);
  const chosen = await call(ctx, 'decide', { decisionId: 'salary-2026' });
  const line = decision(ctx.db).decided_line;
  const fact = factRow(ctx.db, 'business.salaryDecided').value;
  await undo(ctx, chosen);
  const route = await srv.postJson('/api/decisions/salary-2026/decide', { index: 1 });
  assert.equal(route.status, 200, route.text);
  assert.equal(decision(ctx.db).decided_line, line);
  assert.deepEqual(factRow(ctx.db, 'business.salaryDecided').value, fact);
  assert.equal((await srv.postJson('/api/decisions/salary-2026/revisit')).status, 200);
  assert.equal(decision(ctx.db).status, 'open');
});

test('start over detaches only attached threads, matches its route and undoes', async t => {
  const ctx = await store();
  const id = ctx.db.prepare("SELECT id FROM recs WHERE status != 'hidden' LIMIT 1").get().id;
  const insert = ctx.db.prepare('INSERT INTO conversations (key, created_at, rec_id, rec_detached_at) VALUES (?, ?, ?, ?)');
  insert.run('ask:0123456789ab', NOW, id, null);
  insert.run('ask:0123456789ac', NOW, id, '2026-10-01');
  const result = await call(ctx, 'start_over', { id });
  assert.equal(result.detached.value, 1);
  assert.equal(result.detached.unit, 'count');
  await undo(ctx, result);
  const rows = () => ctx.db.prepare('SELECT key, rec_detached_at FROM conversations ORDER BY key').all();
  assert.equal(rows()[0].rec_detached_at, null);
  assert.equal(rows()[1].rec_detached_at, '2026-10-01');
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  assert.equal((await srv.postJson(`/api/recs/${id}/start-over`)).status, 200);
  assert.ok(rows()[0].rec_detached_at);
  assert.equal(rows()[1].rec_detached_at, '2026-10-01');
});

test('refused choices, hidden recs and changed decision receipts write nothing', async () => {
  const ctx = await store();
  await assert.rejects(call(ctx, 'decide', { decisionId: 'missing' }), { code: 'not_found' });
  await assert.rejects(call(ctx, 'decide', { decisionId: 'salary-2026', point: 999 }), { code: 'bad_input' });
  await assert.rejects(call(ctx, 'revisit', { decisionId: 'salary-2026' }), { code: 'conflict' });
  await assert.rejects(call(ctx, 'start_over', { id: 'missing' }), { code: 'not_found' });
  const chosen = await call(ctx, 'decide', { decisionId: 'salary-2026', point: 1 });
  await assert.rejects(call(ctx, 'decide', { decisionId: 'salary-2026' }), { code: 'conflict' });
  ctx.db.prepare("UPDATE decisions SET decided_line = 'Later change' WHERE id = 'salary-2026'").run();
  await assert.rejects(undo(ctx, chosen), { code: 'conflict' });
  assert.equal(decision(ctx.db).decided_line, 'Later change');
});

test('decision proposals do not write and their basis covers decision, game, picks and attached threads', async () => {
  const ctx = await store();
  let pending;
  const tool = proposalTools([getTool('act_on_recommendation')])[0];
  await tool.handler({ operation: 'decide', decisionId: 'salary-2026', point: 1, propose: true }, { ...ctx, onProposal: p => { pending = p; } });
  assert.equal(decision(ctx.db).status, 'open');
  assert.equal(pending.scopes[0], 'write:decisions');
  const basis = () => proposalBasis(ctx.db, pending.tool, pending.scopes, pending.args);
  const before = basis();
  ctx.db.prepare("UPDATE decisions SET title = title || ' changed' WHERE id = 'salary-2026'").run();
  assert.notEqual(basis(), before);
  const picks = basis();
  setSetting(ctx.db, 'wargame.picks', { salary: 0 });
  assert.notEqual(basis(), picks);
  const game = basis();
  ctx.db.prepare("UPDATE content SET updated_at = 'later' WHERE key = 'wargame'").run();
  assert.notEqual(basis(), game);
  const id = ctx.db.prepare("SELECT id FROM recs WHERE status != 'hidden' LIMIT 1").get().id;
  const threads = () => proposalBasis(ctx.db, 'act_on_recommendation', ['write:recs'], { id });
  const prior = threads();
  ctx.db.prepare('INSERT INTO conversations (key, created_at, rec_id) VALUES (?, ?, ?)').run('ask:0123456789ab', NOW, id);
  assert.notEqual(threads(), prior);
});

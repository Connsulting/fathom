import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, addFact } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate } from '../src/api/handlers.mjs';

const s = scratch('fathom-actions-');
after(() => s.cleanup());
const now = '2026-11-05T12:00:00.000Z';
const words = 'Set the expected date to 2027-03-19';
const key = 'ask:0123456789ab';
const factArgs = { key: 'household.expectedDate', value: '2027-03-19', evidence: words };
const context = db => ({ db, now, actorId: 'person-a', ownerText: words, conversationKey: key, turnId: 'turn-a', replan: () => planRun(db) });

test('fact tool uses owner evidence, shared validation, provenance, replanning and exact undo', async () => {
  const db = await s.store();
  addFact(db, 'household.expectingChild', true);
  db.prepare('DELETE FROM facts WHERE key = ?').run('household.expectedDate');
  await planRun(db);
  const ctx = context(db);
  const result = await callTool('record_household_fact', factArgs, ctx);
  assert.equal(getFacts(db)['household.expectedDate'], '2027-03-19');
  const row = db.prepare('SELECT * FROM facts WHERE key = ?').get(factArgs.key);
  assert.match(db.prepare('SELECT label FROM sources WHERE id = ?').get(row.src).label, /you told Fathom in Ask on 2026-11-05/);
  assert.equal(JSON.parse(row.locator).actorId, 'person-a');
  assert.equal(buildScenario(db).recs.find(r => r.id === 'new-child').window.close, '2027-03-19');
  assert.equal(result.receipt.before, null);
  assert.equal(result.receipt.after, '2027-03-19');
  assert.equal(result.receipt.actorId, 'person-a');
  await callTool('undo_fact_action', { id: result.receipt.id }, { ...ctx, scopes: ['write:facts'], channel: 'mcp' });
  assert.equal(Object.hasOwn(getFacts(db), factArgs.key), false);
  assert.notEqual(buildScenario(db).recs.find(r => r.id === 'new-child').window?.close, '2027-03-19');
  await assert.rejects(callTool('undo_fact_action', { id: result.receipt.id }, { ...ctx, channel: 'mcp' }), /already undone/);
});

test('unknown keys, invalid shapes, invented values and missing identity refuse before writing', async () => {
  const db = await s.store();
  const ctx = context(db);
  for (const args of [
    { ...factArgs, key: 'household.typo' },
    { ...factArgs, value: '2027-02-30' },
    { ...factArgs, value: '2027-03-20' },
    { ...factArgs, evidence: 'invented statement' },
  ]) await assert.rejects(callTool('record_household_fact', args, ctx));
  await assert.rejects(callTool('record_household_fact', factArgs, { ...ctx, actorId: null }), /signed.in/);
  assert.equal(db.prepare('SELECT count(*) n FROM action_receipts').get().n, 0);
  await callTool('record_household_fact', factArgs, ctx);
  assert.equal(getFacts(db)[factArgs.key], factArgs.value);
});

test('receipt undo checks actor, scope and later edits atomically; no-op has no receipt', async () => {
  const db = await s.store();
  const ctx = context(db);
  const out = await callTool('record_household_fact', factArgs, ctx);
  const again = await callTool('record_household_fact', factArgs, ctx);
  assert.equal(again.receipt, null);
  for (const other of [ { actorId: 'person-b' }, { scopes: ['write:goals'] } ]) {
    await assert.rejects(callTool('undo_fact_action', { id: out.receipt.id }, { ...ctx, channel: 'mcp', ...other }));
    assert.equal(getFacts(db)[factArgs.key], factArgs.value);
  }
  addFact(db, factArgs.key, '2027-04-01');
  await assert.rejects(callTool('undo_fact_action', { id: out.receipt.id }, { ...ctx, channel: 'mcp' }), /changed since/);
  assert.equal(getFacts(db)[factArgs.key], '2027-04-01');
});

test('goals share screen validation, require target evidence and undo create/edit', async () => {
  const db = await s.store();
  const ctx = { ...context(db), ownerText: 'Create a cash reserve goal with $64,000 by 2027-06-01' };
  await assert.rejects(callTool('create_goal', { title: 'Cash reserve', target: 65000 }, ctx), /stated|evidence/);
  await assert.rejects(callTool('create_goal', { title: '', target: 64000 }, ctx));
  const created = await callTool('create_goal', { title: 'Cash reserve', target: 64000, targetDate: '2027-06-01' }, ctx);
  assert.equal(created.goal.target, 64000);
  const edited = await callTool('edit_goal', { id: created.goal.id, target: 64000, title: 'Reserve' }, ctx);
  assert.equal(edited.goal.title, 'Reserve');
  await callTool('undo_goal_action', { id: edited.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(JSON.parse(db.prepare('SELECT def FROM goals WHERE id = ?').get(created.goal.id).def).title, 'Cash reserve');
  await callTool('undo_goal_action', { id: created.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(db.prepare('SELECT id FROM goals WHERE id = ?').get(created.goal.id), undefined);
});

test('step, status and owner tools each persist an attributed receipt and undo', async () => {
  const db = await s.store();
  await planRun(db);
  const id = db.prepare("SELECT id FROM recs WHERE json_array_length(json_extract(def, '$.tasks')) > 0 AND json_extract(def, '$.question.primary') IS NULL LIMIT 1").get().id;
  const ctx = context(db);
  for (const [name, args, undo] of [
    ['set_recommendation_step', { id, index: 0, checked: true }, 'undo_step_action'],
    ['set_recommendation_status', { id, status: 'doing' }, 'undo_recommendation_action'],
    ['set_recommendation_owner', { id, owner: 'advisor' }, 'undo_recommendation_action'],
  ]) {
    const r = await callTool(name, args, ctx);
    assert.ok(r.receipt);
    assert.equal(r.receipt.actorId, ctx.actorId);
    await callTool(undo, { id: r.receipt.id }, { ...ctx, channel: 'mcp' });
  }
  await assert.rejects(callTool('set_recommendation_step', { id, index: 999, checked: true }, ctx));
});

for (const recId of [null, 'new-child']) for (const fail of [false, true]) {
  test(`scripted model write then ${fail ? 'failure' : 'success'} retains receipt on ${recId ? 'rec dialog' : 'new Ask'}`, async () => {
    const db = await s.store();
    addFact(db, 'household.expectingChild', true);
    await planRun(db);
    const transport = createEngine({ mode: 'fake' });
    const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
      ? Promise.resolve({ text: 'Expected date', toolResults: [] })
      : transport.call({ ...request, fake: [ { toolCalls: [{ name: 'record_household_fact', args: factArgs }] },
        fail ? { status: 'transport_error', is_error: true } : { text: 'The expected date is saved.' } ] }) };
    const answerer = createLiveAnswerer({ engine });
    const ctx = { db, config: {}, identity: { id: 'person-a' }, scheduler: { runNow: () => planRun(db) }, answerer,
      body: { text: words, ...(recId ? { recId } : {}) } };
    const out = await threadCreate(ctx);
    assert.equal(getFacts(db)[factArgs.key], factArgs.value);
    const messages = buildScenario(db).live.conversations[out.thread.key];
    const receipts = messages.flatMap(m => m.provenance?.actions || []);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].after, factArgs.value);
    assert.equal(buildScenario(db).recs.find(r => r.id === 'new-child').window.close, factArgs.value);
  });
}

test('registry assigns the action scopes and marks undo tools MCP-only', () => {
  for (const [name, scope] of [['record_household_fact', 'write:facts'], ['set_recommendation_step', 'write:steps'], ['create_goal', 'write:goals'], ['edit_goal', 'write:goals']]) {
    assert.equal(tools.find(t => t.name === name)?.scope, scope);
  }
  assert.equal(tools.find(t => t.name === 'undo_fact_action')?.mcpOnly, true);
});

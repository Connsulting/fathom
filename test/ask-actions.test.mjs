import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, addFact, householdOf } from './helpers/real-store.mjs';
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
const factArgs = { operation: 'fact', key: 'household.expectedDate', value: '2027-03-19', evidence: words };
const context = db => ({ db, now, actorId: 'person-a', ownerText: words, conversationKey: key, turnId: 'turn-a', replan: () => planRun(db) });

test('fact tool uses owner evidence, shared validation, provenance, replanning and exact undo', async () => {
  const db = await s.store();
  addFact(db, 'household.expectingChild', true);
  db.prepare('DELETE FROM facts WHERE key = ?').run('household.expectedDate');
  await planRun(db);
  const ctx = context(db);
  const result = await callTool('answer', factArgs, ctx);
  assert.equal(getFacts(db)['household.expectedDate'], '2027-03-19');
  const row = db.prepare('SELECT * FROM facts WHERE key = ?').get(factArgs.key);
  assert.match(db.prepare('SELECT label FROM sources WHERE id = ?').get(row.src).label, /you told Fathom in Ask on 2026-11-05/);
  assert.equal(JSON.parse(row.locator).actorId, 'person-a');
  assert.equal(buildScenario(db).recs.find(r => r.id === 'new-child').window.close, '2027-03-19');
  assert.equal(result.receipt.before, null);
  assert.equal(result.receipt.after, '2027-03-19');
  assert.equal(result.receipt.actorId, 'person-a');
  await callTool('undo', { operation: 'undo',  id: result.receipt.id }, { ...ctx, scopes: ['write:facts'], channel: 'mcp' });
  assert.equal(Object.hasOwn(getFacts(db), factArgs.key), false);
  assert.notEqual(buildScenario(db).recs.find(r => r.id === 'new-child').window?.close, '2027-03-19');
  await assert.rejects(callTool('undo', { operation: 'undo',  id: result.receipt.id }, { ...ctx, channel: 'mcp' }), /already undone/);
});

test('unknown keys, invalid shapes, invented values and missing identity refuse before writing', async () => {
  const db = await s.store();
  const ctx = context(db);
  for (const args of [
    { ...factArgs, key: 'household.typo' },
    { ...factArgs, value: '2027-02-30' },
    { ...factArgs, value: '2027-03-20' },
    { ...factArgs, evidence: 'invented statement' },
  ]) await assert.rejects(callTool('answer', { operation: 'fact', ...args }, ctx));
  await assert.rejects(callTool('answer', factArgs, { ...ctx, actorId: null }), /signed.in/);
  assert.equal(db.prepare('SELECT count(*) n FROM action_receipts').get().n, 0);
  await callTool('answer', factArgs, ctx);
  assert.equal(getFacts(db)[factArgs.key], factArgs.value);
});

test('receipt undo checks actor, scope and later edits atomically; no-op has no receipt', async () => {
  const db = await s.store();
  const ctx = context(db);
  const out = await callTool('answer', factArgs, ctx);
  const again = await callTool('answer', factArgs, ctx);
  assert.equal(again.receipt, null);
  for (const other of [ { actorId: 'person-b' }, { scopes: ['write:goals'] } ]) {
    await assert.rejects(callTool('undo', { operation: 'undo',  id: out.receipt.id }, { ...ctx, channel: 'mcp', ...other }));
    assert.equal(getFacts(db)[factArgs.key], factArgs.value);
  }
  addFact(db, factArgs.key, '2027-04-01');
  await assert.rejects(callTool('undo', { operation: 'undo',  id: out.receipt.id }, { ...ctx, channel: 'mcp' }), /changed since/);
  assert.equal(getFacts(db)[factArgs.key], '2027-04-01');
});

test('goals share screen validation, require target evidence and undo create/edit', async () => {
  const db = await s.store();
  const ctx = { ...context(db), ownerText: 'Create a cash reserve goal with $64,000 by 2027-06-01' };
  await assert.rejects(callTool('update_goal', { operation: 'create',  title: 'Cash reserve', target: 65000 }, ctx), /stated|evidence/);
  await assert.rejects(callTool('update_goal', { operation: 'create',  title: '', target: 64000 }, ctx));
  const created = await callTool('update_goal', { operation: 'create',  title: 'Cash reserve', target: 64000, targetDate: '2027-06-01' }, ctx);
  assert.equal(created.goal.target, 64000);
  const edited = await callTool('update_goal', { operation: 'edit',  id: created.goal.id, target: 64000, title: 'Reserve' }, ctx);
  assert.equal(edited.goal.title, 'Reserve');
  await callTool('undo', { operation: 'undo',  id: edited.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(JSON.parse(db.prepare('SELECT def FROM goals WHERE id = ?').get(created.goal.id).def).title, 'Cash reserve');
  await callTool('undo', { operation: 'undo',  id: created.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(db.prepare('SELECT id FROM goals WHERE id = ?').get(created.goal.id), undefined);
});

test('step, status and owner tools each persist an attributed receipt and undo', async () => {
  const db = await s.store();
  await planRun(db);
  const id = db.prepare("SELECT id FROM recs WHERE json_array_length(json_extract(def, '$.tasks')) > 0 AND json_extract(def, '$.question.primary') IS NULL LIMIT 1").get().id;
  const ctx = context(db);
  for (const [name, args, undo] of [
    ['act_on_recommendation', { operation: 'step', id, index: 0, checked: true }, 'undo'],
    ['act_on_recommendation', { operation: 'status', id, status: 'doing' }, 'undo'],
    ['act_on_recommendation', { operation: 'owner', id, owner: 'advisor' }, 'undo'],
  ]) {
    const r = await callTool(name, args, ctx);
    assert.ok(r.receipt);
    assert.equal(r.receipt.actorId, ctx.actorId);
    await callTool(undo, { operation: 'undo', id: r.receipt.id }, { ...ctx, channel: 'mcp' });
  }
  await assert.rejects(callTool('act_on_recommendation', { operation: 'step',  id, index: 999, checked: true }, ctx));
});

for (const recId of [null, 'new-child']) for (const fail of [false, true]) {
  test(`scripted model write then ${fail ? 'failure' : 'success'} retains receipt on ${recId ? 'rec dialog' : 'new Ask'}`, async () => {
    const db = await s.store();
    addFact(db, 'household.expectingChild', true);
    await planRun(db);
    const transport = createEngine({ mode: 'fake' });
    const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
      ? Promise.resolve({ text: 'Expected date', toolResults: [] })
      : transport.call({ ...request, fake: [ { toolCalls: [{ name: 'answer', args: factArgs }] },
        fail ? { status: 'transport_error', is_error: true } : { text: 'The expected date is saved.' } ] }) };
    const answerer = createLiveAnswerer({ engine, root: householdOf(db).root, services: { ...householdOf(db).services, engine: engine, config: { dataDir: householdOf(db).root } } });
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

test('registry assigns the action scopes and offers undo to Ask', () => {
  for (const [name, operation, scope] of [['answer', 'fact', 'write:facts'], ['act_on_recommendation', 'step', 'write:steps'], ['update_goal', 'create', 'write:goals'], ['update_goal', 'edit', 'write:goals']]) {
    assert.equal(tools.find(t => t.name === name)?.operations.find(o => o.name === operation)?.scope, scope);
  }
  assert.ok(!tools.find(t => t.name === 'undo')?.mcpOnly);
});

test('only typed statements by this actor in this thread are evidence', async () => {
  const db = await s.store();
  const ctx = { ...context(db), ownerText: null };
  db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run(key, now);
  const insert = (provenance, thread = key) => db.prepare("INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, 'me', ?, ?, ?)")
    .run(thread, words, now, provenance ? JSON.stringify(provenance) : null);
  insert(null);
  insert({ ownerInput: { actorId: 'person-b', text: words } });
  await assert.rejects(callTool('answer', factArgs, ctx), /stated/);
  insert({ ownerInput: { actorId: 'person-a', text: words } });
  const out = await callTool('answer', factArgs, ctx);
  assert.ok(out.receipt);
  const messages = buildScenario(db).live.conversations[key];
  assert.equal(messages.at(-1).provenance.actions[0].id, out.receipt.id);
});

test('a saved fact with busy planning retains its receipt and queues planning', async () => {
  const db = await s.store();
  let queued = 0;
  const ctx = { ...context(db), replan: async () => { throw new Error('busy'); }, queuePlan: () => queued++ };
  const out = await callTool('answer', factArgs, ctx);
  assert.equal(out.planningPending, true);
  assert.equal(queued, 1);
  assert.equal(getFacts(db)[factArgs.key], factArgs.value);
  assert.equal(buildScenario(db).live.conversations[key].at(-1).provenance.actions[0].planningPending, true);
});

test('a thrown answer after a committed write keeps a receipt-only recommendation conversation', async () => {
  const db = await s.store();
  addFact(db, 'household.expectingChild', true);
  await planRun(db);
  const answerer = { async answer(request) {
    await callTool('answer', factArgs, { ...request, now, conversationKey: request.key, recId: 'new-child' });
    throw new Error('transport disconnected');
  } };
  await assert.rejects(threadCreate({ db, config: {}, identity: { id: 'person-a' }, answerer,
    body: { recId: 'new-child', text: words }, scheduler: { runNow: () => planRun(db) } }), /transport disconnected/);
  const scenario = buildScenario(db);
  assert.equal(scenario.live.threads.length, 1);
  assert.equal(scenario.live.threads[0].recId, 'new-child');
  assert.equal(scenario.live.conversations[scenario.live.threads[0].key][0].provenance.actions[0].after, factArgs.value);
});

test('fact evidence accepts explicit yes/no and the shared choice labels', async () => {
  const db = await s.store();
  for (const [key, value, evidence] of [
    ['retirement.planOffersRoth', true, 'Yes, our plan offers Roth deferrals'],
    ['retirement.planOffersRoth', false, 'No, our plan does not offer Roth deferrals'],
    ['household.filingStatus', 'mfj', 'We file married filing jointly'],
    ['benefits.hsaCoverage', 'family', 'Family coverage'],
  ]) {
    db.prepare('DELETE FROM facts WHERE key = ?').run(key);
    const ctx = { ...context(db), ownerText: evidence };
    const out = await callTool('answer', { operation: 'fact',  key, value, evidence }, ctx);
    assert.ok(out.receipt);
    assert.equal(getFacts(db)[key], value);
  }
  db.prepare('DELETE FROM facts WHERE key = ?').run('retirement.planOffersRoth');
  await assert.rejects(callTool('answer', { operation: 'fact',  key: 'retirement.planOffersRoth', value: true, evidence: 'No, our plan does not offer Roth deferrals' },
    { ...context(db), ownerText: 'No, our plan does not offer Roth deferrals' }), /stated/);
});

test('a fact action replans with the same locked engine after the model round releases it', { timeout: 30000 }, async () => {
  const db = await s.store();
  addFact(db, 'household.expectingChild', true);
  await planRun(db);
  let proseCalls = 0;
  const core = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call(request) {
    let fake;
    if (request.purpose === 'job') {
      if (request.system.includes('rewrite one recommendation')) proseCalls++;
      let input = {};
      try { input = JSON.parse(request.messages[0].content); } catch { /* non-JSON job prompt */ }
      fake = [{ text: JSON.stringify(input.draft || {}) }];
    } else if (request.purpose === 'title') fake = [{ text: 'Expected date' }];
    else fake = [{ toolCalls: [{ name: 'answer', args: factArgs }] }, { text: 'The expected date is saved.' }];
    return core.call({ ...request, fake });
  } };
  const out = await threadCreate({ db, config: {}, identity: { id: 'person-a' },
    body: { recId: 'new-child', text: words }, answerer: createLiveAnswerer({ engine, root: householdOf(db).root, services: { ...householdOf(db).services, engine: engine, config: { dataDir: householdOf(db).root } } }),
    scheduler: { runNow: () => planRun(db, { engine }) } });
  assert.ok(proseCalls > 0, 'planning rewrote prose through the very same engine lock');
  assert.equal(getFacts(db)[factArgs.key], factArgs.value);
  assert.equal(out.scenario.recs.find(r => r.id === 'new-child').window.close, factArgs.value);
  assert.equal(out.message.provenance.actions[0].planningPending, false);
});

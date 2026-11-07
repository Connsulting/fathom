import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, householdOf } from './helpers/real-store.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { preferenceSave, preferenceDelete, actionUndo } from '../src/api/handlers.mjs';

const s = scratch('fathom-preferences-');
after(() => s.cleanup());

test('remembered preferences need owner words, enter the prompt, and undo restores prior text', async () => {
  const db = await s.store();
  const ctx = { db, now: '2026-11-05T12:00:00.000Z', actorId: 'person-a', conversationKey: 'ask:0123456789ab',
    turnId: 'preference-turn', ownerText: 'Please remember: keep answers short' };
  await assert.rejects(callTool('update_preferences', { operation: 'remember',  text: 'always send email', evidence: 'always send email' }, ctx));
  const saved = await callTool('update_preferences', { operation: 'remember',  text: 'keep answers short', evidence: 'keep answers short' }, ctx);
  assert.equal(buildScenario(db).preferences[0].text, 'keep answers short');
  const requests = [];
  const engine = { mode: 'live', isOn: () => true, call: async r => { requests.push(r); return { text: 'Your preferences are saved.', toolResults: [] }; } };
  await createLiveAnswerer({ engine, root: householdOf(db).root }).answer({ db, key: ctx.conversationKey, text: 'What should I do next?', actorId: 'person-a' });
  assert.match(requests[0].systemDynamic, /keep answers short/);
  assert.ok(!requests[0].system.includes('keep answers short'));
  const edited = await callTool('update_preferences', { operation: 'remember',  id: saved.preference.id, text: 'keep answers brief', evidence: 'keep answers brief' }, { ...ctx, ownerText: 'keep answers brief' });
  await callTool('undo', { operation: 'undo',  id: edited.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(buildScenario(db).preferences[0].text, 'keep answers short');
  await callTool('undo', { operation: 'undo',  id: saved.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(buildScenario(db).preferences.length, 0);
});

test('Settings validates, edits and deletes preferences through the same writer, with reversible deletion', async () => {
  const db = await s.store();
  const ctx = { db, config: {}, identity: { id: 'person-a' }, params: {}, body: { text: 'Keep answers short' } };
  const saved = preferenceSave(ctx);
  for (const text of ['', 'x'.repeat(301), 'line\nbreak']) assert.throws(() => preferenceSave({ ...ctx, body: { text } }));
  const edited = preferenceSave({ ...ctx, params: { id: saved.preference.id }, body: { text: 'Use plain language' } });
  assert.equal(edited.scenario.preferences[0].text, 'Use plain language');
  const removed = preferenceDelete({ ...ctx, params: { id: saved.preference.id }, body: {} });
  assert.equal(removed.scenario.preferences.length, 0);
  const undone = await actionUndo({ ...ctx, params: { id: removed.receipt.id } });
  assert.equal(undone.scenario.preferences[0].text, 'Use plain language');
});

test('memories carry their source: REST rows are yours, Ask rows keep their conversation through edits', async () => {
  const db = await s.store();
  const rest = { db, config: {}, identity: { id: 'person-a' }, params: {}, body: { text: 'Call the budget the plan' } };
  const mine = preferenceSave(rest);
  const listed = mine.scenario.preferences.find(p => p.id === mine.preference.id);
  assert.equal(listed.origin, 'you');
  assert.equal(listed.conversationKey, null);
  assert.ok(listed.createdAt && listed.updatedAt);
  assert.equal(listed.actorId, 'person-a');

  const ctx = { db, now: '2026-11-06T12:00:00.000Z', actorId: 'person-a', conversationKey: 'ask:0123456789ab',
    turnId: 'memory-turn', ownerText: 'Please remember: keep answers short' };
  const saved = await callTool('update_preferences', { operation: 'remember', text: 'keep answers short', evidence: 'keep answers short' }, ctx);
  let row = buildScenario(db).preferences.find(p => p.id === saved.preference.id);
  assert.equal(row.origin, 'ask');
  assert.equal(row.conversationKey, 'ask:0123456789ab');
  assert.equal(row.createdAt, '2026-11-06T12:00:00.000Z');

  const edited = preferenceSave({ ...rest, now: undefined, params: { id: saved.preference.id }, body: { text: 'keep answers brief' } });
  row = edited.scenario.preferences.find(p => p.id === saved.preference.id);
  assert.equal(row.text, 'keep answers brief');
  assert.equal(row.origin, 'ask', 'an edit keeps the first origin');
  assert.equal(row.conversationKey, 'ask:0123456789ab');
  assert.equal(row.createdAt, '2026-11-06T12:00:00.000Z');
  assert.notEqual(row.updatedAt, row.createdAt);

  const removed = preferenceDelete({ ...rest, params: { id: saved.preference.id }, body: {} });
  assert.ok(!removed.scenario.preferences.some(p => p.id === saved.preference.id));
  const undone = await actionUndo({ ...rest, params: { id: removed.receipt.id } });
  row = undone.scenario.preferences.find(p => p.id === saved.preference.id);
  assert.equal(row.text, 'keep answers brief');
  assert.equal(row.origin, 'ask');
  assert.equal(row.conversationKey, 'ask:0123456789ab');
});

test('an Ask conversation key that is not a thread key is not stored', async () => {
  const db = await s.store();
  const ctx = { db, now: '2026-11-06T12:00:00.000Z', actorId: 'person-a', conversationKey: 'scheduled:digest',
    turnId: 'memory-turn', ownerText: 'remember: use plain words' };
  const saved = await callTool('update_preferences', { operation: 'remember', text: 'use plain words', evidence: 'use plain words' }, ctx);
  const row = buildScenario(db).preferences.find(p => p.id === saved.preference.id);
  assert.equal(row.origin, 'ask');
  assert.equal(row.conversationKey, null);
});

test('legacy rows list with a null origin, and memories list newest first', async () => {
  const db = await s.store();
  const insert = db.prepare('INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('legacy-1', 'Older memory', 'person-a', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  insert.run('legacy-2', 'Newer memory', 'person-a', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
  insert.run('legacy-0', 'Same time, lower id', 'person-a', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
  const list = buildScenario(db).preferences;
  assert.deepEqual(list.map(p => p.id), ['legacy-0', 'legacy-2', 'legacy-1']);
  assert.equal(list[2].origin, null);
  assert.equal(list[2].conversationKey, null);
});

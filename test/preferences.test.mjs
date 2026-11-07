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
  await createLiveAnswerer({ engine, root: householdOf(db).root, services: { ...householdOf(db).services, engine: engine, config: { dataDir: householdOf(db).root } } }).answer({ db, key: ctx.conversationKey, text: 'What should I do next?', actorId: 'person-a' });
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

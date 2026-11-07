import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch } from './helpers/real-store.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';

const s = scratch('fathom-preferences-');
after(() => s.cleanup());

test('remembered preferences need owner words, enter the prompt, and undo restores prior text', async () => {
  const db = await s.store();
  const ctx = { db, now: '2026-11-05T12:00:00.000Z', actorId: 'person-a', conversationKey: 'ask:0123456789ab',
    turnId: 'preference-turn', ownerText: 'Please remember: keep answers short' };
  await assert.rejects(callTool('remember_preference', { text: 'always send email', evidence: 'always send email' }, ctx));
  const saved = await callTool('remember_preference', { text: 'keep answers short', evidence: 'keep answers short' }, ctx);
  assert.equal(buildScenario(db).preferences[0].text, 'keep answers short');
  const requests = [];
  const engine = { mode: 'live', isOn: () => true, call: async r => { requests.push(r); return { text: 'Your preferences are saved.', toolResults: [] }; } };
  await createLiveAnswerer({ engine }).answer({ db, key: ctx.conversationKey, text: 'What should I do next?', actorId: 'person-a' });
  assert.match(requests[0].systemDynamic, /keep answers short/);
  assert.ok(!requests[0].system.includes('keep answers short'));
  const edited = await callTool('remember_preference', { id: saved.preference.id, text: 'keep answers brief', evidence: 'keep answers brief' }, { ...ctx, ownerText: 'keep answers brief' });
  await callTool('undo_preference_action', { id: edited.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(buildScenario(db).preferences[0].text, 'keep answers short');
  await callTool('undo_preference_action', { id: saved.receipt.id }, { ...ctx, channel: 'mcp' });
  assert.equal(buildScenario(db).preferences.length, 0);
});

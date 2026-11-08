import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore, householdOf } from './helpers/real-store.mjs';
import { callTool, tools, instructions, CAPABILITIES } from '../src/tools/index.mjs';
import { listPreferences, writePreference } from '../src/actions/preferences.mjs';
import { preferenceDelete } from '../src/api/handlers.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';

const s = scratch('fathom-definitions-');
after(() => s.cleanup());
const words = 'Remember elective spending as everything except housing, childcare, healthcare and taxes.';
const args = { operation: 'save_definition', definitionId: 'elective_spending', name: 'Elective spending',
  def: { exclude: { classes: ['housing', 'debt_service', 'childcare', 'healthcare', 'taxes'] } }, evidence: words };
const context = db => ({ db, actorId: 'person-a', ownerText: words, now: '2026-11-08T12:00:00.000Z', conversationKey: 'ask:0123456789ab', channel: 'ask' });
const store = async () => s.track(await createRealStore(s.dir()));
const snapshot = db => ({ definitions: db.prepare('SELECT * FROM spending_definitions ORDER BY id').all(), preferences: db.prepare('SELECT * FROM preferences ORDER BY id').all() });

test('all five linkage rules: one atomic preference, updates, linked edit refusal, forget/delete and exact Undo', async () => {
  const db = await store(), ctx = context(db);
  const saved = await callTool('update_preferences', args, ctx);
  assert.equal(saved.definition.id, args.definitionId);
  assert.equal(typeof saved.receipt.after, 'string');
  assert.equal(saved.receipt.before, null);
  assert.equal(listPreferences(db)[0].definitionId, args.definitionId);
  assert.equal(listPreferences(db)[0].text, 'When I say Elective spending, use my saved spending definition elective_spending.');
  assert.equal(listPreferences(db)[0].id, saved.definition.preferenceId);
  const first = snapshot(db);
  const edited = await callTool('update_preferences', { ...args, name: 'Selected spending', def: { exclude: { classes: ['housing'] } } }, ctx);
  assert.equal(listPreferences(db).length, 1);
  assert.equal(listPreferences(db)[0].id, saved.definition.preferenceId);
  assert.match(listPreferences(db)[0].text, /Selected spending/);
  assert.throws(() => writePreference(ctx, { id: saved.definition.preferenceId, text: 'new words' }), /Change the definition instead/);
  await assert.rejects(callTool('update_preferences', { operation: 'remember', id: saved.definition.preferenceId, text: words, evidence: words }, ctx), /Change the definition instead/);
  await callTool('undo', { operation: 'undo', id: edited.receipt.id }, ctx);
  assert.deepEqual(snapshot(db), first);
  const forgotten = preferenceDelete({ db, config: {}, identity: { id: ctx.actorId }, params: { id: saved.definition.preferenceId }, body: {} });
  assert.deepEqual(snapshot(db), { definitions: [], preferences: [] });
  assert.equal(db.prepare('SELECT kind FROM action_receipts WHERE id=?').get(forgotten.receipt.id).kind, 'spending_definition');
  await callTool('undo', { operation: 'undo', id: forgotten.receipt.id }, ctx);
  assert.deepEqual(snapshot(db), first);
  const deleted = await callTool('update_preferences', { operation: 'delete_definition', definitionId: args.definitionId }, ctx);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.receipt.after, null);
  await callTool('undo', { operation: 'undo', id: deleted.receipt.id }, ctx);
  assert.deepEqual(snapshot(db), first);
  await callTool('undo', { operation: 'undo', id: saved.receipt.id }, ctx);
  assert.deepEqual(snapshot(db), { definitions: [], preferences: [] });
});

test('a later conversation receives the definition id and spending.total resolves the saved selection', async () => {
  const db = await store(), ctx = context(db);
  await callTool('update_preferences', args, ctx);
  db.prepare("INSERT INTO accounts(id,name,kind,sort) VALUES ('card','Synthetic card','card',0)").run();
  for (const [category, amount] of [['Mortgage', -2000], ['Groceries', -100], ['Shopping', -60]])
    db.prepare("INSERT INTO transactions(account_id,date,amount,description,category) VALUES ('card','2026-10-10',?,'Synthetic merchant',?)").run(amount, category);
  let dynamic;
  const engine = { mode: 'live', isOn: () => true, call: async r => { dynamic = r.systemDynamic; return { text: 'Your selection is available.', toolResults: [] }; } };
  const household = householdOf(db);
  await createLiveAnswerer({ engine, root: household.root, services: { ...household.services, household, engine } }).answer({ db, key: 'ask:abcdef012345', text: 'What is my elective spending?', actorId: ctx.actorId });
  assert.match(dynamic, /"definitionId":"elective_spending"/);
  const result = await callTool('spending', { operation: 'total', definition: args.definitionId, window: 'custom', from: '2026-10', to: '2026-10' }, { db });
  assert.equal(result.total.value, 160);
  assert.equal(result.definition.source, 'saved');
  assert.ok((await callTool('spending', { operation: 'definitions' }, { db })).some(d => d.id === args.definitionId && d.preferenceId));
  assert.ok(CAPABILITIES.includes('definitions'));
  assert.match(instructions, /named spending selection.*save_definition/i);
});

test('definition bounds, built-ins, evidence, preference cap and stale Undo refuse atomically', async () => {
  const db = await store(), ctx = context(db);
  for (const change of [ { definitionId: 'essential' }, { definitionId: '../escape' }, { name: 'x'.repeat(61) },
    { def: { exclude: { classes: ['nonsense'] } } }, { def: { include: { surprise: [] } } }, { def: { other: {} } }, { evidence: 'invented' } ]) {
    await assert.rejects(callTool('update_preferences', { ...args, ...change }, ctx));
    assert.deepEqual(snapshot(db), { definitions: [], preferences: [] });
  }
  await assert.rejects(callTool('update_preferences', { operation: 'delete_definition', definitionId: 'essential' }, ctx), /built.in/i);
  const hyphenated = await callTool('update_preferences', { ...args, definitionId: 'valid-selection' }, ctx);
  assert.equal(hyphenated.definition.id, 'valid-selection');
  await callTool('update_preferences', { operation: 'delete_definition', definitionId: 'valid-selection' }, ctx);
  const saved = await callTool('update_preferences', args, ctx);
  await callTool('update_preferences', { ...args, name: 'Changed selection' }, ctx);
  await assert.rejects(callTool('undo', { operation: 'undo', id: saved.receipt.id }, ctx), /changed since/);
  for (let i = 1; i < 50; i++) await callTool('update_preferences', { ...args, definitionId: `selection_${i}` }, ctx);
  await assert.rejects(callTool('update_preferences', { ...args, definitionId: 'too_many' }, ctx), /50/);
  await callTool('update_preferences', { ...args, name: 'Updated at limit' }, ctx);
  const second = await store(), ctx2 = context(second);
  for (let i = 0; i < 100; i++) writePreference(ctx2, { text: `Synthetic preference ${i}` });
  await assert.rejects(callTool('update_preferences', args, ctx2), /100/);
  assert.equal(second.prepare('SELECT count(*) n FROM spending_definitions').get().n, 0);
});

test('plain forget is reversible and proposals cover both linked tables without writing', async () => {
  const db = await store(), ctx = context(db);
  const plain = writePreference(ctx, { text: 'Short answers' });
  const deleted = await callTool('update_preferences', { operation: 'forget', id: plain.preference.id }, ctx);
  await callTool('undo', { operation: 'undo', id: deleted.receipt.id }, ctx);
  let proposal;
  const tool = proposalTools(tools).find(t => t.name === 'update_preferences');
  await tool.handler({ ...args, propose: true }, { ...ctx, onProposal: p => { proposal = p; } });
  assert.equal(db.prepare('SELECT count(*) n FROM spending_definitions').get().n, 0);
  await callTool('update_preferences', args, ctx);
  assert.notEqual(proposal.basis, proposalBasis(db, proposal.tool, proposal.scopes, proposal.args));
});

test('migration preserves existing preferences and demo reset clears linked rows in foreign-key order', async () => {
  const { openDb, migrate, setSetting } = await import('../src/store/db.mjs');
  const { join } = await import('node:path');
  const { seedDemo } = await import('../demo/seed.mjs');
  const db = s.track(openDb(join(s.dir(), 'migration.sqlite')));
  migrate(db, { through: 31 });
  db.prepare("INSERT INTO preferences(id,text,actor_id,created_at,updated_at) VALUES ('old','Synthetic legacy preference','person-a','2026-01-01','2026-01-01')").run();
  migrate(db);
  assert.deepEqual({ ...db.prepare("SELECT * FROM preferences WHERE id='old'").get() }, { id: 'old', text: 'Synthetic legacy preference', actor_id: 'person-a', created_at: '2026-01-01', updated_at: '2026-01-01', origin: null, conversation_key: null, definition_id: null });
  await callTool('update_preferences', args, context(db));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  setSetting(db, 'mode', 'demo');
  seedDemo(db);
  assert.equal(db.prepare('SELECT count(*) n FROM spending_definitions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM preferences').get().n, 0);
});

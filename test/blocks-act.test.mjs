import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { tempDb, serveAppFixture } from './helpers/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { getSetting, setSetting } from '../src/store/db.mjs';
import { pickWargame } from '../src/decisions/write.mjs';

async function fixture(t, name = 'deferral', real = false) {
  const s = await tempDb(); await seedDemo(s.db);
  if (real) await setSetting(s.db, 'mode', 'real');
  await s.db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE wargame = ?").run(name);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', FATHOM_CLOCK: '2026-11-05' });
  const app = await serveAppFixture({ db: s.db, config, authenticated: real });
  t.after(async () => { await app.close(); await s.close(); });
  const args = { operation: 'wargame', name };
  const result = await callTool('recommendations', args, { db: s.db, clock: config.clock });
  const source = { tool: 'recommendations', args, path: name === 'salary' ? 'salary.points' : 'deferral.options' };
  const spec = { source, fields: [name === 'salary' ? 'figures.salary' : 'figures.amount'] };
  const snapshot = buildSnapshot('compare', spec, [{ name: 'recommendations', args, result }]);
  const thread = (await app.postJson('/api/threads')).json.thread;
  const id = (await s.db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts, provenance) VALUES (?, 'fathom', '<p>Options</p>', '[]', 0, ?, ?) RETURNING id")
    .get(thread.key, '2026-11-05T12:00:00Z', JSON.stringify({ blocks: [{ id: 'b1', op: 'compare', spec, snapshot }] }))).id;
  const path = `/api/threads/${thread.id}/messages/m${id}/blocks/b1/act`;
  return { ...s, app, thread, snapshot, path };
}

test('only a war-game list comparison binds closed actions', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.snapshot.action, { kind: 'wargame', name: 'deferral', decisionId: 'deferral', status: 'open' });
  const result = await callTool('recommendations', { operation: 'wargame', name: 'deferral' }, { db: f.db });
  const args = { operation: 'wargame', name: 'deferral' };
  const spec = { options: [0, 1].map(i => ({ source: { tool: 'recommendations', args, path: `deferral.options.${i}` } })), fields: ['figures.amount'] };
  assert.equal(buildSnapshot('compare', spec, [{ name: 'recommendations', args, result }]).action, undefined);
});

test('pick uses stored point ids and one receipt survives Undo and reload', async t => {
  const f = await fixture(t);
  const prior = await getSetting(f.db, 'wargame.picks', null);
  await pickWargame(f.db, 'deferral', f.snapshot.options[1].id);
  const want = await getSetting(f.db, 'wargame.picks');
  if (prior) await setSetting(f.db, 'wargame.picks', prior);
  else await f.db.prepare("DELETE FROM settings WHERE key = 'wargame.picks'").run();
  const res = await f.app.postJson(f.path, { action: 'pick', option: 1 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(await getSetting(f.db, 'wargame.picks'), want);
  const receipt = res.json.message.provenance.actions[0];
  assert.ok(res.json.message.provenance.actionTurn);
  assert.match(res.json.message.text, /You picked/);
  assert.equal((await f.app.postJson(`/api/actions/${receipt.id}/undo`)).status, 200);
  assert.deepEqual(await getSetting(f.db, 'wargame.picks', null), prior);
  const thread = (await f.app.request({ path: `/api/threads/${f.thread.id}` })).json;
  const actions = thread.messages.flatMap(m => m.provenance?.actions || []);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].undone, true);
});

test('decide follows the live pick and Undo revisits through the registry', async t => {
  const f = await fixture(t);
  await f.app.postJson(f.path, { action: 'pick', option: 1 });
  const res = await f.app.postJson(f.path, { action: 'decide' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await f.db.prepare("SELECT status FROM decisions WHERE id = 'deferral'").get()).status, 'decided');
  const fact = JSON.parse((await f.db.prepare("SELECT value FROM facts WHERE key = 'business.deferralDecided'").get()).value);
  assert.equal(fact.option, f.snapshot.options[1].id);
  const receipt = res.json.message.provenance.actions[0];
  assert.equal((await f.app.postJson(`/api/actions/${receipt.id}/undo`)).status, 200);
  assert.equal((await f.db.prepare("SELECT status FROM decisions WHERE id = 'deferral'").get()).status, 'open');
  const actions = (await f.app.request({ path: `/api/threads/${f.thread.id}` })).json.messages.flatMap(m => m.provenance?.actions || []);
  assert.equal(actions.length, 2);
  assert.equal(actions.at(-1).undone, true);
});

test('bad indexes and request point ids are refused; valid choices remain live', async t => {
  const f = await fixture(t);
  for (const body of [{ action: 'pick', option: -1 }, { action: 'pick', option: 999 }, { action: 'pick', option: '1' },
    { action: 'pick', option: 1, point: 'injected' }, { action: 'decide', option: 1 }, { action: 'other' }]) {
    assert.equal((await f.app.postJson(f.path, body)).status, 400);
  }
  assert.equal((await f.app.postJson(f.path, { action: 'pick', option: 1 })).status, 200);
  await f.db.prepare("UPDATE decisions SET unavailable_reason = 'Inputs changed' WHERE id = 'deferral'").run();
  assert.equal((await f.app.postJson(f.path, { action: 'pick', option: 0 })).status, 409);
  assert.equal((await f.app.postJson(f.path, { action: 'decide' })).status, 409);
});

test('a message in another conversation and a block without actions cannot write', async t => {
  const f = await fixture(t);
  const other = (await f.app.postJson('/api/threads')).json.thread;
  assert.equal((await f.app.postJson(f.path.replace(f.thread.id, other.id), { action: 'pick', option: 1 })).status, 404);
  const row = await f.db.prepare('SELECT id, provenance FROM messages WHERE conversation_key = ?').get(f.thread.key);
  const pv = JSON.parse(row.provenance); delete pv.blocks[0].snapshot.action;
  await f.db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify(pv), row.id);
  assert.equal((await f.app.postJson(f.path, { action: 'pick', option: 1 })).status, 400);
});


test('the active salary decision is bound when an earlier salary year is already decided', async t => {
  const f = await fixture(t, 'salary');
  await f.db.prepare("UPDATE decisions SET status = 'decided' WHERE id = 'salary26'").run();
  const args = { operation: 'wargame', name: 'salary' };
  const result = await callTool('recommendations', args, { db: f.db, clock: '2027-01-05' });
  const snap = buildSnapshot('compare', { source: { tool: 'recommendations', args, path: 'salary.points' }, fields: ['figures.salary'] }, [{ name: 'recommendations', args, result }]);
  assert.equal(snap.action.decisionId, 'salary27');
});

test('a real signed-in actor owns the receipt and can undo the pick', async t => {
  const f = await fixture(t, 'deferral', true);
  const res = await f.app.postJson(f.path, { action: 'pick', option: 1 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const receipt = res.json.message.provenance.actions[0];
  assert.equal(receipt.actorId, f.app.session.user.id);
  assert.equal((await f.app.postJson(`/api/actions/${receipt.id}/undo`)).status, 200);
});

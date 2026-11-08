import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, createRealStore } from './helpers/real-store.mjs';
import { callTool } from '../src/tools/index.mjs';
import { packToggle } from '../src/api/handlers.mjs';
import { proposalBasis } from '../src/actions/proposals.mjs';

const s = scratch('fathom-pack-writes-');
after(async () => await s.cleanup());
async function setup() {
  const db = s.track(await createRealStore(s.dir()));
  await db.prepare("INSERT INTO recs(id,def,status,sort,updated_at) VALUES ('rec-a','{}','hidden',0,'2026-11-01')").run();
  await db.prepare("INSERT INTO packs_state(id,def,active,unhid,sort,updated_at) VALUES ('pack-a',?,0,'[]',0,'2026-11-01')")
    .run(JSON.stringify({ id: 'pack-a', name: 'Synthetic pack', status: 'available', recIds: ['rec-a'] }));
  return { db, actorId: 'person-a', now: '2026-11-08T12:00:00.000Z', channel: 'mcp' };
}
const status = async db => (await db.prepare("SELECT status FROM recs WHERE id='rec-a'").get()).status;
const active = async db => (await db.prepare("SELECT active FROM packs_state WHERE id='pack-a'").get()).active;
const change = (ctx, enabled) => callTool('update_preferences', { operation: 'pack', packId: 'pack-a', active: enabled }, ctx);

test('pack activation is idempotent, matches HTTP rec effects and Undo restores wasActive', async () => {
  const ctx = await setup();
  const on = await change(ctx, true);
  assert.deepEqual([on.wasActive, on.pack.status, await active(ctx.db), await status(ctx.db)], [false, 'active', 1, 'proposed']);
  assert.equal((await change(ctx, true)).receipt, null);
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM rec_events').get()).n, 1);
  await callTool('undo', { operation: 'undo', id: on.receipt.id }, ctx);
  assert.deepEqual([await active(ctx.db), await status(ctx.db)], [0, 'hidden']);
  await packToggle({ db: ctx.db, params: { id: 'pack-a' }, config: {} });
  assert.deepEqual([await active(ctx.db), await status(ctx.db)], [1, 'proposed']);
  const off = await change(ctx, false);
  assert.equal(off.wasActive, true);
  assert.equal(await status(ctx.db), 'hidden');
  await callTool('undo', { operation: 'undo', id: off.receipt.id }, ctx);
  assert.deepEqual([await active(ctx.db), await status(ctx.db)], [1, 'proposed']);
});

test('another active pack keeps a recommendation visible and later edits refuse Undo', async () => {
  const ctx = await setup();
  const on = await change(ctx, true);
  await ctx.db.prepare("INSERT INTO packs_state(id,def,active,unhid,sort,updated_at) VALUES ('pack-b',?,1,'[]',1,'2026-11-01')")
    .run(JSON.stringify({ id: 'pack-b', status: 'active', recIds: ['rec-a'] }));
  await change(ctx, false);
  assert.equal(await status(ctx.db), 'proposed');
  await assert.rejects(callTool('undo', { operation: 'undo', id: on.receipt.id }, ctx), /changed since/);
  await assert.rejects(callTool('update_preferences', { operation: 'pack', packId: 'missing', active: true }, ctx), /pack/);
});

test('pack proposal basis tracks packs and recommendation status', async () => {
  const ctx = await setup(), args = { operation: 'pack', packId: 'pack-a', active: true };
  const before = await proposalBasis(ctx.db, 'update_preferences', ['write:preferences'], args);
  await change(ctx, true);
  assert.notEqual(await proposalBasis(ctx.db, 'update_preferences', ['write:preferences'], args), before);
});

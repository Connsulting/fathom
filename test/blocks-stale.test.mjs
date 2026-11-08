import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { tempDb, serveAppFixture, request } from './helpers/server.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { createThread } from '../src/api/threads.mjs';

const clock = '2026-11-05';
async function fixture(t) {
  const s = await tempDb(); seedDemo(s.db); t.after(() => s.close());
  const server = await serveAppFixture({ db: s.db, config: { clock } }); t.after(() => server.close());
  const thread = createThread(s.db, `${clock}T00:00:00Z`);
  async function store(op, spec) {
    const result = await callTool(spec.source.tool, spec.source.args, { db: s.db, clock });
    const block = { id: 'b1', op, spec, calls: [{ tool: spec.source.tool, args: spec.source.args }],
      snapshot: buildSnapshot(op, spec, [{ name: spec.source.tool, args: spec.source.args, result }]), asOf: clock, builtAt: `${clock}T00:00:00Z` };
    const id = s.db.prepare("INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, 'fathom', 'Stored answer', ?, ?)")
      .run(thread.key, `${clock}T00:00:00Z`, JSON.stringify({ blocks: [block] })).lastInsertRowid;
    return { block, id: `m${id}` };
  }
  const dump = () => JSON.stringify(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, s.db.prepare(`SELECT * FROM "${name}"`).all()]));
  const status = async () => {
    const before = dump(); const res = await request(server.baseUrl, { path: `/api/threads/${thread.id}/blocks` });
    assert.equal(res.status, 200); assert.equal(dump(), before, 'status reads write no row'); return res.json.blocks;
  };
  return { ...s, server, thread, store, status };
}

test('status is current, then stale after a new transaction; snapshots remain unchanged', async t => {
  const f = await fixture(t);
  const spec = { source: { tool: 'spending', args: { operation: 'total', groupBy: 'category', from: '2026-01', to: '2026-10' }, path: 'groups' }, columns: ['key', 'figure'] };
  const { id, block } = await f.store('table', spec);
  assert.deepEqual(await f.status(), [{ messageId: id, id: 'b1', state: 'current', changed: 0 }]);
  const row = f.db.prepare('SELECT * FROM transactions WHERE id = ?').get(block.snapshot.rows[0].cells[1].fig.provenance.sources[0].ids[0]);
  const before = f.db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id.slice(1)).provenance;
  f.db.prepare('INSERT INTO transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)').run(row.account_id, '2026-10-15', row.amount, row.description);
  const blocks = await f.status();
  assert.equal(blocks[0].state, 'stale'); assert.ok(blocks[0].changed > 0);
  assert.equal(f.db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id.slice(1)).provenance, before);
});

test('a date-only deadline timeline becomes stale when the date changes', async t => {
  const f = await fixture(t);
  await f.store('timeline', { source: { tool: 'household', args: { operation: 'deadlines' }, path: '' }, date: 'date' });
  assert.equal((await f.status())[0].state, 'current');
  const row = f.db.prepare('SELECT id FROM deadlines LIMIT 1').get(); assert.ok(row);
  f.db.prepare('UPDATE deadlines SET date = ? WHERE id = ?').run('2027-03-15', row.id);
  assert.equal((await f.status())[0].state, 'stale');
});

test('an errored source is unavailable; write tools are never replayed', async t => {
  const f = await fixture(t);
  const args = { operation: 'pnl', groupBy: 'category', from: '2026-01', to: '2026-10' };
  const result = await callTool('business', args, { db: f.db, clock });
  args.entity = result.entities[0].entity.key;
  const { id, block } = await f.store('table', { source: { tool: 'business', args, path: 'entities.0.groups' }, columns: ['key', 'expenses'] });
  assert.equal((await f.status())[0].state, 'current');
  block.calls[0].args = { ...args, entity: 'missing-entity' };
  f.db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify({ blocks: [block] }), id.slice(1));
  assert.equal((await f.status())[0].state, 'unavailable');
  block.calls = [{ tool: 'update_account', args: { operation: 'rename', id: 'checking', name: 'Must not write' } }];
  f.db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify({ blocks: [block] }), id.slice(1));
  assert.equal((await f.status())[0].state, 'unavailable');
});

test('only the twenty most recent messages with blocks are checked and unknown threads are 404', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 22; i++) await f.store('timeline', { source: { tool: 'household', args: { operation: 'deadlines' }, path: '' }, date: 'date' });
  const blocks = await f.status(); assert.equal(blocks.length, 20);
  const missing = await request(f.server.baseUrl, { path: '/api/threads/000000000000/blocks' }); assert.equal(missing.status, 404);
});

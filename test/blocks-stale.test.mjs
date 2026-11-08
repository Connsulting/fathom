import test from 'node:test';
import assert from 'node:assert/strict';
import { openScope } from '../src/storage/index.mjs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { tempDb, tempDir, servedStore, serveAppFixture, request, postJson } from './helpers/server.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { createThread } from '../src/api/threads.mjs';
import { startServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { demoRouteBehavior } from '../src/public-demo/control.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const clock = '2026-11-05';
async function fixture(t) {
  const s = await tempDb(); await seedDemo(s.db); t.after(async () => await s.close());
  const server = await serveAppFixture({ db: s.db, config: { clock } }); t.after(() => server.close());
  const thread = await createThread(s.db, `${clock}T00:00:00Z`);
  async function store(op, spec) {
    const result = await callTool(spec.source.tool, spec.source.args, { db: s.db, clock });
    const block = { id: 'b1', op, spec, calls: [{ tool: spec.source.tool, args: spec.source.args }],
      snapshot: buildSnapshot(op, spec, [{ name: spec.source.tool, args: spec.source.args, result }]), asOf: clock, builtAt: `${clock}T00:00:00Z` };
    const id = (await s.db.prepare("INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, 'fathom', 'Stored answer', ?, ?)")
      .run(thread.key, `${clock}T00:00:00Z`, JSON.stringify({ blocks: [block] }))).lastInsertRowid;
    return { block, id: `m${id}` };
  }
  const dump = async () => JSON.stringify(await mapSeries((await s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()), async ({ name }) => [name, await s.db.prepare(`SELECT * FROM "${name}"`).all()]));
  const status = async () => {
    const before = await dump(); const res = await request(server.baseUrl, { path: `/api/threads/${thread.id}/blocks` });
    assert.equal(res.status, 200); assert.equal(await dump(), before, 'status reads write no row'); return res.json.blocks;
  };
  return { ...s, server, thread, store, status };
}

test('status is current, then stale after a new transaction; snapshots remain unchanged', async t => {
  const f = await fixture(t);
  const spec = { source: { tool: 'spending', args: { operation: 'total', groupBy: 'category', from: '2026-01', to: '2026-10' }, path: 'groups' }, columns: ['key', 'figure'] };
  const { id, block } = await f.store('table', spec);
  assert.deepEqual(await f.status(), [{ messageId: id, id: 'b1', state: 'current', changed: 0 }]);
  const row = await f.db.prepare('SELECT * FROM transactions WHERE id = ?').get(block.snapshot.rows[0].cells[1].fig.provenance.sources[0].ids[0]);
  const before = (await f.db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id.slice(1))).provenance;
  await f.db.prepare('INSERT INTO transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)').run(row.account_id, '2026-10-15', row.amount, row.description);
  const blocks = await f.status();
  assert.equal(blocks[0].state, 'stale'); assert.ok(blocks[0].changed > 0);
  assert.equal((await f.db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id.slice(1))).provenance, before);
});

test('a date-only deadline timeline becomes stale when the date changes', async t => {
  const f = await fixture(t);
  await f.store('timeline', { source: { tool: 'household', args: { operation: 'deadlines' }, path: '' }, date: 'date' });
  assert.equal((await f.status())[0].state, 'current');
  const row = await f.db.prepare('SELECT id FROM deadlines LIMIT 1').get(); assert.ok(row);
  await f.db.prepare('UPDATE deadlines SET date = ? WHERE id = ?').run('2027-03-15', row.id);
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
  await f.db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify({ blocks: [block] }), id.slice(1));
  assert.equal((await f.status())[0].state, 'unavailable');
  block.calls = [{ tool: 'update_account', args: { operation: 'rename', id: 'checking', name: 'Must not write' } }];
  await f.db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify({ blocks: [block] }), id.slice(1));
  assert.equal((await f.status())[0].state, 'unavailable');
});

test('only the twenty most recent messages with blocks are checked and unknown threads are 404', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 22; i++) await f.store('timeline', { source: { tool: 'household', args: { operation: 'deadlines' }, path: '' }, date: 'date' });
  const blocks = await f.status(); assert.equal(blocks.length, 20);
  const missing = await request(f.server.baseUrl, { path: '/api/threads/000000000000/blocks' }); assert.equal(missing.status, 404);
});

test('status compares labels, order and figure dates; money is compared to the cent', async t => {
  const f = await fixture(t);
  const { id, block } = await f.store('table', { source: { tool: 'spending', args: { operation: 'total', groupBy: 'category', from: '2026-01', to: '2026-10' }, path: 'groups' }, columns: ['key', 'figure'] });
  const save = async snapshot => await f.db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify({ blocks: [{ ...block, snapshot }] }), id.slice(1));
  let snapshot = structuredClone(block.snapshot);
  snapshot.rows[0].cells[1].fig.value += 0.001; await save(snapshot);
  assert.equal((await f.status())[0].state, 'current');
  for (const mutate of [s => { s.rows[0].cells[0].text += ' changed'; }, s => { s.rows.reverse(); },
    s => { s.rows[0].cells[1].fig.asOf = '2026-01-01'; }, s => { s.rows[0].cells[1].fig.value += 0.01; }]) {
    snapshot = structuredClone(block.snapshot); mutate(snapshot); await save(snapshot);
    assert.equal((await f.status())[0].state, 'stale');
  }
});

test('row account labels from an earlier account read stay current and track a rename', async t => {
  const f = await fixture(t);
  const spec = { source: { tool: 'transactions', args: { operation: 'search', limit: 3 }, path: 'rows' }, columns: ['description', 'amount'] };
  const { id, block } = await f.store('table', spec);
  const results = await Promise.all(await mapSeries([{ tool: 'accounts', args: { operation: 'list' } }, ...block.calls], async c => ({
    name: c.tool, args: c.args, result: await callTool(c.tool, c.args, { db: f.db, clock }),
  })));
  block.snapshot = buildSnapshot('table', spec, results);
  await f.db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify({ blocks: [block] }), id.slice(1));
  assert.equal((await f.status())[0].state, 'current');
  const account = results.find(r => r.name === 'transactions').result.rows[0].accountId;
  await f.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run('Synthetic renamed account', account);
  assert.equal((await f.status())[0].state, 'stale');
});

test('block status reads stay inside the visitor conversation sandbox', async t => {
  const dataDir = await tempDir();
  const origin = 'http://localhost:5031';
  const server = await startServer({ ...loadConfig({ FATHOM_DATA: dataDir, FATHOM_PUBLIC_DEMO_DATA: dataDir,
    FATHOM_PUBLIC_DEMO: '1', FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake', FATHOM_PUBLIC_URL: origin }), port: 0 });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const created = await postJson(server.url, '/api/threads', {}, { origin });
  assert.equal(created.status, 200);
  const cookie = created.headers['set-cookie'][0].split(';')[0];
  const db = new DatabaseSync((await servedStore(join(dataDir, 'sandboxes', cookie.split('=')[1]))).file);
  try {
    const args = { operation: 'deadlines' };
    const result = await callTool('household', args, { db });
    const spec = { source: { tool: 'household', args, path: '' }, date: 'date' };
    const block = { id: 'b1', op: 'timeline', spec, calls: [{ tool: 'household', args }],
      snapshot: buildSnapshot('timeline', spec, [{ name: 'household', args, result }]), builtAt: `${clock}T00:00:00Z` };
    await db.prepare("INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, 'fathom', 'Synthetic timeline', ?, ?)")
      .run(created.json.thread.key, `${clock}T00:00:00Z`, JSON.stringify({ blocks: [block] }));
  } finally { await db.close(); }
  const path = `/api/threads/${created.json.thread.id}/blocks`;
  const own = await request(server.url, { path, headers: { cookie } });
  assert.equal(own.status, 200); assert.equal(own.json.blocks.length, 1); assert.equal(own.json.blocks[0].state, 'current');
  assert.equal((await request(server.url, { path })).status, 404);
  assert.equal(demoRouteBehavior('HEAD', '/api/threads/:id/blocks'), 'sandbox');
  assert.equal(demoRouteBehavior('POST', '/api/threads/:id/blocks'), 'off');
});

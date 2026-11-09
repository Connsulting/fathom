import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { backupFixture, backup, marker } from './helpers/tenancy-backup.mjs';
import { openPlatform } from '../src/platform/db.mjs';
import { startRuntime } from './helpers/tenancy-runtime.mjs';
import { startModelEmulator, gate } from './helpers/model-emulator.mjs';
import { setInstanceCap, setAllocation } from '../src/platform/model-budget.mjs';
import { request } from 'node:http';
import { demoRouteBehavior } from '../src/public-demo/control.mjs';

test('real passkey sessions authorize only the household admin and never accept paths, keys or a household selector', async () => {
  const f = await backupFixture();
  try {
    const count = async () => (await f.platform.prepare('SELECT count(*) AS n FROM household_backup_operations').get()).n;
    assert.equal((await f.A.member.client.post('/api/household/backups')).status, 403);
    for (const body of [{ householdId: f.B.id }, { destination: f.destination }, { keyFile: f.keys.backupKeyFile }, { path: '../foreign' }]) {
      assert.equal((await f.A.admin.client.post('/api/household/backups', body)).status, 400);
    }
    assert.equal((await f.A.admin.client.post(`/api/household/backups?householdId=${f.B.id}`)).status, 400);
    assert.equal(await count(), 0);
    const queued = await f.A.admin.client.post('/api/household/backups');
    assert.equal(queued.status, 200, queued.text);
    assert.equal(queued.json.status, 'queued');
    const id = queued.json.operationId;
    assert.equal((await f.B.admin.client.get(`/api/household/backups/${id}/status`)).status, 404);
    assert.equal((await f.A.member.client.get(`/api/household/backups/${id}/status`)).status, 403);
    await f.server.app.backups.idle();
    const status = await f.A.admin.client.get(`/api/household/backups/${id}/status`);
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.status, 'done');
    assert.ok(status.json.fileCount >= 5);
    assert.ok(status.json.byteCount > 0);
    assert.deepEqual(Object.keys(status.json).sort(), ['byteCount', 'code', 'fileCount', 'operationId', 'status']);
    const row = await f.platform.prepare('SELECT * FROM household_backup_operations WHERE id = ?').get(id);
    assert.ok(existsSync(row.bundle_file));
    assert.ok(row.bundle_file.startsWith(f.destination + '/'));
    assert.equal(demoRouteBehavior('POST', '/api/household/backups'), 'off');
    assert.equal(demoRouteBehavior('GET', '/api/household/backups/:id/status'), 'off');
  } finally { await f.close(); }
});

test('disconnecting an in-flight MCP tool cannot leak its request or abandon its active work during backup', { timeout: 30000 }, async () => {
  const emulator = await startModelEmulator();
  const response = gate();
  emulator.script([{ wait: response.promise, text: JSON.stringify({ rows: [] }) }]);
  let f;
  let ctx;
  let client;
  let finished = false;
  let timer;
  try {
    f = await backupFixture({ engine: 'live', engineOptions: { testTransport: { baseURL: emulator.baseURL } } });
    await f.A.admin.client.post('/api/household/outbound', { jobs: false, engine: true });
    await setInstanceCap(f.platform, 100); await setAllocation(f.platform, f.A.id, 50);
    ctx = await f.context(f.A.id);
    const key = await f.A.admin.client.post('/api/keys', { name: 'Synthetic disconnect probe', scopes: ['read', 'write:imports'] });
    assert.equal(key.status, 200, key.text);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'refresh', arguments: {
      operation: 'build_your_plans', fileIds: ['synthetic-file'],
    } } });
    client = request(`${f.server.baseUrl}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${key.json.key}`, 'content-length': Buffer.byteLength(body),
    } });
    client.on('error', () => {});
    client.end(body);
    await emulator.waitForRequests(1);
    await new Promise(resolve => { client.once('close', resolve); client.destroy(); });
    await new Promise(resolve => setImmediate(resolve));
    const queued = await f.A.admin.client.post('/api/household/backups');
    assert.equal(queued.status, 200, queued.text);
    const idle = f.server.app.backups.idle();
    await Promise.race([
      idle.then(() => { throw new Error('backup completed before the disconnected tool finished'); }),
      new Promise(resolve => setTimeout(resolve, 100)),
    ]);
    assert.equal((await f.B.admin.client.get('/api/scenario')).status, 200);
    response.open();
    await Promise.race([idle, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('disconnected MCP request blocked backup completion')), 5000); })]);
    finished = true;
    const status = await f.A.admin.client.get(`/api/household/backups/${queued.json.operationId}/status`);
    assert.equal(status.json.status, 'done', status.text);
    assert.equal((await f.platform.prepare('SELECT status FROM households WHERE id = ?').get(f.A.id)).status, 'active');
    assert.equal((await (await f.context(f.A.id)).db.prepare("SELECT count(*) AS n FROM action_receipts WHERE scope = 'write:imports' AND json_extract(after_state, '$.status') = 'built'").get()).n, 1);
  } finally {
    clearTimeout(timer); response.open(); client?.destroy();
    if (f && ctx && !finished) f.server.app.runtimes.release(ctx);
    await f?.close(); await emulator.close();
  }
});

test('an admin can inspect a draining backup, and unavailable configuration refuses before queuing', async () => {
  const f = await backupFixture();
  let held;
  try {
    const keyBytes = await import('node:fs').then(fs => fs.readFileSync(f.keys.backupKeyFile));
    rmSync(f.keys.backupKeyFile);
    const refused = await f.A.admin.client.post('/api/household/backups');
    assert.equal(refused.status, 409);
    assert.equal((await f.platform.prepare('SELECT count(*) AS n FROM household_backup_operations').get()).n, 0);
    writeFileSync(f.keys.backupKeyFile, keyBytes, { mode: 0o600 });
    held = await f.context(f.A.id); f.server.app.runtimes.acquire(held);
    const queued = await f.A.admin.client.post('/api/household/backups');
    assert.equal(queued.status, 200, queued.text);
    await new Promise(resolve => setImmediate(resolve));
    const status = await f.A.admin.client.get(`/api/household/backups/${queued.json.operationId}/status`);
    assert.equal(status.status, 200, status.text); assert.equal(status.json.status, 'running');
    assert.equal((await f.B.admin.client.get('/api/scenario')).status, 200);
    f.server.app.runtimes.release(held); held = null;
    await f.server.app.backups.idle();
    assert.equal((await f.A.admin.client.get(`/api/household/backups/${queued.json.operationId}/status`)).json.status, 'done');
  } finally { if (held) f.server.app.runtimes.release(held); await f.close(); }
});

test('the OS commands use the same configured destination and exact household confirmation', async () => {
  const f = await backupFixture();
  let server;
  try {
    const snap = await backup(f);
    assert.equal((await f.A.admin.client.get('/api/scenario')).status, 200);
    const options = { env: { ...process.env, ...f.server.env }, encoding: 'utf8', timeout: 30000 };
    const count = (await f.platform.prepare('SELECT count(*) AS n FROM household_backup_operations').get()).n;
    const active = spawnSync(process.execPath, ['scripts/restore-household.mjs', '--household', f.A.id, '--confirm', f.A.id, '--bundle', snap.file], options);
    assert.equal(active.status, 1); assert.match(active.stderr, /source_in_use/);
    assert.equal((await f.platform.prepare('SELECT count(*) AS n FROM household_backup_operations').get()).n, count);
    assert.equal((await f.A.admin.client.get('/api/scenario')).status, 200, 'a running service is never suspended by a refused offline command');
    await f.server.close();
    const made = spawnSync(process.execPath, ['scripts/backup-household.mjs', '--household', f.A.id], options);
    assert.equal(made.status, 0, made.stderr);
    const status = JSON.parse(made.stdout);
    assert.equal(status.status, 'done'); assert.ok(!made.stdout.includes(f.destination));
    const platform = await openPlatform(join(f.dataDir, 'platform.sqlite'));
    const op = await platform.prepare('SELECT * FROM household_backup_operations WHERE id = ?').get(status.operationId);
    assert.ok(op.bundle_file.startsWith(f.destination + '/'));
    await platform.close();
    const refused = spawnSync(process.execPath, ['scripts/restore-household.mjs', '--household', f.A.id, '--confirm', f.B.id, '--bundle', op.bundle_file], options);
    assert.equal(refused.status, 1); assert.match(refused.stderr, /restore_confirmation_required/);
    const restored = spawnSync(process.execPath, ['scripts/restore-household.mjs', '--household', f.A.id, '--confirm', f.A.id, '--bundle', op.bundle_file], options);
    assert.equal(restored.status, 0, restored.stderr); assert.equal(JSON.parse(restored.stdout).status, 'done');
    server = await startRuntime({ dataDir: f.dataDir, keys: f.keys, engine: 'off' });
    assert.equal(await marker((await server.app.runtimes.get(f.A.id))), 'alpha');
    assert.equal(await marker((await server.app.runtimes.get(f.B.id))), 'bravo');
  } finally { await server?.close(); await f.close(); }
});

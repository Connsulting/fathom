import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { backupFixture, marker } from './helpers/tenancy-backup.mjs';
import { openPlatform } from '../src/platform/db.mjs';
import { startRuntime } from './helpers/tenancy-runtime.mjs';
import { demoRouteBehavior } from '../src/public-demo/control.mjs';

test('real passkey sessions authorize only the household admin and never accept paths, keys or a household selector', async () => {
  const f = await backupFixture();
  try {
    const count = () => f.platform.prepare('SELECT count(*) AS n FROM household_backup_operations').get().n;
    assert.equal((await f.A.member.client.post('/api/household/backups')).status, 403);
    for (const body of [{ householdId: f.B.id }, { destination: f.destination }, { keyFile: f.keys.backupKeyFile }, { path: '../foreign' }]) {
      assert.equal((await f.A.admin.client.post('/api/household/backups', body)).status, 400);
    }
    assert.equal(count(), 0);
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
    const row = f.platform.prepare('SELECT * FROM household_backup_operations WHERE id = ?').get(id);
    assert.ok(existsSync(row.bundle_file));
    assert.ok(row.bundle_file.startsWith(f.destination + '/'));
    assert.equal(demoRouteBehavior('POST', '/api/household/backups'), 'off');
    assert.equal(demoRouteBehavior('GET', '/api/household/backups/:id/status'), 'off');
  } finally { await f.close(); }
});

test('an admin can inspect a draining backup, and unavailable configuration refuses before queuing', async () => {
  const f = await backupFixture();
  let held;
  try {
    const keyBytes = await import('node:fs').then(fs => fs.readFileSync(f.keys.backupKeyFile));
    rmSync(f.keys.backupKeyFile);
    const refused = await f.A.admin.client.post('/api/household/backups');
    assert.equal(refused.status, 409);
    assert.equal(f.platform.prepare('SELECT count(*) AS n FROM household_backup_operations').get().n, 0);
    writeFileSync(f.keys.backupKeyFile, keyBytes, { mode: 0o600 });
    held = f.context(f.A.id); f.server.app.runtimes.acquire(held);
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
    await f.server.close();
    const options = { env: { ...process.env, ...f.server.env }, encoding: 'utf8', timeout: 30000 };
    const made = spawnSync(process.execPath, ['scripts/backup-household.mjs', '--household', f.A.id], options);
    assert.equal(made.status, 0, made.stderr);
    const status = JSON.parse(made.stdout);
    assert.equal(status.status, 'done'); assert.ok(!made.stdout.includes(f.destination));
    const platform = openPlatform(join(f.dataDir, 'platform.sqlite'));
    const op = platform.prepare('SELECT * FROM household_backup_operations WHERE id = ?').get(status.operationId);
    assert.ok(op.bundle_file.startsWith(f.destination + '/'));
    platform.close();
    const refused = spawnSync(process.execPath, ['scripts/restore-household.mjs', '--household', f.A.id, '--confirm', f.B.id, '--bundle', op.bundle_file], options);
    assert.equal(refused.status, 1); assert.match(refused.stderr, /restore_confirmation_required/);
    const restored = spawnSync(process.execPath, ['scripts/restore-household.mjs', '--household', f.A.id, '--confirm', f.A.id, '--bundle', op.bundle_file], options);
    assert.equal(restored.status, 0, restored.stderr); assert.equal(JSON.parse(restored.stdout).status, 'done');
    server = await startRuntime({ dataDir: f.dataDir, keys: f.keys, engine: 'off' });
    assert.equal(marker(server.app.runtimes.get(f.A.id)), 'alpha');
    assert.equal(marker(server.app.runtimes.get(f.B.id)), 'bravo');
  } finally { await server?.close(); await f.close(); }
});

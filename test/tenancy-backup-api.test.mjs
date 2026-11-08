import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { backupFixture } from './helpers/tenancy-backup.mjs';
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

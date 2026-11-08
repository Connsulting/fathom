import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRuntime } from './helpers/tenancy-runtime.mjs';
import { browser, signIn, mcpList } from './helpers/tenancy.mjs';
import { openReadOnlyHousehold } from '../src/platform/ready.mjs';
import { logicalDigest } from '../src/platform/digest.mjs';
import { backupFixture, backup, restore, marker, changeMarker, platformRows } from './helpers/tenancy-backup.mjs';

const currentRows = f => Object.fromEntries(['household_memberships', 'household_model_budgets', 'model_rounds', 'notification_subscriptions'].map(t => [t, platformRows(f.platform, t, f.A.id)]));

test('restore replaces only A, retains current authorization and spend, revokes A credentials and leaves outbound paused', async () => {
  const f = await backupFixture();
  try {
    f.context(f.A.id).db.prepare("INSERT INTO job_runs (job_id, started_at, status) VALUES ('freshness', '2026-11-01', 'running')").run();
    const snap = await backup(f);
    assert.equal((await mcpList(f.server.baseUrl, f.A.key.key)).status, 200);
    const old = f.context(f.A.id);
    changeMarker(old, 'alpha-current'); changeMarker(f.context(f.B.id), 'bravo-current');
    f.store.removeMember(f.A.id, f.A.member.userId, { actorId: f.A.admin.userId });
    f.platform.prepare(`INSERT INTO model_rounds (id, household_id, month, kind, purpose, state, reserved_usd, cost_usd, reserved_at, expires_at, settled_at)
      VALUES ('synthetic-current-round', ?, '2026-11', 'round', 'chat', 'settled', 3, 2, ?, ?, ?)`).run(f.A.id, Date.now(), Date.now(), Date.now());
    f.platform.prepare(`INSERT INTO model_rounds (id, household_id, month, kind, purpose, state, reserved_usd, reserved_at, expires_at)
      VALUES ('synthetic-current-hold', ?, '2026-11', 'round', 'chat', 'held', 4, ?, ?)`).run(f.A.id, Date.now(), Date.now());
    f.platform.prepare(`INSERT INTO model_rounds (id, household_id, month, kind, purpose, state, reserved_usd, reserved_at, expires_at)
      VALUES ('synthetic-current-reservation', ?, '2026-11', 'round', 'chat', 'reserved', 5, ?, ?)`).run(f.A.id, Date.now(), Date.now() + 600000);
    const current = currentRows(f);
    const bKeys = platformRows(f.platform, 'api_keys', f.B.id);
    const bSessions = platformRows(f.platform, 'auth_sessions', f.B.id);
    const passkeys = f.platform.prepare('SELECT * FROM passkeys ORDER BY id').all();
    const users = f.platform.prepare('SELECT * FROM users ORDER BY id').all();
    const bFile = readFileSync(join(f.B.root, 'files', 'synthetic-file.bin'));
    const bDigest = logicalDigest(f.context(f.B.id).db);
    const result = await restore(f, snap.file);
    assert.equal(result.status, 'done'); assert.ok(result.membershipDrift > 0);
    const restored = f.context(f.A.id);
    assert.equal(marker(restored), 'alpha'); assert.equal(marker(f.context(f.B.id)), 'bravo-current');
    assert.equal(restored.generation, old.generation + 1); assert.equal(old.isCurrent(), false);
    assert.deepEqual(currentRows(f), current);
    assert.deepEqual(platformRows(f.platform, 'api_keys', f.B.id), bKeys);
    assert.deepEqual(platformRows(f.platform, 'auth_sessions', f.B.id), bSessions);
    assert.deepEqual(f.platform.prepare('SELECT * FROM passkeys ORDER BY id').all(), passkeys);
    assert.deepEqual(f.platform.prepare('SELECT * FROM users ORDER BY id').all(), users);
    assert.deepEqual(readFileSync(join(f.B.root, 'files', 'synthetic-file.bin')), bFile);
    assert.equal(logicalDigest(f.context(f.B.id).db), bDigest);
    assert.equal(f.platform.prepare('SELECT count(*) AS n FROM auth_sessions WHERE household_id = ?').get(f.A.id).n, 0);
    assert.ok(platformRows(f.platform, 'api_keys', f.A.id).every(k => k.revoked_at && k.revoked_code === 'household_restored'));
    assert.deepEqual(['jobs', 'email', 'simplefin', 'engine'].map(k => restored.outbound.enabled(k)), [false, false, false, false]);
    assert.equal(restored.db.prepare("SELECT sum(cost_usd) AS n FROM spend_ledger WHERE yyyymm = '2026-11'").get().n, 11);
    assert.equal(restored.db.prepare('SELECT status FROM simplefin_connection').get().status, 'error');
    assert.equal(restored.db.prepare("SELECT count(*) AS n FROM job_runs WHERE status = 'running'").get().n, 0);
    assert.ok(restored.db.prepare("SELECT count(*) AS n FROM job_runs WHERE status = 'interrupted' AND note = 'household_restored'").get().n > 0);
    assert.equal(readFileSync(join(restored.root, 'outbox', 'synthetic.json'), 'utf8'), readFileSync(join(f.A.root, 'outbox', 'synthetic.json'), 'utf8'));
    assert.ok(result.rollbackExpiresAt >= Date.now() + 6 * 86400000);
    assert.equal((await f.B.admin.client.get('/api/scenario')).status, 200);
    assert.equal((await mcpList(f.server.baseUrl, f.A.key.key)).status, 401);
    assert.equal((await mcpList(f.server.baseUrl, f.B.key.key)).status, 200);
    const read = openReadOnlyHousehold({ dataDir: f.dataDir }, f.A.id);
    assert.equal(marker(read), 'alpha'); read.db.close(); read.platform.close();
  } finally { await f.close(); }
});

for (const phase of ['validated', 'suspended', 'switched', 'finalized']) {
  test(`a crash at ${phase} recovers idempotently, including after the generation switch`, async () => {
    const f = await backupFixture();
    let restarted;
    try {
      const snap = await backup(f);
      changeMarker(f.context(f.A.id), 'alpha-current'); changeMarker(f.context(f.B.id), 'bravo-current');
      const bCookie = f.B.admin.client.session();
      await f.server.close();
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { loadConfig } from './src/config.mjs';
        import { openInstance } from './src/platform/ready.mjs';
        import { restoreHousehold } from './src/platform/household-backup.mjs';
        const config = loadConfig();
        const { platform } = openInstance(config);
        await restoreHousehold({ platform, config, householdId: process.argv[1], confirmation: process.argv[1], file: process.argv[2],
          onPhase: reached => { if (reached === process.argv[3]) process.exit(71); } });
      `, f.A.id, snap.file, phase], { env: { ...process.env, ...f.server.env }, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 71, child.stderr);
      const extra = { FATHOM_BACKUP_KEY_FILE: f.keys.backupKeyFile, FATHOM_BACKUP_DESTINATION: f.destination };
      restarted = await startRuntime({ dataDir: f.dataDir, keys: f.keys, engine: 'off', extra });
      const a = restarted.app.runtimes.get(f.A.id);
      assert.equal(marker(a), 'alpha'); assert.equal(marker(restarted.app.runtimes.get(f.B.id)), 'bravo-current');
      assert.equal(a.generation, 2); assert.equal(a.outbound.enabled('engine'), false);
      assert.equal(restarted.app.platform.prepare("SELECT count(*) AS n FROM household_backup_operations WHERE kind = 'restore' AND status = 'done'").get().n, 1);
      assert.equal((await browser(restarted.baseUrl, { '__Host-fathom-session': bCookie }).get('/api/scenario')).status, 200);
      const login = await signIn(restarted.baseUrl, f.A.admin.device);
      assert.equal(login.verify?.status, 200, login.verify?.text);
      assert.equal((await login.client.get('/api/scenario')).status, 200);
      await restarted.close();
      restarted = await startRuntime({ dataDir: f.dataDir, keys: f.keys, engine: 'off', extra });
      assert.equal(restarted.app.runtimes.get(f.A.id).generation, 2, 'second restart cannot repeat the switch');
    } finally { await restarted?.close(); await f.close(); }
  });
}

test('backup drains an acquired request while B continues serving', async () => {
  const f = await backupFixture();
  try {
    const ctx = f.context(f.A.id);
    f.server.app.runtimes.acquire(ctx);
    let finished = false;
    const pending = backup(f).then(r => { finished = true; return r; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal((await f.B.admin.client.get('/api/scenario')).status, 200);
    changeMarker(ctx, 'alpha-drained');
    f.server.app.runtimes.release(ctx);
    const snap = await pending;
    await restore(f, snap.file);
    assert.equal(marker(f.context(f.A.id)), 'alpha-drained');
  } finally { await f.close(); }
});

test('a verified bundle repairs a damaged live vault while preserving the readable current store', async () => {
  const f = await backupFixture();
  try {
    const snap = await backup(f);
    const path = join(f.A.root, 'files', 'synthetic-file.bin');
    const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1;
    writeFileSync(path, bytes);
    changeMarker(f.context(f.A.id), 'alpha-damaged-vault');
    await restore(f, snap.file);
    assert.equal(marker(f.context(f.A.id)), 'alpha');
    const { root, handle } = await f.context(f.A.id).vault();
    const { readObject, PURPOSES } = await import('../src/platform/household-vault.mjs');
    assert.equal((await readObject({ root, handle, purpose: PURPOSES.upload, objectId: 'synthetic-file', storedPath: 'files/synthetic-file.bin' })).toString(), 'Synthetic alpha upload');
  } finally { await f.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupFixture, backup, restore, marker, changeMarker, platformRows } from './helpers/tenancy-backup.mjs';

const currentRows = f => Object.fromEntries(['household_memberships', 'household_model_budgets', 'model_rounds', 'notification_subscriptions'].map(t => [t, platformRows(f.platform, t, f.A.id)]));

test('restore replaces only A, retains current authorization and spend, revokes A credentials and leaves outbound paused', async () => {
  const f = await backupFixture();
  try {
    const snap = await backup(f);
    const old = f.context(f.A.id);
    changeMarker(old, 'alpha-current'); changeMarker(f.context(f.B.id), 'bravo-current');
    f.store.removeMember(f.A.id, f.A.member.userId, { actorId: f.A.admin.userId });
    f.platform.prepare(`INSERT INTO model_rounds (id, household_id, month, kind, purpose, state, reserved_usd, cost_usd, reserved_at, expires_at, settled_at)
      VALUES ('synthetic-current-round', ?, '2026-11', 'round', 'chat', 'settled', 3, 2, ?, ?, ?)`).run(f.A.id, Date.now(), Date.now(), Date.now());
    f.platform.prepare(`INSERT INTO model_rounds (id, household_id, month, kind, purpose, state, reserved_usd, reserved_at, expires_at)
      VALUES ('synthetic-current-hold', ?, '2026-11', 'round', 'chat', 'held', 4, ?, ?)`).run(f.A.id, Date.now(), Date.now());
    const current = currentRows(f);
    const bKeys = platformRows(f.platform, 'api_keys', f.B.id);
    const bSessions = platformRows(f.platform, 'auth_sessions', f.B.id);
    const passkeys = f.platform.prepare('SELECT * FROM passkeys ORDER BY id').all();
    const users = f.platform.prepare('SELECT * FROM users ORDER BY id').all();
    const bFile = readFileSync(join(f.B.root, 'files', 'synthetic-file.bin'));
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
    assert.equal(f.platform.prepare('SELECT count(*) AS n FROM auth_sessions WHERE household_id = ?').get(f.A.id).n, 0);
    assert.ok(platformRows(f.platform, 'api_keys', f.A.id).every(k => k.revoked_at && k.revoked_code === 'household_restored'));
    assert.deepEqual(['jobs', 'email', 'simplefin', 'engine'].map(k => restored.outbound.enabled(k)), [false, false, false, false]);
    assert.equal(restored.db.prepare("SELECT sum(cost_usd) AS n FROM spend_ledger WHERE yyyymm = '2026-11'").get().n, 6);
    assert.equal(restored.db.prepare('SELECT status FROM simplefin_connection').get().status, 'error');
    assert.equal(readFileSync(join(restored.root, 'outbox', 'synthetic.json'), 'utf8'), readFileSync(join(f.A.root, 'outbox', 'synthetic.json'), 'utf8'));
    assert.ok(result.rollbackExpiresAt >= Date.now() + 6 * 86400000);
    assert.equal((await f.B.admin.client.get('/api/scenario')).status, 200);
  } finally { await f.close(); }
});

for (const phase of ['validated', 'suspended', 'switched', 'finalized']) {
  test(`a crash at ${phase} recovers idempotently, including after the generation switch`, async () => {
    const f = await backupFixture();
    try {
      const snap = await backup(f);
      changeMarker(f.context(f.A.id), 'alpha-current'); changeMarker(f.context(f.B.id), 'bravo-current');
      let fired = false;
      await assert.rejects(restore(f, snap.file, { onPhase: reached => {
        if (reached === phase) { fired = true; throw new Error('synthetic crash'); }
      } }), /synthetic crash/);
      assert.equal(fired, true);
      const { recoverHouseholdOperations } = await import('../src/platform/household-backup.mjs');
      await recoverHouseholdOperations({ platform: f.platform, config: f.config, runtimes: f.server.app.runtimes });
      await recoverHouseholdOperations({ platform: f.platform, config: f.config, runtimes: f.server.app.runtimes });
      assert.equal(marker(f.context(f.A.id)), 'alpha'); assert.equal(marker(f.context(f.B.id)), 'bravo-current');
      assert.equal(f.context(f.A.id).generation, 2);
      assert.equal(f.context(f.A.id).outbound.enabled('engine'), false);
      assert.equal(f.platform.prepare("SELECT count(*) AS n FROM household_backup_operations WHERE kind = 'restore' AND status = 'done'").get().n, 1);
    } finally { await f.close(); }
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

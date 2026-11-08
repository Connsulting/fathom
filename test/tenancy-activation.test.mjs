import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { tempDir } from './helpers/server.mjs';
import { createInstance, openPlatform, PLATFORM_MIGRATIONS_DIR } from '../src/platform/db.mjs';
import { openDb, migrate } from '../src/store/db.mjs';
import { createAuthStore } from '../src/auth/store.mjs';
import { isolationFixture, ok } from '../test-isolation/fixture.mjs';

test('release migration 009 enables explicit provisioning on old and fresh platforms only', async () => {
  const root = await tempDir('fathom-activation-');
  try {
    const file = join(root, 'old.sqlite');
    const db = openDb(file);
    migrate(db, { dir: PLATFORM_MIGRATIONS_DIR, through: 8 });
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('users','passkeys') ORDER BY name").all();
    db.prepare("INSERT INTO platform_settings(key,value,updated_at) VALUES ('multi_household_enabled','false',1)").run();
    db.close();
    const upgraded = openPlatform(file);
    assert.equal(createAuthStore(upgraded).getPlatformSetting('multi_household_enabled', false), true);
    assert.deepEqual(upgraded.prepare("SELECT sql FROM sqlite_master WHERE name IN ('users','passkeys') ORDER BY name").all(), before);
    assert.equal(upgraded.prepare('SELECT count(*) n FROM households').get().n, 0, 'migration provisions nothing');
    upgraded.close();
    const fresh = createInstance(join(root, 'fresh'), { mode: 'real', init() {} });
    assert.equal(createAuthStore(fresh.platform).getPlatformSetting('multi_household_enabled', false), true);
    assert.equal(fresh.platform.prepare('SELECT count(*) n FROM households').get().n, 1);
    fresh.db.close(); fresh.platform.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real-session smoke provisions only by operator action and serves independent households', { timeout: 120000 }, async () => {
  const f = await isolationFixture();
  try {
    for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
      ok(await own.admin.client.post('/api/goals', { title: own.canary, horizon: '1-3y' }));
      const scenario = await own.admin.client.get('/api/scenario');
      ok(scenario);
      assert.ok(scenario.text.includes(own.canary));
      assert.ok(!scenario.text.includes(other.canary));
      assert.equal((await own.member.client.post('/api/operator/households', {})).status, 403);
    }
    assert.equal((await f.operator.client.get('/api/scenario')).status, 403);
    assert.equal(f.platform.prepare('SELECT count(*) n FROM households').get().n, 2);
  } finally { await f.close(); }
});

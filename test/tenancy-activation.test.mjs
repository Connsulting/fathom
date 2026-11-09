import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { tempDir } from './helpers/server.mjs';
import { createInstance, openPlatform, PLATFORM_MIGRATIONS_DIR } from '../src/platform/db.mjs';
import { openDb, migrate } from '../src/store/db.mjs';
import { createAuthStore } from '../src/auth/store.mjs';
import { isolationFixture, ok } from '../test-isolation/fixture.mjs';
import { startRuntime } from './helpers/tenancy-runtime.mjs';

test('release migration 009 enables explicit provisioning on old and fresh platforms only', async () => {
  const root = await tempDir('fathom-activation-');
  try {
    const file = join(root, 'old.sqlite');
    const db = await openDb(file);
    await migrate(db, { dir: PLATFORM_MIGRATIONS_DIR, through: 8 });
    const before = await db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('users','passkeys') ORDER BY name").all();
    await db.prepare("INSERT INTO platform_settings(key,value,updated_at) VALUES ('multi_household_enabled','false',1)").run();
    await db.close();
    const upgraded = await openPlatform(file);
    assert.equal(await createAuthStore(upgraded).getPlatformSetting('multi_household_enabled', false), true);
    assert.deepEqual(await upgraded.prepare("SELECT sql FROM sqlite_master WHERE name IN ('users','passkeys') ORDER BY name").all(), before);
    assert.equal((await upgraded.prepare('SELECT count(*) n FROM households').get()).n, 0, 'migration provisions nothing');
    await upgraded.close();
    const fresh = await createInstance(join(root, 'fresh'), { mode: 'real', init() {} });
    assert.equal(await createAuthStore(fresh.platform).getPlatformSetting('multi_household_enabled', false), true);
    assert.equal((await fresh.platform.prepare('SELECT count(*) n FROM households').get()).n, 1);
    await fresh.db.close(); await fresh.platform.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('demo starts and resets with generated synthetic secrets and no mounted key or session', async () => {
  const root = await tempDir('fathom-secret-free-');
  let server;
  try {
    server = await startRuntime({ dataDir: join(root, 'data'), engine: 'fake', extra: { FATHOM_DEMO: '1' } });
    const { request, postJson } = await import('./helpers/server.mjs');
    const scenario = await request(server.baseUrl, { path: '/api/scenario' });
    assert.equal(scenario.status, 200);
    assert.equal((await postJson(server.baseUrl, '/api/demo/reset', {})).status, 200);
    assert.equal((await server.app.platform.prepare('SELECT count(*) n FROM households').get()).n, 1);
  } finally { await server?.close(); rmSync(root, { recursive: true, force: true }); }
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
    assert.equal((await f.platform.prepare('SELECT count(*) n FROM households').get()).n, 2);
  } finally { await f.close(); }
});

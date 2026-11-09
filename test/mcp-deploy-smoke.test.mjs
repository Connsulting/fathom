// End to end: a real server on a synthetic store, a key from scripts/mcp-key.mjs (bound to the household
// named by --household), then scripts/mcp-smoke.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer, runCommand, createSessionFixture, withPlatform, dumpStore } from './helpers/server.mjs';
import { buildLegacyStore } from './helpers/tenancy.mjs';

const OWNER = 'owner@example.test';

// Data dir entries, ignoring the -wal/-shm sidecars a read-only SQLite open of a WAL store leaves.
const listing = dir => readdirSync(dir).filter(f => !/-(wal|shm)$/.test(f)).sort();

// The server's platform store gets OWNER as an enrolled admin of the served household
// (invitation, consumption, enrollment). A failed seed stops the server so the run cannot hang.
async function server() {
  const s = await spawnServer({ env: { FATHOM_ENGINE: 'off', FATHOM_DEMO: '1' } });
  try {
    await createSessionFixture(s.dataDir, { email: OWNER, role: 'admin' });
  } catch (err) {
    await s.stop();
    throw err;
  }
  return s;
}

test('mcp-key creates a read-only key and mcp-smoke passes against the server', async () => {
  const s = await server();
  const keyFile = join(s.dataDir, 'smoke-key');
  try {
    const created = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'deploy-smoke', '--owner', OWNER, '--household', s.householdId], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.stderr.includes(created.stdout.trim()), false);
    assert.match(created.stdout, /^fathom_[A-Za-z0-9_-]{43}\n$/);
    assert.equal(created.stdout.trim().length, created.stdout.length - 1);
    writeFileSync(keyFile, created.stdout, { mode: 0o600 });

    // MT-03: keys live in the platform, bound to the household named by --household.
    await withPlatform(s.platformFile, async (platform, auth) => {
      const row = await platform.prepare('SELECT household_id, scopes, user_id, revoked_at FROM api_keys WHERE name = ?').get('deploy-smoke');
      assert.equal(row.household_id, s.householdId);
      assert.deepEqual(JSON.parse(row.scopes), ['read']);
      assert.equal(row.user_id, (await auth.findUser(OWNER)).id);
      assert.equal(row.revoked_at, null);
    });

    const smoke = await runCommand(process.execPath, ['scripts/mcp-smoke.mjs'], {
      env: { FATHOM_SMOKE_URL: s.baseUrl, FATHOM_SMOKE_KEY_FILE: keyFile },
    });
    assert.equal(smoke.code, 0, smoke.stdout + smoke.stderr);
    assert.equal(smoke.stdout.includes(created.stdout.trim()), false);
    assert.equal(smoke.stderr.includes(created.stdout.trim()), false);
    const rows = smoke.stdout.trim().split('\n');
    assert.ok(rows.some(l => l.startsWith('tools/list pass ')));
    assert.ok(rows.some(l => l.startsWith('household.summary pass ')));
    assert.ok(rows.some(l => l.startsWith('act_on_recommendation.status pass ')));
    assert.ok(!rows.some(l => l.startsWith('calculate.')), 'calculate needs operands, so the smoke skips it');
    for (const row of rows) assert.match(row, /^[a-z0-9_/.]+ (pass|fail) \d+$/);
  } finally {
    await s.stop();
  }
});

test('mcp-key refuses an unknown owner and a duplicate active name', async () => {
  const s = await server();
  try {
    // MT-03: a store-opening CLI has no default household.
    const unnamed = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'no-household', '--owner', OWNER], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.notEqual(unnamed.code, 0);
    assert.equal(unnamed.stdout, '');
    assert.equal(unnamed.stderr, 'mcp-key: household_required\n');

    const unknown = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'no-owner', '--owner', 'missing@example.test', '--household', s.householdId], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.notEqual(unknown.code, 0);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /unknown owner/);

    await withPlatform(s.platformFile, async (_, auth) => auth.invite((await auth.servedHousehold()).id, 'pending@example.test', { role: 'admin' }));
    const pending = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'pending-owner', '--owner', 'pending@example.test', '--household', s.householdId], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.notEqual(pending.code, 0);
    assert.equal(pending.stdout, '');
    assert.equal(pending.stderr, 'mcp-key: unknown owner\n');

    const first = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'once', '--owner', OWNER, '--household', s.householdId], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.equal(first.code, 0, first.stderr);
    const again = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'once', '--owner', OWNER, '--household', s.householdId], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.notEqual(again.code, 0);
    assert.equal(again.stdout, '');
    assert.match(again.stderr, /already exists/);
    assert.equal(again.stderr.includes(first.stdout.trim()), false);

    const padded = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', ' once ', '--owner', OWNER, '--household', s.householdId], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.notEqual(padded.code, 0);
    assert.equal(padded.stdout, '');
    assert.match(padded.stderr, /already exists/);
  } finally {
    await s.stop();
  }
});

test('mcp-smoke exits nonzero for a missing key file and a wrong key', async () => {
  const s = await server();
  const dir = mkdtempSync(join(tmpdir(), 'fathom-smoke-'));
  try {
    const missing = await runCommand(process.execPath, ['scripts/mcp-smoke.mjs'], {
      env: { FATHOM_SMOKE_URL: s.baseUrl, FATHOM_SMOKE_KEY_FILE: join(dir, 'absent') },
    });
    assert.notEqual(missing.code, 0);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /missing key file/);

    const wrongFile = join(dir, 'wrong');
    writeFileSync(wrongFile, 'fathom_not-a-real-key-0000000000000000000000\n', { mode: 0o600 });
    const wrong = await runCommand(process.execPath, ['scripts/mcp-smoke.mjs'], {
      env: { FATHOM_SMOKE_URL: s.baseUrl, FATHOM_SMOKE_KEY_FILE: wrongFile },
    });
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.stdout, /^initialize fail \d+\n$/);
    assert.equal(wrong.stdout.includes('fathom_'), false);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-key refuses an unmigrated real store and leaves it unchanged', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fathom-legacy-'));
  try {
    const legacy = await buildLegacyStore(dataDir);
    const files = listing(dataDir);
    const before = await dumpStore(legacy.file);
    const refused = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'legacy', '--owner', legacy.admin.email, '--household', 'hh-synthetic-legacy'], {
      env: { FATHOM_DATA: dataDir },
    });
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.equal(refused.stderr, 'mcp-key: platform_migration_required\n');
    assert.deepEqual(listing(dataDir), files);
    assert.deepEqual(await dumpStore(legacy.file), before);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

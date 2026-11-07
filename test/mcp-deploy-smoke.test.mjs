// End to end: a real server on a synthetic store, a key from scripts/mcp-key.mjs, then scripts/mcp-smoke.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer, runCommand } from './helpers/server.mjs';
import { openMigrated } from '../src/store/db.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

const OWNER = 'owner@example.test';

function invite(dbFile, email = OWNER) {
  const db = openMigrated(dbFile);
  try {
    const store = createAuthStore(db);
    if (!store.findUser(email)) store.inviteUser(email, { role: 'admin' });
  } finally {
    db.close();
  }
}

async function server() {
  const s = await spawnServer({ env: { FATHOM_ENGINE: 'off', FATHOM_DEMO: '1' } });
  invite(s.dbFile);
  return s;
}

test('mcp-key creates a read-only key and mcp-smoke passes against the server', async () => {
  const s = await server();
  const keyFile = join(s.dataDir, 'smoke-key');
  try {
    const created = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'deploy-smoke', '--owner', OWNER], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.stderr.includes(created.stdout.trim()), false);
    assert.match(created.stdout, /^fathom_[A-Za-z0-9_-]{43}\n$/);
    assert.equal(created.stdout.trim().length, created.stdout.length - 1);
    writeFileSync(keyFile, created.stdout, { mode: 0o600 });

    const db = openMigrated(s.dbFile);
    try {
      const row = db.prepare('SELECT scopes, user_id, revoked_at FROM api_keys WHERE name = ?').get('deploy-smoke');
      const user = createAuthStore(db).findUser(OWNER);
      assert.deepEqual(JSON.parse(row.scopes), ['read']);
      assert.equal(row.user_id, user.id);
      assert.equal(row.revoked_at, null);
    } finally {
      db.close();
    }

    const smoke = await runCommand(process.execPath, ['scripts/mcp-smoke.mjs'], {
      env: { FATHOM_SMOKE_URL: s.baseUrl, FATHOM_SMOKE_KEY_FILE: keyFile },
    });
    assert.equal(smoke.code, 0, smoke.stdout + smoke.stderr);
    assert.equal(smoke.stdout.includes(created.stdout.trim()), false);
    assert.equal(smoke.stderr.includes(created.stdout.trim()), false);
    const rows = smoke.stdout.trim().split('\n');
    assert.ok(rows.some(l => l.startsWith('tools/list pass ')));
    assert.ok(rows.some(l => l.startsWith('household_summary pass ')));
    assert.ok(rows.some(l => l.startsWith('set_recommendation_status pass ')));
    for (const row of rows) assert.match(row, /^[a-z0-9_/]+ (pass|fail) \d+$/);
  } finally {
    await s.stop();
  }
});

test('mcp-key refuses an unknown owner and a duplicate active name', async () => {
  const s = await server();
  try {
    const unknown = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'no-owner', '--owner', 'missing@example.test'], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.notEqual(unknown.code, 0);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /unknown owner/);

    const first = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'once', '--owner', OWNER], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.equal(first.code, 0, first.stderr);
    const again = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', 'once', '--owner', OWNER], {
      env: { FATHOM_DATA: s.dataDir },
    });
    assert.notEqual(again.code, 0);
    assert.equal(again.stdout, '');
    assert.match(again.stderr, /already exists/);
    assert.equal(again.stderr.includes(first.stdout.trim()), false);

    const padded = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--name', ' once ', '--owner', OWNER], {
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

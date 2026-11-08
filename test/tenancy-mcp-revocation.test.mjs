import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpHouseholds, mcp, result } from './helpers/tenancy-mcp.mjs';
import { openScope } from '../src/storage/index.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { PLATFORM_MIGRATIONS_DIR } from '../src/platform/db.mjs';
import { createKeyService, hashKey } from '../src/mcp/keys.mjs';
import { join } from 'node:path';
import { runCommand } from './helpers/server.mjs';

async function live(f, key) {
  const response = await mcp(f.baseUrl, key.key, 'tools/list');
  assert.equal(response.status, 200, response.text);
  assert.ok(response.json.result.tools.some(t => t.name === 'household'));
}
async function denied(f, key) {
  const response = await mcp(f.baseUrl, key.key, 'tools/list');
  assert.equal(response.status, 401);
  assert.deepEqual(response.json, { error: 'unauthorized' });
}

test('membership version reduction permanently invalidates only that creator and household', async () => {
  const f = await mcpHouseholds();
  try {
    const key = await f.create(f.A, f.member.client);
    await live(f, key);
    const demoted = await f.A.admin.client.post(`/api/admin/users/${f.member.userId}/role`, { role: 'member' });
    assert.equal(demoted.status, 200, demoted.text);
    await denied(f, key);
    await live(f, f.A.key);
    await live(f, f.B.key);
    const replacement = await f.create(f.A, f.member.client);
    await live(f, replacement);
    assert.equal((await f.A.admin.client.post(`/api/admin/users/${f.member.userId}/role`, { role: 'admin' })).status, 200);
    await denied(f, key);
    await denied(f, replacement);
    await live(f, await f.create(f.A, f.member.client));
  } finally { await f.close(); }
});

test('removal and inactive membership refuse a retained key; rejoining cannot resurrect it', async () => {
  const f = await mcpHouseholds();
  try {
    const key = await f.create(f.A, f.member.client);
    await f.platform.prepare("UPDATE household_memberships SET status = 'removed' WHERE user_id = ? AND household_id = ?").run(f.member.userId, f.A.id);
    await denied(f, key);
    await f.platform.prepare("UPDATE household_memberships SET status = 'active', version = version + 1 WHERE user_id = ? AND household_id = ?").run(f.member.userId, f.A.id);
    await denied(f, key);
    const fresh = await f.create(f.A, f.member.client);
    await live(f, fresh);
    assert.equal((await f.A.admin.client.post(`/api/admin/users/${f.member.userId}/remove`)).status, 200);
    await denied(f, fresh);
    await live(f, f.A.key);
    await live(f, f.B.key);
  } finally { await f.close(); }
});

test('key revocation and scope reduction take effect on the next stateless request', async () => {
  const f = await mcpHouseholds();
  try {
    await f.platform.prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run('["read"]', f.A.key.record.id);
    const write = await f.call(f.A, 'act_on_recommendation', { operation: 'status', id: 'colliding-rec', status: 'done' });
    assert.equal(write.json.result.isError, true);
    assert.match(write.json.result.content[0].text, /Permission denied/);
    assert.equal(result(await f.call(f.A, 'household', { operation: 'summary' })).facts['synthetic.canary'], f.A.canary);
    assert.equal((await f.A.admin.client.post(`/api/keys/${f.A.key.record.id}/revoke`)).status, 200);
    await denied(f, f.A.key);
    await live(f, f.B.key);
  } finally { await f.close(); }
});

test('suspension refuses one household and restore generation permanently invalidates its old keys', async () => {
  const f = await mcpHouseholds();
  try {
    await f.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(f.A.id);
    await denied(f, f.A.key);
    await live(f, f.B.key);
    await f.platform.prepare("UPDATE households SET status = 'active' WHERE id = ?").run(f.A.id);
    await live(f, f.A.key);
    await f.platform.prepare('UPDATE households SET generation = generation + 1 WHERE id = ?').run(f.A.id);
    await denied(f, f.A.key);
    await live(f, f.B.key);
    await live(f, await f.create(f.A));
  } finally { await f.close(); }
});

test('platform enforces immutable household and creator bindings', async () => {
  const f = await mcpHouseholds();
  try {
    for (const [column, value] of [['household_id', f.B.id], ['user_id', f.B.admin.userId], ['user_id', null], ['household_generation', 42], ['membership_version', 42]]) {
      assert.throws(async () => await f.platform.prepare(`UPDATE api_keys SET ${column} = ? WHERE id = ?`).run(value, f.A.key.record.id));
    }
    await live(f, f.A.key);
    await live(f, f.B.key);
  } finally { await f.close(); }
});

test('one creators keys in two households stay independent when one membership is removed', async () => {
  const f = await mcpHouseholds();
  try {
    const invitation = f.store.invite(f.B.id, 'member@example.test', { role: 'member' });
    assert.equal((await f.member.client.post('/api/auth/invitations/accept', { token: invitation.token })).status, 200);
    const own = await f.create(f.A, f.member.client);
    const issued = await runCommand(process.execPath, ['scripts/mcp-key.mjs', 'create', '--household', f.B.id, '--owner', 'member@example.test', '--name', 'Synthetic second membership key'], { env: f.env });
    assert.equal(issued.code, 0, issued.stderr);
    const other = { key: issued.stdout.trim() };
    await live(f, own);
    await live(f, other);
    assert.equal((await f.A.admin.client.post(`/api/admin/users/${f.member.userId}/remove`)).status, 200);
    await denied(f, own);
    await live(f, other);
    await live(f, f.B.key);
  } finally { await f.close(); }
});

test('platform migration binds existing hashes and preserves account and passkey schemas', async () => {
  const db = await openScope({ path: ':memory:', journal: null, busyTimeout: 0 });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of readdirSync(PLATFORM_MIGRATIONS_DIR).filter(n => /^00[1-5]-.*\.sql$/.test(n)).sort()) await db.applySchema(readFileSync(join(PLATFORM_MIGRATIONS_DIR, name), 'utf8'));
    await db.applySchema(`INSERT INTO households (id, status, mode, created_at, updated_at, generation) VALUES ('alpha', 'active', 'real', 1, 1, 8), ('bravo', 'active', 'demo', 1, 1, 2);
      INSERT INTO users (id, email, user_handle, created_at) VALUES ('creator', 'creator@example.test', 'synthetic-handle', 1);
      INSERT INTO household_memberships (user_id, household_id, role, status, version, created_at, updated_at) VALUES ('creator', 'alpha', 'member', 'active', 7, 1, 1);`);
    const before = await db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('users', 'passkeys') ORDER BY name").all();
    const secret = Buffer.alloc(32, 9);
    const token = 'fathom_' + 'A'.repeat(43);
    const insert = db.prepare("INSERT INTO api_keys (id, household_id, user_id, name, key_hash, scopes, created_at) VALUES (?, ?, ?, 'Synthetic key', ?, '[\"read\"]', '2026-11-05')");
    await insert.run('owned', 'alpha', 'creator', hashKey(token, secret));
    await insert.run('unbound', 'alpha', null, 'b'.repeat(64));
    await insert.run('demo', 'bravo', null, 'c'.repeat(64));
    await db.applySchema(readFileSync(join(PLATFORM_MIGRATIONS_DIR, '006-mcp-key-binding.sql'), 'utf8'));
    const row = await db.prepare("SELECT * FROM api_keys WHERE id = 'owned'").get();
    assert.equal(row.household_generation, 8);
    assert.equal(row.membership_version, 7);
    assert.equal(row.key_hash, hashKey(token, secret));
    const keys = createKeyService({ platform: db, secret: () => secret, creatorActive: () => true });
    assert.equal(keys.verify(token).id, 'owned');
    assert.ok((await db.prepare("SELECT revoked_at FROM api_keys WHERE id = 'unbound'").get()).revoked_at);
    assert.equal((await db.prepare("SELECT revoked_at FROM api_keys WHERE id = 'demo'").get()).revoked_at, null);
    assert.throws(() => keys.create({ householdId: 'alpha', name: 'Unbound real key' }), { code: 'forbidden' });
    const fresh = keys.create({ householdId: 'alpha', userId: 'creator', name: 'Bound real key' });
    assert.equal(keys.verify(fresh.key).id, fresh.record.id);
    assert.deepEqual(await db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('users', 'passkeys') ORDER BY name").all(), before);
  } finally { await db.close(); }
});

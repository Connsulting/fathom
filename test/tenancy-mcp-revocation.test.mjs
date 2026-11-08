import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpHouseholds, mcp, result } from './helpers/tenancy-mcp.mjs';

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
    f.platform.prepare("UPDATE household_memberships SET status = 'removed' WHERE user_id = ? AND household_id = ?").run(f.member.userId, f.A.id);
    await denied(f, key);
    f.platform.prepare("UPDATE household_memberships SET status = 'active', version = version + 1 WHERE user_id = ? AND household_id = ?").run(f.member.userId, f.A.id);
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
    f.platform.prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run('["read"]', f.A.key.record.id);
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
    f.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(f.A.id);
    await denied(f, f.A.key);
    await live(f, f.B.key);
    f.platform.prepare("UPDATE households SET status = 'active' WHERE id = ?").run(f.A.id);
    await live(f, f.A.key);
    f.platform.prepare('UPDATE households SET generation = generation + 1 WHERE id = ?').run(f.A.id);
    await denied(f, f.A.key);
    await live(f, f.B.key);
    await live(f, await f.create(f.A));
  } finally { await f.close(); }
});

test('platform enforces immutable household and creator bindings', async () => {
  const f = await mcpHouseholds();
  try {
    for (const [column, value] of [['household_id', f.B.id], ['user_id', f.B.admin.userId], ['user_id', null], ['household_generation', 42], ['membership_version', 42]]) {
      assert.throws(() => f.platform.prepare(`UPDATE api_keys SET ${column} = ? WHERE id = ?`).run(value, f.A.key.record.id));
    }
    await live(f, f.A.key);
    await live(f, f.B.key);
  } finally { await f.close(); }
});

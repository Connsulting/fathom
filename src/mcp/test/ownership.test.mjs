import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_TIMEOUT, spawnAuthenticatedServer, createSessionFixture, sessionClient, openPlatformStore, request, postJson,
} from '../../../test/helpers/server.mjs';
import { mcpPost, bearer, rpcResult, UNAUTHORIZED } from './helpers.mjs';

const T = { timeout: SERVER_TIMEOUT * 3 };
const REAL = { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_EMAIL_TRANSPORT: 'dev',
  FATHOM_EMAIL_FROM: 'sender@example.test', FATHOM_EMAIL_TO: 'recipient@example.test' };

// Accounts and (MT-03) the household-bound api_keys live in platform.sqlite.
async function platformOf(server, fn) {
  const platform = await openPlatformStore(server.platformFile);
  try { return await fn(platform); } finally { await platform.close(); }
}
async function userClient(server, email, role = 'member') {
  const fixture = await platformOf(server, async platform => createSessionFixture(platform, { email, role }));
  return { ...sessionClient(server.baseUrl, fixture), fixture };
}
async function create(client, name, extra = {}) {
  const r = await client.postJson('/api/keys', { name, ...extra });
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.key, 'string');
  return r.json;
}
async function working(server, key) {
  const result = rpcResult(await mcpPost(server.baseUrl, { auth: bearer(key), method: 'tools/list' }));
  assert.ok(result.tools.some(tool => tool.name === 'household'));
  assert.ok(!result.tools.some(tool => /admin|invite_user|remove_user|set_role/.test(tool.name)));
}
async function denied(server, key) {
  const r = await mcpPost(server.baseUrl, { auth: bearer(key), method: 'tools/list' });
  assert.equal(r.status, 401);
  assert.equal(r.text, UNAUTHORIZED);
}

test('MCP accepts bearer credentials only and browser sessions never authorize key management through MCP', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const key = await create(server, 'Synthetic admin key');
    assert.equal((await server.request({ path: '/api/scenario' })).status, 200);
    for (const headers of [server.headers, { 'tailscale-user-login': 'admin@example.test' }]) {
      const r = await mcpPost(server.baseUrl, { method: 'tools/list', headers });
      assert.equal(r.status, 401);
      assert.equal(r.text, UNAUTHORIZED);
    }
    await working(server, key.key);
    assert.equal((await request(server.baseUrl, { path: '/api/keys', headers: { authorization: bearer(key.key) } })).status, 401);
    assert.equal((await postJson(server.baseUrl, '/api/keys', { name: 'Anonymous key' }, { origin: server.baseUrl, authorization: bearer(key.key) })).status, 401);
    assert.equal((await server.request({ path: '/api/keys' })).status, 200);
  } finally { await server.stop(); }
});

test('members manage their own keys, admins manage all keys, and session ownership overrides spoofed body fields', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const alice = await userClient(server, 'member-a@example.test');
    const bob = await userClient(server, 'member-b@example.test');
    const adminKey = await create(server, 'Admin key');
    const own = await create(alice, 'Member A key', { scopes: ['write:recs'], userId: bob.fixture.user.id, user_id: bob.fixture.user.id });
    const other = await create(bob, 'Member B key');
    const legacy = await create(server, 'Existing household key');
    await platformOf(server, async db => {
      assert.equal((await db.prepare('SELECT user_id FROM api_keys WHERE id = ?').get(own.record.id)).user_id, alice.fixture.user.id);
      assert.throws(async () => await db.prepare('UPDATE api_keys SET user_id = NULL WHERE id = ?').run(legacy.record.id));
    });
    const listed = await alice.request({ path: '/api/keys' });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.keys.map(key => key.id), [own.record.id]);
    assert.ok(!listed.text.includes(own.key), 'list never repeats a raw bearer');
    const all = await server.request({ path: '/api/keys' });
    for (const key of [own, other, adminKey, legacy]) assert.ok(all.json.keys.some(record => record.id === key.record.id));
    for (const key of [other, adminKey, legacy]) {
      const refused = await alice.postJson(`/api/keys/${key.record.id}/revoke`);
      assert.ok([403, 404].includes(refused.status), `foreign key management returns a safe refusal: ${refused.status}`);
      assert.equal(typeof refused.json.error, 'string');
      await working(server, key.key);
    }
    await working(server, own.key);
    assert.equal((await alice.postJson(`/api/keys/${own.record.id}/revoke`)).status, 200);
    await denied(server, own.key);
    assert.equal((await server.postJson(`/api/keys/${legacy.record.id}/revoke`)).status, 200);
    await denied(server, legacy.key);
    await working(server, other.key);
    assert.equal((await alice.request({ path: '/api/scenario' })).status, 200);
  } finally { await server.stop(); }
});

test('removing a user invalidates sessions and their bearer keys immediately, preserving other creators keys', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const removed = await userClient(server, 'removed@example.test');
    const retained = await userClient(server, 'retained@example.test');
    const own = await create(removed, 'Removed user key');
    const other = await create(retained, 'Retained user key');
    const legacy = await create(server, 'Admin key');
    await working(server, own.key);
    await working(server, other.key);
    await working(server, legacy.key);
    const result = await server.postJson(`/api/admin/users/${removed.fixture.user.id}/remove`);
    assert.equal(result.status, 200);
    assert.equal((await removed.request({ path: '/api/scenario' })).status, 401);
    await denied(server, own.key);
    assert.equal(await platformOf(server, async db => (await db.prepare('SELECT count(*) AS n FROM api_keys WHERE id = ?').get(own.record.id)).n), 0);
    await working(server, other.key);
    await working(server, legacy.key);
    assert.equal((await retained.request({ path: '/api/scenario' })).status, 200);
  } finally { await server.stop(); }
});

test('demotion invalidates the old MCP key and permits a fresh member key', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const promoted = await userClient(server, 'second-admin@example.test', 'admin');
    const key = await create(promoted, 'Demoted admin key', { scopes: ['write:recs'] });
    assert.equal((await promoted.request({ path: '/api/admin/users' })).status, 200);
    assert.equal((await server.postJson(`/api/admin/users/${promoted.fixture.user.id}/role`, { role: 'member' })).status, 200);
    assert.equal((await promoted.request({ path: '/api/admin/users' })).status, 403);
    await denied(server, key.key);
    const fresh = await create(promoted, 'Fresh member key', { scopes: ['write:recs'] });
    const tools = rpcResult(await mcpPost(server.baseUrl, { auth: bearer(fresh.key), method: 'tools/list' })).tools;
    assert.ok(tools.some(tool => tool.name === 'act_on_recommendation'));
    await working(server, fresh.key);
    assert.equal((await promoted.request({ path: '/api/scenario' })).status, 200);
  } finally { await server.stop(); }
});

test('a retained key refuses an inactive creator while another creators key stays admin-manageable', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const member = await userClient(server, 'lapsed@example.test');
    const own = await create(member, 'Lapsed member key');
    const legacy = await create(server, 'Admin key');
    await working(server, own.key);
    await working(server, legacy.key);
    await platformOf(server, async platform => await platform.prepare("UPDATE household_memberships SET status = 'removed' WHERE user_id = ?").run(member.fixture.user.id));
    await denied(server, own.key);
    assert.equal(await platformOf(server, async db => (await db.prepare('SELECT count(*) AS n FROM api_keys WHERE id = ?').get(own.record.id)).n), 1, 'the row is still there; verification fails closed');
    await working(server, legacy.key);
    const all = await server.request({ path: '/api/keys' });
    assert.equal(all.status, 200);
    assert.ok(all.json.keys.some(record => record.id === legacy.record.id), 'admins still list their key');
    assert.equal((await server.postJson(`/api/keys/${legacy.record.id}/revoke`)).status, 200);
    await denied(server, legacy.key);
  } finally { await server.stop(); }
});

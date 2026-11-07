import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { ConfigError, loadConfig } from '../src/config.mjs';
import { createHandler } from '../src/api/router.mjs';
import { createAuthService } from '../src/auth/service.mjs';
import { createRuntimeRegistry } from '../src/platform/runtime.mjs';
import { createKeyService } from '../src/mcp/keys.mjs';
import { setSetting } from '../src/store/db.mjs';
import { createSessionFixture, freePort, postJson, request, sessionClient, tempInstance } from './helpers/server.mjs';

const START = Date.parse('2032-03-10T12:34:56.789Z');
const RECENT = 600_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const cookie = response => (response.headers['set-cookie'] || []).map(value => value.split(';', 1)[0]).join('; ');
const malformedCredential = () => ({
  id: 'c3ludGhldGljLWNyZWRlbnRpYWw', rawId: 'c3ludGhldGljLWNyZWRlbnRpYWw', type: 'public-key',
  clientExtensionResults: { credProps: { rk: true } },
  response: { clientDataJSON: 'bm90LWpzb24', attestationObject: 'bm90LWNib3I' },
});

async function fixture(t, { trustedProxies } = {}) {
  const temp = await tempInstance({ mode: 'real', init: db => setSetting(db, 'mode', 'real') });
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    temp.close();
    rmSync(temp.dataDir, { recursive: true, force: true });
  });
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const config = loadConfig({
    FATHOM_DATA: temp.dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_PUBLIC_URL: baseUrl,
    FATHOM_CLOCK: '2001-01-01', FATHOM_TRUSTED_PROXIES: trustedProxies,
  });
  let clock = START;
  const now = () => clock;
  const sent = [];
  const transport = { name: 'dev', async send(message) { sent.push(message); return { id: 'synthetic-send', recipients: 1 }; } };
  const auth = createAuthService({ platform: temp.platform, config, transport, now });
  // The router serves the instance's household through a runtime registry over temp.db.
  const household = await temp.household(config, { transport });
  const runtimes = createRuntimeRegistry({ platform: temp.platform, config, secrets: temp.secrets, build: () => household });
  const keys = createKeyService({ platform: temp.platform, secret: () => temp.secrets.mcpSecret(), creatorActive: auth.creatorActive });
  server = http.createServer(createHandler({ platform: temp.platform, config, runtimes, auth, keys }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const hh = auth.store.servedHousehold().id;
  return {
    db: temp.db, platform: temp.platform, auth, store: auth.store, hh, sent, baseUrl, now,
    advance: ms => { clock += ms; },
    async client(email = 'member@example.test', role = 'member') {
      const session = await createSessionFixture(temp.platform, { email, role, now });
      return { ...sessionClient(baseUrl, session), session };
    },
    post: (path, body = {}, headers = {}) => postJson(baseUrl, path, body, { origin: baseUrl, ...headers }),
  };
}

function recentError(response) {
  assert.equal(response.status, 403);
  assert.deepEqual(Object.keys(response.json).sort(), ['code', 'error']);
  assert.equal(response.json.code, 'recent_signin_required');
  assert.match(response.json.error, /sign in again/i);
  assert.match(response.headers['cache-control'], /no-store/);
  return response.json;
}

function limited(response) {
  assert.equal(response.status, 429);
  assert.deepEqual(response.json, { error: 'too many requests' });
  assert.ok(Number(response.headers['retry-after']) > 0);
  assert.match(response.headers['cache-control'], /no-store/);
}

// Invite links are household invitations (plan Approach 3); the pending role lives on the invitation.
test('HTTP reinvites apply both pending role changes and replace only the invitation', async t => {
  const app = await fixture(t);
  const admin = await app.client('admin@example.test', 'admin');
  for (const [initial, replacement] of [['admin', 'member'], ['member', 'admin']]) {
    const email = `pending-${initial}@example.test`;
    const first = await admin.postJson('/api/admin/users/invite', { email, role: initial });
    assert.equal(first.status, 200);
    const user = app.store.findUser(email);
    const before = { ...app.platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
    const firstMail = app.sent.at(-1);
    const oldToken = new URL(firstMail.text.match(/https?:\/\/\S+/)[0]).hash.slice(1);
    const recovery = app.store.createToken(user.id, 'recovery');
    const again = await admin.postJson('/api/admin/users/invite', { email: email.toUpperCase(), role: replacement });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { sent: true });
    assert.deepEqual({ ...app.platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) }, before);
    const token = new URL(app.sent.at(-1).text.match(/https?:\/\/\S+/)[0]).hash.slice(1);
    assert.notEqual(token, oldToken);
    assert.equal(app.store.invitation(oldToken), null);
    assert.equal(app.store.invitation(token).userId, user.id);
    assert.equal(app.store.invitation(token).role, replacement);
    assert.equal(app.store.invitation(token).householdId, app.hh);
    assert.ok(app.store.token(recovery.token));
    assert.ok(!again.text.includes(token));
  }
});

test('a failed invitation replacement rolls back the pending role and the old link atomically', async t => {
  const app = await fixture(t);
  const admin = await app.client('admin@example.test', 'admin');
  const original = app.store.invite(app.hh, 'pending@example.test', { role: 'admin' });
  const user = original.user;
  const before = { ...app.platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
  const invitations = app.platform.prepare('SELECT * FROM household_invitations ORDER BY hash').all();
  const tokens = app.platform.prepare('SELECT * FROM auth_tokens ORDER BY hash').all();
  app.platform.exec("CREATE TEMP TRIGGER fail_invitation BEFORE INSERT ON household_invitations BEGIN SELECT RAISE(ABORT, 'synthetic invitation storage failure'); END");
  const failed = await admin.postJson('/api/admin/users/invite', { email: user.email, role: 'member' });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.json, { error: 'internal error' });
  assert.deepEqual({ ...app.platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) }, before);
  assert.deepEqual(app.platform.prepare('SELECT * FROM household_invitations ORDER BY hash').all(), invitations);
  assert.deepEqual(app.platform.prepare('SELECT * FROM auth_tokens ORDER BY hash').all(), tokens);
  assert.equal(app.store.invitation(original.token).role, 'admin');
  assert.equal(app.sent.length, 0);
  app.platform.exec('DROP TRIGGER fail_invitation');
  assert.equal((await admin.postJson('/api/admin/users/invite', { email: user.email, role: 'member' })).status, 200);
  const reissued = new URL(app.sent.at(-1).text.match(/https?:\/\/\S+/)[0]).hash.slice(1);
  assert.equal(app.store.invitation(reissued).role, 'member');
  assert.equal(app.store.invitation(reissued).userId, user.id);
  assert.equal(app.store.invitation(original.token), null);
});

// Was "either token purpose" (invite, recovery): invite links are invitations now, so the two auth
// token purposes (recovery, add-passkey) and the membership and invitations are checked unchanged.
test('HTTP active-member reinvites direct callers to a role action without mutating tokens, membership or invitations', async t => {
  const app = await fixture(t);
  const admin = await app.client('admin@example.test', 'admin');
  for (const initial of ['admin', 'member']) {
    const client = await app.client(`enrolled-${initial}@example.test`, initial);
    const user = client.session.user;
    app.store.createToken(user.id, 'add-passkey');
    app.store.createToken(user.id, 'recovery');
    const before = { ...app.platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
    const membership = app.store.membership(user.id, app.hh);
    const invitations = app.platform.prepare('SELECT * FROM household_invitations ORDER BY hash').all();
    const tokens = app.platform.prepare('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY hash').all(user.id);
    for (const role of ['admin', 'member']) {
      const response = await admin.postJson('/api/admin/users/invite', { email: user.email.toUpperCase(), role });
      assert.equal(response.status, 409);
      assert.match(response.json.error, /role/i);
      assert.match(response.json.error, /chang|\/role/i);
      assert.match(response.headers['cache-control'], /no-store/);
      assert.deepEqual({ ...app.platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) }, before);
      assert.deepEqual(app.store.membership(user.id, app.hh), membership);
      assert.deepEqual(app.platform.prepare('SELECT * FROM household_invitations ORDER BY hash').all(), invitations);
      assert.deepEqual(app.platform.prepare('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY hash').all(user.id), tokens);
      assert.equal((await client.request({ path: '/api/auth/session' })).json.identity.role, initial);
    }
  }
  assert.deepEqual(app.sent, []);
});

test('session fixtures reuse enrolled users without reinviting them or changing their identity', async t => {
  const app = await fixture(t);
  const first = await app.client('existing@example.test', 'admin');
  const second = await app.client(' EXISTING@EXAMPLE.TEST ', 'admin');
  assert.equal(second.session.user.id, first.session.user.id);
  assert.notEqual(second.session.token, first.session.token);
  assert.deepEqual(second.session.user, first.session.user);
  assert.equal(app.store.session(first.session.token).id, first.session.user.id);
  assert.equal(app.store.session(second.session.token).id, first.session.user.id);
  assert.deepEqual(app.store.getUser(first.session.user.id), first.session.user);
  assert.equal(app.store.membership(first.session.user.id, app.hh).role, 'admin');
  assert.equal(app.platform.prepare('SELECT count(*) AS n FROM household_memberships WHERE user_id = ?').get(first.session.user.id).n, 1);
  assert.equal(app.platform.prepare('SELECT count(*) AS n FROM household_invitations WHERE email = ?').get('existing@example.test').n, 1, 'no reinvitation');
});

test('add-passkey options and verify require a sign-in strictly less than ten minutes old', async t => {
  const app = await fixture(t);
  const client = await app.client();
  const at = app.now();
  app.advance(RECENT - 1);
  const fresh = await client.postJson('/api/auth/register/options', { name: 'Fresh synthetic device' });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.options.authenticatorSelection.userVerification, 'required');
  assert.equal(fresh.json.options.authenticatorSelection.residentKey, 'required');
  app.advance(1);
  const headers = { cookie: `${client.session.cookie}; ${cookie(fresh)}` };
  const staleVerify = await client.postJson('/api/auth/register/verify', { response: malformedCredential() }, headers);
  const expected = recentError(staleVerify);
  assert.deepEqual(recentError(await client.postJson('/api/auth/register/options')), expected);
  const session = await client.request({ path: '/api/auth/session' });
  assert.equal(session.status, 200);
  assert.equal(session.json.identity.id, client.session.user.id);
  // Identity gains operator and memberships (MT-01 contradiction 8).
  assert.deepEqual(Object.keys(session.json.identity).sort(), ['email', 'householdId', 'id', 'login', 'memberships', 'name', 'operator', 'role']);
  assert.equal(session.json.identity.householdId, app.hh);
  assert.equal(session.json.identity.operator, false);
  assert.deepEqual(session.json.identity.memberships, [{ householdId: app.hh, role: 'member' }]);
  assert.deepEqual(app.store.listPasskeys(client.session.user.id), []);
  const next = await app.client('another@example.test');
  app.advance(RECENT + 1);
  assert.deepEqual(recentError(await next.postJson('/api/auth/register/options')), expected, 'the error is fixed across accounts and ages');
  app.advance(at + WEEK - 1 - app.now());
  assert.equal((await client.request({ path: '/api/auth/passkeys' })).status, 200, 'the ordinary session remains live for seven days');
  app.advance(1);
  assert.equal((await client.request({ path: '/api/auth/passkeys' })).status, 401);
  assert.deepEqual((await client.request({ path: '/api/auth/session' })).json, { identity: null, demo: false });
});

test('fresh malformed registration reaches the real verifier and returns 400 while the app stays usable', async t => {
  const app = await fixture(t);
  const client = await app.client();
  const options = await client.postJson('/api/auth/register/options');
  assert.equal(options.status, 200);
  const failed = await client.postJson('/api/auth/register/verify', { response: malformedCredential() }, {
    cookie: `${client.session.cookie}; ${cookie(options)}`,
  });
  assert.equal(failed.status, 400);
  assert.deepEqual(failed.json, { error: 'passkey verification failed' });
  assert.match(failed.headers['cache-control'], /no-store/);
  assert.equal((await client.request({ path: '/api/auth/passkeys' })).status, 200);
  assert.equal((await client.postJson('/api/auth/register/options')).status, 200);
  assert.equal((await request(app.baseUrl, { path: '/healthz' })).status, 200);
  assert.deepEqual(app.store.listPasskeys(client.session.user.id), []);
});

test('invite and recovery registration are independent of an absent or stale browser session', async t => {
  const app = await fixture(t);
  const client = await app.client('recovered@example.test');
  const invited = app.store.invite(app.hh, 'invited@example.test', { role: 'member' });
  const pending = invited.user;
  app.advance(RECENT);
  for (const [user, purpose] of [[pending, 'invite'], [client.session.user, 'recovery']]) {
    const issued = purpose === 'invite' ? invited : app.store.createToken(user.id, purpose);
    const live = () => (purpose === 'invite' ? app.store.invitation(issued.token) : app.store.token(issued.token));
    for (const sessionCookie of ['', client.session.cookie]) {
      const options = await app.post('/api/auth/register/options', { token: issued.token }, { cookie: sessionCookie });
      assert.equal(options.status, 200, `${purpose} options do not require recent sign-in`);
      const failed = await app.post('/api/auth/register/verify', { token: issued.token, response: malformedCredential() }, {
        cookie: [sessionCookie, cookie(options)].filter(Boolean).join('; '),
      });
      assert.equal(failed.status, 400);
      assert.deepEqual(failed.json, { error: 'passkey verification failed' });
      assert.ok(live());
    }
  }
  assert.equal(app.store.getUser(pending.id).enrolledAt, null);
  assert.equal((await client.request({ path: '/api/auth/passkeys' })).status, 200);
});

const resolver = async cidrs => (await import('../src/auth/client-ip.mjs')).createClientAddressResolver(cidrs);
const proxyRequest = (socket, forwarded) => ({ socket: { remoteAddress: socket }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

test('untrusted sockets ignore all forwarded clients including a forged trusted hop', async () => {
  for (const cidrs of [[], ['192.0.2.0/24']]) {
    const address = await resolver(cidrs);
    for (const socket of ['203.0.113.8', '::ffff:203.0.113.8', '2001:db8:ffff::8']) {
      assert.equal(address(proxyRequest(socket, '198.51.100.9, 192.0.2.10')), socket);
      assert.equal(address(proxyRequest(socket, 'invalid-forwarded-value')), socket);
    }
  }
});

test('trusted CIDRs walk right to left and ignore spoofed hops beyond the first untrusted client', async () => {
  const address = await resolver(['192.0.2.0/24']);
  assert.equal(address(proxyRequest('192.0.2.10', '198.51.100.99, 203.0.113.7, 192.0.2.11')), '203.0.113.7');
  assert.equal(address(proxyRequest('192.0.2.10', '198.51.100.12, 203.0.113.7, 192.0.2.11')), '203.0.113.7');
  assert.equal(address(proxyRequest('192.0.2.10', '192.0.2.1, 192.0.2.11')), '192.0.2.1', 'an entirely trusted chain resolves its leftmost address');
  assert.equal(address(proxyRequest('192.0.2.10')), '192.0.2.10');
});

test('trusted IPv6 CIDRs and IPv4-mapped sockets use the same trust boundary', async () => {
  const address = await resolver(['192.0.2.0/24', '2001:db8:abcd::/48']);
  assert.equal(address(proxyRequest('2001:db8:abcd::10', '198.51.100.9, 2001:db8:abcd::11')), '198.51.100.9');
  assert.equal(address(proxyRequest('::ffff:192.0.2.10', '198.51.100.9, 192.0.2.11')), '198.51.100.9');
  assert.equal(address(proxyRequest('::ffff:192.0.2.10', '198.51.100.9, ::ffff:203.0.113.7')), '::ffff:203.0.113.7');
  assert.equal(address(proxyRequest('2001:db8:abcd::10')), '2001:db8:abcd::10');
});

test('malformed forwarded candidates fall back to the socket instead of creating arbitrary rate keys', async () => {
  const address = await resolver(['192.0.2.0/24']);
  for (const forwarded of ['', 'unknown', '198.51.100.7:443', '[2001:db8::1]',
    '198.51.100.7, invalid, 192.0.2.11', '198.51.100.7,,192.0.2.11', 'invalid, 203.0.113.7, 192.0.2.11']) {
    assert.equal(address(proxyRequest('192.0.2.10', forwarded)), '192.0.2.10', forwarded);
  }
});

test('trusted proxy configuration defaults empty and accepts only comma-separated explicit CIDRs', () => {
  assert.deepEqual(loadConfig({}).trustedProxies, []);
  assert.deepEqual(loadConfig({ FATHOM_TRUSTED_PROXIES: '' }).trustedProxies, []);
  assert.deepEqual(loadConfig({ FATHOM_TRUSTED_PROXIES: ' 192.0.2.0/24, 2001:db8:abcd::/48 ' }).trustedProxies,
    ['192.0.2.0/24', '2001:db8:abcd::/48']);
  const messages = new Set();
  for (const raw of ['loopback', 'linklocal', 'uniquelocal', '192.0.2.1', '2001:db8::1',
    '192.0.2.0/33', '2001:db8::/129', '192.0.2.0/255.255.255.0', 'bad-config-value/24',
    '192.0.2.0/24,', ',192.0.2.0/24', '192.0.2.0/24,,2001:db8::/32']) {
    assert.throws(() => loadConfig({ FATHOM_TRUSTED_PROXIES: raw }), error => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /FATHOM_TRUSTED_PROXIES/);
      assert.match(error.message, /CIDR/);
      assert.ok(!error.message.includes(raw), 'invalid proxy values never reach the error');
      messages.add(error.message);
      return true;
    });
  }
  assert.equal(messages.size, 1, 'invalid configuration has one fixed safe error');
});

// The spec caps invitation emails at 20 per household per hour (every send counts, reissues
// included), so the merged invite buckets (60 per socket, 120 global, per 10 minutes) are proven by
// priming their auth_rate_limits rows just below the limit instead of sending 60 or 120 invites.
const HOUR = 60 * 60 * 1000;
const bucket = (app, key) => app.platform.prepare('SELECT window_start, expires_at, attempts FROM auth_rate_limits WHERE key_hash = ?').get(digest(key));
function prime(app, key, attempts) {
  app.platform.prepare(`INSERT INTO auth_rate_limits (key_hash, window_start, expires_at, attempts) VALUES (?, ?, ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET attempts = excluded.attempts`).run(digest(key), app.now(), app.now() + RECENT, attempts);
}

test('forged forwarded clients share the default recovery quota while invitations have an independent ten-minute quota', async t => {
  const app = await fixture(t);
  const admin = await app.client('admin@example.test', 'admin');
  for (let i = 0; i < 60; i++) {
    const response = await app.post('/api/auth/recover', { email: `absent-${i}@example.test` }, { 'x-forwarded-for': `198.51.100.${i + 1}` });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { sent: true });
  }
  limited(await app.post('/api/auth/recover', { email: 'overflow@example.test' }, { 'x-forwarded-for': '203.0.113.7' }));
  for (const suffix of ['global', 'socket:127.0.0.1']) assert.equal(bucket(app, `invite:${suffix}`), undefined, 'exhausting recovery touches no invitation bucket');
  // 59 earlier invitation attempts in both invite buckets: the 60th passes, the 61st is refused.
  prime(app, 'invite:global', 59);
  prime(app, 'invite:socket:127.0.0.1', 59);
  const accepted = await admin.postJson('/api/admin/users/invite', { email: 'pending@example.test', role: 'member' }, { 'x-forwarded-for': '203.0.113.1' });
  assert.equal(accepted.status, 200, 'exhausting recovery must not consume an invitation attempt');
  limited(await admin.postJson('/api/admin/users/invite', { email: 'pending@example.test', role: 'member' }, { 'x-forwarded-for': '198.51.100.200' }));
  for (const kind of ['recover', 'invite']) {
    for (const suffix of ['global', 'socket:127.0.0.1']) {
      const row = bucket(app, `${kind}:${suffix}`);
      assert.ok(row, `${kind}:${suffix} has an independent bucket`);
      assert.equal(row.window_start, START);
      assert.equal(row.expires_at, START + RECENT);
      assert.equal(row.attempts, 61);
    }
  }
  app.advance(RECENT - 1);
  limited(await app.post('/api/auth/recover', { email: 'before-reset@example.test' }));
  limited(await admin.postJson('/api/admin/users/invite', { email: 'pending@example.test', role: 'member' }));
  app.advance(1);
  assert.equal((await app.post('/api/auth/recover', { email: 'after-reset@example.test' })).status, 200);
  assert.equal((await admin.postJson('/api/admin/users/invite', { email: 'pending@example.test', role: 'member' })).status, 200);
  assert.equal((await admin.request({ path: '/api/auth/passkeys' })).status, 200);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM email_sends').get().n, 0);
});

test('trusted loopback honors forwarded clients while recovery and invitation global limits stay at 120', async t => {
  const app = await fixture(t, { trustedProxies: '127.0.0.0/8,::1/128' });
  const admin = await app.client('admin@example.test', 'admin');
  const recover = (i, client) => app.post('/api/auth/recover', { email: `absent-${i}@example.test` }, { 'x-forwarded-for': `198.51.100.99, ${client}` });
  for (let i = 0; i < 60; i++) assert.equal((await recover(i, '203.0.113.1')).status, 200);
  limited(await recover(60, '203.0.113.1'));
  for (let i = 61; i < 120; i++) assert.equal((await recover(i, '203.0.113.2')).status, 200, 'a second forwarded client gets its own bucket');
  limited(await recover(120, '203.0.113.3'));
  assert.equal(bucket(app, 'recover:global').attempts, 121);

  const invite = client => admin.postJson('/api/admin/users/invite', { email: 'pending@example.test', role: 'member' }, { 'x-forwarded-for': `198.51.100.99, ${client}` });
  prime(app, 'invite:global', 59);
  prime(app, 'invite:socket:203.0.113.1', 59);
  assert.equal((await invite('203.0.113.1')).status, 200, 'the 60th attempt from one forwarded client passes');
  limited(await invite('203.0.113.1'));
  assert.equal(bucket(app, 'invite:socket:203.0.113.1').attempts, 61);
  assert.equal((await invite('203.0.113.2')).status, 200, 'a second forwarded client gets its own bucket');
  assert.equal(bucket(app, 'invite:socket:203.0.113.2').attempts, 1);
  assert.equal(bucket(app, 'invite:socket:127.0.0.1'), undefined, 'the trusted proxy socket is not the client');
  prime(app, 'invite:global', 119);
  assert.equal((await invite('203.0.113.3')).status, 200, 'the 120th attempt overall passes');
  limited(await invite('203.0.113.4'));
  assert.equal(bucket(app, 'invite:global').attempts, 121);
});

// Spec cap: 20 invitation emails per household per hour; every send counts, reissues included.
test('a household gets 20 invitation emails per hour and the 21st is refused with Retry-After', async t => {
  const app = await fixture(t);
  const admin = await app.client('admin@example.test', 'admin');
  app.advance(HOUR + 1); // the admin fixture's own invitation falls outside the hour
  const invite = email => admin.postJson('/api/admin/users/invite', { email, role: 'member' });
  for (let i = 1; i <= 19; i++) assert.equal((await invite(`cap-${i}@example.test`)).status, 200, `invitation ${i} is accepted`);
  const twentieth = await invite('cap-1@example.test');
  assert.equal(twentieth.status, 200, 'the 20th send, a reissue, is accepted');
  assert.equal(app.sent.length, 20);
  const refused = await invite('cap-21@example.test');
  assert.equal(refused.status, 429);
  assert.equal(typeof refused.json.error, 'string');
  assert.ok(Number(refused.headers['retry-after']) > 0);
  assert.match(refused.headers['cache-control'], /no-store/);
  assert.equal(app.sent.length, 20, 'no email for the refused invitation');
  assert.equal(app.store.findUser('cap-21@example.test'), null, 'the refused invitation creates nothing');
  assert.equal((await invite('cap-2@example.test')).status, 429, 'a reissue is refused too');
  app.advance(HOUR + 1);
  assert.equal((await invite('cap-21@example.test')).status, 200, 'the cap resets after an hour');
});

test('trusted clients cannot split the per-email recovery limit or shorten its twenty-minute window', async t => {
  const app = await fixture(t, { trustedProxies: '127.0.0.0/8,::1/128' });
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.post('/api/auth/recover', { email: ' Absent+Tag@EXAMPLE.TEST ' }, { 'x-forwarded-for': `203.0.113.${i + 1}` })).status, 200);
  }
  limited(await app.post('/api/auth/recover', { email: 'absent+tag@example.test' }, { 'x-forwarded-for': '203.0.113.11' }));
  app.advance(RECENT);
  limited(await app.post('/api/auth/recover', { email: 'ABSENT+TAG@example.test' }, { 'x-forwarded-for': '203.0.113.12' }));
  app.advance(RECENT);
  assert.equal((await app.post('/api/auth/recover', { email: 'absent+tag@example.test' }, { 'x-forwarded-for': '203.0.113.13' })).status, 200);
});

test('ceremony rate limiting also resolves forwarded clients only through explicit proxy trust', async t => {
  for (const trustedProxies of [undefined, '127.0.0.0/8,::1/128']) {
    const app = await fixture(t, { trustedProxies });
    for (let i = 0; i < 120; i++) {
      assert.equal((await app.post('/api/auth/signin/options', {}, { 'x-forwarded-for': '203.0.113.1' })).status, 200);
    }
    limited(await app.post('/api/auth/signin/options', {}, { 'x-forwarded-for': '203.0.113.1' }));
    const another = await app.post('/api/auth/signin/options', {}, { 'x-forwarded-for': '203.0.113.2' });
    if (trustedProxies) assert.equal(another.status, 200);
    else limited(another);
  }
});

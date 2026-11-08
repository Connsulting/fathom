import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  SERVER_TIMEOUT, spawnServer, spawnAuthenticatedServer, request, postJson,
  openStore, openPlatformStore, createSessionFixture, sessionClient, serveAppFixture, tempDb, tempDir, tempInstance,
  expectServerExit, runCommand, PLATFORM_FILE,
} from './helpers/server.mjs';
import { existsSync } from 'node:fs';
import { createAuthStore } from '../src/auth/store.mjs';
import { setSetting } from '../src/store/db.mjs';
import { aggregatorCsv } from './helpers/ingest.mjs';
import { signInLocation } from '../src/api/identity.mjs';

const T = { timeout: SERVER_TIMEOUT * 3 };
const REAL = { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_EMAIL_TRANSPORT: 'dev',
  FATHOM_EMAIL_FROM: 'sender@example.test', FATHOM_EMAIL_TO: 'recipient@example.test' };
const protectedPaths = [
  '/', '/plan', '/accounts', '/files', '/admin', '/core/core.js', '/horizon/design.css',
  '/shared/rules.mjs', '/api', '/api/', '/api/scenario', '/api/identity', '/api/keys', '/api/mcp',
  '/api/threads', '/api/files', '/api/email', '/api/jobs', '/api/yearend/packet',
  '/api/auth/passkeys', '/api/admin/users', '/api/no-such-route', '/no-such-page',
  '/%61pi/scenario', '/api/%73cenario', '/api/%61uth/passkeys',
];
const publicPosts = ['/api/auth/recover', '/api/auth/register/options', '/api/auth/register/verify',
  '/api/auth/signin/options', '/api/auth/signin/verify'];
const adminPosts = [
  ['/api/admin/users/invite', { email: 'invited@example.test', role: 'member' }],
  ['/api/admin/users/no-user/role', { role: 'admin' }],
  ['/api/admin/users/no-user/remove', {}],
  ['/api/admin/users/no-user/passkeys/no-key/revoke', {}],
];

// Financial store reads (facts, email_sends) and platform reads (accounts, auth rows) are separate.
async function dbCall(server, fn) {
  const db = await openStore(server.dbFile);
  try { return await fn(db); } finally { db.close(); }
}
async function authCall(server, fn) {
  const platform = await openPlatformStore(server.platformFile);
  try {
    const store = createAuthStore(platform);
    return await fn(platform, store, store.servedHousehold().id);
  } finally { platform.close(); }
}
async function clientFor(server, options) {
  const fixture = await authCall(server, platform => createSessionFixture(platform, options));
  return { ...sessionClient(server.baseUrl, fixture), fixture };
}
const cookies = response => (response.headers['set-cookie'] || []).map(c => c.split(';', 1)[0]).join('; ');
function safeError(response, expected) {
  assert.equal(response.status, expected, response.text.slice(0, 200));
  assert.ok(Object.keys(response.json).every(key => ['error', 'code'].includes(key)));
  if ('code' in response.json) assert.match(response.json.code, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
  assert.equal(typeof response.json.error, 'string');
  assert.match(response.headers['cache-control'] || '', /no-store/);
}
function passkey(platform, userId, id) {
  platform.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run(id, userId, Buffer.from('synthetic bytes'), '["internal"]', 'Synthetic credential', Date.now());
}

describe('real HTTP session gate', () => {
  let server;
  let admin;
  let member;
  before(async () => {
    server = await spawnServer({ env: REAL });
    admin = await clientFor(server, { email: 'admin@example.test', role: 'admin' });
    member = await clientFor(server, { email: 'member@example.test', role: 'member' });
  }, T);
  after(async () => { if (server) await server.stop(); });

  test('anonymous is the request default and every protected read is 401', async () => {
    for (const path of protectedPaths) {
      const r = await request(server.baseUrl, { path });
      assert.ok(!r.text.includes('"accounts":'), path);
      const api = path.startsWith('/api') || path.startsWith('/%61') || path.includes('%');
      if (api) {
        assert.equal(r.status, 401, path);
        assert.deepEqual(r.json, { error: 'unauthorized' }, path);
      } else {
        assert.equal(r.status, 303, path);
        assert.equal(r.headers.location, signInLocation(path), path);
        assert.match(r.headers.location, /^\/signin(\?next=|$)/, path);
        assert.equal(r.text, '', path);
      }
    }
    for (const path of ['/api/engine', '/api/threads', '/api/files', '/api/auth/signout', '/api/admin/users/invite', '/healthz', '/signin']) {
      const r = await postJson(server.baseUrl, path, {}, { origin: server.baseUrl });
      assert.equal(r.status, 401, path);
    }
    assert.equal((await admin.request({ path: '/api/scenario' })).status, 200);
    assert.equal((await member.request({ path: '/api/scenario' })).status, 200);
    assert.equal((await admin.request({ path: '/' })).status, 200);
  });

  test('forged proxy identity and forwarded host do not grant access', async () => {
    for (const headers of [
      { 'tailscale-user-login': 'admin@example.test', 'tailscale-user-name': 'Synthetic admin' },
      { 'x-forwarded-user': 'admin@example.test', 'x-forwarded-email': 'admin@example.test' },
      { cookie: '__Host-fathom-session=' + randomBytes(32).toString('base64url') },
      { cookie: 'fathom-session=' + admin.fixture.token },
    ]) {
      assert.equal((await request(server.baseUrl, { path: '/api/scenario', headers })).status, 401);
    }
    assert.equal((await admin.request({ path: '/api/scenario' })).status, 200);
  });

  test('health, exact auth pages, narrow auth assets and session are public', async () => {
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await request(server.baseUrl, { path: '/healthz', method })).status, 200);
      for (const path of ['/signin', '/enroll', '/auth/auth.js', '/auth/auth.css', '/auth/return-path.js', '/favicon.svg']) {
        const r = await request(server.baseUrl, { path, method });
        assert.equal(r.status, 200, `${method} ${path}`);
        if (method === 'GET' && ['/signin', '/enroll'].includes(path)) {
          assert.ok(!r.text.includes('horizon/design.js'));
          assert.ok(!r.text.includes('id="app"'));
        }
      }
    }
    const session = await request(server.baseUrl, { path: '/api/auth/session' });
    assert.equal(session.status, 200);
    assert.deepEqual(session.json, { identity: null, demo: false });
    assert.match(session.headers['cache-control'], /no-store/);
    for (const path of ['/healthz/', '/healthz/more', '/signin/', '/enroll/extra', '/auth/other.js']) {
      const r = await request(server.baseUrl, { path });
      assert.equal(r.status, 303, path);
      assert.equal(r.headers.location, signInLocation(path), path);
    }
    assert.equal((await request(server.baseUrl, { path: '/api/auth/session/' })).status, 401);
    assert.equal((await request(server.baseUrl, { path: '/', method: 'HEAD' })).status, 401);
  });

  test('session and identity expose only the current user projection; authenticated route errors survive', async () => {
    // householdId is the opaque served household id; identity adds operator and memberships
    // (MT-01 contradiction 8).
    const { id, email } = member.fixture.user;
    const { householdId } = member.fixture;
    assert.equal(typeof householdId, 'string');
    assert.ok(householdId.length > 0);
    const identity = { id, email, householdId, role: 'member', name: email, login: email, operator: false,
      memberships: [{ householdId, role: 'member', name: null }], contextVersion: 1 };
    assert.deepEqual((await member.request({ path: '/api/identity' })).json, { identity });
    const session = await member.request({ path: '/api/auth/session' });
    assert.deepEqual(session.json, { identity, demo: false });
    assert.match(session.headers['cache-control'], /no-store/);
    assert.equal((await member.request({ path: '/api/no-such-route' })).status, 404);
    assert.equal((await member.request({ path: '/api/engine' })).status, 405);
  });

  test('members use household data but cannot call any admin endpoint', async () => {
    safeError(await member.request({ path: '/api/admin/users' }), 403);
    for (const [path, body] of adminPosts) safeError(await member.postJson(path, body), 403);
    assert.equal((await member.request({ path: '/api/scenario' })).status, 200);
    const users = await admin.request({ path: '/api/admin/users' });
    assert.equal(users.status, 200);
    assert.ok(users.json.users.some(user => user.id === member.fixture.user.id));
    assert.equal((await admin.postJson('/api/engine', { on: false })).status, 200);
  });

  test('role edits take effect in an existing session and a pending admin cannot replace the last enrolled admin', async () => {
    const disposable = await clientFor(server, { email: 'role-change@example.test', role: 'member' });
    const id = disposable.fixture.user.id;
    assert.equal((await admin.postJson(`/api/admin/users/${id}/role`, { role: 'admin' })).status, 200);
    assert.equal((await disposable.request({ path: '/api/admin/users' })).status, 200);
    assert.equal((await admin.postJson(`/api/admin/users/${id}/role`, { role: 'member' })).status, 200);
    safeError(await disposable.request({ path: '/api/admin/users' }), 403);
    assert.equal((await admin.postJson('/api/admin/users/invite', { email: 'pending-admin@example.test', role: 'admin' })).status, 200);
    safeError(await admin.postJson(`/api/admin/users/${admin.fixture.user.id}/role`, { role: 'member' }), 409);
    safeError(await admin.postJson(`/api/admin/users/${admin.fixture.user.id}/remove`, {}), 409);
    assert.equal((await admin.request({ path: '/api/admin/users' })).status, 200);
  });

  test('strict configured Origin covers normal and public auth POSTs, including scheme mismatch and missing Origin', async () => {
    const before = (await admin.request({ path: '/api/scenario' })).json.live.engine;
    for (const origin of [undefined, 'null', 'https://foreign.example.test', server.baseUrl.replace('http:', 'https:'), server.baseUrl + '/']) {
      safeError(await admin.postJson('/api/engine', { on: !before }, { origin }), 403);
      for (const path of publicPosts) {
        safeError(await postJson(server.baseUrl, path, {}, { origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'foreign.example.test' }), 403);
      }
    }
    assert.equal((await admin.request({ path: '/api/scenario' })).json.live.engine, before);
    assert.equal((await admin.postJson('/api/engine', { on: !before })).status, 200);
    assert.equal((await postJson(server.baseUrl, '/api/auth/signin/options', {}, { origin: server.baseUrl })).status, 200);
  });

  test('Host validation follows canonical encoded dispatch for authenticated and public APIs', async () => {
    for (const path of ['/api/scenario', '/api/%73cenario', '/%61pi/scenario', '/api/%61uth/session', '/api/no-such-route']) {
      const r = await admin.request({ path, headers: { host: 'rebind.example.test', 'x-forwarded-host': new URL(server.baseUrl).host } });
      assert.equal(r.status, 403, path);
      assert.deepEqual(r.json, { error: 'forbidden host' });
    }
    assert.equal((await request(server.baseUrl, { path: '/api/auth/session', headers: { host: 'rebind.example.test' } })).status, 403);
    for (const path of ['/api/scenario', '/api/%73cenario', '/%61pi/scenario']) {
      assert.equal((await admin.request({ path })).status, 200, path);
    }
    assert.equal((await request(server.baseUrl, { path: '/healthz' })).status, 200);
  });

  test('signout clears a secure host cookie and revokes only the presented session', async () => {
    const own = await clientFor(server, { email: 'signout@example.test' });
    const other = await clientFor(server, { email: 'signout@example.test' });
    assert.equal((await own.request({ path: '/api/scenario' })).status, 200);
    const r = await own.postJson('/api/auth/signout');
    assert.equal(r.status, 200);
    const cleared = r.headers['set-cookie'].find(value => value.startsWith('__Host-fathom-session='));
    for (const pattern of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Path=\//i, /Max-Age=0|Expires=Thu, 01 Jan 1970/i]) assert.match(cleared, pattern);
    assert.doesNotMatch(cleared, /Domain=/i);
    assert.equal((await own.request({ path: '/api/scenario' })).status, 401);
    assert.equal((await other.request({ path: '/api/scenario' })).status, 200);
    assert.deepEqual((await own.request({ path: '/api/auth/session' })).json, { identity: null, demo: false });
  });

  test('self and admin credential revocation invalidate all sessions, allow final removal and preserve other users', async () => {
    for (const asAdmin of [false, true]) {
      const account = await clientFor(server, { email: `revoke-${asAdmin}@example.test` });
      const other = await clientFor(server, { email: `revoke-${asAdmin}@example.test` });
      const keyId = `credential-${asAdmin}`;
      await authCall(server, platform => passkey(platform, account.fixture.user.id, keyId));
      const listed = await account.request({ path: '/api/auth/passkeys' });
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.json.passkeys.map(key => key.id), [keyId]);
      assert.ok(!listed.text.includes('synthetic bytes'));
      const path = asAdmin ? `/api/admin/users/${account.fixture.user.id}/passkeys/${keyId}/revoke` : `/api/auth/passkeys/${keyId}/revoke`;
      assert.equal((await (asAdmin ? admin : account).postJson(path)).status, 200);
      assert.equal((await account.request({ path: '/api/scenario' })).status, 401);
      assert.equal((await other.request({ path: '/api/scenario' })).status, 401);
      assert.deepEqual(await authCall(server, (platform, store) => store.listPasskeys(account.fixture.user.id)), []);
      assert.equal((await member.request({ path: '/api/scenario' })).status, 200);
    }
  });
});

test('real uploads enforce exact Origin before reading the body and accept a valid local upload', T, async () => {
  // The vault key: spawnServer gives a real instance its synthetic FATHOM_PLATFORM_KEY_FILE (MT-03).
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const boundary = 'synthetic-origin-test';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic.csv"\r\nContent-Type: text/csv\r\n\r\n${aggregatorCsv([{ date: '2032-03-09', amount: '-12.50', description: 'SYNTHETIC SHOP' }])}\r\n--${boundary}--\r\n`;
    for (const origin of [undefined, 'null', 'https://foreign.example.test', server.baseUrl.replace('http:', 'https:')]) {
      safeError(await server.request({ method: 'POST', path: '/api/files', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin }, body }), 403);
    }
    assert.deepEqual((await server.request({ path: '/api/files' })).json.files, []);
    const valid = await server.request({ method: 'POST', path: '/api/files', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    assert.equal(valid.status, 200, valid.text.slice(0, 200));
    assert.equal(valid.json.files[0].status, 'imported');
  } finally { await server.stop(); }
});

test('registration links expire or consume once while fresh invitations produce strict resident options', T, async () => {
  const server = await spawnServer({ env: REAL });
  try {
    const enrolledUser = await clientFor(server, { email: 'enrolled@example.test', role: 'member' });
    const issued = await authCall(server, (platform, store, hh) => {
      const expiredStore = createAuthStore(platform, { now: () => Date.now() - 21 * 60 * 1000 });
      const expired = expiredStore.invite(hh, 'expired@example.test', { role: 'member' });
      const usedInvite = store.invite(hh, 'used@example.test', { role: 'member' });
      store.consumeInvitation(usedInvite.token, usedInvite.user.id);
      const used = store.createToken(enrolledUser.fixture.user.id, 'recovery');
      store.consumeToken(used.token);
      const fresh = store.invite(hh, 'new@example.test', { role: 'member' });
      return { expired, usedInvite, used, fresh };
    });
    for (const token of [issued.expired.token, issued.usedInvite.token, issued.used.token, randomBytes(32).toString('base64url')]) {
      safeError(await postJson(server.baseUrl, '/api/auth/register/options', { token }, { origin: server.baseUrl }), 410);
    }
    const valid = await postJson(server.baseUrl, '/api/auth/register/options', { token: issued.fresh.token }, { origin: server.baseUrl });
    assert.equal(valid.status, 200, valid.text);
    const { options } = valid.json;
    assert.equal(options.rp.id, 'localhost');
    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.authenticatorSelection.requireResidentKey, true);
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    assert.equal(options.attestation, 'none');
    assert.equal(options.extensions.credProps, true);
    assert.ok(!valid.text.includes(issued.fresh.token));
    const ceremony = valid.headers['set-cookie'].find(value => value.startsWith('__Host-'));
    for (const pattern of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Path=\//i]) assert.match(ceremony, pattern);
    assert.doesNotMatch(ceremony, /Domain=/i);
    const failed = await postJson(server.baseUrl, '/api/auth/register/verify', { token: issued.fresh.token, response: { synthetic: 'private-verifier-payload' } }, { origin: server.baseUrl, cookie: cookies(valid) });
    safeError(failed, 400);
    assert.ok(!failed.text.includes('private-verifier-payload'));
    assert.ok(!server.output().includes('private-verifier-payload'));
    assert.equal(await authCall(server, (platform, store) => store.findUser('new@example.test').enrolledAt), null);
    assert.equal((await postJson(server.baseUrl, '/api/auth/register/options', { token: issued.fresh.token }, { origin: server.baseUrl })).status, 200);
  } finally { await server.stop(); }
});

test('registration requires credProps rk exactly true and consumes refused challenges without enrolling', T, async () => {
  const server = await spawnServer({ env: REAL });
  try {
    const issued = await authCall(server, (platform, store, hh) => store.invite(hh, 'discoverability@example.test', { role: 'member' }));
    for (const extensions of [{ credProps: { rk: false } }, { credProps: {} }, {}]) {
      const options = await postJson(server.baseUrl, '/api/auth/register/options', { token: issued.token }, { origin: server.baseUrl });
      assert.equal(options.status, 200);
      assert.equal(await authCall(server, platform => platform.prepare('SELECT count(*) AS n FROM auth_challenges WHERE user_id = ?').get(issued.user.id).n), 1);
      const headers = { origin: server.baseUrl, cookie: cookies(options) };
      const body = { token: issued.token, response: { clientExtensionResults: extensions } };
      const refused = await postJson(server.baseUrl, '/api/auth/register/verify', body, headers);
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.json, { error: 'a discoverable passkey is required' });
      await authCall(server, (platform, store, hh) => {
        assert.deepEqual(store.listPasskeys(issued.user.id), []);
        assert.equal(store.getUser(issued.user.id).enrolledAt, null);
        assert.equal(platform.prepare('SELECT count(*) AS n FROM auth_challenges WHERE user_id = ?').get(issued.user.id).n, 0);
        assert.ok(store.invitation(issued.token), 'the invitation remains usable for a fresh ceremony');
        assert.equal(store.membership(issued.user.id, hh), null, 'a refused registration creates no membership');
      });
      const replay = await postJson(server.baseUrl, '/api/auth/register/verify', body, headers);
      assert.equal(replay.status, 400);
      assert.deepEqual(replay.json, { error: 'passkey verification failed' });
    }
  } finally { await server.stop(); }
});

test('discoverable signin options and failed library responses have safe fixed errors and single-use challenges', T, async () => {
  const server = await spawnServer({ env: REAL });
  try {
    const errors = [];
    for (const response of [null, {}, { id: 'synthetic', rawId: 'c3ludGhldGlj', type: 'public-key', response: { clientDataJSON: 'private-verifier-payload' } }]) {
      const options = await postJson(server.baseUrl, '/api/auth/signin/options', {}, { origin: server.baseUrl });
      assert.equal(options.status, 200);
      assert.equal(options.json.options.userVerification, 'required');
      assert.equal('allowCredentials' in options.json.options, false);
      assert.equal(typeof options.json.options.challenge, 'string');
      const headers = { origin: server.baseUrl, cookie: cookies(options) };
      const failed = await postJson(server.baseUrl, '/api/auth/signin/verify', { response }, headers);
      safeError(failed, 400);
      errors.push(failed.json.error);
      assert.ok(!failed.text.includes('private-verifier-payload'));
      const replay = await postJson(server.baseUrl, '/api/auth/signin/verify', { response }, headers);
      assert.equal(replay.status, 400);
    }
    assert.equal(new Set(errors).size, 1, 'verifier failures have one fixed safe message');
    assert.ok(!server.output().includes('private-verifier-payload'));
    assert.equal((await request(server.baseUrl, { path: '/api/auth/session' })).json.identity, null);
    assert.equal((await postJson(server.baseUrl, '/api/auth/signin/options', {}, { origin: server.baseUrl })).status, 200);
  } finally { await server.stop(); }
});

test('anonymous options are bounded, persist hashed rate keys and leave health and live sessions usable', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    let limited;
    for (let i = 0; i < 256; i++) {
      const r = await postJson(server.baseUrl, '/api/auth/signin/options', {}, { origin: server.baseUrl, 'x-forwarded-for': `192.0.2.${i % 200 + 1}` });
      if (r.status === 429) { limited = r; break; }
      assert.equal(r.status, 200);
    }
    assert.ok(limited, 'changing spoofed forwarding addresses cannot evade the socket/global limit');
    safeError(limited, 429);
    const rates = await authCall(server, platform => JSON.stringify(platform.prepare('SELECT * FROM auth_rate_limits').all()));
    assert.ok(!rates.includes('127.0.0.1'));
    assert.ok(!rates.includes('192.0.2.'));
    assert.equal((await request(server.baseUrl, { path: '/healthz' })).status, 200);
    assert.equal((await server.request({ path: '/api/scenario' })).status, 200);
  } finally { await server.stop(); }
});

for (const publicUrl of [undefined, 'http://example.test', 'https://127.0.0.1', 'http://127.0.0.1:9000', 'https://example.test/path']) {
  test(`real startup refuses an absent or invalid public origin: ${publicUrl ?? 'unset'}`, T, async () => {
    const dataDir = await tempDir();
    const result = await expectServerExit({ dataDir, env: { ...REAL, FATHOM_PUBLIC_URL: publicUrl } });
    try {
      assert.equal(result.started, false, result.output);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /FATHOM_PUBLIC_URL/);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
}

test('demo stays anonymous without a public URL and every auth/admin API except session returns 404', T, async () => {
  const server = await spawnServer({ env: { FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake', FATHOM_PUBLIC_URL: undefined } });
  try {
    assert.equal((await request(server.baseUrl, { path: '/' })).status, 200);
    assert.equal((await request(server.baseUrl, { path: '/api/scenario' })).json.live.mode, 'demo');
    assert.deepEqual((await request(server.baseUrl, { path: '/api/identity' })).json, { identity: null });
    assert.deepEqual((await request(server.baseUrl, { path: '/api/auth/session' })).json, { identity: null, demo: true });
    for (const path of [...publicPosts, '/api/auth/signout', '/api/auth/passkeys/synthetic/revoke', ...adminPosts.map(([path]) => path)]) {
      assert.equal((await postJson(server.baseUrl, path)).status, 404, path);
    }
    for (const path of ['/api/auth/passkeys', '/api/admin/users']) assert.equal((await request(server.baseUrl, { path })).status, 404);
    assert.equal((await postJson(server.baseUrl, '/api/engine', { on: false })).status, 200, 'demo keeps CLI-friendly mutation semantics');
    assert.equal((await postJson(server.baseUrl, '/api/demo/reset')).status, 200);
    // The demo platform is synthetic and created at startup; the financial store keeps no households.
    assert.equal(await authCall(server, platform => platform.prepare('SELECT count(*) AS n FROM households').get().n), 1);
    assert.equal(await authCall(server, (platform, store) => store.servedHousehold().mode), 'demo');
    assert.equal(await dbCall(server, db => db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'households'").get().n), 0);
    assert.equal((await request(server.baseUrl, { path: '/api/scenario' })).json.live.mode, 'demo');
  } finally { await server.stop(); }
});

async function waitStartupJobs(server) {
  for (let i = 0; i < 500; i++) {
    if (/fathom: job simplefin-sync (?:ok|skipped|failed)/.test(server.output())) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('the synthetic server did not finish its startup job tick');
}

async function outbox(server, count) {
  for (let i = 0; i < 100; i++) {
    let files = [];
    try { files = readdirSync(join(server.dataDir, 'outbox')).filter(name => name.endsWith('.json')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const messages = files.map(name => JSON.parse(readFileSync(join(server.dataDir, 'outbox', name), 'utf8')))
      .filter(message => /\/enroll#[A-Za-z0-9_-]{43}/.test(message.text));
    if (messages.length >= count) return messages;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('the local dev transport did not write its expected message');
}

function linkFrom(text) {
  const links = String(text).match(/https?:\/\/[^\s<>"']+/g) || [];
  const link = links.map(value => new URL(value)).find(url => url.pathname === '/enroll' && url.hash);
  assert.ok(link, 'enrollment URL has a fragment');
  assert.equal(link.search, '', 'the bearer never enters the query');
  const token = link.hash.match(/[A-Za-z0-9_-]{43}/)?.[0];
  assert.ok(token, 'fragment carries one bearer');
  return { link, token };
}

test('recovery response is generic for known, unknown, invalid and pending addresses; only enrolled users receive canonical mail', T, async () => {
  const server = await spawnServer({ env: REAL });
  try {
    const client = await clientFor(server, { email: ' Recover+Tag@EXAMPLE.TEST ', role: 'member' });
    await authCall(server, (platform, store, hh) => store.invite(hh, 'pending@example.test', { role: 'member' }));
    await waitStartupJobs(server);
    const sendsBefore = await dbCall(server, db => db.prepare('SELECT count(*) AS n FROM email_sends').get().n);
    const responses = [];
    for (const email of ['unknown@example.test', 'not an email', 'pending@example.test', ' Recover+Tag@EXAMPLE.TEST ']) {
      const r = await postJson(server.baseUrl, '/api/auth/recover', { email }, { origin: server.baseUrl });
      assert.equal(r.status, 200);
      assert.match(r.headers['cache-control'], /no-store/);
      responses.push(r.json);
    }
    for (const r of responses) assert.deepEqual(r, responses[0]);
    const messages = await outbox(server, 1);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].to, ['recover+tag@example.test']);
    const { token } = linkFrom(messages[0].text);
    assert.equal(await authCall(server, (platform, store) => store.token(token).purpose), 'recovery');
    assert.equal(await dbCall(server, db => db.prepare('SELECT count(*) AS n FROM email_sends').get().n), sendsBefore);
    const rates = await authCall(server, platform => JSON.stringify(platform.prepare('SELECT * FROM auth_rate_limits').all()));
    assert.ok(!rates.includes('recover+tag@example.test'));
    assert.ok(!rates.includes('127.0.0.1'));
    assert.ok(!server.output().includes(token));
    assert.ok(!server.output().includes('recover+tag@example.test'));
    assert.equal((await client.request({ path: '/api/scenario' })).status, 200, 'requesting recovery alone does not revoke sessions');
    const options = await postJson(server.baseUrl, '/api/auth/register/options', { token }, { origin: server.baseUrl });
    assert.equal(options.status, 200);
    const rejected = await postJson(server.baseUrl, '/api/auth/register/verify', { token, response: {} }, { origin: server.baseUrl, cookie: cookies(options) });
    assert.equal(rejected.status, 400);
    assert.equal((await client.request({ path: '/api/scenario' })).status, 200, 'failed verification does not revoke sessions');
  } finally { await server.stop(); }
});

test('admin invitations return no bearer and use the canonical stored address without financial email bookkeeping', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    await waitStartupJobs(server);
    const sendsBefore = await dbCall(server, db => db.prepare('SELECT count(*) AS n FROM email_sends').get().n);
    const result = await server.postJson('/api/admin/users/invite', { email: ' New+Tag@EXAMPLE.TEST ', role: 'member' });
    assert.equal(result.status, 200);
    const [mail] = await outbox(server, 1);
    assert.deepEqual(mail.to, ['new+tag@example.test']);
    const { token } = linkFrom(mail.text);
    assert.ok(!result.text.includes(token));
    assert.ok(!result.text.includes('/enroll#'));
    assert.ok(!server.output().includes(token));
    assert.equal(await dbCall(server, db => db.prepare('SELECT count(*) AS n FROM email_sends').get().n), sendsBefore);
    const member = await authCall(server, (platform, store) => store.findUser('new+tag@example.test'));
    assert.equal(member.enrolledAt, null);
    const pending = await authCall(server, (platform, store) => store.invitation(token));
    assert.deepEqual({ ...pending, expiresAt: typeof pending.expiresAt },
      { householdId: server.session.householdId, email: 'new+tag@example.test', role: 'member', userId: member.id, expiresAt: 'number' });
    const again = await server.postJson('/api/admin/users/invite', { email: 'NEW+TAG@example.test', role: 'admin' });
    assert.equal(again.status, 200);
    const mails = await outbox(server, 2);
    const replacement = mails.map(mail => linkFrom(mail.text).token).find(value => value !== token);
    assert.ok(replacement);
    assert.equal(await authCall(server, (platform, store) => store.invitation(token)), null);
    assert.ok(await authCall(server, (platform, store) => store.invitation(replacement)));
    assert.equal(await authCall(server, (platform, store) => store.invitation(replacement).userId), member.id, 'the reissue keeps the pending user');
    assert.equal(await authCall(server, (platform, store) => store.invitation(replacement).role), 'admin', 'reissue applies the requested pending role');
  } finally { await server.stop(); }
});

test('expired sessions are denied and request entry lazily removes expired auth rows while keeping live rows and financial data', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const facts = await dbCall(server, db => db.prepare('SELECT * FROM facts ORDER BY key').all());
    const rows = await authCall(server, (platform, store, hh) => {
      const { user, token } = store.invite(hh, 'expiry@example.test', { role: 'member' });
      store.consumeInvitation(token, user.id);
      store.markEnrolled(user.id);
      const old = createAuthStore(platform, { now: () => Date.now() - 8 * 24 * 60 * 60 * 1000 });
      const expiredSession = old.createSession(user.id);
      old.createToken(user.id, 'recovery');
      const liveToken = store.createToken(server.session.user.id, 'recovery');
      return { expiredSession, liveToken };
    });
    assert.equal((await request(server.baseUrl, { path: '/api/scenario', headers: { cookie: `__Host-fathom-session=${rows.expiredSession.token}` } })).status, 401);
    assert.equal((await server.request({ path: '/api/scenario' })).status, 200);
    await authCall(server, (platform, store) => {
      assert.equal(store.session(rows.expiredSession.token), null);
      assert.ok(store.token(rows.liveToken.token));
      assert.equal(platform.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
      assert.equal(platform.prepare('SELECT count(*) AS n FROM auth_tokens').get().n, 1);
    });
    assert.deepEqual(await dbCall(server, db => db.prepare('SELECT * FROM facts ORDER BY key').all()), facts);
  } finally { await server.stop(); }
});

const inviteCli = (args, env) => runCommand(process.execPath, ['scripts/user-invite.mjs', ...args], { env });
const cliEnv = dataDir => ({ ...REAL, FATHOM_DATA: dataDir, FATHOM_PUBLIC_URL: 'http://localhost:9443' });
const financialDump = db => Object.fromEntries(['facts', 'files', 'accounts', 'transactions', 'messages', 'recs', 'email_sends']
  .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));

// Bootstrap targets the served household of an instance's platform.sqlite. The CLI writes from
// its own process while this test reads through `temp.platform`.
const realInstance = () => tempInstance({ mode: 'real', init: db => setSetting(db, 'mode', 'real') });
const liveInvitations = platform => platform.prepare('SELECT count(*) AS n FROM household_invitations WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(Date.now()).n;

test('bootstrap CLI requires explicit admin, reissues only before enrollment, and prints its link only after dev email succeeds', T, async () => {
  const temp = await realInstance();
  try {
    const initial = financialDump(temp.db);
    const store = createAuthStore(temp.platform);
    const hh = store.servedHousehold().id;
    for (const args of [['bootstrap@example.test'], ['bootstrap@example.test', '--member'], ['bootstrap@example.test', '--admin', '--unknown']]) {
      const failed = await inviteCli(args, cliEnv(temp.dataDir));
      assert.notEqual(failed.code, 0);
      assert.equal(failed.stdout.trim(), '');
      assert.ok(!failed.stderr.includes('bootstrap@example.test'));
      assert.equal(store.listPeople(hh).length, 0);
      assert.equal(store.findUser('bootstrap@example.test'), null);
    }
    const first = await inviteCli([' Bootstrap@EXAMPLE.TEST ', '--admin'], cliEnv(temp.dataDir));
    assert.equal(first.code, 0, first.stderr);
    const { token, link } = linkFrom(first.stdout);
    assert.equal(link.origin, 'http://localhost:9443');
    assert.ok(!first.stdout.toLowerCase().includes('bootstrap@example.test'));
    assert.ok(!first.stderr.includes(token));
    assert.ok(!first.stderr.includes('bootstrap@example.test'));
    const user = store.findUser('bootstrap@example.test');
    assert.ok(user);
    assert.deepEqual({ ...store.invitation(token), expiresAt: typeof store.invitation(token).expiresAt },
      { householdId: hh, email: 'bootstrap@example.test', role: 'admin', userId: user.id, expiresAt: 'number' });
    const [message] = await outbox({ dataDir: temp.dataDir }, 1);
    assert.deepEqual(message.to, ['bootstrap@example.test']);
    assert.ok(message.text.includes(token));
    const second = await inviteCli(['bootstrap@example.test', '--admin'], cliEnv(temp.dataDir));
    assert.equal(second.code, 0, second.stderr);
    const replacement = linkFrom(second.stdout).token;
    assert.notEqual(replacement, token);
    assert.equal(store.invitation(token), null);
    assert.equal(store.invitation(replacement).role, 'admin');
    // The bootstrap admin redeems the invitation and enrolls; bootstrap then refuses.
    store.consumeInvitation(replacement, user.id);
    store.markEnrolled(user.id);
    const refused = await inviteCli(['another@example.test', '--admin'], cliEnv(temp.dataDir));
    assert.notEqual(refused.code, 0);
    assert.equal(refused.stdout.trim(), '');
    assert.equal(store.findUser('another@example.test'), null);
    assert.equal(store.membership(user.id, hh).role, 'admin');
    assert.deepEqual(financialDump(temp.db), initial);
  } finally { temp.close(); rmSync(temp.dataDir, { recursive: true, force: true }); }
});

test('bootstrap CLI refuses demo, absent database, an unmigrated real store and invalid public origin without seeding financial data', T, async () => {
  const demoInstance = await tempInstance({ mode: 'demo', init: db => setSetting(db, 'mode', 'demo') });
  const real = await realInstance();
  const legacy = await tempDb();
  const missing = await tempDir();
  try {
    const demoInitial = financialDump(demoInstance.db);
    const demo = await inviteCli(['admin@example.test', '--admin'], cliEnv(demoInstance.dataDir));
    assert.notEqual(demo.code, 0);
    assert.equal(demo.stdout.trim(), '');
    assert.deepEqual(financialDump(demoInstance.db), demoInitial);
    assert.equal(createAuthStore(demoInstance.platform).findUser('admin@example.test'), null);
    const absent = await inviteCli(['admin@example.test', '--admin'], cliEnv(missing));
    assert.notEqual(absent.code, 0);
    assert.equal(absent.stdout.trim(), '');
    assert.deepEqual(readdirSync(missing), []);
    // A real store without platform.sqlite needs the offline platform migration first.
    setSetting(legacy.db, 'mode', 'real');
    const legacyInitial = financialDump(legacy.db);
    const unmigrated = await inviteCli(['admin@example.test', '--admin'], cliEnv(legacy.dataDir));
    assert.notEqual(unmigrated.code, 0);
    assert.equal(unmigrated.stdout.trim(), '');
    assert.match(unmigrated.stderr, /platform_migration_required/);
    assert.equal(existsSync(join(legacy.dataDir, PLATFORM_FILE)), false, 'no platform is created');
    assert.deepEqual(financialDump(legacy.db), legacyInitial);
    const realInitial = financialDump(real.db);
    const invalid = await inviteCli(['admin@example.test', '--admin'], { ...cliEnv(real.dataDir), FATHOM_PUBLIC_URL: 'http://foreign.example.test' });
    assert.notEqual(invalid.code, 0);
    assert.equal(invalid.stdout.trim(), '');
    const store = createAuthStore(real.platform);
    assert.equal(store.listPeople(store.servedHousehold().id).length, 0);
    assert.equal(store.findUser('admin@example.test'), null);
    assert.deepEqual(financialDump(real.db), realInitial);
  } finally {
    for (const temp of [demoInstance, real, legacy]) { temp.close(); rmSync(temp.dataDir, { recursive: true, force: true }); }
    rmSync(missing, { recursive: true, force: true });
  }
});

test('email failure revokes the bootstrap link and writes only a fixed sanitized error', T, async () => {
  const temp = await realInstance();
  try {
    const failed = await inviteCli(['private-test-address@example.test', '--admin'], {
      ...cliEnv(temp.dataDir), FATHOM_EMAIL_TRANSPORT: 'smtp', FATHOM_EMAIL_CREDENTIAL_FILE: join(temp.dataDir, 'missing-credential'),
    });
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stdout.trim(), '');
    for (const text of ['private-test-address@example.test', 'missing-credential', 'ENOENT', '/enroll#']) assert.ok(!failed.stderr.includes(text));
    assert.equal(liveInvitations(temp.platform), 0, 'the failed link is revoked');
    assert.equal(temp.platform.prepare('SELECT count(*) AS n FROM auth_tokens').get().n, 0);
    const good = await inviteCli(['private-test-address@example.test', '--admin'], cliEnv(temp.dataDir));
    assert.equal(good.code, 0, good.stderr);
    assert.ok(createAuthStore(temp.platform).invitation(linkFrom(good.stdout).token));
    assert.equal(liveInvitations(temp.platform), 1);
    assert.equal(temp.db.prepare('SELECT count(*) AS n FROM email_sends').get().n, 0);
  } finally { temp.close(); rmSync(temp.dataDir, { recursive: true, force: true }); }
});

test('adding a credential excludes every current credential and malformed verification preserves both accounts', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const first = await clientFor(server, { email: 'add-first@example.test', role: 'member' });
    const second = await clientFor(server, { email: 'add-second@example.test', role: 'member' });
    await authCall(server, platform => {
      passkey(platform, first.fixture.user.id, 'c3ludGhldGljLW9uZQ');
      passkey(platform, first.fixture.user.id, 'c3ludGhldGljLXR3bw');
      passkey(platform, second.fixture.user.id, 'c3ludGhldGljLW90aGVy');
    });
    const options = await first.postJson('/api/auth/register/options', { name: 'Additional synthetic credential' });
    assert.equal(options.status, 200, options.text);
    assert.deepEqual(options.json.options.excludeCredentials.map(key => key.id).sort(), ['c3ludGhldGljLW9uZQ', 'c3ludGhldGljLXR3bw'].sort());
    const failed = await first.postJson('/api/auth/register/verify', { response: {} }, { cookie: [first.fixture.cookie, cookies(options)].join('; ') });
    assert.equal(failed.status, 400);
    assert.equal(typeof failed.json.error, 'string');
    await authCall(server, (platform, store) => {
      assert.equal(store.listPasskeys(first.fixture.user.id).length, 2);
      assert.equal(store.listPasskeys(second.fixture.user.id).length, 1);
    });
    assert.equal((await first.request({ path: '/api/scenario' })).status, 200);
    assert.equal((await second.request({ path: '/api/scenario' })).status, 200);
    assert.equal((await first.postJson('/api/auth/register/options', { name: 'Retry synthetic credential' })).status, 200);
  } finally { await server.stop(); }
});

test('a member cannot revoke another account credential and their own remaining credential stays usable as metadata', T, async () => {
  const server = await spawnAuthenticatedServer({ env: REAL });
  try {
    const first = await clientFor(server, { email: 'credential-first@example.test', role: 'member' });
    const second = await clientFor(server, { email: 'credential-second@example.test', role: 'member' });
    await authCall(server, platform => {
      passkey(platform, first.fixture.user.id, 'first-only');
      passkey(platform, second.fixture.user.id, 'second-only');
    });
    const refused = await first.postJson('/api/auth/passkeys/second-only/revoke');
    assert.ok([403, 404].includes(refused.status));
    assert.equal(typeof refused.json.error, 'string');
    assert.deepEqual((await second.request({ path: '/api/auth/passkeys' })).json.passkeys.map(key => key.id), ['second-only']);
    assert.deepEqual((await first.request({ path: '/api/auth/passkeys' })).json.passkeys.map(key => key.id), ['first-only']);
    assert.equal((await second.request({ path: '/api/scenario' })).status, 200);
    assert.equal((await first.postJson('/api/auth/passkeys/first-only/revoke')).status, 200);
    assert.equal((await first.request({ path: '/api/scenario' })).status, 401);
    assert.equal((await second.request({ path: '/api/scenario' })).status, 200);
  } finally { await server.stop(); }
});

test('recovery does not await mail latency, sanitizes send failures and revokes a failed link before retry', T, async t => {
  const temp = await realInstance();
  const fixture = await createSessionFixture(temp.platform, { email: 'latency@example.test', role: 'member' });
  const sent = [];
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  let rejectMail;
  let completed = false;
  const pending = new Promise((resolve, reject) => { rejectMail = reject; });
  // The transport interface is createTransport().send({to, subject, text, html}) in
  // src/email/transport.mjs; no WebAuthn verifier or internal auth effect is replaced.
  const transport = {
    name: 'dev',
    send(message) {
      sent.push(message);
      return completed ? Promise.resolve({ id: 'synthetic-delivery', recipients: 1 }) : pending;
    },
  };
  const app = await serveAppFixture({ db: temp.db, platform: temp.platform, config: { dataDir: temp.dataDir, emailTransport: 'dev',
    emailFrom: REAL.FATHOM_EMAIL_FROM, emailTo: REAL.FATHOM_EMAIL_TO }, transport });
  let timer;
  try {
    const response = await Promise.race([
      postJson(app.baseUrl, '/api/auth/recover', { email: ' LATENCY@EXAMPLE.TEST ' }, { origin: app.baseUrl }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('recovery waited for mail delivery')), 1500); }),
    ]);
    clearTimeout(timer);
    assert.equal(response.status, 200);
    for (let i = 0; sent.length === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].to].flat(), ['latency@example.test']);
    const { token } = linkFrom(sent[0].text);
    const unknown = await postJson(app.baseUrl, '/api/auth/recover', { email: 'unknown@example.test' }, { origin: app.baseUrl });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.json, response.json);
    rejectMail(new Error('synthetic-provider-private-diagnostic latency@example.test'));
    completed = true;
    const store = createAuthStore(temp.platform);
    for (let i = 0; store.token(token) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.token(token), null);
    const logged = logs.join('\n');
    for (const value of [token, 'latency@example.test', 'synthetic-provider-private-diagnostic']) assert.ok(!logged.includes(value));
    assert.equal(store.session(fixture.token).id, fixture.user.id);
    const retry = await postJson(app.baseUrl, '/api/auth/recover', { email: 'latency@example.test' }, { origin: app.baseUrl });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.json, response.json);
    for (let i = 0; sent.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 2);
    assert.ok(store.token(linkFrom(sent[1].text).token));
    assert.equal(temp.db.prepare('SELECT count(*) AS n FROM email_sends').get().n, 0);
  } finally {
    clearTimeout(timer);
    rejectMail(new Error('synthetic transport closed'));
    await app.close();
    temp.close();
    rmSync(temp.dataDir, { recursive: true, force: true });
  }
});

test('bootstrap CLI refuses after any member has enrolled and preserves that account and session', T, async () => {
  const temp = await realInstance();
  try {
    const member = await createSessionFixture(temp.platform, { email: 'existing-member@example.test', role: 'member' });
    const initial = financialDump(temp.db);
    const refused = await inviteCli(['new-admin@example.test', '--admin'], cliEnv(temp.dataDir));
    assert.notEqual(refused.code, 0);
    assert.equal(refused.stdout.trim(), '');
    const store = createAuthStore(temp.platform);
    assert.deepEqual(store.listPeople(member.householdId).map(person => person.id), [member.user.id]);
    assert.equal(store.membership(member.user.id, member.householdId).role, 'member');
    assert.equal(store.findUser('new-admin@example.test'), null);
    assert.equal(store.session(member.token).id, member.user.id);
    assert.deepEqual(financialDump(temp.db), initial);
  } finally { temp.close(); rmSync(temp.dataDir, { recursive: true, force: true }); }
});

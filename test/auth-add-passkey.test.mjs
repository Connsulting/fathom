// Add-a-device passkey links: POST /api/auth/passkeys/link mails a signed-in user a single-use
// 'add-passkey' link; redeeming it through /api/auth/register/* adds a passkey without revoking
// anything. Everything goes through HTTP with real cookies against the real WebAuthn verifier,
// driven by the software authenticator in test/helpers/webauthn.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rmSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { createHandler } from '../src/api/router.mjs';
import { createAuthService } from '../src/auth/service.mjs';
import { createRuntimeRegistry } from '../src/platform/runtime.mjs';
import { createKeyService } from '../src/mcp/keys.mjs';
import { setSetting } from '../src/store/db.mjs';
import { createSessionFixture, freePort, postJson, request, tempInstance } from './helpers/server.mjs';
import { createAuthenticator } from './helpers/webauthn.mjs';

const START = Date.parse('2032-03-10T12:34:56.789Z');
const RECENT = 10 * 60_000;
const TTL = 20 * 60_000;
const LINK = '/api/auth/passkeys/link';
const LINK_SUBJECT = 'Add a Fathom passkey on another device';
const ADDED = 'Fathom passkey added';
const SESSION = '__Host-fathom-session';
const EXPIRED = { error: 'link expired or already used' };

async function fixture(t) {
  const temp = await tempInstance({ mode: 'real', init: async db => await setSetting(db, 'mode', 'real') });
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await temp.close();
    rmSync(temp.dataDir, { recursive: true, force: true });
  });
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const config = loadConfig({
    FATHOM_DATA: temp.dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_PUBLIC_URL: baseUrl,
    FATHOM_CLOCK: '2001-01-01',
  });
  let clock = START;
  const now = () => clock;
  const sent = [];
  const state = { fail: false };
  const transport = {
    name: 'dev',
    async send(message) {
      if (state.fail) throw new Error('synthetic transport failure');
      sent.push(message);
      return { id: 'synthetic-send', recipients: 1 };
    },
  };
  const auth = await createAuthService({ platform: temp.platform, config, transport, now });
  // The router serves the instance's household through a runtime registry over temp.db.
  const household = await temp.household(config, { transport });
  const runtimes = createRuntimeRegistry({ platform: temp.platform, config, secrets: temp.secrets, build: () => household });
  const keys = createKeyService({ platform: temp.platform, secret: () => temp.secrets.mcpSecret(), creatorActive: auth.creatorActive });
  server = http.createServer(createHandler({ platform: temp.platform, config, runtimes, auth, keys }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    db: temp.db, platform: temp.platform, auth, store: auth.store, hh: (await auth.store.servedHousehold()).id, sent, state, baseUrl, now,
    advance: ms => { clock += ms; },
    // A trusted session fixture for an existing or new user (signed in now).
    async sessionFor(email, role = 'member') {
      const session = await createSessionFixture(temp.platform, { email, role, now });
      return browser(this, session.token);
    },
  };
}

// A browser: a cookie jar that applies Set-Cookie, and same-origin requests by default.
function browser(app, sessionToken = null) {
  const jar = new Map();
  if (sessionToken) jar.set(SESSION, sessionToken);
  const cookie = () => (jar.size ? [...jar].map(([name, value]) => `${name}=${value}`).join('; ') : undefined);
  const absorb = response => {
    for (const line of response.headers['set-cookie'] || []) {
      const pair = line.split(';', 1)[0];
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return response;
  };
  return {
    jar,
    session: () => jar.get(SESSION) ?? null,
    post: async (path, body = {}, headers = {}) => absorb(await postJson(app.baseUrl, path, body, { origin: app.baseUrl, cookie: cookie(), ...headers })),
    get: async path => absorb(await request(app.baseUrl, { path, headers: { cookie: cookie() } })),
  };
}

async function identityOf(client) {
  const response = await client.get('/api/auth/session');
  assert.equal(response.status, 200);
  return response.json.identity;
}

async function register(app, client, device, extra, name) {
  const options = await client.post('/api/auth/register/options', { ...extra, name });
  if (options.status !== 200) return { options, verify: null };
  const response = device.createCredential(options.json.options, { origin: app.baseUrl });
  const verify = await client.post('/api/auth/register/verify', { ...extra, name, response });
  return { options, verify, response };
}

// An enrolled user with a real passkey: invited to the served household, then registered through
// the invitation link.
async function enrolled(app, email, role = 'member') {
  const { user: invited, token } = app.store.invite(app.hh, email, { role });
  const device = createAuthenticator();
  const client = browser(app);
  const { options, verify } = await register(app, client, device, { token }, 'First synthetic device');
  assert.equal(options.status, 200, `invite options for ${email}`);
  assert.equal(verify.status, 200, `invite enrollment for ${email}`);
  assert.ok(client.session(), 'enrollment signs the browser in');
  const user = await app.store.getUser(invited.id);
  assert.notEqual(user.enrolledAt, null);
  return { user, client, device, credentialId: device.credentials()[0].id };
}

async function signIn(app, device, credentialId) {
  const client = browser(app);
  const options = await client.post('/api/auth/signin/options', {});
  assert.equal(options.status, 200);
  const response = device.getAssertion(options.json.options, { origin: app.baseUrl, credentialId });
  const verify = await client.post('/api/auth/signin/verify', { response });
  return { client, verify };
}

const tokenRows = async (app, userId) => (await app.platform.prepare('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY purpose, hash').all(userId)).map(row => ({ ...row }));
const invitationRows = async (app, userId) => (await app.platform.prepare('SELECT * FROM household_invitations WHERE user_id = ? ORDER BY hash').all(userId)).map(row => ({ ...row }));
const addRows = async (app, userId) => (await tokenRows(app, userId)).filter(row => row.purpose === 'add-passkey');
const otherRows = async (app, userId) => (await tokenRows(app, userId)).filter(row => row.purpose !== 'add-passkey');
const sessionCount = async (app, userId) => (await app.platform.prepare('SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?').get(userId)).n;
const passkeyIds = async (app, userId) => (await app.store.listPasskeys(userId)).map(item => item.id);
const recipients = mail => [mail.to].flat();

// The single add-passkey mail sent since `mark`; returns its token after checking the link shape.
function mailedToken(app, mark, email) {
  const mails = app.sent.slice(mark).filter(mail => mail.subject === LINK_SUBJECT);
  assert.equal(mails.length, 1, 'one add-passkey link mail');
  const [mail] = mails;
  assert.deepEqual(recipients(mail), [email]);
  assert.equal(mail.cc, undefined);
  assert.equal(mail.bcc, undefined);
  const match = /\/enroll#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(mail.text);
  assert.ok(match, 'the text part carries an /enroll# link');
  const token = match[1];
  const link = `${app.baseUrl}/enroll#${token}`;
  assert.ok(mail.text.includes(link), 'text link is <origin>/enroll#<token>');
  assert.ok(mail.html.includes(link), 'html carries the same link');
  return token;
}

async function requestLink(app, client, email, body = {}) {
  const mark = app.sent.length;
  const response = await client.post(LINK, body);
  assert.equal(response.status, 200, `link request: ${response.text}`);
  assert.deepEqual(response.json, { sent: true });
  const token = mailedToken(app, mark, email);
  assert.ok(!response.text.includes(token), 'the token is only in the email');
  return token;
}

function recentError(response) {
  assert.equal(response.status, 403);
  assert.equal(response.json.code, 'recent_signin_required');
  assert.match(response.json.error, /sign in again/i);
  assert.match(response.headers['cache-control'], /no-store/);
}

function limited(response) {
  assert.equal(response.status, 429);
  assert.deepEqual(response.json, { error: 'too many requests' });
  assert.ok(Number(response.headers['retry-after']) > 0);
}

function notices(app, mark) {
  return app.sent.slice(mark).filter(mail => mail.subject === ADDED || mail.subject === 'Fathom account recovered');
}

test('a signed-in browser with a recent sign-in gets an add-passkey link mailed only to its own address', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test', 'admin');
  const other = await enrolled(app, 'other@example.test');
  // Was an invite token plus a recovery token: invite links are household invitations now, so the
  // owner's consumed invitation row stands in for the other link kind.
  await app.store.createToken(owner.user.id, 'recovery');
  const kept = await otherRows(app, owner.user.id);
  assert.equal(kept.length, 1);
  const invitations = await invitationRows(app, owner.user.id);
  assert.equal(invitations.length, 1);
  const mark = app.sent.length;
  const response = await owner.client.post(LINK, { email: other.user.email, userId: other.user.id });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { sent: true });
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(app.sent.length - mark, 1, 'exactly one mail');
  const token = mailedToken(app, mark, owner.user.email);
  assert.ok(!response.text.includes(token));
  const issued = app.store.token(token);
  assert.deepEqual(issued, { userId: owner.user.id, purpose: 'add-passkey', expiresAt: START + TTL });
  assert.equal((await addRows(app, owner.user.id)).length, 1);
  assert.deepEqual(await otherRows(app, owner.user.id), kept, 'the recovery token is untouched');
  assert.deepEqual(await invitationRows(app, owner.user.id), invitations, 'the invitation is untouched');
  assert.deepEqual(await tokenRows(app, other.user.id), [], 'the address in the body gets nothing');
  assert.equal((await app.db.prepare('SELECT count(*) AS n FROM email_sends').get()).n, 0, 'auth mail stays out of email_sends');
});

test('the link needs a live session whose sign-in is under ten minutes old', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  app.advance(RECENT - 1);
  await requestLink(app, owner.client, owner.user.email);
  const pending = await addRows(app, owner.user.id);
  assert.equal(pending.length, 1, 'a sign-in just under ten minutes old is recent');
  app.advance(1);
  const mark = app.sent.length;
  const stale = await owner.client.post(LINK, {});
  recentError(stale);
  const inPlace = await owner.client.post('/api/auth/register/options', {});
  assert.deepEqual(stale.json, inPlace.json, 'the same refusal as adding a passkey in place');
  assert.equal(app.sent.length, mark, 'no mail');
  assert.deepEqual(await addRows(app, owner.user.id), pending, 'no new token and the earlier one is untouched');
  assert.equal((await identityOf(owner.client)).id, owner.user.id, 'the stale session stays signed in');
  const anonymous = await browser(app).post(LINK, { email: owner.user.email });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.json, { error: 'unauthorized' });
  assert.equal(app.sent.length, mark);
  const again = await signIn(app, owner.device, owner.credentialId);
  assert.equal(again.verify.status, 200);
  await requestLink(app, again.client, owner.user.email);
});

test('a missing or foreign Origin is refused before any token or mail', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const mark = app.sent.length;
  for (const origin of [undefined, 'http://evil.example.test', app.baseUrl.replace('http:', 'https:'), 'null']) {
    const response = await owner.client.post(LINK, {}, { origin });
    assert.equal(response.status, 403, `origin ${origin}`);
    assert.match(response.json.error, /cross-origin/i);
  }
  assert.equal(app.sent.length, mark);
  assert.deepEqual(await addRows(app, owner.user.id), []);
  await requestLink(app, owner.client, owner.user.email);
});

test('redeeming the link in the requesting browser adds a passkey and keeps that session', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const original = owner.client.session();
  const sessionsBefore = await sessionCount(app, owner.user.id);
  const token = await requestLink(app, owner.client, owner.user.email);
  const mark = app.sent.length;
  const phone = createAuthenticator();
  const { options, verify } = await register(app, owner.client, phone, { token }, 'Synthetic phone');
  assert.equal(options.status, 200);
  assert.equal(options.json.options.user.name, owner.user.email);
  assert.ok(options.json.options.excludeCredentials.some(item => item.id === owner.credentialId));
  assert.equal(verify.status, 200, verify.text);
  assert.equal(verify.json.identity.id, owner.user.id);
  assert.ok(app.store.session(original), 'the original session row survives');
  assert.equal((await identityOf(browser(app, original))).id, owner.user.id, 'the original session cookie still authenticates');
  assert.equal((await identityOf(owner.client)).id, owner.user.id, 'the browser is still signed in');
  assert.ok(await sessionCount(app, owner.user.id) >= sessionsBefore, 'no session of the user is deleted');
  assert.deepEqual((await app.store.listPasskeys(owner.user.id)).map(item => item.name).sort(), ['First synthetic device', 'Synthetic phone']);
  assert.equal(app.store.token(token), null, 'the link is consumed');
  const sentNotices = notices(app, mark);
  assert.equal(sentNotices.length, 1);
  assert.equal(sentNotices[0].subject, ADDED);
  assert.deepEqual(recipients(sentNotices[0]), [owner.user.email]);
});

test('the passkey added notice stays link-free even when the passkey name contains a URL', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const name = 'Review https://example.test now';
  const token = await requestLink(app, owner.client, owner.user.email);
  const mark = app.sent.length;
  const { verify } = await register(app, owner.client, createAuthenticator(), { token }, name);
  assert.equal(verify.status, 200, verify.text);
  const sentNotices = notices(app, mark).filter(mail => mail.subject === ADDED);
  assert.equal(sentNotices.length, 1);
  const [notice] = sentNotices;
  for (const part of [notice.subject, notice.text, notice.html]) {
    assert.doesNotMatch(part, /http:\/\/|https:\/\/|href|example\.test\//i);
    assert.ok(!part.includes(name), 'the passkey name is not in the notice');
    assert.ok(!part.includes('Review'), 'no part of the passkey name is in the notice');
  }
  const listed = await owner.client.get('/api/auth/passkeys');
  assert.equal(listed.status, 200);
  assert.ok(JSON.stringify(listed.json).includes(name), 'the passkey is stored and listed under that name');
});

test('a fresh browser consumes the link, adds a second passkey without revoking anything, and both passkeys sign in', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test', 'admin');
  const admin = await enrolled(app, 'second-admin@example.test', 'admin');
  const elsewhere = await app.sessionFor(owner.user.email);
  const requester = owner.client.session();
  const token = await requestLink(app, owner.client, owner.user.email);
  const sessionsBefore = await sessionCount(app, owner.user.id);
  const mark = app.sent.length;
  const tablet = createAuthenticator();
  const fresh = browser(app);
  const { options, verify } = await register(app, fresh, tablet, { token }, 'Synthetic tablet');
  assert.equal(options.status, 200);
  assert.equal(options.json.options.user.id, (await app.store.userRow(owner.user.id)).user_handle);
  assert.equal(verify.status, 200, verify.text);
  assert.equal(verify.json.identity.id, owner.user.id);
  assert.ok(fresh.session(), 'the fresh browser gets a session cookie');
  assert.equal((await identityOf(fresh)).id, owner.user.id);
  const ids = await passkeyIds(app, owner.user.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(owner.credentialId), 'the first passkey stays');
  assert.ok(ids.includes(tablet.credentials()[0].id));
  assert.equal(app.store.session(requester)?.id, owner.user.id, 'the requesting session stays');
  assert.equal((await identityOf(owner.client)).id, owner.user.id);
  assert.equal((await identityOf(elsewhere)).id, owner.user.id, 'other sessions stay');
  assert.equal(await sessionCount(app, owner.user.id), sessionsBefore + 1);
  assert.equal(app.store.token(token), null, 'single use');
  const sentNotices = notices(app, mark);
  assert.equal(sentNotices.length, 1, 'one notice, to the user only (no admin copies)');
  assert.equal(sentNotices[0].subject, ADDED);
  assert.deepEqual(recipients(sentNotices[0]), [owner.user.email]);
  assert.ok(!recipients(sentNotices[0]).includes(admin.user.email));
  for (const [device, credentialId] of [[owner.device, owner.credentialId], [tablet, tablet.credentials()[0].id]]) {
    const { client, verify: signedIn } = await signIn(app, device, credentialId);
    assert.equal(signedIn.status, 200, signedIn.text);
    assert.equal(signedIn.json.identity.id, owner.user.id);
    assert.equal((await identityOf(client)).id, owner.user.id);
  }
});

test('a used link is refused at options and at verify, including a ceremony started before it was used', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const token = await requestLink(app, owner.client, owner.user.email);
  const early = browser(app);
  const earlyDevice = createAuthenticator();
  const started = await early.post('/api/auth/register/options', { token, name: 'Started early' });
  assert.equal(started.status, 200);
  const first = await register(app, browser(app), createAuthenticator(), { token }, 'First redemption');
  assert.equal(first.verify.status, 200);
  for (const client of [browser(app), owner.client]) {
    const replay = await client.post('/api/auth/register/options', { token, name: 'Replayed device' });
    assert.equal(replay.status, 410);
    assert.deepEqual(replay.json, EXPIRED);
  }
  const response = earlyDevice.createCredential(started.json.options, { origin: app.baseUrl });
  const late = await early.post('/api/auth/register/verify', { token, name: 'Started early', response });
  assert.equal(late.status, 410);
  assert.deepEqual(late.json, EXPIRED);
  assert.equal(early.session(), null, 'no session for the refused browser');
  assert.equal((await passkeyIds(app, owner.user.id)).length, 2);
});

test('the link expires after twenty minutes and works just before', async t => {
  const app = await fixture(t);
  const a = await enrolled(app, 'early@example.test');
  const b = await enrolled(app, 'late@example.test');
  const tokenA = await requestLink(app, a.client, a.user.email);
  const tokenB = await requestLink(app, b.client, b.user.email);
  app.advance(TTL - 1);
  const live = await register(app, browser(app), createAuthenticator(), { token: tokenA }, 'Just in time');
  assert.equal(live.options.status, 200);
  assert.equal(live.verify.status, 200, 'still valid just before twenty minutes');
  const pending = browser(app);
  const device = createAuthenticator();
  const started = await pending.post('/api/auth/register/options', { token: tokenB, name: 'Too late' });
  assert.equal(started.status, 200);
  app.advance(1);
  const response = device.createCredential(started.json.options, { origin: app.baseUrl });
  const verify = await pending.post('/api/auth/register/verify', { token: tokenB, name: 'Too late', response });
  assert.equal(verify.status, 410);
  assert.deepEqual(verify.json, EXPIRED);
  const options = await browser(app).post('/api/auth/register/options', { token: tokenB, name: 'Too late' });
  assert.equal(options.status, 410);
  assert.deepEqual(options.json, EXPIRED);
  assert.deepEqual(await passkeyIds(app, b.user.id), [b.credentialId]);
  assert.equal((await passkeyIds(app, a.user.id)).length, 2);
});

test('the link is bound to its user and never reaches another account or a pending user', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test', 'admin');
  const member = await enrolled(app, 'member@example.test');
  const memberSession = member.client.session();
  const ownerToken = await requestLink(app, owner.client, owner.user.email);
  const memberToken = await requestLink(app, member.client, member.user.email);
  assert.ok(app.store.token(ownerToken), "another user's link request leaves this link valid");
  assert.equal(app.store.token(memberToken).userId, member.user.id);

  const inPlace = await member.client.post('/api/auth/register/options', { name: 'Member in place' });
  assert.equal(inPlace.status, 200);
  assert.equal(inPlace.json.options.user.id, (await app.store.userRow(member.user.id)).user_handle, "a session add is for the session's user");
  assert.ok(app.store.token(ownerToken));

  const device = createAuthenticator();
  const { options, verify } = await register(app, member.client, device, { token: ownerToken }, 'Owner device in member browser');
  assert.equal(options.status, 200);
  assert.equal(options.json.options.user.id, (await app.store.userRow(owner.user.id)).user_handle, 'the token decides the account');
  assert.equal(verify.status, 200);
  assert.equal(verify.json.identity.id, owner.user.id);
  assert.equal((await passkeyIds(app, owner.user.id)).length, 2);
  assert.deepEqual(await passkeyIds(app, member.user.id), [member.credentialId], 'nothing is added to the browser user');
  assert.equal(app.store.session(memberSession)?.id, member.user.id, "the other user's session is not deleted");
  assert.equal((await identityOf(member.client)).id, owner.user.id, 'the redeeming browser is signed in as the token user');
  assert.ok(app.store.token(memberToken), "the other user's link is unaffected");

  const { user: pending, token: invite } = app.store.invite(app.hh, 'pending@example.test');
  const pendingAdd = await app.store.createToken(pending.id, 'add-passkey');
  const refused = await register(app, browser(app), createAuthenticator(), { token: pendingAdd.token }, 'Pending device');
  assert.equal(refused.options.status, 410);
  assert.deepEqual(refused.options.json, EXPIRED);
  assert.equal((await app.store.getUser(pending.id)).enrolledAt, null);
  assert.deepEqual(await passkeyIds(app, pending.id), []);
  assert.equal(await app.store.membership(pending.id, app.hh), null);
  assert.equal((await app.store.invitation(invite))?.userId, pending.id, 'the invitation stays live');
});

test('add-passkey tokens are independent of invitations and recovery tokens', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const recovery = await app.store.createToken(owner.user.id, 'recovery');
  const first = await requestLink(app, owner.client, owner.user.email);
  assert.equal(app.store.token(recovery.token)?.purpose, 'recovery', 'issuing add-passkey keeps recovery');
  const nextRecovery = await app.store.createToken(owner.user.id, 'recovery');
  assert.equal(app.store.token(recovery.token), null, 'recovery replaces only recovery');
  assert.equal(app.store.token(first)?.purpose, 'add-passkey', 'issuing recovery keeps add-passkey');
  const second = await requestLink(app, owner.client, owner.user.email);
  assert.notEqual(second, first);
  assert.equal(app.store.token(first), null, 'reissuing revokes the earlier add-passkey link');
  assert.equal(app.store.token(second)?.purpose, 'add-passkey');
  assert.equal(app.store.token(nextRecovery.token)?.purpose, 'recovery');
  assert.equal((await addRows(app, owner.user.id)).length, 1);
  const stale = await browser(app).post('/api/auth/register/options', { token: first, name: 'Old link' });
  assert.equal(stale.status, 410);

  const invited = app.store.invite(app.hh, 'pending@example.test');
  const pending = invited.user;
  const add = await app.store.createToken(pending.id, 'add-passkey');
  assert.equal((await app.store.invitation(invited.token))?.userId, pending.id);
  assert.equal(app.store.token(add.token)?.purpose, 'add-passkey');
  const reissued = app.store.invite(app.hh, 'pending@example.test');
  assert.equal(await app.store.invitation(invited.token), null);
  assert.ok(await app.store.invitation(reissued.token));
  assert.equal(app.store.token(add.token)?.purpose, 'add-passkey', 'reissuing an invitation keeps add-passkey');
  assert.equal(add.expiresAt, START + TTL);
});

test('completing recovery deletes the pending add-passkey link and any ceremony started with it', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test', 'admin');
  const elsewhere = await app.sessionFor(owner.user.email);
  const addToken = await requestLink(app, owner.client, owner.user.email);
  const stranded = browser(app);
  const strandedDevice = createAuthenticator();
  const started = await stranded.post('/api/auth/register/options', { token: addToken, name: 'Stranded device' });
  assert.equal(started.status, 200);

  const mark = app.sent.length;
  const asked = await browser(app).post('/api/auth/recover', { email: owner.user.email });
  assert.equal(asked.status, 200);
  let recoveryMail;
  for (let i = 0; i < 100 && !recoveryMail; i++) {
    recoveryMail = app.sent.slice(mark).find(mail => mail.subject === 'Your Fathom recovery link');
    if (!recoveryMail) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(recoveryMail, 'the recovery link was mailed');
  assert.deepEqual(recipients(recoveryMail), [owner.user.email]);
  const recoveryToken = /\/enroll#([A-Za-z0-9_-]{43})/.exec(recoveryMail.text)[1];
  assert.equal(app.store.token(recoveryToken)?.purpose, 'recovery');
  assert.ok(app.store.token(addToken), 'requesting recovery alone does not revoke the add-passkey link');

  const replacement = createAuthenticator();
  const recovered = await register(app, browser(app), replacement, { token: recoveryToken }, 'Recovered device');
  assert.equal(recovered.verify.status, 200, recovered.verify?.text);
  assert.deepEqual(await passkeyIds(app, owner.user.id), [replacement.credentials()[0].id], 'old passkeys are deleted');
  assert.equal((await identityOf(owner.client)), null, 'old sessions are deleted');
  assert.equal((await identityOf(elsewhere)), null);
  assert.equal(app.store.token(addToken), null, 'the pending add-passkey link is deleted');
  assert.deepEqual(await addRows(app, owner.user.id), []);
  const options = await browser(app).post('/api/auth/register/options', { token: addToken, name: 'After recovery' });
  assert.equal(options.status, 410);
  assert.deepEqual(options.json, EXPIRED);
  const response = strandedDevice.createCredential(started.json.options, { origin: app.baseUrl });
  const late = await stranded.post('/api/auth/register/verify', { token: addToken, name: 'Stranded device', response });
  assert.equal(late.status, 410);
  assert.deepEqual(await passkeyIds(app, owner.user.id), [replacement.credentials()[0].id]);
});

test('a failed send answers 503 and revokes the token it issued', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const earlier = await requestLink(app, owner.client, owner.user.email);
  app.state.fail = true;
  const mark = app.sent.length;
  const failed = await owner.client.post(LINK, {});
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.json, { error: 'authentication email unavailable' });
  assert.equal(app.sent.length, mark);
  assert.deepEqual(await addRows(app, owner.user.id), [], 'no add-passkey link survives the failure');
  assert.equal(app.store.token(earlier), null);
  app.state.fail = false;
  assert.equal((await identityOf(owner.client)).id, owner.user.id, 'the session is unaffected');
  await requestLink(app, owner.client, owner.user.email);
});

test('each user may request ten links per twenty minutes', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const member = await enrolled(app, 'member@example.test');
  let last;
  for (let i = 1; i <= 10; i++) {
    last = await requestLink(app, owner.client, owner.user.email);
    assert.ok(last, `request ${i} is allowed`);
  }
  const mark = app.sent.length;
  limited(await owner.client.post(LINK, {}));
  assert.equal(app.sent.length, mark, 'no mail when limited');
  assert.ok(app.store.token(last), 'the limited request leaves the last link valid');
  const another = await app.sessionFor(owner.user.email);
  limited(await another.post(LINK, {}));
  await requestLink(app, member.client, member.user.email);
  app.advance(TTL - 1);
  limited(await (await app.sessionFor(owner.user.email)).post(LINK, {}));
  app.advance(1);
  await requestLink(app, await app.sessionFor(owner.user.email), owner.user.email);
});

test('signing out deletes that person\'s pending add-a-device link', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const token = await requestLink(app, owner.client, owner.user.email);
  const started = await browser(app).post('/api/auth/register/options', { token, name: 'Other device' });
  assert.equal(started.status, 200);
  const signedOut = await owner.client.post('/api/auth/signout', {});
  assert.equal(signedOut.status, 200);
  assert.equal(app.store.token(token), null);
  const refused = await browser(app).post('/api/auth/register/options', { token, name: 'After sign-out' });
  assert.equal(refused.status, 410);
  assert.deepEqual(refused.json, EXPIRED);
});

test('removing a passkey deletes that person\'s pending add-a-device link', async t => {
  const app = await fixture(t);
  const owner = await enrolled(app, 'owner@example.test');
  const token = await requestLink(app, owner.client, owner.user.email);
  const revoked = await owner.client.post(`/api/auth/passkeys/${encodeURIComponent(owner.credentialId)}/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.equal(app.store.token(token), null);
  const refused = await browser(app).post('/api/auth/register/options', { token, name: 'After revoke' });
  assert.equal(refused.status, 410);
  assert.deepEqual(refused.json, EXPIRED);
});

// The auth store over the platform DB (createAuthStore(platform)): users, household memberships,
// invitations, tokens, sessions and passkeys. Each fixture is a fresh synthetic instance built by
// createInstance, so the served household exists and fathom.sqlite holds no account rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { openDb, migrate, listMigrations, listTables } from '../src/store/db.mjs';
import { createAuthStore } from '../src/auth/store.mjs';
import { tempInstance } from './helpers/server.mjs';

const START = Date.parse('2032-03-10T12:00:00Z');
const TOKEN_TTL = 20 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const status = expected => err => err.status === expected && typeof err.message === 'string';

async function fixture(t) {
  const instance = await tempInstance({ mode: 'real' });
  t.after(() => { instance.close(); rmSync(instance.dataDir, { recursive: true, force: true }); });
  const { db, platform } = instance;
  let clock = START;
  const now = () => clock;
  const store = createAuthStore(platform, { now });
  const household = store.servedHousehold();
  const hh = household.id;
  const invite = async (email, role = 'member') => store.invite(hh, email, { role });
  const enroll = async (email, role = 'member') => {
    const { user, token } = await invite(email, role);
    store.consumeInvitation(token, user.id);
    await store.markEnrolled(user.id);
    return store.getUser(user.id);
  };
  const roleOf = userId => store.membership(userId, hh)?.role ?? null;
  return { db, platform, store, household, hh, now, invite, enroll, roleOf, advance: ms => { clock += ms; } };
}

async function passkey(platform, userId, id) {
  await platform.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, Buffer.from('synthetic public key bytes'), 0, JSON.stringify(['internal']), 'Synthetic passkey', START);
}

// Was "household is a singleton": the singleton households row (id 1) in fathom.sqlite is now one
// served household in platform.sqlite with an opaque id, and the store only names it.
test('the served household is a single opaque platform row and creating it populates no financial table', async t => {
  const { db, platform, household, hh } = await fixture(t);
  assert.equal(typeof hh, 'string');
  assert.ok(hh.length > 0);
  assert.deepEqual({ mode: household.mode, status: household.status }, { mode: 'real', status: 'active' });
  assert.equal((await platform.prepare('SELECT count(*) AS n FROM households').get()).n, 1);
  const served = { ...await platform.prepare('SELECT * FROM households WHERE id = ?').get(hh) };
  const duplicate = { ...served, id: `${hh}-duplicate` };
  const columns = Object.keys(duplicate);
  assert.throws(async () => await platform.prepare(`INSERT INTO households (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(duplicate)),
    'a second household cannot also be served by the singleton store');
  for (const table of ['facts', 'files', 'accounts', 'transactions', 'recs']) {
    assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n, 0, table);
  }
  const financial = await listTables(db);
  for (const table of ['households', 'users', 'passkeys', 'auth_tokens', 'auth_sessions', 'auth_challenges', 'auth_rate_limits']) {
    assert.ok(!financial.includes(table), `fathom.sqlite has no ${table}`);
  }
  assert.equal((await db.prepare('SELECT household_id FROM store_identity').get()).household_id, hh);
});

test('invitations canonicalize the entire ASCII address, preserve plus tags and reissue pending roles', async t => {
  const { store, hh, invite } = await fixture(t);
  const first = invite('  Owner+One@EXAMPLE.TEST  ', 'admin');
  assert.equal(first.user.email, 'owner+one@example.test');
  assert.equal(first.user.enrolledAt, null);
  assert.deepEqual(await store.invitation(first.token),
    { householdId: hh, email: 'owner+one@example.test', role: 'admin', userId: first.user.id, expiresAt: first.expiresAt });
  assert.equal((await store.findUser(' OWNER+ONE@example.test ')).id, first.user.id);
  const member = invite('owner+one@example.test', 'member');
  assert.equal(member.user.id, first.user.id);
  assert.equal((await store.invitation(member.token)).role, 'member');
  assert.equal(await store.invitation(first.token), null, 'a reissue revokes the earlier link');
  const admin = invite('owner+one@example.test', 'admin');
  assert.equal((await store.invitation(admin.token)).role, 'admin');
  assert.notEqual(invite('owner@example.test', 'member').user.id, first.user.id);
  assert.equal((await store.listPeople(hh)).length, 2);
  assert.equal(store.membership(first.user.id, hh), null, 'a pending invitee has no membership yet');
  assert.equal(store.getUser('missing'), null);
  assert.equal(await store.findUser('absent@example.test'), null);
});

test('pending reinvites change either role without replacing the user or WebAuthn handle', async t => {
  const { platform, store, invite } = await fixture(t);
  for (const [initial, replacement] of [['admin', 'member'], ['member', 'admin']]) {
    const { user } = invite(`${initial}@example.test`, initial);
    const before = { ...await platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
    const reissued = invite(` ${initial.toUpperCase()}@EXAMPLE.TEST `, replacement);
    assert.equal(reissued.user.id, user.id);
    assert.equal((await store.invitation(reissued.token)).role, replacement);
    assert.deepEqual({ ...await platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) }, before, 'the role lives on the invitation; the user row is unchanged');
  }
});

// Was "enrolled reinvites": an enrolled user is now an active member, and inviting an active member
// is the same 409 pointing at the role change action (plan Approach 3).
test('reinviting an active member directs callers to role changes without changing users, memberships, tokens or sessions', async t => {
  const { platform, store, hh, enroll, roleOf } = await fixture(t);
  for (const initial of ['admin', 'member']) {
    const user = enroll(`${initial}@example.test`, initial);
    const recovery = store.createToken(user.id, 'recovery');
    const add = store.createToken(user.id, 'add-passkey');
    const session = store.createSession(user.id);
    const before = { ...await platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
    const membership = store.membership(user.id, hh);
    const tokens = await platform.prepare('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY hash').all(user.id);
    const invitations = await platform.prepare('SELECT * FROM household_invitations ORDER BY hash').all();
    for (const role of ['admin', 'member']) {
      assert.throws(async () => store.invite(hh, user.email, { role }), err => {
        assert.equal(err.status, 409);
        assert.match(err.message, /role/i);
        assert.match(err.message, /chang|\/role/i);
        return true;
      });
      assert.deepEqual({ ...await platform.prepare('SELECT * FROM users WHERE id = ?').get(user.id) }, before);
      assert.deepEqual(store.membership(user.id, hh), membership);
      assert.deepEqual(await platform.prepare('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY hash').all(user.id), tokens);
      assert.deepEqual(await platform.prepare('SELECT * FROM household_invitations ORDER BY hash').all(), invitations);
      assert.ok(store.token(recovery.token));
      assert.ok(store.token(add.token));
      assert.equal(store.session(session.token).id, user.id);
      assert.equal(roleOf(user.id), initial);
    }
  }
});

test('invalid email and roles are refused while safe local characters and DNS labels work', async t => {
  const { store, hh } = await fixture(t);
  for (const email of ['', 'a@@example.test', 'a@', '@example.test', 'a,b@example.test', 'a@example.test,b@example.test',
    '"a"@example.test', 'a(comment)@example.test', 'a b@example.test', 'a\n@example.test', 'é@example.test',
    'a@exämple.test', 'a@-example.test', 'a@example-.test', 'a@example..test', 'a@exam_ple.test',
    `${'a'.repeat(65)}@example.test`, `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.test`]) {
    assert.throws(async () => store.invite(hh, email, { role: 'member' }), status(400), JSON.stringify(email));
  }
  assert.throws(async () => store.invite(hh, 'valid@example.test', { role: 'root' }), status(400));
  assert.equal(await store.findUser('valid@example.test'), null, 'a refused role creates no user');
  assert.equal(store.invite(hh, "a.b+tag_o'hara@sub-1.example.test", { role: 'member' }).user.email, "a.b+tag_o'hara@sub-1.example.test");
});

test('users have stable distinct random handles and public metadata contains no handle', async t => {
  const { platform, store, hh, invite, enroll } = await fixture(t);
  const a = invite('a@example.test', 'admin').user;
  const b = invite('b@example.test', 'member').user;
  enroll('c@example.test', 'member');
  const handle = async id => (await platform.prepare('SELECT user_handle FROM users WHERE id = ?').get(id)).user_handle;
  assert.ok(await handle(a.id));
  assert.notDeepEqual(await handle(a.id), await handle(b.id));
  const before = await handle(a.id);
  const again = invite('A@example.test', 'member');
  assert.equal(again.user.id, a.id);
  assert.deepEqual(await handle(a.id), before);
  const people = await store.listPeople(hh);
  assert.equal(people.length, 3);
  for (const user of [...people, again.user, store.getUser(a.id)]) {
    for (const key of ['user_handle', 'userHandle', 'public_key', 'token']) assert.equal(key in user, false, key);
  }
});

// Was one test over the 'invite' token purpose: invite links are household invitations now, so the
// token rules are asserted for both auth tokens (recovery) and invitations (contradiction 2: 20 min).
test('tokens contain 32 random bytes, persist only a digest, expire at 20 minutes and consume once', async t => {
  const { platform, store, enroll, advance } = await fixture(t);
  const user = enroll('enrolled@example.test');
  const issued = store.createToken(user.id, 'recovery');
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, START + TOKEN_TTL);
  const stored = JSON.stringify(await platform.prepare('SELECT * FROM auth_tokens').all());
  assert.ok(!stored.includes(issued.token));
  assert.ok(stored.includes(digest(issued.token)));
  const expected = { userId: user.id, purpose: 'recovery', expiresAt: issued.expiresAt };
  assert.deepEqual(store.token(issued.token), expected);
  assert.deepEqual(store.consumeToken(issued.token), expected);
  assert.equal(store.consumeToken(issued.token), null);
  assert.equal(store.token(issued.token), null);
  const later = store.createToken(user.id, 'recovery');
  advance(TOKEN_TTL - 1);
  assert.ok(store.token(later.token));
  advance(1);
  assert.equal(store.token(later.token), null);
  assert.equal(store.consumeToken(later.token), null);
  assert.throws(() => store.createToken(user.id, 'invite'), status(400), 'invite is no longer an auth token purpose');
});

test('invitations contain 32 random bytes, persist only a digest, expire at 20 minutes and consume once', async t => {
  const { platform, store, hh, invite, advance } = await fixture(t);
  const issued = invite('pending@example.test');
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, START + TOKEN_TTL);
  const stored = JSON.stringify(await platform.prepare('SELECT * FROM household_invitations').all());
  assert.ok(!stored.includes(issued.token));
  assert.ok(stored.includes(digest(issued.token)));
  assert.equal((await platform.prepare('SELECT count(*) AS n FROM auth_tokens').get()).n, 0, 'an invitation is not an auth token');
  assert.deepEqual(await store.invitation(issued.token),
    { householdId: hh, email: 'pending@example.test', role: 'member', userId: issued.user.id, expiresAt: issued.expiresAt });
  store.consumeInvitation(issued.token, issued.user.id);
  assert.deepEqual({ role: store.membership(issued.user.id, hh).role, status: store.membership(issued.user.id, hh).status }, { role: 'member', status: 'active' });
  assert.equal(await store.invitation(issued.token), null);
  assert.throws(() => store.consumeInvitation(issued.token, issued.user.id), status(410), 'a consumed invitation is single use');
  const other = invite('later@example.test');
  advance(TOKEN_TTL - 1);
  assert.ok(await store.invitation(other.token));
  advance(1);
  assert.equal(await store.invitation(other.token), null);
  assert.throws(() => store.consumeInvitation(other.token, other.user.id), status(410));
  assert.equal(store.membership(other.user.id, hh), null, 'an expired invitation creates no membership');
});

test('reissue invalidates every prior same-purpose token and leaves the other purpose live', async t => {
  const { store, enroll } = await fixture(t);
  const user = enroll('enrolled@example.test');
  const first = store.createToken(user.id, 'add-passkey');
  const recovery = store.createToken(user.id, 'recovery');
  const second = store.createToken(user.id, 'add-passkey');
  assert.notEqual(first.token, second.token);
  assert.equal(store.token(first.token), null);
  assert.ok(store.token(second.token));
  assert.ok(store.token(recovery.token));
  const nextRecovery = store.createToken(user.id, 'recovery');
  assert.equal(store.token(recovery.token), null);
  assert.ok(store.token(nextRecovery.token));
  assert.ok(store.token(second.token));
});

test('malformed bearer input never resolves while a valid token, invitation and session still resolve', async t => {
  const { store, enroll, invite } = await fixture(t);
  const user = enroll('session@example.test');
  const token = store.createToken(user.id, 'recovery');
  const invited = invite('pending@example.test');
  const session = store.createSession(user.id);
  for (const raw of [undefined, null, {}, [], '', 'a', 'A'.repeat(42), 'A'.repeat(44), ' '.repeat(43),
    token.token + '=', '\n' + token.token, invited.token + '=', randomBytes(32).toString('base64url')]) {
    assert.equal(store.token(raw), null);
    assert.equal(store.consumeToken(raw), null);
    assert.equal(await store.invitation(raw), null);
    assert.equal(store.session(raw), null);
  }
  assert.ok(store.token(token.token));
  assert.ok(await store.invitation(invited.token));
  assert.equal(store.session(session.token).id, user.id);
});

test('sessions require enrollment, store only a digest and use seven-day absolute expiry', async t => {
  const { platform, store, enroll, invite, advance } = await fixture(t);
  const pending = invite('pending@example.test').user;
  assert.throws(() => store.createSession(pending.id));
  const user = enroll('active@example.test');
  const session = store.createSession(user.id);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.expiresAt, START + SESSION_TTL);
  const stored = JSON.stringify(await platform.prepare('SELECT * FROM auth_sessions').all());
  assert.ok(!stored.includes(session.token));
  assert.ok(stored.includes(digest(session.token)));
  advance(SESSION_TTL - 1);
  assert.equal(store.session(session.token).id, user.id);
  advance(1);
  assert.equal(store.session(session.token), null);
});

// The merged test compared store.session() to the user projection; the contract leaves the session
// projection open (it may carry the session household), so the same intent is checked by value:
// the session resolves to the user and exposes no sign-in time.
test('sessions record their actual creation wall time without exposing it as user metadata', async t => {
  const { platform, store, enroll, now, advance } = await fixture(t);
  const column = (await platform.prepare('PRAGMA table_info(auth_sessions)').all()).find(row => row.name === 'signed_in_at');
  assert.ok(column, 'auth_sessions has a signed_in_at column');
  assert.equal(column.type.toUpperCase(), 'INTEGER');
  assert.equal(column.notnull, 1);
  const user = enroll('wall-clock@example.test');
  advance(2 * 60 * 60 * 1000 + 123);
  const firstAt = now();
  const first = store.createSession(user.id);
  advance(599_999);
  const secondAt = now();
  const second = store.createSession(user.id);
  const row = async token => await platform.prepare('SELECT signed_in_at, expires_at FROM auth_sessions WHERE hash = ?').get(digest(token));
  assert.deepEqual({ ...await row(first.token) }, { signed_in_at: firstAt, expires_at: firstAt + SESSION_TTL });
  assert.deepEqual({ ...await row(second.token) }, { signed_in_at: secondAt, expires_at: secondAt + SESSION_TTL });
  assert.notEqual(firstAt, user.enrolledAt);
  for (const [token, at] of [[first.token, firstAt], [second.token, secondAt]]) {
    const resolved = store.session(token);
    assert.equal(resolved.id, user.id);
    assert.equal(resolved.email, user.email);
    for (const key of ['signedInAt', 'signed_in_at']) assert.equal(key in resolved, false, key);
    assert.ok(!Object.values(resolved).includes(at), 'the sign-in time is not part of the projection');
  }
  assert.deepEqual(store.getUser(user.id), user);
});

test('revoking one session preserves another and revoking user sessions preserves other users', async t => {
  const { store, enroll } = await fixture(t);
  const a = enroll('a@example.test');
  const b = enroll('b@example.test');
  const first = store.createSession(a.id);
  const second = store.createSession(a.id);
  const other = store.createSession(b.id);
  store.revokeSession(first.token);
  assert.equal(store.session(first.token), null);
  assert.ok(store.session(second.token));
  store.revokeUserSessions(a.id);
  assert.equal(store.session(second.token), null);
  assert.equal(store.session(other.token).id, b.id);
});

// Contradiction 3: removal removes the membership; the account goes only when nothing else holds it.
test('pending admins do not defeat the last enrolled admin removal and demotion guard', async t => {
  const { store, hh, enroll, invite, roleOf } = await fixture(t);
  const admin = enroll('admin@example.test', 'admin');
  invite('pending-admin@example.test', 'admin');
  assert.throws(() => store.setRole(hh, admin.id, 'member'), status(409));
  assert.throws(() => store.removeMember(hh, admin.id), status(409));
  assert.equal(roleOf(admin.id), 'admin');
  const replacement = enroll('replacement@example.test', 'admin');
  store.setRole(hh, admin.id, 'member');
  assert.equal(roleOf(admin.id), 'member');
  store.removeMember(hh, admin.id);
  assert.equal(store.getUser(admin.id), null, 'no other membership or operator grant holds the account');
  assert.equal(store.membership(admin.id, hh), null);
  assert.equal(roleOf(replacement.id), 'admin');
});

// Contradiction 5: the last-admin guard counts active enrolled admins of this household only.
test('an enrolled admin of another household does not satisfy this household last-admin guard', async t => {
  const { store, hh, enroll, roleOf } = await fixture(t);
  const admin = enroll('admin@example.test', 'admin');
  store.grantOperator(admin.id);
  await store.setPlatformSetting('multi_household_enabled', true);
  const provisioned = store.provisionHousehold({ displayName: 'Synthetic second household', adminEmail: 'other-admin@example.test' }, { actorId: admin.id });
  assert.equal(provisioned.household.status, 'provisioning');
  assert.notEqual(provisioned.household.id, hh);
  const pending = await store.invitation(provisioned.token);
  assert.equal(pending.householdId, provisioned.household.id);
  assert.equal(pending.role, 'admin');
  store.consumeInvitation(provisioned.token, pending.userId);
  await store.markEnrolled(pending.userId);
  assert.equal(store.membership(pending.userId, provisioned.household.id).role, 'admin');
  assert.equal(store.membership(pending.userId, hh), null);
  assert.throws(() => store.setRole(hh, admin.id, 'member'), status(409));
  assert.throws(() => store.removeMember(hh, admin.id), status(409));
  assert.throws(() => store.setRole(provisioned.household.id, pending.userId, 'member'), status(409));
  assert.equal(roleOf(admin.id), 'admin');
});

test('role changes bump the membership version and a second enrolled admin permits removal', async t => {
  const { store, hh, enroll, roleOf } = await fixture(t);
  const a = enroll('a@example.test', 'admin');
  const b = enroll('b@example.test', 'admin');
  const live = store.createSession(a.id);
  assert.throws(() => store.setRole(hh, a.id, 'root'), status(400));
  assert.equal(roleOf(a.id), 'admin');
  const v0 = store.membership(a.id, hh).version;
  store.setRole(hh, a.id, 'member');
  assert.equal(roleOf(a.id), 'member');
  assert.ok(store.membership(a.id, hh).version > v0, 'a role change bumps the membership version');
  assert.equal(store.session(live.token).id, a.id, 'a role change keeps the session; the role is read per request');
  store.setRole(hh, a.id, 'admin');
  assert.equal(roleOf(a.id), 'admin');
  store.removeMember(hh, b.id);
  assert.throws(() => store.setRole(hh, a.id, 'member'), status(409));
  assert.throws(() => store.setRole(hh, 'missing-user', 'admin'), status(404));
});

test('passkey metadata hides material and revoking any credential invalidates every user session', async t => {
  const { platform, store, enroll } = await fixture(t);
  const a = enroll('a@example.test');
  const b = enroll('b@example.test');
  await passkey(platform, a.id, 'credential-a');
  await passkey(platform, a.id, 'credential-a2');
  await passkey(platform, b.id, 'credential-b');
  assert.deepEqual((await store.listPasskeys(a.id)).find(x => x.id === 'credential-a'), {
    id: 'credential-a', name: 'Synthetic passkey', createdAt: START, transports: ['internal'],
  });
  const first = store.createSession(a.id);
  const second = store.createSession(a.id);
  const other = store.createSession(b.id);
  assert.equal(store.revokePasskey(a.id, 'credential-b'), false);
  assert.ok(store.session(first.token));
  assert.equal(store.revokePasskey(a.id, 'credential-a'), true);
  assert.equal(store.session(first.token), null);
  assert.equal(store.session(second.token), null);
  assert.equal(store.session(other.token).id, b.id);
  assert.equal(store.revokePasskey(a.id, 'credential-a2'), true, 'final credential can be revoked');
  assert.deepEqual(await store.listPasskeys(a.id), []);
  assert.deepEqual((await store.listPasskeys(b.id)).map(x => x.id), ['credential-b']);
});

test('removal cascades tokens, credentials and sessions while unrelated users remain live', async t => {
  const { platform, store, hh, enroll } = await fixture(t);
  const a = enroll('remove@example.test');
  const b = enroll('keep@example.test', 'admin');
  await passkey(platform, a.id, 'remove-key');
  const token = store.createToken(a.id, 'recovery');
  const session = store.createSession(a.id);
  const kept = store.createSession(b.id);
  store.removeMember(hh, a.id);
  assert.equal(store.token(token.token), null);
  assert.equal(store.consumeToken(token.token), null);
  assert.equal(store.session(session.token), null);
  assert.deepEqual(await store.listPasskeys(a.id), []);
  assert.equal(store.getUser(a.id), null);
  assert.equal(store.session(kept.token).id, b.id);
  assert.ok(!(await store.listPeople(hh)).some(person => person.id === a.id));
});

// Contradiction 3: a removed member who keeps an operator grant keeps the account and its passkeys;
// the membership is marked removed and the sessions and issued invitations go.
test('removing a member who is also an operator removes only the membership and revokes sessions and issued invitations', async t => {
  const { platform, store, hh, enroll, advance } = await fixture(t);
  enroll('keep@example.test', 'admin');
  const operator = enroll('operator@example.test', 'admin');
  store.grantOperator(operator.id);
  await passkey(platform, operator.id, 'operator-key');
  const session = store.createSession(operator.id);
  const issued = store.invite(hh, 'invited-by-operator@example.test', { role: 'member', inviterId: operator.id });
  const before = store.membership(operator.id, hh);
  advance(1);
  store.removeMember(hh, operator.id);
  const after = store.membership(operator.id, hh);
  assert.equal(after.status, 'removed');
  assert.ok(after.version > before.version, 'removal bumps the membership version');
  assert.ok(store.getUser(operator.id), 'the operator account remains');
  assert.ok(store.isOperator(operator.id));
  assert.deepEqual((await store.listPasskeys(operator.id)).map(item => item.id), ['operator-key']);
  assert.equal(store.session(session.token), null, 'the removed member is signed out');
  assert.equal(await store.invitation(issued.token), null, 'invitations the removed member issued in this household are revoked');
  assert.deepEqual(await store.activeMemberships(operator.id), []);
  assert.ok(!(await store.listPeople(hh)).some(person => person.id === operator.id));
});

test('the accounts migration preserves existing MCP bearers as ownerless and is repeatable', async t => {
  const db = await openDb(':memory:');
  t.after(async () => await db.close());
  const accounts = listMigrations().find(migration => /accounts/.test(migration.name));
  assert.ok(accounts, 'accounts migration is registered');
  await db.applySchema('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of listMigrations().filter(migration => migration.id < accounts.id)) {
    await db.applySchema(readFileSync(migration.file, 'utf8'));
    await db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(migration.id, migration.name, '2032-03-10T12:00:00.000Z');
  }
  await db.prepare('INSERT INTO api_keys (id, name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-key', 'Existing synthetic household key', 'a'.repeat(64), '["read"]', '2032-03-10T12:00:00.000Z');
  const before = { ...await db.prepare('SELECT * FROM api_keys WHERE id = ?').get('legacy-key') };
  // Through 022: a store with no users passes the platform-identity guard and keeps api_keys rows.
  // MT-03 store migration 025 moves keys to the platform and refuses while the store still holds
  // any, so the store side stops before it (the offline tenancy migration moves the rows first).
  const dropped = listMigrations().find(migration => /platform-api-keys/.test(migration.name));
  assert.ok(dropped, 'the platform api_keys migration is registered');
  await migrate(db, { through: dropped.id - 1 });
  const after = { ...await db.prepare('SELECT * FROM api_keys WHERE id = ?').get('legacy-key') };
  assert.deepEqual(after, { ...before, user_id: null });
  assert.deepEqual((await migrate(db, { through: dropped.id - 1 })).applied, []);
  assert.throws(async () => await migrate(db), /CHECK constraint failed/, '025 refuses while the store holds a key row');
  assert.deepEqual({ ...await db.prepare('SELECT * FROM api_keys WHERE id = ?').get('legacy-key') }, after, 'the refused migration changed nothing');
  await db.prepare('DELETE FROM api_keys').run();
  await migrate(db);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get()).n, 0, 'an emptied store drops its api_keys');
  assert.deepEqual((await migrate(db)).applied, []);
});

// The tour flag (users.tour_pending) is set when a user finishes onboarding. The first person to join a
// household founds it and onboards; everyone who joins after another member never does, so accepting
// the invitation starts their tour.
test('accepting an invitation into a household that already has a member sets the tour flag; the founder\'s comes from onboarding', async t => {
  const f = await fixture(t);
  const pending = async userId => (await f.platform.prepare('SELECT tour_pending AS p FROM users WHERE id = ?').get(userId)).p;
  assert.equal((await f.platform.prepare("SELECT count(*) AS n FROM household_memberships WHERE household_id = ? AND status = 'active'").get(f.hh)).n, 0, 'precondition: nobody has joined yet');

  const admin = f.invite('first-admin@example.test', 'admin');
  f.store.consumeInvitation(admin.token, admin.user.id);
  assert.equal(await pending(admin.user.id), 0, 'the founder is flagged by finishing onboarding, not by joining');

  const member = f.invite('invited-member@example.test', 'member');
  assert.equal(await pending(member.user.id), 0, 'an invitation alone flags nobody');
  f.store.consumeInvitation(member.token, member.user.id);
  assert.equal(await pending(member.user.id), 1, 'the member joined a household that already had one, so the tour starts');

  const second = f.invite('second-admin@example.test', 'admin');
  f.store.consumeInvitation(second.token, second.user.id);
  assert.equal(await pending(second.user.id), 1, 'any role that joins after another member gets the tour');
  assert.equal(await pending(admin.user.id), 0, 'nobody else is touched');
});

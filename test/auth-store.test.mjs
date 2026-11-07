import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb, migrate, listMigrations } from '../src/store/db.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

const START = Date.parse('2032-03-10T12:00:00Z');
const TOKEN_TTL = 20 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const status = expected => err => err.status === expected && typeof err.message === 'string';

function fixture(t) {
  const db = openDb(':memory:');
  migrate(db);
  t.after(() => db.close());
  let clock = START;
  const now = () => clock;
  const store = createAuthStore(db, { now });
  const enroll = (email, role = 'member') => {
    const user = store.inviteUser(email, { role });
    db.prepare('UPDATE users SET enrolled_at = ? WHERE id = ?').run(now(), user.id);
    return store.getUser(user.id);
  };
  return { db, store, now, enroll, advance: ms => { clock += ms; } };
}

function passkey(db, userId, id) {
  db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, Buffer.from('synthetic public key bytes'), 0, JSON.stringify(['internal']), 'Synthetic passkey', START);
}

test('household is a singleton and creating it does not populate financial tables', t => {
  const { db, store } = fixture(t);
  assert.deepEqual(store.ensureHousehold(), { id: 1 });
  assert.deepEqual(store.ensureHousehold(), { id: 1 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM households').get().n, 1);
  const duplicate = { ...db.prepare('SELECT * FROM households WHERE id = 1').get(), id: 2 };
  const columns = Object.keys(duplicate);
  assert.throws(() => db.prepare(`INSERT INTO households (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(duplicate)));
  for (const table of ['facts', 'files', 'accounts', 'transactions', 'recs']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

test('invitations canonicalize the entire ASCII address, preserve plus tags and update pending roles', t => {
  const { store } = fixture(t);
  const user = store.inviteUser('  Owner+One@EXAMPLE.TEST  ', { role: 'admin' });
  assert.equal(user.email, 'owner+one@example.test');
  assert.equal(user.enrolledAt, null);
  assert.equal(user.role, 'admin');
  assert.equal(store.findUser(' OWNER+ONE@example.test ').id, user.id);
  assert.equal(store.inviteUser('owner+one@example.test', { role: 'member' }).role, 'member');
  assert.equal(store.inviteUser('owner+one@example.test', { role: 'admin' }).role, 'admin');
  assert.notEqual(store.inviteUser('owner@example.test', { role: 'member' }).id, user.id);
  assert.equal(store.listUsers().length, 2);
  assert.equal(store.getUser('missing'), null);
  assert.equal(store.findUser('absent@example.test'), null);
});

test('pending reinvites change either role without replacing the user or WebAuthn handle', t => {
  const { db, store } = fixture(t);
  for (const [initial, replacement] of [['admin', 'member'], ['member', 'admin']]) {
    const user = store.inviteUser(`${initial}@example.test`, { role: initial });
    const before = { ...db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
    const reissued = store.inviteUser(` ${initial.toUpperCase()}@EXAMPLE.TEST `, { role: replacement });
    assert.equal(reissued.id, user.id);
    assert.equal(reissued.role, replacement);
    assert.deepEqual({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) }, { ...before, role: replacement });
  }
});

test('enrolled reinvites direct callers to role changes without changing users, tokens or sessions', t => {
  const { db, store, enroll } = fixture(t);
  for (const initial of ['admin', 'member']) {
    const user = enroll(`${initial}@example.test`, initial);
    const invite = store.createToken(user.id, 'invite');
    const recovery = store.createToken(user.id, 'recovery');
    const session = store.createSession(user.id);
    const before = { ...db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
    const tokens = db.prepare('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY hash').all(user.id);
    for (const role of ['admin', 'member']) {
      assert.throws(() => store.inviteUser(user.email, { role }), err => {
        assert.equal(err.status, 409);
        assert.match(err.message, /role/i);
        assert.match(err.message, /chang|\/role/i);
        return true;
      });
      assert.deepEqual({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) }, before);
      assert.deepEqual(db.prepare('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY hash').all(user.id), tokens);
      assert.ok(store.token(invite.token));
      assert.ok(store.token(recovery.token));
      assert.equal(store.session(session.token).role, initial);
    }
  }
});

test('invalid email and roles are refused while safe local characters and DNS labels work', t => {
  const { store } = fixture(t);
  for (const email of ['', 'a@@example.test', 'a@', '@example.test', 'a,b@example.test', 'a@example.test,b@example.test',
    '"a"@example.test', 'a(comment)@example.test', 'a b@example.test', 'a\n@example.test', 'é@example.test',
    'a@exämple.test', 'a@-example.test', 'a@example-.test', 'a@example..test', 'a@exam_ple.test',
    `${'a'.repeat(65)}@example.test`, `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.test`]) {
    assert.throws(() => store.inviteUser(email, { role: 'member' }), status(400), JSON.stringify(email));
  }
  assert.throws(() => store.inviteUser('valid@example.test', { role: 'root' }), status(400));
  assert.equal(store.inviteUser("a.b+tag_o'hara@sub-1.example.test", { role: 'member' }).email, "a.b+tag_o'hara@sub-1.example.test");
});

test('users have stable distinct random handles and public metadata contains no handle', t => {
  const { db, store } = fixture(t);
  const a = store.inviteUser('a@example.test', { role: 'admin' });
  const b = store.inviteUser('b@example.test', { role: 'member' });
  const handle = id => db.prepare('SELECT user_handle FROM users WHERE id = ?').get(id).user_handle;
  assert.ok(handle(a.id));
  assert.notDeepEqual(handle(a.id), handle(b.id));
  const before = handle(a.id);
  assert.equal(store.inviteUser('A@example.test', { role: 'member' }).id, a.id);
  assert.deepEqual(handle(a.id), before);
  for (const user of store.listUsers()) {
    for (const key of ['user_handle', 'userHandle', 'public_key', 'token']) assert.equal(key in user, false, key);
  }
});

test('tokens contain 32 random bytes, persist only a digest, expire at 20 minutes and consume once', t => {
  const { db, store, advance } = fixture(t);
  const user = store.inviteUser('pending@example.test', { role: 'member' });
  const issued = store.createToken(user.id, 'invite');
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, START + TOKEN_TTL);
  const stored = JSON.stringify(db.prepare('SELECT * FROM auth_tokens').all());
  assert.ok(!stored.includes(issued.token));
  assert.ok(stored.includes(digest(issued.token)));
  const expected = { userId: user.id, purpose: 'invite', expiresAt: issued.expiresAt };
  assert.deepEqual(store.token(issued.token), expected);
  assert.deepEqual(store.consumeToken(issued.token), expected);
  assert.equal(store.consumeToken(issued.token), null);
  assert.equal(store.token(issued.token), null);
  const later = store.createToken(user.id, 'invite');
  advance(TOKEN_TTL - 1);
  assert.ok(store.token(later.token));
  advance(1);
  assert.equal(store.token(later.token), null);
  assert.equal(store.consumeToken(later.token), null);
});

test('reissue invalidates every prior same-purpose token and leaves the other purpose live', t => {
  const { store, enroll } = fixture(t);
  const user = enroll('enrolled@example.test');
  const first = store.createToken(user.id, 'invite');
  const recovery = store.createToken(user.id, 'recovery');
  const second = store.createToken(user.id, 'invite');
  assert.notEqual(first.token, second.token);
  assert.equal(store.token(first.token), null);
  assert.ok(store.token(second.token));
  assert.ok(store.token(recovery.token));
  const nextRecovery = store.createToken(user.id, 'recovery');
  assert.equal(store.token(recovery.token), null);
  assert.ok(store.token(nextRecovery.token));
  assert.ok(store.token(second.token));
});

test('malformed bearer input never resolves while a valid token and session still resolve', t => {
  const { store, enroll } = fixture(t);
  const user = enroll('session@example.test');
  const token = store.createToken(user.id, 'recovery');
  const session = store.createSession(user.id);
  for (const raw of [undefined, null, {}, [], '', 'a', 'A'.repeat(42), 'A'.repeat(44), ' '.repeat(43),
    token.token + '=', '\n' + token.token, randomBytes(32).toString('base64url')]) {
    assert.equal(store.token(raw), null);
    assert.equal(store.consumeToken(raw), null);
    assert.equal(store.session(raw), null);
  }
  assert.ok(store.token(token.token));
  assert.equal(store.session(session.token).id, user.id);
});

test('sessions require enrollment, store only a digest and use seven-day absolute expiry', t => {
  const { db, store, enroll, advance } = fixture(t);
  const pending = store.inviteUser('pending@example.test', { role: 'member' });
  assert.throws(() => store.createSession(pending.id));
  const user = enroll('active@example.test');
  const session = store.createSession(user.id);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.expiresAt, START + SESSION_TTL);
  const stored = JSON.stringify(db.prepare('SELECT * FROM auth_sessions').all());
  assert.ok(!stored.includes(session.token));
  assert.ok(stored.includes(digest(session.token)));
  advance(SESSION_TTL - 1);
  assert.equal(store.session(session.token).id, user.id);
  advance(1);
  assert.equal(store.session(session.token), null);
});

test('sessions record their actual creation wall time without exposing it as user metadata', t => {
  const { db, store, enroll, now, advance } = fixture(t);
  const column = db.prepare('PRAGMA table_info(auth_sessions)').all().find(row => row.name === 'signed_in_at');
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
  const row = token => db.prepare('SELECT signed_in_at, expires_at FROM auth_sessions WHERE hash = ?').get(digest(token));
  assert.deepEqual({ ...row(first.token) }, { signed_in_at: firstAt, expires_at: firstAt + SESSION_TTL });
  assert.deepEqual({ ...row(second.token) }, { signed_in_at: secondAt, expires_at: secondAt + SESSION_TTL });
  assert.notEqual(firstAt, user.enrolledAt);
  assert.deepEqual(store.session(first.token), user);
  assert.deepEqual(store.session(second.token), user);
  assert.deepEqual(store.getUser(user.id), user);
});

test('revoking one session preserves another and revoking user sessions preserves other users', t => {
  const { store, enroll } = fixture(t);
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

test('pending admins do not defeat the last enrolled admin removal and demotion guard', t => {
  const { store, enroll } = fixture(t);
  const admin = enroll('admin@example.test', 'admin');
  store.inviteUser('pending-admin@example.test', { role: 'admin' });
  assert.throws(() => store.setRole(admin.id, 'member'), status(409));
  assert.throws(() => store.removeUser(admin.id), status(409));
  assert.equal(store.getUser(admin.id).role, 'admin');
  const replacement = enroll('replacement@example.test', 'admin');
  assert.equal(store.setRole(admin.id, 'member').role, 'member');
  assert.equal(store.removeUser(admin.id), true);
  assert.equal(store.getUser(admin.id), null);
  assert.equal(store.getUser(replacement.id).role, 'admin');
});

test('role changes are visible on existing sessions and a second enrolled admin permits removal', t => {
  const { store, enroll } = fixture(t);
  const a = enroll('a@example.test', 'admin');
  const b = enroll('b@example.test', 'admin');
  const live = store.createSession(a.id);
  assert.throws(() => store.setRole(a.id, 'root'), status(400));
  assert.equal(store.session(live.token).role, 'admin');
  assert.equal(store.setRole(a.id, 'member').role, 'member');
  assert.equal(store.session(live.token).role, 'member');
  assert.equal(store.setRole(a.id, 'admin').role, 'admin');
  assert.equal(store.removeUser(b.id), true);
  assert.throws(() => store.setRole(a.id, 'member'), status(409));
});

test('passkey metadata hides material and revoking any credential invalidates every user session', t => {
  const { db, store, enroll } = fixture(t);
  const a = enroll('a@example.test');
  const b = enroll('b@example.test');
  passkey(db, a.id, 'credential-a');
  passkey(db, a.id, 'credential-a2');
  passkey(db, b.id, 'credential-b');
  assert.deepEqual(store.listPasskeys(a.id).find(x => x.id === 'credential-a'), {
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
  assert.deepEqual(store.listPasskeys(a.id), []);
  assert.deepEqual(store.listPasskeys(b.id).map(x => x.id), ['credential-b']);
});

test('removal cascades tokens, credentials and sessions while unrelated users remain live', t => {
  const { db, store, enroll } = fixture(t);
  const a = enroll('remove@example.test');
  const b = enroll('keep@example.test', 'admin');
  passkey(db, a.id, 'remove-key');
  const token = store.createToken(a.id, 'recovery');
  const session = store.createSession(a.id);
  const kept = store.createSession(b.id);
  assert.equal(store.removeUser(a.id), true);
  assert.equal(store.token(token.token), null);
  assert.equal(store.consumeToken(token.token), null);
  assert.equal(store.session(session.token), null);
  assert.deepEqual(store.listPasskeys(a.id), []);
  assert.equal(store.session(kept.token).id, b.id);
});

test('the accounts migration preserves existing MCP bearers as ownerless and is repeatable', t => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const accounts = listMigrations().find(migration => /accounts/.test(migration.name));
  assert.ok(accounts, 'accounts migration is registered');
  db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of listMigrations().filter(migration => migration.id < accounts.id)) {
    db.exec(readFileSync(migration.file, 'utf8'));
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(migration.id, migration.name, '2032-03-10T12:00:00.000Z');
  }
  db.prepare('INSERT INTO api_keys (id, name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-key', 'Existing synthetic household key', 'a'.repeat(64), '["read"]', '2032-03-10T12:00:00.000Z');
  const before = { ...db.prepare('SELECT * FROM api_keys WHERE id = ?').get('legacy-key') };
  migrate(db);
  const after = { ...db.prepare('SELECT * FROM api_keys WHERE id = ?').get('legacy-key') };
  assert.deepEqual(after, { ...before, user_id: null });
  assert.deepEqual(migrate(db).applied, []);
});

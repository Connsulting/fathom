// Migration 020: auth_tokens is rebuilt so its purpose CHECK also takes 'add-passkey'. A
// populated store keeps every auth row, the table keeps its keys, index and cascades, and
// auth_challenges.token_hash still references auth_tokens(hash). Later migrations (022 moves the
// auth tables to platform.sqlite) are held back with migrate(db, { through: 020 }), so 020 is
// proven on its own; the last tests show where 022 takes over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openScope } from '../src/storage/index.mjs';
import { listMigrations, migrate, openDb } from '../src/store/db.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const TARGET = listMigrations().find(m => m.name === 'auth-token-add-passkey');
const THROUGH = { through: TARGET?.id };
const AUTH_TABLES = ['households', 'users', 'passkeys', 'auth_tokens', 'auth_sessions', 'auth_challenges', 'auth_rate_limits'];
const hex = c => c.repeat(64);

// A store migrated only through the migration before TARGET (019), holding auth rows of every kind.
async function storeBefore() {
  assert.ok(TARGET, 'migration 020-auth-token-add-passkey.sql is registered');
  const db = await openScope({ path: ':memory:', journal: null, busyTimeout: 0 });
  await db.applySchema('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of listMigrations().filter(x => x.id < TARGET.id)) {
    db.exec('BEGIN');
    await db.applySchema(readFileSync(m.file, 'utf8'));
    await db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, '2032-03-10T12:00:00.000Z');
    db.exec('COMMIT');
  }
  await db.prepare('INSERT INTO households (id) VALUES (1)').run();
  const user = db.prepare('INSERT INTO users (id, household_id, email, role, user_handle, created_at, enrolled_at) VALUES (?, 1, ?, ?, ?, ?, ?)');
  await user.run('user-owner', 'owner@example.test', 'admin', 'A'.repeat(43), 1_900_000_000_000, 1_900_000_000_100);
  await user.run('user-member', 'member@example.test', 'member', 'B'.repeat(43), 1_900_000_000_200, 1_900_000_000_300);
  await user.run('user-pending', 'pending@example.test', 'member', 'C'.repeat(43), 1_900_000_000_400, null);
  const passkey = db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  await passkey.run('credential-owner', 'user-owner', new Uint8Array([1, 2, 3, 255]), 4, '["internal"]', 'Synthetic laptop', 1_900_000_000_100);
  await passkey.run('credential-member', 'user-member', new Uint8Array([9, 8, 7]), 0, '[]', 'Synthetic phone', 1_900_000_000_300);
  const token = db.prepare('INSERT INTO auth_tokens (hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)');
  await token.run(hex('a'), 'user-pending', 'invite', 1_900_000_001_000);
  await token.run(hex('b'), 'user-owner', 'recovery', 1_900_000_002_000);
  await token.run(hex('c'), 'user-member', 'invite', 1_900_000_003_000);
  await token.run(hex('d'), 'user-member', 'recovery', 1_900_000_004_000);
  const session = db.prepare('INSERT INTO auth_sessions (hash, user_id, signed_in_at, expires_at) VALUES (?, ?, ?, ?)');
  await session.run(hex('e'), 'user-owner', 1_900_000_000_100, 1_900_600_000_100);
  await session.run(hex('f'), 'user-member', 1_900_000_000_300, 1_900_600_000_300);
  const challenge = db.prepare(`INSERT INTO auth_challenges (hash, ceremony, user_id, token_hash, session_hash, challenge, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  await challenge.run(hex('1'), 'register', 'user-owner', hex('b'), null, 'synthetic-challenge-recovery', 1_900_000_000_500);
  await challenge.run(hex('2'), 'register', 'user-pending', hex('a'), null, 'synthetic-challenge-invite', 1_900_000_000_600);
  await challenge.run(hex('3'), 'register', 'user-member', null, hex('f'), 'synthetic-challenge-session', 1_900_000_000_700);
  await challenge.run(hex('4'), 'signin', null, null, null, 'synthetic-challenge-signin', 1_900_000_000_800);
  const limit = db.prepare('INSERT INTO auth_rate_limits (key_hash, window_start, expires_at, attempts) VALUES (?, ?, ?, ?)');
  await limit.run(hex('7'), 1_900_000_000_000, 1_900_000_600_000, 3);
  await limit.run(hex('8'), 1_900_000_000_000, 1_900_001_200_000, 11);
  return db;
}

const snapshot = async db => Object.fromEntries(await mapSeries(AUTH_TABLES, async table => [table,
  (await db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).map(row => ({ ...row }))
    .sort((x, y) => JSON.stringify(Object.values(x)).localeCompare(JSON.stringify(Object.values(y))))]));

const tableSql = async (db, name) => (await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))?.sql ?? '';

test('migration 020 keeps every auth row byte for byte', async () => {
  const db = await storeBefore();
  const before = await snapshot(db);
  assert.equal(before.auth_tokens.length, 4);
  assert.equal(before.auth_challenges.length, 4);
  assert.deepEqual((await migrate(db, THROUGH)).applied, [TARGET.id]);
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual((await db.foreignKeyCheck()), []);
  assert.equal((await (await db.inspect('foreign_keys'))[0]).foreign_keys, 1, 'foreign keys are back on');
  assert.deepEqual((await migrate(db, THROUGH)).applied, [], 'repeatable');
});

test('migration 020 keeps the auth_tokens shape, keys, index and the challenge reference', async () => {
  const db = await storeBefore();
  await migrate(db, THROUGH);
  const columns = await db.columns('auth_tokens');
  assert.deepEqual(columns.map(c => ({ name: c.name, type: c.type, pk: c.pk })), [
    { name: 'hash', type: 'TEXT', pk: 1 },
    { name: 'user_id', type: 'TEXT', pk: 0 },
    { name: 'purpose', type: 'TEXT', pk: 0 },
    { name: 'expires_at', type: 'INTEGER', pk: 0 },
  ]);
  assert.deepEqual(columns.filter(c => c.name !== 'hash').map(c => c.notnull), [1, 1, 1]);
  const sql = await tableSql(db, 'auth_tokens');
  assert.match(sql, /UNIQUE\s*\(\s*user_id\s*,\s*purpose\s*\)/i);
  assert.match(sql, /CHECK\s*\(\s*purpose\s+IN\s*\(\s*'invite'\s*,\s*'recovery'\s*,\s*'add-passkey'\s*\)\s*\)/i);
  assert.doesNotMatch(sql, /auth_tokens_new/, 'the rebuilt table carries its final name');
  const unique = (await db.inspect('index_list', 'auth_tokens')).filter(index => index.unique === 1 && index.origin === 'u');
  assert.equal(unique.length, 1);
  assert.deepEqual((await db.inspect('index_info', unique[0].name)).map(c => c.name), ['user_id', 'purpose']);
  const expiry = await db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'auth_tokens_expiry'").get();
  assert.ok(expiry, 'auth_tokens_expiry exists');
  assert.equal(expiry.tbl_name, 'auth_tokens');
  assert.deepEqual((await db.inspect('index_info', 'auth_tokens_expiry')).map(c => c.name), ['expires_at']);
  const tokenFks = (await db.inspect('foreign_key_list', 'auth_tokens')).map(fk => ({ table: fk.table, from: fk.from, to: fk.to, on_delete: fk.on_delete }));
  assert.deepEqual(tokenFks, [{ table: 'users', from: 'user_id', to: 'id', on_delete: 'CASCADE' }]);
  const challengeFk = (await db.inspect('foreign_key_list', 'auth_challenges')).find(fk => fk.from === 'token_hash');
  assert.deepEqual({ table: challengeFk.table, to: challengeFk.to, on_delete: challengeFk.on_delete }, { table: 'auth_tokens', to: 'hash', on_delete: 'CASCADE' });
  assert.doesNotMatch(await tableSql(db, 'auth_challenges'), /auth_tokens_new/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'auth_tokens_new%'").get()).n, 0);
});

test('after migration 020 auth_tokens takes add-passkey, refuses unknown purposes and still cascades', async () => {
  const db = await storeBefore();
  await migrate(db, THROUGH);
  const insert = db.prepare('INSERT INTO auth_tokens (hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)');
  await assert.doesNotReject(async () => await insert.run(hex('5'), 'user-owner', 'add-passkey', 1_900_000_005_000));
  await assert.rejects(async () => await insert.run(hex('6'), 'user-owner', 'add-passkey', 1_900_000_006_000), /UNIQUE/, 'one pending add-passkey token per user');
  await assert.doesNotReject(async () => await insert.run(hex('6'), 'user-member', 'add-passkey', 1_900_000_006_000));
  await assert.rejects(async () => await insert.run(hex('9'), 'user-owner', 'bogus', 1_900_000_007_000), /CHECK/);
  await assert.rejects(async () => await insert.run(hex('9'), 'user-owner', 'Add-Passkey', 1_900_000_007_000), /CHECK/);
  await assert.rejects(async () => await insert.run(hex('5'), 'user-pending', 'recovery', 1_900_000_007_000), /UNIQUE|PRIMARY/, 'hash stays the primary key');
  await assert.rejects(async () => await insert.run(hex('9'), 'user-absent', 'recovery', 1_900_000_007_000), /FOREIGN KEY/);
  await assert.rejects(async () => await db.prepare('INSERT INTO auth_tokens (hash, user_id, purpose) VALUES (?, ?, ?)').run(hex('9'), 'user-pending', 'recovery'), /NOT NULL/);

  await db.prepare('INSERT INTO auth_challenges (hash, ceremony, user_id, token_hash, session_hash, challenge, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .run(hex('0'), 'register', 'user-owner', hex('5'), 'synthetic-challenge-add', 1_900_000_000_900);
  await assert.rejects(async () => await db.prepare('INSERT INTO auth_challenges (hash, ceremony, user_id, token_hash, session_hash, challenge, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .run(hex('9'), 'register', 'user-owner', hex('9'), 'synthetic-challenge-orphan', 1_900_000_000_900), /FOREIGN KEY/);

  await db.prepare('DELETE FROM auth_tokens WHERE hash = ?').run(hex('b'));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_challenges WHERE hash = ?').get(hex('1'))).n, 0, 'deleting a token cascades its challenge');
  await db.prepare('DELETE FROM auth_tokens WHERE hash = ?').run(hex('5'));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_challenges WHERE hash = ?').get(hex('0'))).n, 0, 'add-passkey challenges cascade too');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_challenges').get()).n, 3, 'other challenges stay');

  await db.prepare('DELETE FROM users WHERE id = ?').run('user-member');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_tokens WHERE user_id = ?').get('user-member')).n, 0, 'deleting a user cascades its tokens');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM passkeys WHERE user_id = ?').get('user-member')).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?').get('user-member')).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_tokens WHERE user_id = ?').get('user-pending')).n, 1);
  assert.deepEqual((await db.foreignKeyCheck()), []);
});

test('migration 020 applies to a fresh store and is a no-op the second time', async () => {
  assert.ok(TARGET, 'migration 020-auth-token-add-passkey.sql is registered');
  assert.match(readFileSync(TARGET.file, 'utf8'), /^-- REBUILDS_TABLE\b/m, 'rebuilds through the foreign-key-safe path');
  const fresh = await openDb(':memory:');
  try {
    assert.ok((await migrate(fresh, THROUGH)).applied.includes(TARGET.id));
    assert.deepEqual((await migrate(fresh, THROUGH)).applied, []);
    assert.equal((await fresh.prepare('SELECT count(*) AS n FROM auth_tokens').get()).n, 0);
    assert.match(await tableSql(fresh, 'auth_tokens'), /'add-passkey'/);
    // A fresh store has no users, so the later migrations (022 platform identity) apply and the
    // auth tables leave the financial store.
    const later = listMigrations().filter(m => m.id > TARGET.id).map(m => m.id);
    assert.deepEqual((await migrate(fresh)).applied, later);
    assert.equal(await tableSql(fresh, 'auth_tokens'), '');
    assert.deepEqual((await migrate(fresh)).applied, []);
  } finally { await fresh.close(); }
});

test('after 020, a populated store without store_identity refuses migration 022 and keeps every auth row', async () => {
  const db = await storeBefore();
  await migrate(db, THROUGH);
  const before = await snapshot(db);
  const identity = listMigrations().find(m => m.name === 'platform-identity');
  assert.ok(identity && identity.id > TARGET.id, 'migration 022-platform-identity is registered after 020');
  await assert.rejects(async () => await migrate(db), new RegExp(`migration ${identity.id}-platform-identity failed`));
  assert.equal((await db.prepare('SELECT max(id) AS id FROM schema_migrations').get()).id, identity.id - 1, 'only the migrations between 020 and the platform migration are recorded');
  assert.deepEqual(await snapshot(db), before, 'the refused migration rolls back');
  assert.equal((await (await db.inspect('foreign_keys'))[0]).foreign_keys, 1);
});

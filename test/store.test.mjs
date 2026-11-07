// AC2: the store opens SQLite, applies numbered migrations once, and owns the foundation tables.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, migrate, listTables, listMigrations, MIGRATIONS_DIR, getSetting, setSetting, DB_FILE } from '../src/store/db.mjs';
import { tempDb, tempDir, withServer, request, expectServerExit, dumpStore, migrateLegacyStore, PLATFORM_FILE, SERVER_TIMEOUT } from './helpers/server.mjs';
import { existsSync } from 'node:fs';

const TABLES = [
  'schema_migrations', 'settings', 'content', 'files', 'sources', 'facts', 'accounts', 'transactions',
  'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'figures', 'recs', 'rec_events',
  'conversations', 'messages', 'goals', 'deadlines', 'events', 'packs_state', 'decisions', 'jobs',
  'job_runs', 'api_keys', 'spend_ledger', 'store_identity',
];
// Account tables moved to platform.sqlite by migration 022 (platform identity).
const ACCOUNT_TABLES = ['households', 'users', 'passkeys', 'auth_tokens', 'auth_sessions', 'auth_challenges', 'auth_rate_limits'];
const PROVENANCE_TABLES = [
  'accounts', 'transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'facts', 'figures',
];

const columns = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);

function insertAccount(db, id, mask) {
  db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, fig_key, file_id, parser, locator)
              VALUES (?, 'Test Bank', ?, 'Checking', 'Household', 'checking', 'manual', '', NULL, NULL, 'test', 'row 1')`)
    .run(id, mask);
}

test('migrate on an empty db creates every foundation table', async () => {
  const t = await tempDb();
  try {
    const tables = listTables(t.db);
    for (const name of TABLES) assert.ok(tables.includes(name), `missing table ${name}`);
    for (const name of ACCOUNT_TABLES) assert.ok(!tables.includes(name), `${name} belongs to platform.sqlite`);
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM store_identity').get().n, 0, 'a bare migrated store names no household');
    assert.deepEqual([...tables].sort(), tables, 'listTables is sorted');
    assert.ok(!tables.some(n => n.startsWith('sqlite_')), 'listTables excludes sqlite internals');
  } finally {
    t.close();
  }
});

test('migrate reports what it applied and a rerun is a no-op', async () => {
  const t = await tempDb();
  try {
    const before = t.db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all().map(r => ({ ...r }));
    assert.ok(before.length >= 1);
    assert.equal(before[0].id, 1);
    const again = migrate(t.db);
    assert.deepEqual(again.applied, []);
    const after = t.db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all().map(r => ({ ...r }));
    assert.deepEqual(after, before);
  } finally {
    t.close();
  }
});

test('a first migrate returns the applied migration ids in order', async () => {
  const t = await tempDb();
  t.close();
  const raw = openDb(t.file + '.fresh');
  try {
    const res = migrate(raw);
    assert.ok(res.applied.length >= 1);
    assert.equal(res.applied[0], 1);
    assert.deepEqual([...res.applied].sort((a, b) => a - b), res.applied);
  } finally {
    raw.close();
  }
});

test('openDb enables foreign keys and WAL', async () => {
  const t = await tempDb();
  try {
    assert.equal(t.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(String(t.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  } finally {
    t.close();
  }
});

test('every data-derived table carries provenance columns', async () => {
  const t = await tempDb();
  try {
    for (const table of PROVENANCE_TABLES) {
      const cols = columns(t.db, table);
      for (const c of ['file_id', 'parser', 'locator']) assert.ok(cols.includes(c), `${table}.${c}`);
    }
  } finally {
    t.close();
  }
});

test('accounts keep only a four digit mask', async () => {
  const t = await tempDb();
  try {
    assert.throws(() => insertAccount(t.db, 'a1', '123456789'));
    assert.throws(() => insertAccount(t.db, 'a2', '12a4'));
    assert.throws(() => insertAccount(t.db, 'a3', '123'));
    assert.throws(() => insertAccount(t.db, 'a6', '1234\u00005678901'), 'an embedded NUL must not smuggle extra digits past the check');
    assert.throws(() => insertAccount(t.db, 'a7', Buffer.from('1234')), 'a blob mask is rejected');
    insertAccount(t.db, 'a4', '1234');
    insertAccount(t.db, 'a5', null);
    const masks = t.db.prepare('SELECT id, mask FROM accounts ORDER BY id').all().map(r => [r.id, r.mask]);
    assert.deepEqual(masks, [['a4', '1234'], ['a5', null]]);
  } finally {
    t.close();
  }
});

test('enumerated columns reject unknown values and accept known ones', async () => {
  const t = await tempDb();
  try {
    const db = t.db;
    db.prepare(`INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note)
                VALUES ('s1', 'Test source', '2026-08-30', 'other', NULL, '')`).run();
    const fig = db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at)
                            VALUES (?, 1.5, ?, ?, ?, NULL, 'test', 'row 1', '2026-11-05T09:00:00Z')`);
    assert.throws(() => fig.run('f_bad', 's1', 'z', 'Bad kind'));
    for (const k of ['a', 'p', 'e', 'm']) fig.run('f_' + k, 's1', k, 'Kind ' + k);

    db.prepare("INSERT INTO conversations (key, created_at) VALUES ('ask:0123456789ab', '2026-11-05T09:00:00Z')").run();
    const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES ('ask:0123456789ab', ?, '<p>x</p>', '[]', 0, '2026-11-05T09:00:00Z')");
    assert.throws(() => msg.run('bot'));
    for (const role of ['me', 'fathom', 'advisor', 'claude']) msg.run(role);

    const dec = db.prepare(`INSERT INTO decisions (id, title, status, wargame, rec_id, opens_on, when_label, note, decided_line, sort)
                            VALUES (?, 'A decision', ?, NULL, NULL, NULL, 'Soon', 'A note', NULL, 0)`);
    assert.throws(() => dec.run('d_bad', 'maybe'));
    for (const st of ['open', 'decided', 'upcoming']) dec.run('d_' + st, st);
  } finally {
    t.close();
  }
});

test('settings hold JSON values with a fallback', async () => {
  const t = await tempDb();
  try {
    assert.deepEqual(getSetting(t.db, 'cap', { usd: 200 }), { usd: 200 });
    setSetting(t.db, 'cap', { usd: 150 });
    assert.deepEqual(getSetting(t.db, 'cap', { usd: 200 }), { usd: 150 });
    setSetting(t.db, 'clock', '2026-11-05');
    assert.equal(getSetting(t.db, 'clock', null), '2026-11-05');
    setSetting(t.db, 'engine', { on: false });
    assert.deepEqual(getSetting(t.db, 'engine', null), { on: false });
  } finally {
    t.close();
  }
});

test('migration files are NNN-name.sql numbered from 001 without gaps', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 1);
  assert.equal(files[0], '001-foundation.sql');
  files.forEach((f, i) => {
    assert.match(f, /^\d{3}-[a-z0-9-]+\.sql$/);
    assert.equal(Number(f.slice(0, 3)), i + 1, `${f} is numbered ${i + 1}`);
  });
  const identity = listMigrations().find(m => m.name === 'platform-identity');
  assert.ok(identity, 'the platform identity migration is registered');
  assert.ok(identity.id > listMigrations().find(m => m.name === 'auth-token-add-passkey').id, 'it follows 020');
});

// Migration 022 drops the account tables only from a store whose accounts were extracted (it
// carries a store_identity row) or that never had any (a new store).
const IDENTITY = listMigrations().find(m => m.name === 'platform-identity');
const storeBeforePlatform = () => {
  const db = openDb(':memory:');
  migrate(db, { through: IDENTITY.id - 1 });
  assert.equal(db.prepare('SELECT max(id) AS id FROM schema_migrations').get().id, IDENTITY.id - 1);
  return db;
};
const addUser = db => {
  db.prepare('INSERT INTO households (id) VALUES (1)').run();
  db.prepare(`INSERT INTO users (id, household_id, email, role, user_handle, created_at, enrolled_at)
              VALUES ('user-owner', 1, 'owner@example.test', 'admin', ?, 1900000000000, 1900000000100)`).run('A'.repeat(43));
};

test('migration 022 refuses a store that still holds account rows and no store_identity', () => {
  const db = storeBeforePlatform();
  try {
    addUser(db);
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, scopes, created_at, user_id) VALUES ('key-owner', 'Synthetic key', ?, '["read"]', '2032-03-10T12:00:00.000Z', 'user-owner')`).run('b'.repeat(64));
    assert.throws(() => migrate(db), new RegExp(`migration ${IDENTITY.id}-platform-identity failed`));
    const tables = listTables(db);
    for (const name of ACCOUNT_TABLES) assert.ok(tables.includes(name), `${name} is kept`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM api_keys').get().n, 1);
    assert.equal(db.prepare('SELECT max(id) AS id FROM schema_migrations').get().id, IDENTITY.id - 1);
  } finally { db.close(); }
});

test('migration 022 applies to a store without users and drops the account tables', () => {
  const db = storeBeforePlatform();
  try {
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, scopes, created_at) VALUES ('key-ownerless', 'Synthetic key', ?, '["read"]', '2032-03-10T12:00:00.000Z')`).run('c'.repeat(64));
    const before = { ...db.prepare("SELECT * FROM api_keys WHERE id = 'key-ownerless'").get() };
    assert.ok(migrate(db).applied.includes(IDENTITY.id));
    const tables = listTables(db);
    for (const name of ACCOUNT_TABLES) assert.ok(!tables.includes(name), `${name} is dropped`);
    assert.ok(tables.includes('store_identity'));
    assert.deepEqual({ ...db.prepare("SELECT * FROM api_keys WHERE id = 'key-ownerless'").get() }, before);
    assert.deepEqual(migrate(db).applied, []);
  } finally { db.close(); }
});

// Contradiction 1: 022 rebuilds api_keys without the users foreign key, keeping columns, rows and
// the api_keys_user index, so creator-owned keys outlive the users table.
test('migration 022 on a marked store drops the account tables and keeps creator-owned api_keys rows', () => {
  const db = storeBeforePlatform();
  try {
    addUser(db);
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, scopes, created_at, user_id) VALUES ('key-owner', 'Synthetic key', ?, '["read"]', '2032-03-10T12:00:00.000Z', 'user-owner')`).run('d'.repeat(64));
    const columnsBefore = db.prepare('PRAGMA table_info(api_keys)').all().map(c => c.name);
    const keyBefore = { ...db.prepare("SELECT * FROM api_keys WHERE id = 'key-owner'").get() };
    // The marker the offline migration writes after publishing platform.sqlite.
    db.exec('CREATE TABLE IF NOT EXISTS store_identity (id INTEGER PRIMARY KEY CHECK (id = 1), household_id TEXT NOT NULL, platform_operation TEXT)');
    db.prepare("INSERT INTO store_identity (id, household_id, platform_operation) VALUES (1, 'hh-synthetic', 'op-synthetic')").run();
    assert.ok(migrate(db).applied.includes(IDENTITY.id));
    const tables = listTables(db);
    for (const name of ACCOUNT_TABLES) assert.ok(!tables.includes(name), `${name} is dropped`);
    assert.deepEqual(db.prepare('PRAGMA table_info(api_keys)').all().map(c => c.name), columnsBefore);
    assert.deepEqual({ ...db.prepare("SELECT * FROM api_keys WHERE id = 'key-owner'").get() }, keyBefore);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(api_keys)').all(), [], 'no foreign key to the dropped users table');
    assert.deepEqual(db.prepare('PRAGMA index_info(api_keys_user)').all().map(c => c.name), ['user_id']);
    assert.equal(db.prepare('SELECT household_id FROM store_identity').get().household_id, 'hh-synthetic');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

// AC15 (merge-gate blocker 7): main's latest store before the chat branch is schema 005
// (002-ingest, 003-ingest-recipients, 004-ingest-survivor, 005-pack-manifest). Since MT-01 a real
// store first goes through the offline platform migration; then starting the server applies 006-chat: messages.provenance exists, existing messages survive. Every
// later migration (007-planner, 008-jobs-email, 009-confirm-deck, 010-ask-threads, ...) applies in the same startup, so the schema
// reports the newest migration and the old 'ask' conversation's messages now live in one Ask
// thread.
const LATEST = Math.max(...listMigrations().map(m => m.id));
const MAIN_MIGRATIONS = ['001-foundation.sql', '002-ingest.sql', '003-ingest-recipients.sql', '004-ingest-survivor.sql', '005-pack-manifest.sql'];

test('a store migrated to exactly 005 upgrades to 006-chat through the platform migration and startup and keeps its messages', { timeout: SERVER_TIMEOUT * 2 }, async () => {
  const dataDir = await tempDir('fathom-upgrade-');
  const file = join(dataDir, DB_FILE);
  const old = openDb(file);
  try {
    old.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const record = old.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, '2026-10-01T00:00:00Z')");
    for (const name of MAIN_MIGRATIONS) {
      old.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      record.run(Number(name.slice(0, 3)), name.slice(4, -4));
    }
    setSetting(old, 'mode', 'real');
    old.prepare("INSERT INTO conversations (key, created_at) VALUES ('ask', '2026-10-02T09:00:00Z')").run();
    const msg = old.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES ('ask', ?, ?, '[]', 0, ?)");
    msg.run('me', '<p>Synthetic question before the upgrade</p>', '2026-10-02T09:00:00Z');
    msg.run('fathom', '<p>Synthetic answer before the upgrade</p>', '2026-10-02T09:00:05Z');
    assert.ok(!old.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'provenance'), 'the fixture is pre-chat');
  } finally {
    old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    old.close();
  }

  // A real store with no platform.sqlite refuses to start and is left unchanged; the offline
  // platform migration (migrations through 021, platform.sqlite, then 022) makes it startable.
  const before = await dumpStore(file);
  const refused = await expectServerExit({ dataDir, env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off' } });
  assert.equal(refused.started, false, refused.output);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /platform_migration_required/);
  assert.deepEqual(await dumpStore(file), before, 'the refused start leaves the store unchanged');
  assert.equal(existsSync(join(dataDir, PLATFORM_FILE)), false);
  await migrateLegacyStore(dataDir);

  await withServer({ dataDir, env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off' } }, async s => {
    const h = await request(s.baseUrl, { path: '/healthz' });
    assert.equal(h.status, 200);
    const latest = Math.max(...readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).map(f => Number(f.slice(0, 3))));
    assert.equal(h.json.schema, latest, 'the schema version reports the highest migration after startup');
  });

  const db = openDb(file);
  try {
    assert.ok(db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'provenance'), 'messages.provenance exists');
    const applied = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all().map(r => `${r.id}-${r.name}`);
    assert.deepEqual(applied, listMigrations().map(m => `${m.id}-${m.name}`));
    assert.deepEqual(applied.slice(0, 7), ['1-foundation', '2-ingest', '3-ingest-recipients', '4-ingest-survivor', '5-pack-manifest', '6-chat', '7-planner']);
    assert.equal(db.prepare("SELECT count(*) AS n FROM conversations WHERE key = 'ask'").get().n, 0, 'the bare ask conversation is gone');
    const threads = db.prepare("SELECT key FROM conversations WHERE key LIKE 'ask:%'").all().map(r => r.key);
    assert.equal(threads.length, 1);
    assert.match(threads[0], /^ask:[a-f0-9]{12}$/);
    const rows = db.prepare('SELECT role, text, provenance FROM messages WHERE conversation_key = ? ORDER BY id').all(threads[0]).map(r => ({ ...r }));
    assert.deepEqual(rows, [
      { role: 'me', text: '<p>Synthetic question before the upgrade</p>', provenance: null },
      { role: 'fathom', text: '<p>Synthetic answer before the upgrade</p>', provenance: null },
    ], 'existing message rows survive');
    assert.equal(getSetting(db, 'mode', null), 'real');
  } finally {
    db.close();
  }
});

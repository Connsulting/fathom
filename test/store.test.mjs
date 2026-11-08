// AC2: the store opens SQLite, applies numbered migrations once, and owns the foundation tables.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, migrate, listTables, listMigrations, MIGRATIONS_DIR, getSetting, setSetting, DB_FILE } from '../src/store/db.mjs';
import {
  tempDb, tempDir, withServer, request, expectServerExit, dumpStore, migrateLegacyStore, migrateTenancyStore, servedStore, PLATFORM_FILE, SERVER_TIMEOUT,
} from './helpers/server.mjs';
import { existsSync } from 'node:fs';

const TABLES = [
  'schema_migrations', 'settings', 'content', 'files', 'sources', 'facts', 'accounts', 'transactions',
  'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'figures', 'recs', 'rec_events',
  'conversations', 'messages', 'goals', 'deadlines', 'events', 'packs_state', 'decisions', 'jobs',
  'job_runs', 'spend_ledger', 'store_identity',
];
// MCP keys moved to platform.sqlite (bound to a household) and migration 025 drops them here.
const PLATFORM_KEY_TABLES = ['api_keys'];
// Account tables moved to platform.sqlite by migration 022 (platform identity).
const ACCOUNT_TABLES = ['households', 'users', 'passkeys', 'auth_tokens', 'auth_sessions', 'auth_challenges', 'auth_rate_limits'];
const PROVENANCE_TABLES = [
  'accounts', 'transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'facts', 'figures',
];

const columns = async (db, table) => (await db.prepare(`PRAGMA table_info("${table}")`).all()).map(c => c.name);

async function insertAccount(db, id, mask) {
  await db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, fig_key, file_id, parser, locator)
              VALUES (?, 'Test Bank', ?, 'Checking', 'Household', 'checking', 'manual', '', NULL, NULL, 'test', 'row 1')`)
    .run(id, mask);
}

test('migrate on an empty db creates every foundation table', async () => {
  const t = await tempDb();
  try {
    const tables = await listTables(t.db);
    for (const name of TABLES) assert.ok(tables.includes(name), `missing table ${name}`);
    for (const name of [...ACCOUNT_TABLES, ...PLATFORM_KEY_TABLES]) assert.ok(!tables.includes(name), `${name} belongs to platform.sqlite`);
    assert.equal((await t.db.prepare('SELECT count(*) AS n FROM store_identity').get()).n, 0, 'a bare migrated store names no household');
    assert.deepEqual([...tables].sort(), tables, 'listTables is sorted');
    assert.ok(!tables.some(n => n.startsWith('sqlite_')), 'listTables excludes sqlite internals');
  } finally {
    t.close();
  }
});

test('migrate reports what it applied and a rerun is a no-op', async () => {
  const t = await tempDb();
  try {
    const before = (await t.db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all()).map(r => ({ ...r }));
    assert.ok(before.length >= 1);
    assert.equal(before[0].id, 1);
    const again = await migrate(t.db);
    assert.deepEqual(again.applied, []);
    const after = (await t.db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all()).map(r => ({ ...r }));
    assert.deepEqual(after, before);
  } finally {
    t.close();
  }
});

test('a first migrate returns the applied migration ids in order', async () => {
  const t = await tempDb();
  t.close();
  const raw = await openDb(t.file + '.fresh');
  try {
    const res = await migrate(raw);
    assert.ok(res.applied.length >= 1);
    assert.equal(res.applied[0], 1);
    assert.deepEqual([...res.applied].sort((a, b) => a - b), res.applied);
  } finally {
    await raw.close();
  }
});

test('openDb enables foreign keys and WAL', async () => {
  const t = await tempDb();
  try {
    assert.equal((await t.db.prepare('PRAGMA foreign_keys').get()).foreign_keys, 1);
    assert.equal(String((await t.db.prepare('PRAGMA journal_mode').get()).journal_mode).toLowerCase(), 'wal');
  } finally {
    t.close();
  }
});

test('every data-derived table carries provenance columns', async () => {
  const t = await tempDb();
  try {
    for (const table of PROVENANCE_TABLES) {
      const cols = await columns(t.db, table);
      for (const c of ['file_id', 'parser', 'locator']) assert.ok(cols.includes(c), `${table}.${c}`);
    }
  } finally {
    t.close();
  }
});

test('accounts keep only a four digit mask', async () => {
  const t = await tempDb();
  try {
    assert.throws(async () => await insertAccount(t.db, 'a1', '123456789'));
    assert.throws(async () => await insertAccount(t.db, 'a2', '12a4'));
    assert.throws(async () => await insertAccount(t.db, 'a3', '123'));
    assert.throws(async () => await insertAccount(t.db, 'a6', '1234\u00005678901'), 'an embedded NUL must not smuggle extra digits past the check');
    assert.throws(async () => await insertAccount(t.db, 'a7', Buffer.from('1234')), 'a blob mask is rejected');
    await insertAccount(t.db, 'a4', '1234');
    await insertAccount(t.db, 'a5', null);
    const masks = (await t.db.prepare('SELECT id, mask FROM accounts ORDER BY id').all()).map(r => [r.id, r.mask]);
    assert.deepEqual(masks, [['a4', '1234'], ['a5', null]]);
  } finally {
    t.close();
  }
});

test('enumerated columns reject unknown values and accept known ones', async () => {
  const t = await tempDb();
  try {
    const db = t.db;
    await db.prepare(`INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note)
                VALUES ('s1', 'Test source', '2026-08-30', 'other', NULL, '')`).run();
    const fig = db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at)
                            VALUES (?, 1.5, ?, ?, ?, NULL, 'test', 'row 1', '2026-11-05T09:00:00Z')`);
    assert.throws(async () => await fig.run('f_bad', 's1', 'z', 'Bad kind'));
    for (const k of ['a', 'p', 'e', 'm']) await fig.run('f_' + k, 's1', k, 'Kind ' + k);

    await db.prepare("INSERT INTO conversations (key, created_at) VALUES ('ask:0123456789ab', '2026-11-05T09:00:00Z')").run();
    const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES ('ask:0123456789ab', ?, '<p>x</p>', '[]', 0, '2026-11-05T09:00:00Z')");
    assert.throws(async () => await msg.run('bot'));
    for (const role of ['me', 'fathom', 'advisor', 'claude']) await msg.run(role);

    const dec = db.prepare(`INSERT INTO decisions (id, title, status, wargame, rec_id, opens_on, when_label, note, decided_line, sort)
                            VALUES (?, 'A decision', ?, NULL, NULL, NULL, 'Soon', 'A note', NULL, 0)`);
    assert.throws(async () => await dec.run('d_bad', 'maybe'));
    for (const st of ['open', 'decided', 'upcoming']) await dec.run('d_' + st, st);
  } finally {
    t.close();
  }
});

test('settings hold JSON values with a fallback', async () => {
  const t = await tempDb();
  try {
    assert.deepEqual(await getSetting(t.db, 'cap', { usd: 200 }), { usd: 200 });
    await setSetting(t.db, 'cap', { usd: 150 });
    assert.deepEqual(await getSetting(t.db, 'cap', { usd: 200 }), { usd: 150 });
    await setSetting(t.db, 'clock', '2026-11-05');
    assert.equal(await getSetting(t.db, 'clock', null), '2026-11-05');
    await setSetting(t.db, 'engine', { on: false });
    assert.deepEqual(await getSetting(t.db, 'engine', null), { on: false });
  } finally {
    t.close();
  }
});

test('migration files have unique positive numeric ids in application order', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 1);
  assert.equal(files[0], '001-foundation.sql');
  files.forEach((f, i) => {
    assert.match(f, /^\d{3}-[a-z0-9-]+\.sql$/);
    assert.ok(Number(f.slice(0, 3)) > 0);
    if (i) assert.ok(Number(f.slice(0, 3)) > Number(files[i - 1].slice(0, 3)), `${f} follows its predecessor`);
  });
  const identity = listMigrations().find(m => m.name === 'platform-identity');
  assert.ok(identity, 'the platform identity migration is registered');
  assert.ok(identity.id > listMigrations().find(m => m.name === 'auth-token-add-passkey').id, 'it follows 020');
});

// Migration 022 drops the account tables only from a store whose accounts were extracted (it
// carries a store_identity row) or that never had any (a new store).
const IDENTITY = listMigrations().find(m => m.name === 'platform-identity');
// Store migration 025 (MT-03) refuses while api_keys holds rows (the offline tenancy migration moves
// them to the platform first), so the 022 cases below stop just before it.
const KEYS_MOVED = listMigrations().find(m => m.name === 'platform-api-keys');
const BEFORE_KEYS_MOVED = { through: KEYS_MOVED.id - 1 };
const storeBeforePlatform = async () => {
  const db = await openDb(':memory:');
  await migrate(db, { through: IDENTITY.id - 1 });
  assert.equal((await db.prepare('SELECT max(id) AS id FROM schema_migrations').get()).id, IDENTITY.id - 1);
  return db;
};
const addUser = async db => {
  await db.prepare('INSERT INTO households (id) VALUES (1)').run();
  await db.prepare(`INSERT INTO users (id, household_id, email, role, user_handle, created_at, enrolled_at)
              VALUES ('user-owner', 1, 'owner@example.test', 'admin', ?, 1900000000000, 1900000000100)`).run('A'.repeat(43));
};

test('migration 022 refuses a store that still holds account rows and no store_identity', async () => {
  const db = await storeBeforePlatform();
  try {
    await addUser(db);
    await db.prepare(`INSERT INTO api_keys (id, name, key_hash, scopes, created_at, user_id) VALUES ('key-owner', 'Synthetic key', ?, '["read"]', '2032-03-10T12:00:00.000Z', 'user-owner')`).run('b'.repeat(64));
    assert.throws(async () => await migrate(db), new RegExp(`migration ${IDENTITY.id}-platform-identity failed`));
    const tables = await listTables(db);
    for (const name of ACCOUNT_TABLES) assert.ok(tables.includes(name), `${name} is kept`);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM users').get()).n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM api_keys').get()).n, 1);
    assert.equal((await db.prepare('SELECT max(id) AS id FROM schema_migrations').get()).id, IDENTITY.id - 1);
  } finally { await db.close(); }
});

test('migration 022 applies to a store without users and drops the account tables', async () => {
  const db = await storeBeforePlatform();
  try {
    await db.prepare(`INSERT INTO api_keys (id, name, key_hash, scopes, created_at) VALUES ('key-ownerless', 'Synthetic key', ?, '["read"]', '2032-03-10T12:00:00.000Z')`).run('c'.repeat(64));
    const before = { ...await db.prepare("SELECT * FROM api_keys WHERE id = 'key-ownerless'").get() };
    assert.ok((await migrate(db, BEFORE_KEYS_MOVED)).applied.includes(IDENTITY.id));
    const tables = await listTables(db);
    for (const name of ACCOUNT_TABLES) assert.ok(!tables.includes(name), `${name} is dropped`);
    assert.ok(tables.includes('store_identity'));
    assert.deepEqual({ ...await db.prepare("SELECT * FROM api_keys WHERE id = 'key-ownerless'").get() }, before);
    assert.deepEqual((await migrate(db, BEFORE_KEYS_MOVED)).applied, []);
    assert.throws(async () => await migrate(db), new RegExp(`migration ${KEYS_MOVED.id}-platform-api-keys failed`), '025 refuses while a key row remains');
    assert.deepEqual({ ...await db.prepare("SELECT * FROM api_keys WHERE id = 'key-ownerless'").get() }, before, 'the refusal keeps the row');
  } finally { await db.close(); }
});

// Contradiction 1: 022 rebuilds api_keys without the users foreign key, keeping columns, rows and
// the api_keys_user index, so creator-owned keys outlive the users table.
test('migration 022 on a marked store drops the account tables and keeps creator-owned api_keys rows', async () => {
  const db = await storeBeforePlatform();
  try {
    await addUser(db);
    await db.prepare(`INSERT INTO api_keys (id, name, key_hash, scopes, created_at, user_id) VALUES ('key-owner', 'Synthetic key', ?, '["read"]', '2032-03-10T12:00:00.000Z', 'user-owner')`).run('d'.repeat(64));
    const columnsBefore = (await db.prepare('PRAGMA table_info(api_keys)').all()).map(c => c.name);
    const keyBefore = { ...await db.prepare("SELECT * FROM api_keys WHERE id = 'key-owner'").get() };
    // The marker the offline migration writes after publishing platform.sqlite.
    await db.applySchema('CREATE TABLE IF NOT EXISTS store_identity (id INTEGER PRIMARY KEY CHECK (id = 1), household_id TEXT NOT NULL, platform_operation TEXT)');
    await db.prepare("INSERT INTO store_identity (id, household_id, platform_operation) VALUES (1, 'hh-synthetic', 'op-synthetic')").run();
    assert.ok((await migrate(db, BEFORE_KEYS_MOVED)).applied.includes(IDENTITY.id));
    const tables = await listTables(db);
    for (const name of ACCOUNT_TABLES) assert.ok(!tables.includes(name), `${name} is dropped`);
    assert.deepEqual((await db.prepare('PRAGMA table_info(api_keys)').all()).map(c => c.name), columnsBefore);
    assert.deepEqual({ ...await db.prepare("SELECT * FROM api_keys WHERE id = 'key-owner'").get() }, keyBefore);
    assert.deepEqual(await db.prepare('PRAGMA foreign_key_list(api_keys)').all(), [], 'no foreign key to the dropped users table');
    assert.deepEqual((await db.prepare('PRAGMA index_info(api_keys_user)').all()).map(c => c.name), ['user_id']);
    assert.equal((await db.prepare('SELECT household_id FROM store_identity').get()).household_id, 'hh-synthetic');
    assert.deepEqual((await db.foreignKeyCheck()), []);
  } finally { await db.close(); }
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
  const old = await openDb(file);
  try {
    old.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const record = old.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, '2026-10-01T00:00:00Z')");
    for (const name of MAIN_MIGRATIONS) {
      old.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      await record.run(Number(name.slice(0, 3)), name.slice(4, -4));
    }
    await setSetting(old, 'mode', 'real');
    await old.prepare("INSERT INTO conversations (key, created_at) VALUES ('ask', '2026-10-02T09:00:00Z')").run();
    const msg = old.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES ('ask', ?, ?, '[]', 0, ?)");
    await msg.run('me', '<p>Synthetic question before the upgrade</p>', '2026-10-02T09:00:00Z');
    await msg.run('fathom', '<p>Synthetic answer before the upgrade</p>', '2026-10-02T09:00:05Z');
    assert.ok(!(await old.prepare('PRAGMA table_info(messages)').all()).some(c => c.name === 'provenance'), 'the fixture is pre-chat');
  } finally {
    await old.checkpoint();
    await old.close();
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
  // MT-03: the platform-migrated single-store layout still refuses until the offline tenancy
  // migration moves the store into its household root.
  const unrooted = await expectServerExit({ dataDir, env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off' } });
  assert.equal(unrooted.started, false, unrooted.output);
  assert.match(unrooted.output, /tenancy_migration_required/);
  await migrateTenancyStore(dataDir);

  await withServer({ dataDir, env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off' } }, async s => {
    const h = await request(s.baseUrl, { path: '/healthz' });
    assert.equal(h.status, 200);
    const latest = Math.max(...readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).map(f => Number(f.slice(0, 3))));
    assert.equal(h.json.schema, latest, 'the schema version reports the highest migration after startup');
  });

  assert.equal(existsSync(file), false, 'the original store moved out of the data root');
  const db = await openDb((await servedStore(dataDir)).file);
  try {
    assert.ok((await db.prepare('PRAGMA table_info(messages)').all()).some(c => c.name === 'provenance'), 'messages.provenance exists');
    const applied = (await db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all()).map(r => `${r.id}-${r.name}`);
    assert.deepEqual(applied, listMigrations().map(m => `${m.id}-${m.name}`));
    assert.deepEqual(applied.slice(0, 7), ['1-foundation', '2-ingest', '3-ingest-recipients', '4-ingest-survivor', '5-pack-manifest', '6-chat', '7-planner']);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM conversations WHERE key = 'ask'").get()).n, 0, 'the bare ask conversation is gone');
    const threads = (await db.prepare("SELECT key FROM conversations WHERE key LIKE 'ask:%'").all()).map(r => r.key);
    assert.equal(threads.length, 1);
    assert.match(threads[0], /^ask:[a-f0-9]{12}$/);
    const rows = (await db.prepare('SELECT role, text, provenance FROM messages WHERE conversation_key = ? ORDER BY id').all(threads[0])).map(r => ({ ...r }));
    assert.deepEqual(rows, [
      { role: 'me', text: '<p>Synthetic question before the upgrade</p>', provenance: null },
      { role: 'fathom', text: '<p>Synthetic answer before the upgrade</p>', provenance: null },
    ], 'existing message rows survive');
    assert.equal(await getSetting(db, 'mode', null), 'real');
  } finally {
    await db.close();
  }
});

// openDb waits for another process's lock instead of failing at once: busy_timeout must be set
// before the first statement that needs a lock (journal_mode). A server that is still closing
// (checkpointing its WAL) holds such a lock for a moment after it exits.
test('openDb waits out a short exclusive lock held by another process', async () => {
  const { spawn } = await import('node:child_process');
  const dir = await tempDir();
  const file = join(dir, DB_FILE);
  (await openDb(file)).close();
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = await openScope({ path: ${JSON.stringify(file)}, journal: null, busyTimeout: 0 });
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.applySchema('CREATE TABLE IF NOT EXISTS held (x)');
    process.stdout.write('locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    db.exec('COMMIT');
    db.close();
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', d => { if (String(d).includes('locked')) resolve(); });
    holder.on('exit', code => reject(new Error(`lock holder exited early with ${code}`)));
  });
  const db = await openDb(file);
  try {
    assert.equal((await db.prepare('PRAGMA journal_mode').get()).journal_mode, 'wal');
  } finally {
    await db.close();
    await new Promise(resolve => (holder.exitCode !== null ? resolve() : holder.on('exit', resolve)));
  }
});

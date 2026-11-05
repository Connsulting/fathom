// AC2: the store opens SQLite, applies numbered migrations once, and owns the foundation tables.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, migrate, listTables, MIGRATIONS_DIR, getSetting, setSetting, DB_FILE } from '../src/store/db.mjs';
import { tempDb, tempDir, withServer, request, SERVER_TIMEOUT } from './helpers/server.mjs';

const TABLES = [
  'schema_migrations', 'settings', 'content', 'files', 'sources', 'facts', 'accounts', 'transactions',
  'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'figures', 'recs', 'rec_events',
  'conversations', 'messages', 'goals', 'deadlines', 'events', 'packs_state', 'decisions', 'jobs',
  'job_runs', 'api_keys', 'spend_ledger',
];
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

    db.prepare("INSERT INTO conversations (key, created_at) VALUES ('ask', '2026-11-05T09:00:00Z')").run();
    const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES ('ask', ?, '<p>x</p>', '[]', 0, '2026-11-05T09:00:00Z')");
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
});

// AC15 (merge-gate blocker 7): main's latest store before the chat branch is schema 005
// (002-ingest, 003-ingest-recipients, 004-ingest-survivor, 005-pack-manifest). Starting the server
// on such a store applies 006-chat: messages.provenance exists, existing messages survive, the
// schema reports 6.
const MAIN_MIGRATIONS = ['001-foundation.sql', '002-ingest.sql', '003-ingest-recipients.sql', '004-ingest-survivor.sql', '005-pack-manifest.sql'];

test('a store migrated to exactly 005 upgrades to 006-chat on startup and keeps its messages', { timeout: SERVER_TIMEOUT * 2 }, async () => {
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
    assert.deepEqual(applied.slice(0, 6), ['1-foundation', '2-ingest', '3-ingest-recipients', '4-ingest-survivor', '5-pack-manifest', '6-chat']);
    const rows = db.prepare("SELECT role, text, provenance FROM messages WHERE conversation_key = 'ask' ORDER BY id").all().map(r => ({ ...r }));
    assert.deepEqual(rows, [
      { role: 'me', text: '<p>Synthetic question before the upgrade</p>', provenance: null },
      { role: 'fathom', text: '<p>Synthetic answer before the upgrade</p>', provenance: null },
    ], 'existing message rows survive');
    assert.equal(getSetting(db, 'mode', null), 'real');
  } finally {
    db.close();
  }
});

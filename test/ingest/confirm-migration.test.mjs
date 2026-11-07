// AC5 (plan feat-confirm-context, Interfaces, Migration): a store at migration 014 with an imported
// account, an owner answer and its undo log, and a pending question upgrades through the confirm-context migration. It
// adds exactly its four tables and alters nothing, so the answer stays answered, an answer recorded
// before the migration still reopens, and a re-import of the answered account asks nothing new.
// The 014 store is built by applying migrations 001 to 014 the way db.mjs migrate does
// (test/store-upgrade.test.mjs) and populated with the rows main's code writes, the undo log in
// main's format ({table, op, rowid, before, after}, row images as json_object text). Every value
// here is synthetic.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { src, tempDir } from '../helpers/server.mjs';
import { aggregatorFile, offEngine, one, count, NOW } from '../helpers/ingest.mjs';

let P;
let C;
let DB;
let V;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  DB = await src('src/store/db.mjs');
  V = await src('src/ingest/vault.mjs');
});

const AT = '2032-03-01T09:00:00.000Z';
const FILE_ID = 'f-00000000000000000000aa01';
const NEW_TABLES = {
  account_holders: ['account_id', 'holder', 'file_id', 'locator', 'created_at'],
  confirm_auto: ['item_id', 'rule', 'evidence', 'created_at'],
  confirm_auto_declined: ['item_id', 'at'],
  simplefin_snapshots: ['sf_key', 'snapshot', 'at'],
};

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
// A row image exactly as main's undo.mjs triggers write it.
const image = (db, table, rowid) => db.prepare(`SELECT json_object(${columnsOf(db, table).map((c) => `'${c}', t."${c}"`).join(', ')}) AS img
  FROM "${table}" AS t WHERE t.rowid = ?`).get(rowid).img;

// The account aggregatorFile() rows land in by default (Example Bank, number ending 1111).
const accountOf = (mask) => {
  const identity = P.accountIdentity({ account: { inst: 'Example Bank', mask } });
  return { id: P.accountIdOf(identity), identity };
};

function applyThrough(db, target) {
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id));
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  const applied = [];
  for (const migration of DB.listMigrations().filter((m) => m.id <= target && !done.has(m.id))) {
    const sql = readFileSync(migration.file, 'utf8');
    const rebuild = /^-- REBUILDS_TABLE\b/m.test(sql);
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      record.run(migration.id, migration.name, AT);
      db.exec('COMMIT');
      applied.push(migration.id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return applied;
}

async function storeAt014() {
  const dataDir = await tempDir('fathom-confirm-migration-');
  const keyDir = await tempDir('fathom-key-');
  const db = DB.openDb(join(dataDir, 'fathom.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  applyThrough(db, 14);
  DB.setSetting(db, 'mode', 'real');
  const keyFile = join(keyDir, 'data.key');
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const config = { dataDir, dataKeyFile: keyFile, engine: 'off', clock: null, demo: false, port: 0, host: '127.0.0.1', claudeCredentialFile: null, emailTransport: 'dev' };
  const key = await V.loadDataKey({ dataDir, keyFile, mode: 'real' });
  return {
    db,
    opts: (engine) => ({ engine, config, now: NOW, key }),
    close() {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(keyDir, { recursive: true, force: true });
    },
  };
}

// An imported file with two accounts: 1111 (owner answered "You" with main's undo log) and 2222
// (kind still asked).
function populate(db) {
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status, parser, source_kind, source_id, counts)
              VALUES (?, 'old-export.csv', 'text/csv', 10, ?, ?, NULL, 'imported', 'aggregator', 'aggregator_csv', 'ing:aggregator:all', '{}')`)
    .run(FILE_ID, 'b'.repeat(64), AT);
  const addAccount = (mask, kind) => {
    const { id, identity } = accountOf(mask);
    db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, file_id, parser, locator, identity, source_id)
                VALUES (?, 'Example Bank', ?, ?, NULL, ?, NULL, ?, 'aggregator', NULL, ?, 'ing:aggregator:all')`)
      .run(id, mask, `Synthetic account ${mask}`, kind, FILE_ID, identity);
    return id;
  };
  const answered = addAccount('1111', 'cash');
  const asked = addAccount('2222', null);
  const addItem = (kind, subject, options) => Number(db.prepare(`INSERT INTO confirm_items (kind, subject, question, options, context, status, file_id, created_at)
    VALUES (?, ?, ?, ?, '{}', 'pending', ?, ?)`).run(kind, subject, `Synthetic ${kind} question`, JSON.stringify(options), FILE_ID, AT).lastInsertRowid);
  const ownerId = addItem('account_owner', answered, C.OWNER_OPTIONS);
  const pendingId = addItem('account_kind', asked, C.KIND_OPTIONS);

  // The owner answer as main's recordAnswer stores it: applyAnswer's account update, then the item
  // update, captured as whole-row images, with the ingest epoch at answer time.
  const acctRowid = db.prepare('SELECT rowid AS r FROM accounts WHERE id = ?').get(answered).r;
  const before = [image(db, 'accounts', acctRowid), image(db, 'confirm_items', ownerId)];
  db.prepare("UPDATE accounts SET owner = 'You' WHERE id = ?").run(answered);
  db.prepare("UPDATE confirm_items SET status = 'answered', answer = 'owner', answered_at = ? WHERE id = ?").run(AT, ownerId);
  const changes = [
    { table: 'accounts', op: 'update', rowid: acctRowid, before: before[0], after: image(db, 'accounts', acctRowid) },
    { table: 'confirm_items', op: 'update', rowid: ownerId, before: before[1], after: image(db, 'confirm_items', ownerId) },
  ];
  db.prepare(`INSERT INTO confirm_undo (item_id, ingest_epoch, changes, created_at, used_at)
              VALUES (?, coalesce((SELECT n FROM ingest_epoch WHERE id = 1), 0), ?, ?, NULL)`).run(ownerId, JSON.stringify(changes), AT);
  return { answered, asked, ownerId, pendingId };
}

async function withOldStore(fn) {
  const s = await storeAt014();
  try {
    assert.equal(DB.schemaVersion(s.db), 14, 'precondition: the store is at 014');
    const ids = populate(s.db);
    return await fn(s, ids);
  } finally { s.close(); }
}

const snapshot = (db) => Object.fromEntries(['accounts', 'confirm_items', 'confirm_undo', 'files'].map((t) =>
  [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all().map((r) => JSON.stringify({ ...r }))]));

test('migrate applies the confirm-context migration, creates exactly its four tables and changes no stored row', () => withOldStore((s, ids) => {
  const before = snapshot(s.db);

  const mig = DB.listMigrations().find((m) => m.name === 'confirm-context');
  assert.ok(mig, 'a confirm-context migration exists');
  assert.ok(mig.id > 14);
  applyThrough(s.db, mig.id - 1);
  assert.deepEqual(snapshot(s.db), before, 'preceding migrations keep every stored row');
  const tables = DB.listTables(s.db);
  for (const t of Object.keys(NEW_TABLES)) assert.ok(!tables.includes(t), `precondition: ${t} is new`);
  assert.deepEqual(applyThrough(s.db, mig.id), [mig.id]);
  const added = DB.listTables(s.db).filter((t) => !tables.includes(t)).sort();
  assert.deepEqual(added, Object.keys(NEW_TABLES).sort(), 'exactly the four tables');
  for (const [t, cols] of Object.entries(NEW_TABLES)) assert.deepEqual(columnsOf(s.db, t), cols, `${t} columns`);
  for (const t of tables) assert.ok(DB.listTables(s.db).includes(t), `${t} is kept`);
  assert.deepEqual(snapshot(s.db), before, 'every stored row is unchanged');
  assert.deepEqual(DB.migrate(s.db).applied, DB.listMigrations().filter((m) => m.id > mig.id).map((m) => m.id));
  assert.deepEqual(snapshot(s.db), before, 'later migrations keep every stored row');

  const owner = C.getItem(s.db, ids.ownerId);
  assert.equal(owner.status, 'answered');
  assert.equal(owner.answer, 'owner');
  assert.equal(one(s.db, 'SELECT owner FROM accounts WHERE id = ?', ids.answered).owner, 'You');
  assert.equal(C.getItem(s.db, ids.pendingId).status, 'pending');
  assert.equal(C.autoInfo(s.db, ids.ownerId), null, 'an answer from before the migration is the owner\'s own');
  assert.deepEqual(DB.migrate(s.db), { applied: [] }, 'a second migrate applies nothing');
}));

test('an answer recorded before the migration still reopens, and the pending question is answerable', () => withOldStore((s, ids) => {
  DB.migrate(s.db);
  assert.equal(C.finalReason(s.db, C.getItem(s.db, ids.ownerId)), null, 'no import since the answer, so it is not final');
  const out = C.reopenItem(s.db, ids.ownerId, { now: NOW });
  assert.equal(out.item.status, 'pending');
  assert.equal(one(s.db, 'SELECT owner FROM accounts WHERE id = ?', ids.answered).owner, null, 'the owner is restored to unset');
  assert.equal(count(s.db, 'confirm_undo', 'item_id = ?', ids.ownerId), 0);

  C.answerItem(s.db, ids.ownerId, 'spouse', { now: NOW });
  assert.equal(one(s.db, 'SELECT owner FROM accounts WHERE id = ?', ids.answered).owner, 'Your spouse');
  C.answerItem(s.db, ids.pendingId, 'checking', { now: NOW });
  assert.equal(one(s.db, 'SELECT kind FROM accounts WHERE id = ?', ids.asked).kind, 'checking');
}));

test('re-importing the answered account after the migration asks nothing new for it', () => withOldStore(async (s, ids) => {
  DB.migrate(s.db);
  const questions = count(s.db, 'confirm_items');
  const { results } = await P.ingestFiles(s.db, [aggregatorFile('later-export.csv', [{ date: '2032-03-02', amount: '12.50', description: 'Synthetic later row' }])], s.opts(await offEngine()));
  assert.equal(results[0].status, 'imported');
  assert.equal(count(s.db, 'accounts'), 2, 'the row lands in the existing account');
  assert.equal(count(s.db, 'transactions', 'account_id = ?', ids.answered), 1);
  assert.equal(count(s.db, 'confirm_items'), questions, 'no new question');
  const owner = C.getItem(s.db, ids.ownerId);
  assert.equal(owner.status, 'answered');
  assert.equal(owner.answer, 'owner');
  assert.equal(one(s.db, 'SELECT owner FROM accounts WHERE id = ?', ids.answered).owner, 'You');
}));

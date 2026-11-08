import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, listTables } from '../../src/store/db.mjs';

const now = '2032-04-17T12:00:00.000Z';
function legacy() {
  const db = openDb(':memory:'); migrate(db, { through: 28 });
  db.prepare('INSERT INTO files (id, name, sha256, size, mime, uploaded_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('f-synthetic', 'synthetic.csv', 'a'.repeat(64), 20, 'text/csv', now, 'imported');
  db.prepare('INSERT INTO column_mappings (signature, mapping, src, created_at, uses) VALUES (?, ?, ?, ?, ?)')
    .run('same-signature', '{"type":"transactions"}', 'model', now, 7);
  db.prepare('INSERT INTO accounts (id, name, kind) VALUES (?, ?, ?)').run('account-synthetic', 'Synthetic account', 'checking');
  db.prepare('INSERT INTO transactions (account_id, date, amount, description, file_id, parser, locator, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('account-synthetic', '2032-04-17', -12.34, 'Synthetic posting', 'f-synthetic', 'aggregator', '{"row":2}', 'synthetic-key');
  return db;
}
function snapshot(db) {
  return Object.fromEntries(listTables(db).filter(n => !['schema_migrations', 'column_mappings', 'import_proposals', 'import_batches'].includes(n))
    .map(n => [n, db.prepare(`SELECT rowid AS _rowid, * FROM "${n}" ORDER BY rowid`).all()]));
}

test('populated additive upgrade preserves financial rows and provenance; old mappings are unapproved', () => {
  const db = legacy();
  try {
    const before = snapshot(db); const old = db.prepare('SELECT * FROM column_mappings').get();
    assert.deepEqual(migrate(db, { through: 29 }).applied, [29]);
    assert.deepEqual(snapshot(db), before);
    const mapping = db.prepare('SELECT * FROM column_mappings').get();
    for (const k of Object.keys(old)) assert.deepEqual(mapping[k], old[k]);
    assert.equal(mapping.approval_status, 'unapproved'); assert.equal(mapping.mapping_version, 1);
    assert.equal(mapping.schema_version, 1); assert.equal(mapping.approved_by, null); assert.equal(mapping.approved_at, null);
    assert.equal(mapping.structural_context, null);
    assert.deepEqual(migrate(db, { through: 29 }).applied, []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => db.prepare("UPDATE column_mappings SET approval_status = 'guessed'").run());
    assert.throws(() => db.prepare('UPDATE column_mappings SET mapping_version = 0').run());
  } finally { db.close(); }
});

test('household-local proposal versions, batches and mapping approval cannot cross databases', () => {
  const a = legacy(), b = legacy();
  try {
    migrate(a); migrate(b);
    a.prepare("UPDATE column_mappings SET approval_status = 'approved', approved_by = 'actor-synthetic', approved_at = ? WHERE signature = 'same-signature'").run(now);
    assert.equal(b.prepare('SELECT approval_status FROM column_mappings').get().approval_status, 'unapproved');
    const insert = db => db.prepare(`INSERT INTO import_proposals
      (id, version, file_id, source_sha256, status, proposal, interpreter_version, created_at, updated_at)
      VALUES ('proposal-synthetic', 1, 'f-synthetic', ?, 'needs_confirmation', '{}', '1', ?, ?)`).run('a'.repeat(64), now, now);
    insert(a); insert(b);
    assert.throws(() => insert(a));
    a.prepare(`INSERT INTO import_proposals (id, version, file_id, source_sha256, status, proposal, interpreter_version, created_at, updated_at)
      VALUES ('proposal-synthetic', 2, 'f-synthetic', ?, 'needs_clarification', '{}', '1', ?, ?)`).run('a'.repeat(64), now, now);
    a.prepare(`INSERT INTO import_batches (id, proposal_id, proposal_version, file_id, status, before_state, after_state, created_at)
      VALUES ('batch-synthetic', 'proposal-synthetic', 2, 'f-synthetic', 'committed', '[]', '[]', ?)`).run(now);
    assert.equal(b.prepare('SELECT count(*) AS n FROM import_batches').get().n, 0);
    assert.throws(() => a.prepare("UPDATE import_batches SET proposal_version = 99").run());
    assert.throws(() => a.prepare("UPDATE import_proposals SET status = 'fabricated'").run());
    assert.throws(() => a.prepare('UPDATE import_proposals SET version = 0').run());
  } finally { a.close(); b.close(); }
});

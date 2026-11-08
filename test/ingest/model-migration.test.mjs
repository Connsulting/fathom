import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, listTables, listMigrations, schemaVersion } from '../../src/store/db.mjs';
import { mapSeries } from '../../src/shared/series.mjs';

const now = '2032-04-17T12:00:00.000Z';
async function legacy() {
  const db = await openDb(':memory:'); await migrate(db, { through: 28 });
  await db.prepare('INSERT INTO files (id, name, sha256, size, mime, uploaded_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('f-synthetic', 'synthetic.csv', 'a'.repeat(64), 20, 'text/csv', now, 'imported');
  await db.prepare('INSERT INTO column_mappings (signature, mapping, src, created_at, uses) VALUES (?, ?, ?, ?, ?)')
    .run('same-signature', '{"type":"transactions"}', 'model', now, 7);
  await db.prepare('INSERT INTO accounts (id, name, kind) VALUES (?, ?, ?)').run('account-synthetic', 'Synthetic account', 'checking');
  await db.prepare('INSERT INTO transactions (account_id, date, amount, description, file_id, parser, locator, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('account-synthetic', '2032-04-17', -12.34, 'Synthetic posting', 'f-synthetic', 'aggregator', '{"row":2}', 'synthetic-key');
  return db;
}
async function snapshot(db) {
  return Object.fromEntries(await mapSeries((await listTables(db)).filter(n => !['schema_migrations', 'column_mappings', 'import_proposals', 'import_batches', 'import_model_spend'].includes(n)), async n => [n, await db.prepare(`SELECT rowid AS _rowid, * FROM "${n}" ORDER BY rowid`).all()]));
}

test('populated additive upgrade preserves financial rows and provenance; old mappings are unapproved', async () => {
  const db = await legacy();
  try {
    const before = await snapshot(db); const old = await db.prepare('SELECT * FROM column_mappings').get();
    assert.deepEqual((await migrate(db, { through: 30 })).applied, [29, 30]);
    assert.deepEqual(await snapshot(db), before);
    const mapping = await db.prepare('SELECT * FROM column_mappings').get();
    for (const k of Object.keys(old)) assert.deepEqual(mapping[k], old[k]);
    assert.equal(mapping.approval_status, 'unapproved'); assert.equal(mapping.mapping_version, 1);
    assert.equal(mapping.schema_version, 1); assert.equal(mapping.approved_by, null); assert.equal(mapping.approved_at, null);
    assert.equal(mapping.structural_context, null);
    assert.deepEqual((await migrate(db, { through: 29 })).applied, []);
    assert.deepEqual(await db.foreignKeyCheck(), []);
    await assert.rejects(async () => await db.prepare("UPDATE column_mappings SET approval_status = 'guessed'").run());
    await assert.rejects(async () => await db.prepare('UPDATE column_mappings SET mapping_version = 0').run());
  } finally { await db.close(); }
});

test('household-local proposal versions, batches and mapping approval cannot cross databases', async () => {
  const a = await legacy(), b = await legacy();
  try {
    await migrate(a); await migrate(b);
    await a.prepare("UPDATE column_mappings SET approval_status = 'approved', approved_by = 'actor-synthetic', approved_at = ? WHERE signature = 'same-signature'").run(now);
    assert.equal((await b.prepare('SELECT approval_status FROM column_mappings').get()).approval_status, 'unapproved');
    const insert = async db => await db.prepare(`INSERT INTO import_proposals
      (id, version, file_id, source_sha256, status, proposal, interpreter_version, created_at, updated_at)
      VALUES ('proposal-synthetic', 1, 'f-synthetic', ?, 'needs_confirmation', '{}', '1', ?, ?)`).run('a'.repeat(64), now, now);
    await insert(a); await insert(b);
    await assert.rejects(async () => await insert(a));
    await a.prepare(`INSERT INTO import_proposals (id, version, file_id, source_sha256, status, proposal, interpreter_version, created_at, updated_at)
      VALUES ('proposal-synthetic', 2, 'f-synthetic', ?, 'needs_clarification', '{}', '1', ?, ?)`).run('a'.repeat(64), now, now);
    await a.prepare(`INSERT INTO import_batches (id, proposal_id, proposal_version, file_id, status, before_state, after_state, created_at)
      VALUES ('batch-synthetic', 'proposal-synthetic', 2, 'f-synthetic', 'committed', '[]', '[]', ?)`).run(now);
    assert.equal((await b.prepare('SELECT count(*) AS n FROM import_batches').get()).n, 0);
    await assert.rejects(async () => await a.prepare("UPDATE import_batches SET proposal_version = 99").run());
    await assert.rejects(async () => await a.prepare("UPDATE import_proposals SET status = 'fabricated'").run());
    await assert.rejects(async () => await a.prepare('UPDATE import_proposals SET version = 0').run());
  } finally { a.close(); b.close(); }
});

test('migration 034 preserves populated proposal, mapping and financial rows', async () => {
  const db = await legacy();
  try {
    await migrate(db, { through: 33 });
    await db.prepare(`INSERT INTO import_proposals (id,version,file_id,source_sha256,status,proposal,interpreter_version,created_at,updated_at)
      VALUES ('proposal-synthetic',1,'f-synthetic',?,'needs_confirmation','{}','1',?,?)`).run('a'.repeat(64), now, now);
    const oldProposal = await db.prepare('SELECT * FROM import_proposals').get();
    const oldMapping = await db.prepare('SELECT * FROM column_mappings').get();
    const before = await snapshot(db);
    assert.deepEqual((await migrate(db, { through: 34 })).applied, [34]);
    assert.equal(await schemaVersion(db), 34);
    const proposal = await db.prepare('SELECT * FROM import_proposals').get(), mapping = await db.prepare('SELECT * FROM column_mappings').get();
    for (const [key, value] of Object.entries(oldProposal)) assert.deepEqual(proposal[key], value);
    for (const [key, value] of Object.entries(oldMapping)) assert.deepEqual(mapping[key], value);
    assert.equal(proposal.review_state, null); assert.equal(mapping.header_signature, null);
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual((await migrate(db, { through: 34 })).applied, []);
    assert.deepEqual(await db.foreignKeyCheck(), []);
  } finally { await db.close(); }
});

test('store migrations have unique numbers and import review follows spending definitions', () => {
  const migrations = listMigrations();
  assert.equal(new Set(migrations.map(m => m.id)).size, migrations.length);
  assert.equal(migrations.find(m => m.id === 33).name, 'spending-definitions');
  assert.equal(migrations.find(m => m.id === 34).name, 'import-review');
});

// MGI3 (plan Revision 6, R6-3): a store at main's latest migration (006) upgraded to 007 keeps its
// data and gains the planner tables and columns, and a planning run succeeds on it. The 006 store
// is built by applying migrations 001 to 006 exactly as db.mjs migrate does, then seeded with one
// synthetic row per table the planner or ingest touches. Every value is invented.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, listMigrations, migrate, schemaVersion, listTables } from '../src/store/db.mjs';
import { runPlanning } from '../src/jobs/planner.mjs';
import { PACKS_DIR } from './helpers/real-store.mjs';

const dirs = [];
const dbs = [];
after(() => {
  for (const db of dbs) { try { db.close(); } catch { /* already closed */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const AT = '2026-11-01T09:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';

// Migrations 001..006 applied the way db.mjs migrate applies them (own transaction each, recorded
// in schema_migrations with the same columns).
function storeAtMain() {
  const dir = mkdtempSync(join(tmpdir(), 'fathom-upgrade-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'fathom.sqlite'));
  dbs.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of listMigrations().filter(m => m.id <= 6)) {
    db.exec('BEGIN');
    db.exec(readFileSync(m.file, 'utf8'));
    record.run(m.id, m.name, AT);
    db.exec('COMMIT');
  }
  return db;
}

// One row per table, with the columns that exist at 006. Returns {table: [columns]}.
function seed(db) {
  const put = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]));
    return cols;
  };
  const W2_FIELDS = { taxYear: 2026, employerName: 'Example Employer Inc', wages: 40000, federalWithheld: 4800, state: 'VA', stateWithheld: 1800, box12: [{ code: 'D', amount: 3000 }], confidence: 0.95 };
  const cols = {};
  const add = (table, row) => { cols[table] = put(table, row); };
  add('settings', { key: 'mode', value: JSON.stringify('real'), updated_at: AT });
  put('settings', { key: 'clock', value: JSON.stringify('2026-11-05'), updated_at: AT });
  add('files', { id: 'f-000000000000000000000001', name: 'synthetic-w2.txt', mime: 'text/plain', size: 10, sha256: 'a'.repeat(64), source_kind: 'tax_doc', uploaded_at: AT, stored_path: null, status: 'imported', note: null, parser: 'extract-w2', counts: '{}', source_id: 'ing:extract-w2:all', header_signature: null, period_from: '2026-01-01', period_to: '2026-12-31', coverage: null });
  add('sources', { id: 'ing:extract-w2:all', label: 'W-2', as_of: '2026-12-31', kind: 'tax_doc', last_ingest_at: AT, note: '' });
  add('accounts', { id: 'acct-0000000000000001', inst: 'Example Bank', mask: '1234', name: 'Example Bank 1234', owner: 'You', kind: 'checking', mirror: 'manual', note: null, fig_key: null, file_id: 'f-000000000000000000000001', parser: 'chase-activity', locator: null, sort: 0, source_id: 'ing:chase-activity:acct-0000000000000001', identity: 'examplebank|mask:1234' });
  add('balances', { account_id: 'acct-0000000000000001', date: '2026-10-31', amount: 12000, file_id: 'f-000000000000000000000001', parser: 'chase-activity', locator: '{}', dedupe_key: 'bal-1' });
  add('facts', { key: 'household.state', value: JSON.stringify('VA'), src: 'you', as_of: null, confirmed: 1, file_id: null, parser: null, locator: null, updated_at: AT });
  put('facts', { key: 'income.w2', value: 'true', src: 'ing:extract-w2:all', as_of: '2026-12-31', confirmed: 0, file_id: 'f-000000000000000000000001', parser: 'extract-w2', locator: '{"document":"w2"}', updated_at: AT });
  add('documents', { doc_type: 'w2', tax_year: 2026, fields: JSON.stringify(W2_FIELDS), file_id: 'f-000000000000000000000001', parser: 'extract-w2', locator: '{"document":"w2"}', dedupe_key: 'doc-1' });
  add('tax_payments', { jurisdiction: 'federal', tax_year: 2026, date: '2026-12-31', amount: 4800, kind: 'withholding', file_id: 'f-000000000000000000000001', parser: 'extract-w2', locator: '{"document":"w2","field":"federalWithheld"}', dedupe_key: 'tp-1', source_slot: 'wh:14c1870cabc3:2026:federal:owner', payer: 'w2:14c1870cabc3:2026:4000000:owner', date_precision: 'year', tax_year_basis: 'annual_total', recipient: 'owner' });
  add('superseded_rows', { table_name: 'tax_payments', dedupe_key: 'tp-0', row: JSON.stringify({ amount: 4700 }), file_id: 'f-000000000000000000000001', superseded_by: 'f-000000000000000000000001', reason: 'duplicate', at: AT, survivor_key: 'tp-1' });
  add('packs_state', { id: 'w2', def: JSON.stringify({ id: 'w2', manifest: 'w2-benefits', recIds: [] }), active: null, exploring: 0, what_if_asked: 0, what_if_done: 0, unhid: '[]', sort: 0, updated_at: AT });
  add('recs', { id: 'owner-note', def: JSON.stringify({ title: 'Synthetic owner rec', domain: 'data' }), status: 'proposed', waiting_on: null, wake: null, tasks_done: '[]', window_close: null, window_label: null, pack_id: null, sort: 0, updated_at: AT, file_id: null, parser: null, locator: null });
  add('decisions', { id: 'd-owner', title: 'Synthetic owner decision', status: 'open', wargame: null, rec_id: null, opens_on: null, when_label: null, note: 'kept', decided_line: null, sort: 0 });
  add('events', { date: '2026-10-01', kind: 'note', title: 'Synthetic owner event', body: 'kept', sort: 0 });
  add('deadlines', { date: '2027-01-15', label: 'Jan 15', title: 'Synthetic owner deadline', rec_id: null, hard: 1 });
  add('figures', { key: 'bal.legacy', v: 12000, src: 'ing:extract-w2:all', kind: 'a', label: 'Legacy balance', file_id: null, parser: 'manual', locator: '{}', updated_at: AT });
  add('confirm_items', { kind: 'account_owner', subject: 'acct-0000000000000001', question: 'Whose account is Example Bank 1234?', options: '[{"id":"owner","label":"You"}]', context: '{}', status: 'answered', answer: 'owner', file_id: 'f-000000000000000000000001', created_at: AT, answered_at: AT });
  return cols;
}

const snapshot = (db, cols) => Object.fromEntries(Object.entries(cols).map(([t, c]) =>
  [t, db.prepare(`SELECT ${c.join(', ')} FROM ${t} ORDER BY rowid`).all().map(r => JSON.stringify({ ...r }))]));
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

test('MGI3: a 006 store upgraded to 007 keeps its data and gains the planner tables and columns', async () => {
  const db = storeAtMain();
  assert.equal(schemaVersion(db), 6);
  assert.ok(!listTables(db).includes('planner_recs'), 'the 006 store has no planner tables yet');
  const cols = seed(db);
  const before = snapshot(db, cols);

  // 007 and every later migration apply; the later ones (008-ask-threads, ...) are covered by their own tests.
  const later = listMigrations().filter(m => m.id > 6).map(m => m.id);
  assert.equal(later[0], 7);
  assert.deepEqual(migrate(db), { applied: later });
  assert.equal(schemaVersion(db), later.at(-1));
  assert.deepEqual(snapshot(db, cols), before, 'every seeded row keeps its old columns unchanged');

  assert.ok(listTables(db).includes('planner_recs'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM planner_recs').get().n, 0);
  for (const t of ['events', 'deadlines', 'decisions']) {
    assert.ok(columnsOf(db, t).includes('src'), `${t}.src added`);
    assert.equal(db.prepare(`SELECT src FROM ${t}`).get().src, null, `${t}.src is NULL on the old row`);
  }
  for (const t of ['decisions', 'figures']) {
    assert.ok(columnsOf(db, t).includes('unavailable_reason'), `${t}.unavailable_reason added`);
    assert.equal(db.prepare(`SELECT unavailable_reason FROM ${t}`).get().unavailable_reason, null, `${t}.unavailable_reason is NULL on the old row`);
  }
  assert.deepEqual(migrate(db), { applied: [] }, 'a second migrate applies nothing');

  const result = await runPlanning(db, null, { now: NOW, packDirs: [PACKS_DIR] });
  assert.equal(result.status, 'ok');
  const planned = ['content', 'events', 'deadlines', 'decisions'].reduce((n, t) => n + db.prepare(`SELECT count(*) AS n FROM ${t} WHERE src = 'planner'`).get().n, 0);
  assert.ok(planned > 0, 'the planning run writes rows marked src planner');
  assert.ok(db.prepare('SELECT count(*) AS n FROM planner_recs').get().n > 0, 'the planner records the recs it owns');
  for (const [t, title] of [['events', 'Synthetic owner event'], ['deadlines', 'Synthetic owner deadline'], ['decisions', 'Synthetic owner decision']]) {
    assert.ok(db.prepare(`SELECT 1 FROM ${t} WHERE title = ? AND src IS NULL`).get(title), `the owner's ${t} row survives planning`);
  }
  assert.ok(db.prepare("SELECT 1 FROM recs WHERE id = 'owner-note'").get(), 'the owner rec survives planning');
});

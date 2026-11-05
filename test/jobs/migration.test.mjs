// Upgrade from main's migration 004 to the jobs and email migration: a store built with 001 to 004
// only, holding a jobs row and a job_runs row in the shape PR #8's planner writes (no period key),
// is migrated by the real migrate(). The new columns and tables appear, the old row survives,
// NULL period keys may repeat, and a duplicate (job_id, period_key) is rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, DB_FILE } from '../helpers/server.mjs';
import { openDb, migrate, listMigrations, listTables, schemaVersion } from '../../src/store/db.mjs';

const MAIN_LATEST = 4;

// Apply migrations 001 to 004 exactly as migrate() would, recording them in schema_migrations.
function applyThrough(db, last) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of listMigrations().filter((x) => x.id <= last)) {
    db.exec('BEGIN');
    db.exec(readFileSync(m.file, 'utf8'));
    record.run(m.id, m.name, '2026-11-01T00:00:00.000Z');
    db.exec('COMMIT');
  }
}

const columns = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);

async function oldStore() {
  const dir = await tempDir('fathom-migr-');
  const db = openDb(join(dir, DB_FILE));
  applyThrough(db, MAIN_LATEST);
  return { db, done() { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

test('main stops at 004 and this branch adds at least one migration after it', () => {
  const ids = listMigrations().map((m) => m.id);
  assert.ok(ids.includes(MAIN_LATEST));
  assert.ok(Math.max(...ids) > MAIN_LATEST, 'a new migration exists');
});

test('upgrading a 004 store keeps planner-shaped job_runs rows and adds the scheduler and email schema', async () => {
  const s = await oldStore();
  try {
    const { db } = s;
    assert.equal(schemaVersion(db), MAIN_LATEST);
    assert.ok(!columns(db, 'job_runs').includes('period_key'), 'starting point has no period_key');
    db.prepare("INSERT INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES ('plan', 'Synthetic nightly plan', 'Daily', 'Synthetic', 0.1, '', '', 1, 0)").run();
    db.prepare("INSERT INTO job_runs (job_id, started_at, finished_at, status, cost_usd, note) VALUES ('plan', '2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05.000Z', 'ok', 0.05, '{\"recs\":2}')").run();

    const { applied } = migrate(db);
    assert.ok(applied.length >= 1 && applied.every((id) => id > MAIN_LATEST), `applied ${applied}`);
    const newest = schemaVersion(db);
    assert.equal(newest, Math.max(...applied), 'the new migration is the highest applied id');

    const jr = columns(db, 'job_runs');
    for (const c of ['period_key', 'trigger', 'duration_ms', 'error_class']) assert.ok(jr.includes(c), `job_runs.${c}`);
    const tables = listTables(db);
    for (const t of ['job_lock', 'email_sends', 'deadline_alerts']) assert.ok(tables.includes(t), `table ${t}`);
    assert.ok(columns(db, 'job_lock').includes('holder'));
    assert.ok(columns(db, 'job_lock').includes('expires_at'));
    for (const c of ['key', 'threshold']) assert.ok(columns(db, 'deadline_alerts').includes(c), `deadline_alerts.${c}`);
    const sends = columns(db, 'email_sends');
    for (const c of ['kind', 'subject', 'status']) assert.ok(sends.includes(c), `email_sends.${c}`);
    for (const c of ['body', 'text', 'html', 'text_body', 'html_body']) assert.ok(!sends.includes(c), `email_sends has no ${c} column`);

    const old = db.prepare("SELECT * FROM job_runs WHERE job_id = 'plan'").all();
    assert.equal(old.length, 1, 'the old row survives');
    assert.equal(old[0].period_key, null);
    assert.equal(old[0].status, 'ok');
    assert.equal(old[0].note, '{"recs":2}');

    // The planner keeps inserting rows with no period key: repeats are allowed.
    const insertNull = db.prepare("INSERT INTO job_runs (job_id, started_at, status) VALUES ('plan', ?, 'ok')");
    insertNull.run('2026-11-05T07:00:00.000Z');
    insertNull.run('2026-11-06T07:00:00.000Z');
    assert.equal(db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'plan' AND period_key IS NULL").get().n, 3);

    const keyed = db.prepare("INSERT INTO job_runs (job_id, started_at, status, period_key, trigger) VALUES ('plan', '2026-11-07T07:00:00.000Z', 'ok', ?, 'scheduled')");
    keyed.run('2026-11-07');
    keyed.run('2026-11-08'); // liveness: another period is fine
    assert.throws(() => keyed.run('2026-11-07'), /UNIQUE/i, 'one attempt per (job_id, period_key)');
  } finally { s.done(); }
});

test('migrating twice is a no-op', async () => {
  const s = await oldStore();
  try {
    migrate(s.db);
    assert.deepEqual(migrate(s.db).applied, []);
  } finally { s.done(); }
});

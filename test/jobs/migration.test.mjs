// Upgrade from main's latest migration before the jobs-email migration (the highest id below it) through the jobs-email
// migration and any later ones: a store built with migrations below jobs-email
// only, holding a jobs row and a job_runs row in the shape PR #8's planner writes (no period key),
// is migrated by the real migrate(). The new columns and tables appear, the old row survives,
// NULL period keys may repeat, and a duplicate (job_id, period_key) is rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, DB_FILE } from '../helpers/server.mjs';
import { openDb, migrate, setSetting, listMigrations, listTables, schemaVersion } from '../../src/store/db.mjs';

// The latest migration before the jobs-email one: the highest-numbered one below it (later
// migrations, such as 009-confirm-deck, come after it and are applied by migrate() too).
const JOBS_EMAIL = listMigrations().find((m) => /jobs-email/.test(m.name)).id;
const MAIN_LATEST = Math.max(...listMigrations().filter((m) => m.id < JOBS_EMAIL).map((m) => m.id));

// Apply migrations through `last` exactly as migrate() would, recording them in schema_migrations.
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

test('the jobs-email migration exists and has an id greater than the latest main migration', () => {
  const ids = listMigrations().map((m) => m.id);
  assert.ok(JOBS_EMAIL, 'jobs-email migration exists');
  assert.ok(ids.includes(MAIN_LATEST));
  assert.ok(JOBS_EMAIL.id > MAIN_LATEST, 'jobs-email comes after the latest main migration');
});

test('upgrading a store at the latest main migration keeps planner-shaped job_runs rows and adds the scheduler and email schema', async () => {
  const s = await oldStore();
  try {
    const { db } = s;
    assert.equal(schemaVersion(db), MAIN_LATEST);
    assert.ok(!columns(db, 'job_runs').includes('period_key'), 'starting point has no period_key');
    db.prepare("INSERT INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES ('plan', 'Synthetic nightly plan', 'Daily', 'Synthetic', 0.1, '', '', 1, 0)").run();
    db.prepare("INSERT INTO job_runs (job_id, started_at, finished_at, status, cost_usd, note) VALUES ('plan', '2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05.000Z', 'ok', 0.05, '{\"recs\":2}')").run();

    const { applied } = migrate(db);
    assert.ok(applied.length >= 1 && applied.every((id) => id > MAIN_LATEST), `applied ${applied}`);
    assert.ok(applied.includes(JOBS_EMAIL.id), 'the jobs-email migration is applied');
    const newest = schemaVersion(db);
    assert.equal(newest, Math.max(...applied), 'the highest applied id is the schema version');

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

const RETIRED = ['sync', 'sweep', 'triggers', 'brief', 'packet'];

function seedRetired(db, ids) {
  const job = db.prepare("INSERT INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, 'Daily', 'Synthetic', 0, '', '', 1, 0)");
  const run = db.prepare("INSERT INTO job_runs (job_id, started_at, finished_at, status) VALUES (?, '2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05.000Z', 'ok')");
  for (const id of ids) { job.run(id, `Synthetic ${id}`); run.run(id); run.run(id); }
}

test('upgrading a demo store removes the five retired mock jobs and their job_runs rows', async () => {
  const s = await oldStore();
  try {
    const { db } = s;
    setSetting(db, 'mode', 'demo');
    seedRetired(db, RETIRED);
    db.prepare("INSERT INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES ('plan', 'Synthetic nightly plan', 'Daily', 'Synthetic', 0, '', '', 1, 0)").run();
    db.prepare("INSERT INTO job_runs (job_id, started_at, status) VALUES ('plan', '2026-11-04T07:00:00.000Z', 'ok')").run();
    assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 6);
    migrate(db);
    for (const id of RETIRED) {
      assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE id = ?').get(id).n, 0, `job ${id} removed`);
      assert.equal(db.prepare('SELECT count(*) AS n FROM job_runs WHERE job_id = ?').get(id).n, 0, `job_runs for ${id} removed`);
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE id = 'plan'").get().n, 1, 'other jobs survive');
    assert.equal(db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'plan'").get().n, 1, 'other runs survive');
  } finally { s.done(); }
});

test('upgrading a real store keeps a job that shares a retired id', async () => {
  const s = await oldStore();
  try {
    const { db } = s;
    setSetting(db, 'mode', 'real');
    seedRetired(db, ['sync']);
    migrate(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE id = 'sync'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'sync'").get().n, 2);
  } finally { s.done(); }
});

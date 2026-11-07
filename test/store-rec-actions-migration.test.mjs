// Migration 015: the 'accepted' rec status folds into 'doing'. A populated store keeps every rec,
// its events and the rows that reference it; history that named accept/accepted reads as start/doing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { listMigrations, migrate, openDb } from '../src/store/db.mjs';
import { ACTION_STATUS } from '../src/shared/rules.mjs';

const TARGET = listMigrations().find(m => m.name === 'rec-doing-status');

// A store at migration 014 holding recs in every status, with events and referencing rows.
function storeBefore() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const m of listMigrations().filter(x => x.id < TARGET.id)) {
    db.exec('BEGIN');
    db.exec(readFileSync(m.file, 'utf8'));
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, 'x');
    db.exec('COMMIT');
  }
  const rec = db.prepare(`INSERT INTO recs (id, def, status, wake, tasks_done, updated_at, sort, pack_id)
                          VALUES (?, '{}', ?, ?, '[true,false]', '2026-11-01T00:00:00Z', ?, 'p')`);
  ['proposed', 'accepted', 'doing', 'waiting', 'snoozed', 'done', 'dismissed', 'hidden', 'accepted']
    .forEach((s, i) => rec.run(`r${i}`, s, s === 'snoozed' ? 'Next month' : null, i));
  const ev = db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor)
                         VALUES (?, '2026-11-01T00:00:00Z', ?, ?, ?, ?, ?)`);
  ev.run('r1', 'accept', null, 'proposed', 'accepted', 'ui');
  ev.run('r8', 'set_status', null, 'proposed', 'accepted', 'tool');
  ev.run('r8', 'task', '0', 'accepted', 'accepted', 'ui');
  ev.run('r2', 'start', null, 'accepted', 'doing', 'ui');
  ev.run('r5', 'complete', null, 'doing', 'done', 'ui');
  db.prepare(`INSERT INTO planner_recs (rec_id, trigger_id, grounding_hash, prose_src, held_from, retired_from) VALUES ('r1', 't', 'h', 'template', NULL, NULL)`).run();
  // A rec parked as waiting while accepted, and one retired from accepted: both remember 'accepted'.
  db.prepare(`INSERT INTO planner_recs (rec_id, trigger_id, grounding_hash, prose_src, held_from) VALUES ('r3', 't', 'h', 'template', 'accepted')`).run();
  db.prepare(`INSERT INTO planner_recs (rec_id, trigger_id, grounding_hash, prose_src, held_from, retired_from) VALUES ('r4', 't', 'h', 'template', 'proposed', 'accepted')`).run();
  db.prepare(`INSERT INTO conversations (key, created_at) VALUES ('r1', 'x')`).run();
  const msg = db.prepare(`INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES ('r1', 'fathom', 't', 'x', ?)`);
  msg.run(JSON.stringify({ proposal: { recId: 'r1', action: 'accept' }, tools: [{ name: 'propose_recommendation_action', args: { id: 'r1', action: 'accept' } }] }));
  msg.run(JSON.stringify({ proposal: { recId: 'r1', action: 'dismiss' } }));
  msg.run('not json');
  msg.run(null);
  db.prepare(`INSERT INTO advisor_reviews (rec_id, title, sent_at) VALUES ('r8', 'Review', '2026-11-01')`).run();
  return db;
}

test('migration 015 turns every accepted rec into doing and keeps all other data', () => {
  const db = storeBefore();
  const before = db.prepare('SELECT id, status, wake, tasks_done, pack_id, sort, updated_at FROM recs ORDER BY id').all();
  assert.equal(before.filter(r => r.status === 'accepted').length, 2);

  // Later migrations (016 moves rec conversations into Ask threads) apply after it.
  assert.equal(migrate(db).applied[0], TARGET.id);

  const after = db.prepare('SELECT id, status, wake, tasks_done, pack_id, sort, updated_at FROM recs ORDER BY id').all();
  assert.deepEqual(after.map(r => ({ ...r })), before.map(r => ({ ...r, status: r.status === 'accepted' ? 'doing' : r.status })));
  assert.equal(db.prepare("SELECT count(*) AS n FROM recs WHERE status = 'accepted'").get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM planner_recs').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM advisor_reviews').get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('migration 015 rewrites rec history so it reads in the new vocabulary', () => {
  const db = storeBefore();
  migrate(db);
  const rows = db.prepare('SELECT rec_id, action, from_status, to_status, actor FROM rec_events ORDER BY id').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { rec_id: 'r1', action: 'start', from_status: 'proposed', to_status: 'doing', actor: 'ui' },
    { rec_id: 'r8', action: 'set_status', from_status: 'proposed', to_status: 'doing', actor: 'tool' },
    { rec_id: 'r8', action: 'task', from_status: 'doing', to_status: 'doing', actor: 'ui' },
    { rec_id: 'r2', action: 'start', from_status: 'doing', to_status: 'doing', actor: 'ui' },
    { rec_id: 'r5', action: 'complete', from_status: 'doing', to_status: 'done', actor: 'ui' },
  ]);
});

test('migration 015 leaves the recs table refusing accepted, with its index and foreign keys intact', () => {
  const db = storeBefore();
  migrate(db);
  assert.throws(() => db.prepare("UPDATE recs SET status = 'accepted' WHERE id = 'r0'").run(), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO rec_events (rec_id, ts, action, actor) VALUES ('nope', 'x', 'start', 'ui')`).run(), /FOREIGN KEY/);
  assert.doesNotThrow(() => db.prepare("UPDATE recs SET status = 'doing' WHERE id = 'r0'").run());
  const cols = db.prepare('PRAGMA table_info(recs)').all().map(c => c.name);
  // Later migrations add columns (019: owner, owner_override, goal_kinds) after the rebuilt ones.
  assert.deepEqual(cols, ['id', 'def', 'status', 'waiting_on', 'wake', 'tasks_done', 'window_close', 'window_label', 'pack_id', 'sort', 'updated_at', 'file_id', 'parser', 'locator', 'owner', 'owner_override', 'goal_kinds']);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'recs'").get().sql.includes('accepted'), false);
});

test('migration 015 is a no-op on a store with no recs and on a fresh store', () => {
  const fresh = openDb(':memory:');
  assert.ok(migrate(fresh).applied.includes(TARGET.id));
  assert.equal(fresh.prepare('SELECT count(*) AS n FROM recs').get().n, 0);
  assert.deepEqual(migrate(fresh).applied, []);
});

test('migration 015 keeps the planner able to restore a rec parked or retired while accepted', () => {
  const db = storeBefore();
  migrate(db);
  const rows = db.prepare('SELECT rec_id, held_from, retired_from FROM planner_recs ORDER BY rec_id').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { rec_id: 'r1', held_from: null, retired_from: null },
    { rec_id: 'r3', held_from: 'doing', retired_from: null },
    { rec_id: 'r4', held_from: 'proposed', retired_from: 'doing' },
  ]);
  // The planner's unblock writes held_from back as the rec status; the recs CHECK must take it.
  for (const r of db.prepare('SELECT rec_id, held_from FROM planner_recs WHERE held_from IS NOT NULL').all()) {
    assert.doesNotThrow(() => db.prepare('UPDATE recs SET status = ? WHERE id = ?').run(r.held_from, r.rec_id), r.rec_id);
  }
});

test('migration 015 turns a stored accept proposal into start and leaves other messages alone', () => {
  const db = storeBefore();
  migrate(db);
  const rows = db.prepare('SELECT provenance FROM messages ORDER BY id').all().map(r => r.provenance);
  assert.equal(JSON.parse(rows[0]).proposal.action, 'start');
  assert.ok(Object.hasOwn(ACTION_STATUS, JSON.parse(rows[0]).proposal.action), 'the Ask card can still resolve the action');
  assert.equal(JSON.parse(rows[0]).proposal.recId, 'r1');
  assert.equal(JSON.parse(rows[1]).proposal.action, 'dismiss');
  assert.equal(rows[2], 'not json');
  assert.equal(rows[3], null);
});

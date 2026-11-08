// Migration 019 (AC3): recs gain owner, owner_override and goal_kinds. A populated store keeps
// every rec, its status, def, tasks, events, planner bookkeeping and advisor rows; planner recs are
// backfilled from their trigger's static goalKinds and owner, demo seed recs from the demo
// scenario, anything else gets the defaults (housekeeping, owner 'you'). No override is set, so the
// next planning run applies the contextual owner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openScope } from '../src/storage/index.mjs';
import { listMigrations, migrate, openDb } from '../src/store/db.mjs';
import demo from '../demo/scenario.mjs';
import { triggers } from '../src/jobs/triggers/index.mjs';
import { forEachSeries } from '../src/shared/series.mjs';

// Found by number or name so this does not depend on 018 existing.
const TARGET = listMigrations().find(m => m.id === 19) || listMigrations().find(m => /owner|goal-links/.test(m.name));
const TARGET_ID = TARGET ? TARGET.id : 19;
const STATUSES = ['proposed', 'doing', 'waiting', 'snoozed', 'done', 'dismissed', 'hidden'];
const TS = '2026-11-01T00:00:00Z';

async function storeBefore() {
  const db = await openScope({ path: ':memory:', journal: null, busyTimeout: 0 });
  await db.applySchema('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of listMigrations().filter(x => x.id < TARGET_ID)) {
    await db.applySchema(readFileSync(m.file, 'utf8'));
    await db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, 'x');
  }
  return db;
}

const insertRec = async (db, id, i, { parser = null, status = STATUSES[i % STATUSES.length] } = {}) =>
  await db.prepare(`INSERT INTO recs (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, parser, locator)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, JSON.stringify({ id, title: `Synthetic ${id}`, tasks: [{ t: 'one' }, { t: 'two' }] }), status,
      status === 'waiting' ? 'data' : null, status === 'snoozed' ? 'Next month' : null, JSON.stringify([i % 2 === 0, false]),
      i % 3 ? '2026-12-31' : null, i % 3 ? 'Dec 31' : null, i % 4 ? 'p' : null, i, TS, parser, JSON.stringify({ n: i }));

const event = async (db, recId, action, from, to, actor = 'ui') =>
  await db.prepare('INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)').run(recId, TS, action, null, from, to, actor);

// Planner recs for every trigger (rec id = trigger id, as the planner writes them), some retired
// and some held, plus a planner rec whose trigger no longer exists and two non-planner recs.
async function plannerStore() {
  const db = await storeBefore();
  const pr = db.prepare(`INSERT INTO planner_recs (rec_id, trigger_id, grounding_hash, prose_src, retired_at, retired_reason, retired_from, held_from)
                         VALUES (?, ?, 'h', 'template', ?, ?, ?, ?)`);
  await forEachSeries(triggers, async (t, i) => {
    await insertRec(db, t.id, i, { parser: 'planner' });
    const retired = i % 4 === 1;
    const held = i % 4 === 2;
    await pr.run(t.id, t.id, retired ? TS : null, retired ? 'Its window closed on Dec 31.' : null, retired ? 'proposed' : null, held ? 'doing' : null);
    await event(db, t.id, 'start', 'proposed', 'doing');
    if (retired) await event(db, t.id, 'retire', 'proposed', 'dismissed', 'planner');
  });
  await insertRec(db, 'old-trigger-rec', 20, { parser: 'planner', status: 'dismissed' });
  await pr.run('old-trigger-rec', 'a-trigger-since-removed', TS, 'gone', 'proposed', null);
  // An owner note that shares a demo rec id but is not demo-seeded, and a rec with no parser.
  await insertRec(db, 'umbrella', 21, { parser: 'manual', status: 'doing' });
  await insertRec(db, 'owner-note', 22, { status: 'proposed' });
  await event(db, 'owner-note', 'snooze', 'proposed', 'snoozed');
  await db.prepare("INSERT INTO advisor_reviews (rec_id, title, sent_at) VALUES ('va529', 'Review', '2026-11-01')").run();
  return db;
}

// Demo seed recs for every demo rec id, plus one unknown rec.
async function demoStore() {
  const db = await storeBefore();
  await forEachSeries(demo.recs, async (r, i) => await insertRec(db, r.id, i, { parser: 'demo-seed', status: (r.statusByDemo && r.statusByDemo.november) || r.status }));
  await insertRec(db, 'unknown-rec', 40, { parser: 'test' });
  await event(db, 'va529', 'start', 'proposed', 'doing');
  await event(db, 'umbrella', 'snooze', 'doing', 'snoozed');
  await db.prepare("INSERT INTO advisor_reviews (rec_id, title, sent_at) VALUES ('compmemo', 'Review', '2026-11-01')").run();
  return db;
}

const snapshot = async db => ({
  recs: (await db.prepare('SELECT id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator FROM recs ORDER BY id').all()).map(r => ({ ...r })),
  events: (await db.prepare('SELECT * FROM rec_events ORDER BY id').all()).map(r => ({ ...r })),
  planner: (await db.prepare('SELECT * FROM planner_recs ORDER BY rec_id').all()).map(r => ({ ...r })),
  advisor: (await db.prepare('SELECT * FROM advisor_reviews ORDER BY id').all()).map(r => ({ ...r })),
});

const links = async db => Object.fromEntries((await db.prepare('SELECT id, owner, owner_override, goal_kinds FROM recs').all())
  .map(r => [r.id, { owner: r.owner, override: r.owner_override, kinds: JSON.parse(r.goal_kinds) }]));

test('migration 019 exists', () => {
  assert.ok(TARGET, 'a migration numbered 19 adding rec owner and goal links');
});

test('migration 019 adds owner, owner_override and goal_kinds to recs', async () => {
  const db = await plannerStore();
  await migrate(db);
  const cols = Object.fromEntries((await db.columns('recs')).map(c => [c.name, c]));
  for (const c of ['owner', 'owner_override', 'goal_kinds']) assert.ok(cols[c], `recs.${c}`);
  assert.equal(cols.owner.notnull, 1);
  assert.equal(cols.owner_override.notnull, 1);
  assert.equal(cols.goal_kinds.notnull, 1);
});

test('migration 019 backfills planner recs from each trigger module, with no override', async () => {
  const db = await plannerStore();
  await migrate(db);
  const got = await links(db);
  for (const t of triggers) {
    assert.deepEqual(got[t.id], { owner: t.owner, override: 0, kinds: [...t.goalKinds] }, t.id);
  }
  // A planner rec whose trigger is gone and recs that are neither planner nor demo seed get the defaults.
  assert.deepEqual(got['old-trigger-rec'], { owner: 'you', override: 0, kinds: [] });
  assert.deepEqual(got.umbrella, { owner: 'you', override: 0, kinds: [] }, 'a non-demo rec sharing a demo id');
  assert.deepEqual(got['owner-note'], { owner: 'you', override: 0, kinds: [] });
});

test('migration 019 backfills demo seed recs from the demo scenario, with no override', async () => {
  const db = await demoStore();
  await migrate(db);
  const got = await links(db);
  for (const r of demo.recs) {
    assert.ok(Array.isArray(r.goalKinds) && typeof r.owner === 'string', `demo rec ${r.id} names goalKinds and owner`);
    assert.deepEqual(got[r.id], { owner: r.owner, override: 0, kinds: r.goalKinds }, r.id);
  }
  assert.deepEqual(got['unknown-rec'], { owner: 'you', override: 0, kinds: [] });
});

test('migration 019 leaves statuses, defs, tasks, events, planner and advisor rows unchanged', async () => {
  for (const make of [plannerStore, demoStore]) {
    const db = make();
    const before = await snapshot(db);
    assert.ok(before.recs.some(r => r.status === 'hidden') && before.recs.some(r => r.status === 'waiting'), 'precondition: varied statuses');
    await migrate(db);
    assert.deepEqual(await snapshot(db), before, make.name);
    assert.deepEqual((await db.foreignKeyCheck()), [], make.name);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM recs WHERE owner_override != 0').get()).n, 0, `${make.name}: no override`);
  }
  const db = await plannerStore();
  await migrate(db);
  const held = await db.prepare('SELECT rec_id, held_from, retired_from FROM planner_recs WHERE held_from IS NOT NULL OR retired_from IS NOT NULL').all();
  assert.ok(held.length >= 3, 'retired and held rows kept');
});

test('migration 019 applies once; a second migrate does nothing', async () => {
  const db = await demoStore();
  const first = (await migrate(db)).applied;
  assert.ok(first.includes(TARGET_ID));
  const backfilled = await links(db);
  assert.deepEqual((await migrate(db)).applied, []);
  assert.deepEqual(await links(db), backfilled);
  const fresh = await openDb(':memory:');
  assert.ok((await migrate(fresh)).applied.includes(TARGET_ID));
  assert.deepEqual((await migrate(fresh)).applied, []);
});

test('migration 019 CHECKs the owner and override and defaults new rows', async () => {
  const db = await plannerStore();
  await migrate(db);
  await assert.rejects(async () => await db.prepare("UPDATE recs SET owner = 'nobody' WHERE id = 'va529'").run(), /CHECK/);
  await assert.rejects(async () => await db.prepare("UPDATE recs SET owner = 'Spouse' WHERE id = 'va529'").run(), /CHECK/);
  await assert.rejects(async () => await db.prepare("UPDATE recs SET owner_override = 2 WHERE id = 'va529'").run(), /CHECK/);
  for (const o of ['you', 'spouse', 'both', 'advisor', 'automatic']) {
    await assert.doesNotReject(async () => await db.prepare('UPDATE recs SET owner = ?, owner_override = 1 WHERE id = ?').run(o, 'va529'), o);
  }
  await db.prepare(`INSERT INTO recs (id, def, status, sort, updated_at) VALUES ('later', '{}', 'proposed', 0, ?)`).run(TS);
  assert.deepEqual({ ...await db.prepare("SELECT owner, owner_override, goal_kinds FROM recs WHERE id = 'later'").get() }, { owner: 'you', owner_override: 0, goal_kinds: '[]' });
});

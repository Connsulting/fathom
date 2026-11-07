// Migration 026 (goal model v2): goals gain a done_at column and nothing else. A store built at
// migration 025 with owner goals (with and without target, track and pace, one archived) and seed
// goals (one done, one with a legacy topic as its def kind, one with progress tokens) keeps every
// goals row byte for byte. loadGoals reads every goal back with the same def fields plus the
// read-time defaults: kind balance, owner and priority unset, canonical status, seed display text as
// statusLabel and the legacy topic as `topic`. Fixtures are synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { listMigrations, migrate } from '../src/store/db.mjs';
import { loadGoals, loadFigures } from '../src/scenario/build.mjs';
import { servesGoals } from '../src/shared/goals.mjs';

const BEFORE = 25;
const TARGET = 26;
const TS = '2026-10-01T09:00:00.000Z';

const DEFS = Object.freeze({
  o_full: { id: 'o_full', title: 'A year of cash', note: 'Parked.', horizon: '1-3y', target: 60000, targetDate: '2028-01-31',
    track: { accounts: ['acc'] }, pace: { startDate: '2026-09-30', startValue: 12000, sources: [{ rows: { table: 'balances', ids: [1], count: 1 } }] } },
  o_bare: { id: 'o_bare', title: 'A boat someday', note: '', horizon: '3-10y', target: null, targetDate: null, track: null },
  o_arch: { id: 'o_arch', title: 'An old plan', note: '', horizon: 'now', target: 5000, targetDate: '2026-12-31', track: null, pace: null },
  s_track: { id: 's_track', title: 'Reserve in {n:bank}', horizon: 'now', status: 'on track', prose: 'Parked at {n:bank}.',
    target: 50000, targetDate: '2026-12-31', track: { figure: 'cash.total' }, pace: { startDate: '2026-01-01', startValue: 20000 },
    progress: { cur: 'cash.total', target: 'seed_target' } },
  s_done: { id: 's_done', title: 'Mortgage paid off', horizon: 'now', status: 'done', prose: 'Done in August.' },
  s_legacy: { id: 's_legacy', title: 'Plain seed goal', horizon: '3-10y', status: 'watch', kind: 'education', prose: 'Plain words.' },
});

function storeAt025() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, { through: BEFORE });
  db.prepare("INSERT INTO sources (id, label, as_of) VALUES ('bank', 'Synthetic bank export', '2026-09-30')").run();
  db.prepare("INSERT INTO accounts (id, inst, name, kind, fig_key, parser) VALUES ('acc', 'Example Bank', 'Savings', 'checking', 'bal.acc', 'test')").run();
  const fig = db.prepare("INSERT INTO figures (key, v, src, kind, label, updated_at) VALUES (?, ?, 'bank', ?, ?, ?)");
  fig.run('bal.acc', 12000, 'a', 'Savings', TS);
  fig.run('cash.total', 30000, 'a', 'All cash', TS);
  fig.run('seed_target', 50000, 'p', 'Seed target', TS);
  const owner = db.prepare("INSERT INTO goals (id, def, sort, origin, archived_at, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?, ?)");
  owner.run('o_full', JSON.stringify(DEFS.o_full), 7, null, TS, TS);
  owner.run('o_bare', JSON.stringify(DEFS.o_bare), 8, null, TS, TS);
  owner.run('o_arch', JSON.stringify(DEFS.o_arch), 9, '2026-10-02T09:00:00.000Z', TS, '2026-10-02T09:00:00.000Z');
  const seedGoal = db.prepare('INSERT INTO goals (id, def, sort) VALUES (?, ?, ?)');
  seedGoal.run('s_track', JSON.stringify(DEFS.s_track), 0);
  seedGoal.run('s_done', JSON.stringify(DEFS.s_done), 1);
  seedGoal.run('s_legacy', JSON.stringify(DEFS.s_legacy), 2);
  return db;
}

const COLUMNS = 'id, def, sort, origin, archived_at, created_at, updated_at';
const rows = db => db.prepare(`SELECT ${COLUMNS} FROM goals ORDER BY id`).all().map(r => ({ ...r }));
const schema = db => Object.fromEntries(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
  .map(r => [`${r.type}:${r.name}`, r.sql]));
const goalsRead = db => {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY sort, id').all();
  return loadGoals(db, { fig: loadFigures(db), accounts });
};

test('the migration under test is 026 and the store before it is at 025', () => {
  const ids = listMigrations().map(m => m.id);
  assert.ok(ids.includes(BEFORE), 'migration 025 exists');
  assert.ok(ids.includes(TARGET), 'migration 026 exists');
  assert.match(listMigrations().find(m => m.id === TARGET).name, /goal/);
  const db = storeAt025();
  assert.equal(db.prepare('SELECT max(id) AS id FROM schema_migrations').get().id, BEFORE);
  assert.equal(db.prepare('PRAGMA table_info(goals)').all().some(c => c.name === 'done_at'), false);
});

test('migration 026 adds done_at and rewrites no goal row', () => {
  const db = storeAt025();
  const before = rows(db);
  assert.equal(before.length, Object.keys(DEFS).length);
  assert.deepEqual(migrate(db, { through: TARGET }).applied, [TARGET]);
  const after = rows(db);
  assert.deepEqual(after, before, 'every column of every goals row is unchanged');
  for (const r of after) assert.equal(r.def, JSON.stringify(DEFS[r.id]), `${r.id} def text is byte for byte the same`);
  const doneAt = db.prepare('PRAGMA table_info(goals)').all().find(c => c.name === 'done_at');
  assert.ok(doneAt, 'goals has a done_at column');
  assert.equal(doneAt.type, 'TEXT');
  assert.equal(doneAt.notnull, 0, 'done_at is nullable');
  assert.equal(doneAt.dflt_value, null, 'done_at has no default');
  assert.deepEqual(db.prepare('SELECT id, done_at FROM goals ORDER BY id').all().map(r => ({ ...r })),
    before.map(r => ({ id: r.id, done_at: null })), 'done_at is null on every row');
  assert.deepEqual(migrate(db, { through: TARGET }).applied, [], 'running it again applies nothing');
});

test('migration 026 changes no other table', () => {
  const db = storeAt025();
  const before = schema(db);
  migrate(db, { through: TARGET });
  const after = schema(db);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'no object is added or dropped');
  for (const [key, sql] of Object.entries(before)) {
    if (key === 'table:goals') continue;
    assert.equal(after[key], sql, `${key} is unchanged`);
  }
  assert.notEqual(after['table:goals'], before['table:goals']);
  assert.equal(after['table:goals'].replace(/,\s*done_at\s+TEXT(?=\s*\)\s*$)/i, ''), before['table:goals'], 'goals differs only by the added column');
});

test('loadGoals reads existing goals back identically, plus kind balance, status open, owner and priority unset', () => {
  const db = storeAt025();
  const pre = goalsRead(db);
  migrate(db, { through: TARGET });
  const post = goalsRead(db);
  assert.deepEqual(post, pre, 'the read is the same before and after the migration');
  assert.deepEqual(post.map(g => g.id).sort(), Object.keys(DEFS).sort());

  for (const g of post) {
    const def = DEFS[g.id];
    for (const [k, v] of Object.entries(def)) {
      if (k === 'kind' || k === 'status') continue;
      if (k === 'progress' && g.origin === 'owner') continue;
      assert.deepEqual(g[k], v, `${g.id}.${k} reads back as stored`);
    }
    assert.equal(g.kind, 'balance', `${g.id} defaults to kind balance`);
    assert.equal(g.owner, null, `${g.id} has no owner set`);
    assert.equal(g.priority, null, `${g.id} has no priority set`);
    assert.equal(g.doneAt, null, `${g.id} is not done`);
  }
  const byId = Object.fromEntries(post.map(g => [g.id, g]));
  assert.equal(byId.o_full.origin, 'owner');
  assert.equal(byId.o_full.status, 'open');
  assert.equal(byId.o_bare.status, 'open');
  assert.equal(byId.o_arch.status, 'archived');
  assert.equal(byId.o_arch.archived, true);
  assert.equal(byId.o_full.progress?.cur, 'bal.acc', 'owner goal progress still derives from the tracked account');

  // Seed goals: canonical status, the old display text as statusLabel.
  assert.equal(byId.s_track.status, 'open');
  assert.equal(byId.s_track.statusLabel, 'on track');
  assert.equal(byId.s_done.status, 'done', 'a finished seed goal reads done');
  assert.equal(byId.s_done.statusLabel, 'done');
  assert.equal(byId.s_legacy.status, 'open');
  assert.equal(byId.s_legacy.statusLabel, 'watch');
  assert.deepEqual(byId.s_track.progress, DEFS.s_track.progress, 'seed progress tokens are untouched');

  // The legacy topic moves to `topic` at read time and still links.
  assert.equal(byId.s_legacy.topic, 'education');
  for (const id of ['o_full', 'o_bare', 's_track', 's_done']) assert.equal(byId[id].topic, undefined, `${id} has no topic`);
  assert.deepEqual(servesGoals({ id: 'r', goalKinds: ['education'] }, post).map(g => g.id), ['s_legacy']);
  assert.equal(servesGoals({ id: 'r', goalKinds: ['home'] }, post).length, 0, 'the done seed goal links to nothing');
});

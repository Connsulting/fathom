// The link from a packs_state row (the UI pack the owner toggles) to the repo pack manifest the MCP
// pack tools read. A row def may carry `manifest`, a manifest id. The demo seed tags the demo rows,
// migration 005 tags the rows of an existing demo store (never a real store), and an untagged row
// links by its own id.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import demo from '../demo/scenario.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { listMigrations, migrate, parseJson, setSetting } from '../src/store/db.mjs';
import { ROOT, tempDb } from './helpers/server.mjs';

// The independent expectation: demo row id to repo manifest id.
const LINKS = {
  scorp: 's-corp-owner',
  selfemp: 'self-employed-partnership',
  w2: 'w2-benefits',
  kids: 'kids-dependents',
  retire: 'advanced-retirement',
  giving: 'charitable-giving',
};
const UNLINKED = ['illinois', 'contractor', 'abroad', 'rental'];

const defs = db => Object.fromEntries(db.prepare('SELECT id, def FROM packs_state').all().map(r => [r.id, parseJson(r.def, null)]));
const manifestOf = (db, id) => {
  const row = db.prepare('SELECT def FROM packs_state WHERE id = ?').get(id);
  return row ? parseJson(row.def, {}).manifest : undefined;
};
const dumpPacks = db => db.prepare('SELECT * FROM packs_state ORDER BY id').all().map(r => JSON.stringify({ ...r }));

// Forget migration 005 so migrate() applies it again.
const forget005 = db => db.prepare('DELETE FROM schema_migrations WHERE id = 5').run();
const stripTags = db => db.prepare("UPDATE packs_state SET def = json_remove(def, '$.manifest')").run();

describe('the demo seed tags the demo pack rows', () => {
  let t;
  before(async () => {
    t = await tempDb();
    seedDemo(t.db);
  });
  after(() => t && t.close());

  test('the six rows with a manifest carry that manifest id, and each target exists on disk', () => {
    const all = defs(t.db);
    for (const [row, manifest] of Object.entries(LINKS)) {
      assert.ok(all[row], `seeded row ${row}`);
      assert.equal(all[row].manifest, manifest, `${row} links to ${manifest}`);
      assert.ok(existsSync(join(ROOT, 'packs', manifest, 'manifest.json')), `packs/${manifest}/manifest.json exists`);
    }
  });

  test('illinois, contractor, abroad and rental have no manifest', () => {
    const all = defs(t.db);
    for (const row of UNLINKED) {
      assert.ok(all[row], `seeded row ${row}`);
      assert.ok(all[row].manifest == null, `${row} carries no manifest tag`);
    }
  });

  test('the demo rows are exactly the linked and unlinked ones', () => {
    assert.deepEqual(Object.keys(defs(t.db)).sort(), [...Object.keys(LINKS), ...UNLINKED].sort());
  });

  test('the tags are not lost on a reseed', () => {
    seedDemo(t.db);
    for (const [row, manifest] of Object.entries(LINKS)) assert.equal(manifestOf(t.db, row), manifest, row);
  });

  test('buildScenario still lists the seeded pack ids in order', () => {
    const scenario = buildScenario(t.db);
    assert.deepEqual(scenario.packs.map(p => p.id), demo.packs.map(p => p.id));
    assert.deepEqual(Object.keys(scenario.live.packs).sort(), demo.packs.map(p => p.id).sort());
  });
});

describe('migration 005 tags the rows of an existing demo store', () => {
  test('005 is a pack-manifest migration after 004', () => {
    const m = listMigrations().find(x => x.id === 5);
    assert.ok(m, 'a migration numbered 5 exists');
    assert.equal(m.name, 'pack-manifest');
  });

  test('stripping the tags and rerunning migrate restores them; a second migrate is a no-op', async () => {
    const t = await tempDb();
    try {
      seedDemo(t.db);
      const tagged = dumpPacks(t.db);
      stripTags(t.db);
      for (const row of Object.keys(LINKS)) assert.ok(manifestOf(t.db, row) == null, `${row} stripped`);
      forget005(t.db);

      const first = migrate(t.db);
      assert.deepEqual(first.applied, [5], 'migration 5 applied');
      for (const [row, manifest] of Object.entries(LINKS)) assert.equal(manifestOf(t.db, row), manifest, `${row} restored`);
      for (const row of UNLINKED) assert.ok(manifestOf(t.db, row) == null, `${row} stays untagged`);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM packs_state').get().n, Object.keys(LINKS).length + UNLINKED.length);
      assert.equal(t.db.prepare('SELECT name FROM schema_migrations WHERE id = 5').get().name, 'pack-manifest');

      const settled = dumpPacks(t.db);
      assert.deepEqual(migrate(t.db).applied, [], 'second migrate applies nothing');
      assert.deepEqual(dumpPacks(t.db), settled, 'second migrate changes nothing');
      assert.deepEqual(settled.length, tagged.length);
    } finally {
      t.close();
    }
  });

  test('the migration SQL itself is idempotent: applying it twice leaves the same rows', async () => {
    const t = await tempDb();
    try {
      seedDemo(t.db);
      stripTags(t.db);
      forget005(t.db);
      migrate(t.db);
      const once = dumpPacks(t.db);
      forget005(t.db);
      assert.deepEqual(migrate(t.db).applied, [5]);
      assert.deepEqual(dumpPacks(t.db), once);
    } finally {
      t.close();
    }
  });

  test('a demo row with an id outside the mapping stays untagged, other def fields survive', async () => {
    const t = await tempDb();
    try {
      seedDemo(t.db);
      t.db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                    VALUES ('custom', '{"id":"custom","status":"available","why":"A synthetic row."}', NULL, 0, 0, 0, '[]', 99, '2026-11-01T09:00:00Z')`).run();
      const before = defs(t.db).scorp;
      stripTags(t.db);
      forget005(t.db);
      migrate(t.db);
      assert.ok(manifestOf(t.db, 'custom') == null);
      assert.equal(parseJson(t.db.prepare("SELECT def FROM packs_state WHERE id = 'custom'").get().def, {}).why, 'A synthetic row.');
      assert.deepEqual(defs(t.db).scorp, before, 'the scorp def is the seeded def again, tag included');
    } finally {
      t.close();
    }
  });

  test('a real store with a row named scorp stays untagged', async () => {
    const t = await tempDb();
    try {
      setSetting(t.db, 'mode', 'real');
      t.db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                    VALUES ('scorp', '{"id":"scorp","status":"available"}', NULL, 0, 0, 0, '[]', 0, '2026-11-01T09:00:00Z')`).run();
      forget005(t.db);
      migrate(t.db);
      assert.ok(manifestOf(t.db, 'scorp') == null, 'real-mode scorp row is not tagged');
      assert.deepEqual(defs(t.db).scorp, { id: 'scorp', status: 'available' });
    } finally {
      t.close();
    }
  });

  test('a store with no mode setting stays untagged too', async () => {
    const t = await tempDb();
    try {
      t.db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                    VALUES ('kids', '{"id":"kids"}', NULL, 0, 0, 0, '[]', 0, '2026-11-01T09:00:00Z')`).run();
      forget005(t.db);
      migrate(t.db);
      assert.ok(manifestOf(t.db, 'kids') == null);
    } finally {
      t.close();
    }
  });

  test('a fresh migrated store has no pack rows to tag', async () => {
    const t = await tempDb();
    try {
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM packs_state').get().n, 0);
      assert.deepEqual(migrate(t.db).applied, []);
    } finally {
      t.close();
    }
  });
});

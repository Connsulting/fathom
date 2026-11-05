// AC2: the frozen pack-state seam (src/packs/state.mjs): packs_state rows carry the CONTRACT pack
// def computed from the loaded packs and the stored facts, keep the owner's live columns and the
// previous what-if conversation, drop packs that are no longer loaded, and touch updated_at only
// when the def changes.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultPackDirs, refreshPackState, refreshPackStateIn } from '../src/packs/state.mjs';
import { loadPacks, activePacks } from '../src/packs/index.mjs';
import { tx } from '../src/store/db.mjs';
import { scratch, createRealStore, addFact, parseJson, PACKS_DIR } from './helpers/real-store.mjs';

const S = scratch('fathom-packs-');
after(() => S.cleanup());
const OPTS = { packDirs: [PACKS_DIR] };
const PACKS = loadPacks([PACKS_DIR]);
const pause = ms => new Promise(r => setTimeout(r, ms));

function storeWithFacts(facts = { 'income.sCorp': true, 'household.state': 'VA', 'household.dependents': 1 }) {
  const db = S.track(createRealStore(S.dir()));
  for (const [k, v] of Object.entries(facts)) addFact(db, k, v);
  return { db, facts };
}
const rows = db => Object.fromEntries(db.prepare('SELECT * FROM packs_state').all().map(r => [r.id, { ...r, def: parseJson(r.def, {}) }]));

test('AC2: refreshPackState writes one row per loaded pack with the CONTRACT def and returns the activation', () => {
  const { db, facts } = storeWithFacts();
  const activation = refreshPackState(db, OPTS);
  const oracle = activePacks(PACKS, facts);
  const byIdOrder = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  assert.deepEqual(
    activation.map(a => ({ id: a.id, status: a.status, why: a.why })).sort(byIdOrder),
    oracle.map(a => ({ id: a.pack.id, status: a.status, why: a.why })).sort(byIdOrder),
  );
  const byId = rows(db);
  assert.deepEqual(Object.keys(byId).sort(), PACKS.map(p => p.id).sort());
  for (const { pack, status, why } of oracle) {
    const r = byId[pack.id];
    assert.deepEqual(Object.keys(r.def).sort(), ['covers', 'curator', 'entries', 'id', 'name', 'recIds', 'status', 'updated', 'whatIf', 'why'].sort(), `${pack.id} def keys`);
    assert.equal(r.def.id, pack.id);
    assert.equal(r.def.name, pack.name);
    assert.equal(r.def.status, status);
    assert.equal(r.def.why, why);
    assert.deepEqual(r.def.covers, pack.covers);
    assert.equal(r.def.entries, pack.entries.length);
    assert.equal(r.def.curator, pack.curator);
    assert.equal(r.def.updated, pack.reviewed);
    assert.deepEqual(r.def.recIds, []);
    assert.deepEqual(r.def.whatIf, { prompt: pack.whatIf.prompt, a: [], unlocks: [] });
    assert.equal(r.active, null, 'no owner override yet');
  }
  assert.equal(byId['s-corp-owner'].def.status, 'active');
  assert.equal(byId['virginia-resident'].def.status, 'active');
  assert.equal(byId['kids-dependents'].def.status, 'active');
  const sorted = db.prepare('SELECT id, sort FROM packs_state ORDER BY sort').all();
  sorted.forEach((r, i) => assert.equal(r.sort, i, `${r.id} sort`));
});

test('AC2: the owner live columns and the previous what-if answers survive a refresh', () => {
  const { db } = storeWithFacts();
  refreshPackState(db, OPTS);
  const prev = rows(db)['s-corp-owner'].def;
  const whatIf = { ...prev.whatIf, a: ['A synthetic what-if paragraph.'], unlocks: [{ title: 'Synthetic unlock', text: 'Example.' }] };
  db.prepare(`UPDATE packs_state SET def = ?, active = 0, exploring = 1, what_if_asked = 1, what_if_done = 1, unhid = '["scorp-salary"]'
              WHERE id = 's-corp-owner'`).run(JSON.stringify({ ...prev, whatIf }));
  refreshPackState(db, OPTS);
  const r = rows(db)['s-corp-owner'];
  assert.deepEqual([r.active, r.exploring, r.what_if_asked, r.what_if_done, r.unhid], [0, 1, 1, 1, '["scorp-salary"]']);
  assert.deepEqual(r.def.whatIf.a, whatIf.a);
  assert.deepEqual(r.def.whatIf.unlocks, whatIf.unlocks);
  assert.equal(r.def.status, 'active', 'base status still from facts');
});

test('AC2: rows for packs that are not loaded are removed', () => {
  const { db } = storeWithFacts();
  db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
              VALUES ('retired-pack', '{"id":"retired-pack"}', NULL, 0, 0, 0, '[]', 99, '2026-01-01T00:00:00Z')`).run();
  refreshPackState(db, OPTS);
  assert.equal(db.prepare("SELECT 1 FROM packs_state WHERE id = 'retired-pack'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM packs_state WHERE id = 's-corp-owner'").get(), 'loaded packs stay');
});

test('AC2: recIds list the recs whose pack_id is the pack, sorted', () => {
  const { db } = storeWithFacts();
  const insert = db.prepare(`INSERT INTO recs (id, def, status, tasks_done, pack_id, sort, updated_at) VALUES (?, '{}', 'proposed', '[]', ?, 0, '2026-11-05T00:00:00Z')`);
  insert.run('scorp-salary', 's-corp-owner');
  insert.run('invoice-deferral', 's-corp-owner');
  insert.run('va529', 'virginia-resident');
  refreshPackState(db, OPTS);
  const byId = rows(db);
  assert.deepEqual(byId['s-corp-owner'].def.recIds, ['invoice-deferral', 'scorp-salary']);
  assert.deepEqual(byId['virginia-resident'].def.recIds, ['va529']);
  assert.deepEqual(byId['charitable-giving'].def.recIds, []);
});

test('AC2: updated_at moves only when the def changes', async () => {
  const { db } = storeWithFacts();
  refreshPackState(db, OPTS);
  const stamps = () => Object.fromEntries(db.prepare('SELECT id, updated_at FROM packs_state').all().map(r => [r.id, r.updated_at]));
  const before = stamps();
  await pause(15);
  refreshPackState(db, OPTS);
  assert.deepEqual(stamps(), before, 'no def change, no write');
  addFact(db, 'giving.charitable', true);
  await pause(15);
  refreshPackState(db, OPTS);
  const after = stamps();
  assert.notEqual(after['charitable-giving'], before['charitable-giving'], 'the activated pack is rewritten');
  assert.equal(after['w2-benefits'], before['w2-benefits'], 'an unaffected pack is not');
  assert.equal(rows(db)['charitable-giving'].def.status, 'active');
});

test('AC2: refreshPackStateIn runs inside the caller transaction without nesting BEGIN', () => {
  const { db } = storeWithFacts();
  const activation = tx(db, () => refreshPackStateIn(db, OPTS));
  assert.ok(Array.isArray(activation) && activation.length === PACKS.length);
  assert.equal(db.prepare('SELECT count(*) AS n FROM packs_state').get().n, PACKS.length);
  // and it rolls back with the caller
  const { db: other } = storeWithFacts();
  assert.throws(() => tx(other, () => { refreshPackStateIn(other, OPTS); throw new Error('caller failure'); }), /caller failure/);
  assert.equal(other.prepare('SELECT count(*) AS n FROM packs_state').get().n, 0);
});

test('AC2: defaultPackDirs is the repo packs, plus the data directory your-plans folder when it exists', () => {
  const dir = S.dir();
  assert.deepEqual(defaultPackDirs(dir).map(d => resolve(d)), [resolve(PACKS_DIR)]);
  const yours = join(dir, 'packs', 'your-plans');
  mkdirSync(yours, { recursive: true });
  assert.deepEqual(defaultPackDirs(dir).map(d => resolve(d)), [resolve(PACKS_DIR), resolve(yours)]);
});

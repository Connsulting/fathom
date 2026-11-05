// AC2: the pack-state seam (src/packs/state.mjs): a refresh keeps the owner's live columns and the
// previous what-if conversation, and touches updated_at only when the def changes.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultPackDirs, refreshPackState } from '../src/packs/state.mjs';
import { scratch, createRealStore, addFact, parseJson, PACKS_DIR } from './helpers/real-store.mjs';

const S = scratch('fathom-packs-');
after(() => S.cleanup());
const OPTS = { packDirs: [PACKS_DIR] };
const pause = ms => new Promise(r => setTimeout(r, ms));

async function storeWithFacts(facts = { 'income.sCorp': true, 'household.state': 'VA', 'household.dependents': 1 }) {
  const db = S.track(await createRealStore(S.dir()));
  for (const [k, v] of Object.entries(facts)) addFact(db, k, v);
  return { db, facts };
}
const rows = db => Object.fromEntries(db.prepare('SELECT * FROM packs_state').all().map(r => [r.id, { ...r, def: parseJson(r.def, {}) }]));

test('AC2: the owner live columns and the previous what-if answers survive a refresh', async () => {
  const { db } = await storeWithFacts();
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

test('AC2: updated_at moves only when the def changes', async () => {
  const { db } = await storeWithFacts();
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

test('AC2: defaultPackDirs is the repo packs, plus the data directory your-plans folder when it exists', () => {
  const dir = S.dir();
  assert.deepEqual(defaultPackDirs(dir).map(d => resolve(d)), [resolve(PACKS_DIR)]);
  const yours = join(dir, 'packs', 'your-plans');
  mkdirSync(yours, { recursive: true });
  assert.deepEqual(defaultPackDirs(dir).map(d => resolve(d)), [resolve(PACKS_DIR), resolve(yours)]);
});

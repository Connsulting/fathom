// AC4: live packs. Facts in the store (upsertFact, getFacts) drive manifest activation through
// refreshPackState in real stores (rows keyed by manifest id, overrides kept); demo stores keep
// their seeded rows, and the live view (src/packs/live.mjs) adds the backing manifest's fields to
// the seven tagged demo rows (D7, D8, R2, R3). A Your plans pack in the data dir loads, a broken one
// is skipped with a warning, and loaded() follows packs.generation and the Your plans dir (D9, R12).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertFact, getFacts } from '../../store/facts.mjs';
import { REPO_PACKS_DIR, defaultPackDirs } from '../state.mjs';
import { yourPlansDir, loadLivePacks, refreshLivePacks, createLivePacks } from '../live.mjs';
import { openDb, migrate, setSetting, MIGRATIONS_DIR, parseJson } from '../../store/db.mjs';
import { seedDemo } from '../../../demo/seed.mjs';
import demo from '../../../demo/scenario.mjs';
import { forEachSeries } from '../../shared/series.mjs';

const REPO_PACKS = resolve(fileURLToPath(new URL('../../../packs/', import.meta.url)));
const ALIASES = {
  scorp: 's-corp-owner', selfemp: 'self-employed-partnership', w2: 'w2-benefits', virginia: 'virginia-resident',
  kids: 'kids-dependents', retire: 'advanced-retirement', giving: 'charitable-giving',
};
const ILLUSTRATIVE = ['contractor', 'abroad', 'rental'];
const ALWAYS_ACTIVE = ['account-tax-treatment', 'spending-and-obligations'];
const PUBLIC_IDS = [...Object.values(ALIASES), ...ALWAYS_ACTIVE].sort();
const DEMO_IDS = demo.packs.map(p => p.id).sort();
const manifestOf = id => JSON.parse(readFileSync(join(REPO_PACKS, id, 'manifest.json'), 'utf8'));

// Synthetic facts matching the demo household, for stores built without the seed.
const FACTS = {
  'household.state': 'VA', 'household.filingStatus': 'mfj', 'household.dependents': 1, 'household.expectingChild': true,
  'income.w2': true, 'income.sCorp': true, 'income.selfEmployed': true, 'income.partnership': true,
  'benefits.hsa': true, 'benefits.employer401k': true, 'retirement.solo401k': true, 'retirement.ira': true,
  'retirement.backdoorRothCandidate': true, 'accounts.has529': true, 'giving.charitable': false, 'income.agiEstimate': 380000,
};

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'fathom-pack-live-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// seed: the demo seed; else a real store holding FACTS.
async function store(t, { seed = true, facts = FACTS } = {}) {
  const dataDir = scratch(t);
  const db = await openDb(join(dataDir, 'fathom.sqlite'));
  t.after(async () => await db.close());
  await migrate(db);
  if (seed) await seedDemo(db);
  else {
    await setSetting(db, 'mode', 'real');
    for (const [key, value] of Object.entries(facts)) await upsertFact(db, { key, value, src: 'you', confirmed: true });
  }
  return { db, dataDir };
}

const rows = async db => (await db.prepare('SELECT * FROM packs_state ORDER BY id').all()).map(r => ({ ...r, def: parseJson(r.def, {}) }));
const row = async (db, id) => (await rows(db)).find(r => r.id === id);

function writePack(dir, overrides = {}, body = '# Synthetic plan entry\n\nThe owner reviews the synthetic plan.\n') {
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id: 'your-plans', name: 'Your plans', version: '1.0.0', taxYear: 2026, reviewed: '2026-11-05',
    curator: 'Built from your documents', covers: ['Synthetic plan entry'], appliesWhen: { all: [] },
    whatIf: { prompt: 'What do our own plan and benefits documents say about the choices in front of us?' },
    entries: [{ file: '01-synthetic-plan-entry.md', title: 'Synthetic plan entry',
      cites: [{ label: 'synthetic-plan.md, page 1', url: 'https://your-plans.invalid/file-synthetic?page=1' }] }],
    ...overrides,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const entry of manifest.entries) writeFileSync(join(dir, entry.file), body);
  return manifest;
}

// ---------------------------------------------------------------- facts

test('upsertFact never lets an unconfirmed value overwrite a confirmed one, and getFacts is flat', async t => {
  const { db } = await store(t, { seed: false, facts: {} });
  await db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
              VALUES ('file-synthetic', 'synthetic.csv', 'text/csv', 1, NULL, 'other', '2026-11-01T00:00:00Z', NULL, 'parsed', '')`).run();
  assert.deepEqual(await upsertFact(db, { key: 'household.dependents', value: 1 }), { written: true, changed: true });
  assert.deepEqual(await upsertFact(db, { key: 'household.dependents', value: 2 }), { written: true, changed: true }, 'unconfirmed over unconfirmed');
  assert.deepEqual(await upsertFact(db, { key: 'household.dependents', value: 3, src: 'you', confirmed: true }), { written: true, changed: true });
  assert.equal((await upsertFact(db, { key: 'household.dependents', value: 4, src: 'parser',
    provenance: { fileId: 'file-synthetic', parser: 'synthetic', locator: 'row 2' } })).written, false);
  assert.equal((await getFacts(db))['household.dependents'], 3, 'the confirmed value stands');
  // An identical write (same value and provenance) is a no-op (test/store-facts.test.mjs MGI4).
  assert.deepEqual(await upsertFact(db, { key: 'household.dependents', value: 3, src: 'you', confirmed: true }), { written: false, changed: false, reason: 'unchanged' }, 'same value');
  assert.deepEqual(await upsertFact(db, { key: 'household.dependents', value: 5, src: 'you', confirmed: true }), { written: true, changed: true }, 'confirmed over confirmed');

  await upsertFact(db, { key: 'household.state', value: 'VA', asOf: '2026-11-01',
    provenance: { fileId: 'file-synthetic', parser: 'synthetic', locator: 'row 1' } });
  await upsertFact(db, { key: 'household.dependentAges', value: [2] });
  await upsertFact(db, { key: 'income.w2', value: true });
  assert.deepEqual(await getFacts(db), { 'household.dependents': 5, 'household.state': 'VA', 'household.dependentAges': [2], 'income.w2': true });
  const stored = await db.prepare("SELECT * FROM facts WHERE key = 'household.state'").get();
  assert.equal(stored.file_id, 'file-synthetic');
  assert.equal(stored.parser, 'synthetic');
  assert.equal(stored.locator, 'row 1');
  assert.equal(stored.as_of, '2026-11-01');
  assert.equal(stored.confirmed, 0);
  assert.equal(JSON.parse(stored.value), 'VA');
});

// ---------------------------------------------------------------- dirs and loading

test('pack dirs are the repo packs plus the data dir your-plans pack when it exists', t => {
  const dataDir = scratch(t);
  assert.equal(resolve(REPO_PACKS_DIR), REPO_PACKS);
  assert.equal(yourPlansDir(dataDir), join(dataDir, 'packs', 'your-plans'));
  assert.deepEqual(defaultPackDirs(dataDir).map(d => resolve(d)), [REPO_PACKS]);
  assert.deepEqual(loadLivePacks(dataDir).dirs.map(d => resolve(d)), [REPO_PACKS]);
  writePack(yourPlansDir(dataDir));
  assert.deepEqual(defaultPackDirs(dataDir).map(d => resolve(d)), [REPO_PACKS, yourPlansDir(dataDir)]);
  const live = loadLivePacks(dataDir);
  assert.deepEqual(live.dirs.map(d => resolve(d)), [REPO_PACKS, yourPlansDir(dataDir)]);
  assert.ok(live.packs.some(p => p.id === 'your-plans'));
  assert.deepEqual(live.warnings, []);
});

test('a broken your-plans pack is skipped with a warning that carries none of its contents', async t => {
  const { db, dataDir } = await store(t, { seed: false });
  const dir = yourPlansDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{"id": "your-plans", "name": "SYNTHETIC-PRIVATE-PLAN-TEXT"');
  const logged = [];
  for (const name of ['log', 'info', 'warn', 'error']) t.mock.method(console, name, (...args) => { logged.push(args.map(String).join(' ')); });
  const result = await refreshLivePacks(db, { dataDir });
  assert.ok(result.warnings.length >= 1);
  assert.ok(result.warnings.every(w => !w.includes('SYNTHETIC-PRIVATE-PLAN-TEXT')));
  assert.ok(logged.length >= 1, 'the skip is logged');
  assert.ok(logged.every(line => !line.includes('SYNTHETIC-PRIVATE-PLAN-TEXT')));
  assert.equal(await row(db, 'your-plans'), undefined);
  assert.ok(await row(db, 's-corp-owner'), 'repo packs still refresh');
});

// ---------------------------------------------------------------- refresh

test('in a real store the refresh writes manifest rows, keeps overrides, and a fact change flips the base status', async t => {
  const { db, dataDir } = await store(t, { seed: false });
  await refreshLivePacks(db, { dataDir });
  assert.deepEqual((await rows(db)).map(r => r.id).sort(), PUBLIC_IDS);
  assert.equal((await row(db, 'charitable-giving')).def.status, 'suggested');
  assert.equal((await row(db, 's-corp-owner')).def.status, 'active');
  await db.prepare("UPDATE packs_state SET exploring = 1, what_if_asked = 1, unhid = '[\"daf\"]' WHERE id = 'charitable-giving'").run();
  await db.prepare("UPDATE packs_state SET active = 0 WHERE id = 's-corp-owner'").run();

  await upsertFact(db, { key: 'giving.charitable', value: true, src: 'you', confirmed: true });
  await refreshLivePacks(db, { dataDir });
  const giving = await row(db, 'charitable-giving');
  assert.equal(giving.def.status, 'active');
  assert.match(giving.def.why, /giving\.charitable/);
  assert.equal(giving.exploring, 1, 'overrides survive the flip');
  assert.equal(giving.what_if_asked, 1);
  assert.deepEqual(JSON.parse(giving.unhid), ['daf']);
  assert.equal((await row(db, 's-corp-owner')).active, 0);
});

test('a demo store keeps its seeded rows; the view adds the backing manifest fields to the seven tagged rows', async t => {
  const { db, dataDir } = await store(t);
  const before = await rows(db);
  const packs = createLivePacks(db, { dataDir });
  packs.refresh();
  const after = await rows(db);
  const added = after.filter(r => !before.some(b => b.id === r.id));
  assert.deepEqual(added.map(r => r.id).sort(), ALWAYS_ACTIVE, 'only the unseeded always-active packs are added');
  for (const row of added) assert.equal(row.def.status, 'active', row.id);
  for (const prior of before) assert.deepEqual(after.find(r => r.id === prior.id), prior, 'seeded rows stay untouched');
  for (const [id, manifestId] of Object.entries(ALIASES)) {
    const prior = before.find(r => r.id === id).def;
    const def = packs.view(id, prior);
    const manifest = manifestOf(manifestId);
    assert.equal(def.id, id);
    assert.equal(def.manifest, manifestId);
    assert.equal(def.name, prior.name, 'the demo display name is kept');
    assert.equal(def.status, prior.status, 'the seeded base status is kept');
    assert.equal(def.version, manifest.version);
    assert.equal(def.taxYear, manifest.taxYear);
    assert.equal(def.reviewed, manifest.reviewed);
    assert.equal(def.curator, manifest.curator);
    assert.equal(def.entries, manifest.entries.length);
    assert.equal(def.entryList.length, manifest.entries.length);
    for (const entry of def.entryList) {
      assert.deepEqual(Object.keys(entry).sort(), ['cites', 'id', 'title']);
      assert.ok(entry.cites.length > 0);
    }
    assert.deepEqual(def.recIds, prior.recIds);
    assert.equal(def.whatIf.prompt, manifest.whatIf.prompt);
    assert.ok(!/\{[a-z]+:/.test(def.why), `${id} why carries no scenario token, since it renders literally`);
    assert.deepEqual(def.whatIf.a, prior.whatIf.a);
    assert.deepEqual(def.whatIf.unlocks, prior.whatIf.unlocks);
    assert.equal(packs.backing(id, prior).id, manifestId);
  }
  assert.equal(packs.view('giving', (await row(db, 'giving')).def).status, 'suggested');
  for (const id of ILLUSTRATIVE) {
    const def = (await row(db, id)).def;
    assert.deepEqual(packs.view(id, def), def, `${id} has no manifest view`);
    assert.equal(packs.backing(id, def), null);
  }
});

test('a your-plans pack from the data dir becomes an active row in a real store and in a demo store', async t => {
  for (const seed of [false, true]) {
    const { db, dataDir } = await store(t, { seed });
    writePack(yourPlansDir(dataDir));
    const result = await refreshLivePacks(db, { dataDir });
    assert.deepEqual(result.warnings, []);
    const yp = await row(db, 'your-plans');
    assert.ok(yp, `your-plans row exists (${seed ? 'demo' : 'real'})`);
    assert.equal(yp.def.status, 'active');
    const view = createLivePacks(db, { dataDir }).view('your-plans', yp.def);
    assert.equal(view.manifest, 'your-plans');
    assert.equal(view.entryList[0].id, '01-synthetic-plan-entry');
    await refreshLivePacks(db, { dataDir });
    assert.equal((await rows(db)).filter(r => r.id === 'your-plans').length, 1, 'no duplicate row');
  }
  const { db, dataDir } = await store(t);
  await refreshLivePacks(db, { dataDir });
  assert.deepEqual((await rows(db)).map(r => r.id).sort(), [...DEMO_IDS, ...ALWAYS_ACTIVE].sort(),
    'a demo store gains the unseeded always-active packs and no other repository row');
});

// ---------------------------------------------------------------- demo upgrade (R2)

// A store at schema 001 holding the pre-change demo pack rows (defs without manifest or label).
async function preChangeStore(t, mode, facts = FACTS) {
  const dataDir = scratch(t);
  const db = await openDb(join(dataDir, 'fathom.sqlite'));
  t.after(async () => await db.close());
  await db.applySchema('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  await db.applySchema(readFileSync(join(MIGRATIONS_DIR, '001-foundation.sql'), 'utf8'));
  await db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (1, 'foundation', '2026-11-01T00:00:00Z')").run();
  await setSetting(db, 'mode', mode);
  const insert = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                             VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, '2026-11-01T00:00:00Z')`);
  await forEachSeries(demo.packs, async (p, i) => await insert.run(p.id, JSON.stringify(p), i));
  const fact = db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                           VALUES (?, ?, 'you', '2026-11-05', 1, NULL, NULL, NULL, '2026-11-05T00:00:00Z')`);
  for (const [key, value] of Object.entries(facts)) await fact.run(key, JSON.stringify(value));
  return { db, dataDir };
}

test('an existing demo store upgrades through the migration: ids, names and overrides kept, no duplicates', async t => {
  const { db, dataDir } = await preChangeStore(t, 'demo');
  await db.prepare("UPDATE packs_state SET active = 1 WHERE id = 'giving'").run();
  await db.prepare("UPDATE packs_state SET exploring = 1, what_if_asked = 1, what_if_done = 1 WHERE id = 'scorp'").run();
  const applied = (await migrate(db)).applied;
  assert.ok(applied.length >= 1 && !applied.includes(1));
  for (const [id, manifestId] of Object.entries(ALIASES)) {
    const def = (await row(db, id)).def;
    assert.equal(def.manifest, manifestId, `${id} is tagged by the migration`);
    assert.equal(def.label, demo.packs.find(p => p.id === id).name);
  }
  const packs = createLivePacks(db, { dataDir });
  packs.refresh();
  assert.deepEqual((await rows(db)).map(r => r.id).sort(), [...DEMO_IDS, ...ALWAYS_ACTIVE].sort(), 'no duplicate manifest rows');
  assert.equal((await row(db, 'giving')).active, 1);
  assert.equal(packs.view('giving', (await row(db, 'giving')).def).version, manifestOf('charitable-giving').version);
  assert.equal((await row(db, 'scorp')).exploring, 1);
  assert.equal((await row(db, 'scorp')).what_if_done, 1);
  assert.equal((await row(db, 'scorp')).def.name, 'S corp owner');
  for (const id of ILLUSTRATIVE) assert.equal((await row(db, id)).def.manifest, undefined);
});

test('a real store is not tagged by the migration, so its never-manifest rows stay untouched', async t => {
  const { db, dataDir } = await preChangeStore(t, 'real');
  const scorpBefore = await row(db, 'scorp');
  await migrate(db);
  assert.equal((await row(db, 'scorp')).def.manifest, undefined);
  await refreshLivePacks(db, { dataDir });
  assert.deepEqual((await row(db, 'scorp')).def, scorpBefore.def);
  assert.ok(await row(db, 's-corp-owner'), 'the manifest gets its own row');
});

// The demo fact set as the pre-change seed wrote it: no income.agiEstimate.
const OLD_FACTS = Object.fromEntries(Object.entries(FACTS).filter(([key]) => key !== 'income.agiEstimate'));
const factValue = async (db, key) => {
  const r = await db.prepare('SELECT value FROM facts WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : undefined;
};

test('the upgrade adds income.agiEstimate to an old demo store and keeps an existing one', async t => {
  const old = (await preChangeStore(t, 'demo', OLD_FACTS)).db;
  assert.equal(await factValue(old, 'income.agiEstimate'), undefined, 'the fixture has the old fact set');
  await migrate(old);
  assert.equal(await factValue(old, 'income.agiEstimate'), 380000);
  const kept = (await preChangeStore(t, 'demo', { ...OLD_FACTS, 'income.agiEstimate': 120000 })).db;
  await migrate(kept);
  assert.equal(await factValue(kept, 'income.agiEstimate'), 120000, 'not overwritten');
});

test('the upgrade inserts no fact into a real store', async t => {
  const { db } = await preChangeStore(t, 'real', OLD_FACTS);
  const before = (await db.prepare('SELECT key, value FROM facts ORDER BY key').all()).map(r => ({ ...r }));
  await migrate(db);
  assert.deepEqual((await db.prepare('SELECT key, value FROM facts ORDER BY key').all()).map(r => ({ ...r })), before);
  assert.equal(await factValue(db, 'income.agiEstimate'), undefined);
});

// ---------------------------------------------------------------- live view

test('loaded() follows packs.generation and the your-plans dir, and entry() serves backed rows only', async t => {
  const { db, dataDir } = await store(t);
  const packs = createLivePacks(db, { dataDir });
  assert.deepEqual(packs.loaded().map(p => p.id).sort(), PUBLIC_IDS);
  assert.equal(packs.loaded(), packs.loaded(), 'nothing changed, nothing reloads');

  const entry = packs.entry('giving', 'bunching');
  const manifest = manifestOf('charitable-giving');
  assert.equal(entry.id, 'bunching');
  assert.equal(entry.title, manifest.entries.find(e => e.file === 'bunching.md').title);
  assert.equal(entry.body, readFileSync(join(REPO_PACKS, 'charitable-giving', 'bunching.md'), 'utf8'));
  assert.ok(entry.cites.length > 0);
  assert.equal(packs.entry('giving', 'no-such-entry'), null);
  assert.equal(packs.entry('contractor', 'bunching'), null, 'illustrative rows serve no entries');
  assert.equal(packs.entry('no-such-pack', 'bunching'), null);

  writePack(yourPlansDir(dataDir));
  await setSetting(db, 'packs.generation', 1);
  assert.ok(packs.loaded().some(p => p.id === 'your-plans'), 'a new your-plans pack appears without a restart');
  await refreshLivePacks(db, { dataDir });
  const yp = packs.entry('your-plans', '01-synthetic-plan-entry');
  assert.equal(yp.title, 'Synthetic plan entry');
  assert.match(yp.body, /synthetic plan/);
});

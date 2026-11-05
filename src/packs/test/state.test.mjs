// AC4: live pack state. Facts in the store (upsertFact, getFacts) drive manifest activation;
// refreshPackState rewrites manifest-backed packs_state rows by def.manifest (D7, D8, R2, R3),
// keeps overrides, leaves illustrative rows alone, deletes rows whose manifest is gone, loads a
// your-plans pack from the data dir and skips a broken one with a warning. The refresher
// fingerprints facts plus packs.generation (D9, R12) and recomputes its dirs on every refresh (R4).

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertFact, getFacts } from '../../store/facts.mjs';
import {
  REPO_PACKS_DIR, yourPlansDir, defaultPackDirs, refreshPackState, createPackRefresher,
} from '../state.mjs';
import { openDb, migrate, setSetting, MIGRATIONS_DIR, parseJson } from '../../store/db.mjs';
import { seedDemo } from '../../../demo/seed.mjs';
import demo from '../../../demo/scenario.mjs';

const REPO_PACKS = resolve(fileURLToPath(new URL('../../../packs/', import.meta.url)));
const ALIASES = {
  scorp: 's-corp-owner', selfemp: 'self-employed-partnership', w2: 'w2-benefits', virginia: 'virginia-resident',
  kids: 'kids-dependents', retire: 'advanced-retirement', giving: 'charitable-giving',
};
const ILLUSTRATIVE = ['contractor', 'abroad', 'rental'];
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
  const root = mkdtempSync(join(tmpdir(), 'fathom-pack-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function store(t, { seed = true } = {}) {
  const dataDir = scratch(t);
  const db = openDb(join(dataDir, 'fathom.sqlite'));
  t.after(() => db.close());
  migrate(db);
  if (seed) seedDemo(db);
  return { db, dataDir };
}

const rows = db => db.prepare('SELECT * FROM packs_state ORDER BY id').all().map(r => ({ ...r, def: parseJson(r.def, {}) }));
const row = (db, id) => rows(db).find(r => r.id === id);

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

test('upsertFact never lets an unconfirmed value overwrite a confirmed one, and getFacts is flat', t => {
  const { db } = store(t, { seed: false });
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
              VALUES ('file-synthetic', 'synthetic.csv', 'text/csv', 1, NULL, 'other', '2026-11-01T00:00:00Z', NULL, 'parsed', '')`).run();
  assert.deepEqual(upsertFact(db, { key: 'household.dependents', value: 1 }), { changed: true });
  assert.deepEqual(upsertFact(db, { key: 'household.dependents', value: 2 }), { changed: true }, 'unconfirmed over unconfirmed');
  assert.deepEqual(upsertFact(db, { key: 'household.dependents', value: 3, src: 'you', confirmed: true }), { changed: true });
  assert.deepEqual(upsertFact(db, { key: 'household.dependents', value: 4, src: 'parser',
    provenance: { fileId: 'file-synthetic', parser: 'synthetic', locator: 'row 2' } }), { changed: false });
  assert.equal(getFacts(db)['household.dependents'], 3, 'the confirmed value stands');
  assert.deepEqual(upsertFact(db, { key: 'household.dependents', value: 3, src: 'you', confirmed: true }), { changed: false }, 'same value');
  assert.deepEqual(upsertFact(db, { key: 'household.dependents', value: 5, src: 'you', confirmed: true }), { changed: true }, 'confirmed over confirmed');

  upsertFact(db, { key: 'household.state', value: 'VA', asOf: '2026-11-01',
    provenance: { fileId: 'file-synthetic', parser: 'synthetic', locator: 'row 1' } });
  upsertFact(db, { key: 'household.dependentAges', value: [2] });
  upsertFact(db, { key: 'income.w2', value: true });
  assert.deepEqual(getFacts(db), { 'household.dependents': 5, 'household.state': 'VA', 'household.dependentAges': [2], 'income.w2': true });
  const stored = db.prepare("SELECT * FROM facts WHERE key = 'household.state'").get();
  assert.equal(stored.file_id, 'file-synthetic');
  assert.equal(stored.parser, 'synthetic');
  assert.equal(stored.locator, 'row 1');
  assert.equal(stored.as_of, '2026-11-01');
  assert.equal(stored.confirmed, 0);
  assert.equal(JSON.parse(stored.value), 'VA');
});

// ---------------------------------------------------------------- dirs

test('pack dirs are the repo packs plus the data dir your-plans pack when it exists', t => {
  const dataDir = scratch(t);
  assert.equal(resolve(REPO_PACKS_DIR), REPO_PACKS);
  assert.equal(yourPlansDir(dataDir), join(dataDir, 'packs', 'your-plans'));
  assert.deepEqual(defaultPackDirs(dataDir).map(d => resolve(d)), [REPO_PACKS]);
  writePack(yourPlansDir(dataDir));
  assert.deepEqual(defaultPackDirs(dataDir).map(d => resolve(d)), [REPO_PACKS, yourPlansDir(dataDir)]);
});

// ---------------------------------------------------------------- refreshPackState

test('refresh rewrites the seven demo rows from manifests under their demo ids and keeps illustrative rows', t => {
  const { db } = store(t);
  const before = rows(db);
  const result = refreshPackState(db, { packDirs: [REPO_PACKS_DIR] });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.packs.length, Object.keys(ALIASES).length);
  assert.equal(result.activation.find(a => a.pack.id === 'charitable-giving').status, 'suggested');
  const after = rows(db);
  assert.deepEqual(after.map(r => r.id).sort(), DEMO_IDS, 'no duplicate manifest rows');
  for (const [id, manifestId] of Object.entries(ALIASES)) {
    const def = row(db, id).def;
    const manifest = manifestOf(manifestId);
    const prior = before.find(r => r.id === id).def;
    assert.equal(def.id, id);
    assert.equal(def.manifest, manifestId);
    assert.equal(def.name, prior.name, 'the demo display label is kept');
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
    assert.equal(def.updated, 'Nov 2026');
    assert.deepEqual(def.recIds, prior.recIds);
    assert.equal(def.whatIf.prompt, manifest.whatIf.prompt);
    assert.deepEqual(def.whatIf.a, prior.whatIf.a);
    assert.deepEqual(def.whatIf.unlocks, prior.whatIf.unlocks);
    assert.equal(typeof def.why, 'string');
  }
  assert.equal(row(db, 'scorp').def.status, 'active');
  assert.equal(row(db, 'giving').def.status, 'suggested');
  for (const id of ILLUSTRATIVE) assert.deepEqual(row(db, id), before.find(r => r.id === id), `${id} is untouched`);
});

test('refresh keeps overrides, and a fact change flips the base status on the next refresh', t => {
  const { db } = store(t);
  db.prepare("UPDATE packs_state SET exploring = 1, what_if_asked = 1, unhid = '[\"daf\"]' WHERE id = 'giving'").run();
  db.prepare("UPDATE packs_state SET active = 0 WHERE id = 'scorp'").run();
  refreshPackState(db, { packDirs: [REPO_PACKS_DIR] });
  assert.equal(row(db, 'giving').def.status, 'suggested');
  assert.equal(row(db, 'giving').exploring, 1);
  assert.equal(row(db, 'giving').what_if_asked, 1);
  assert.deepEqual(JSON.parse(row(db, 'giving').unhid), ['daf']);
  assert.equal(row(db, 'scorp').active, 0);

  assert.deepEqual(upsertFact(db, { key: 'giving.charitable', value: true, src: 'you', confirmed: true }), { changed: true });
  refreshPackState(db, { packDirs: [REPO_PACKS_DIR] });
  assert.equal(row(db, 'giving').def.status, 'active');
  assert.match(row(db, 'giving').def.why, /giving\.charitable/);
  assert.equal(row(db, 'giving').exploring, 1, 'overrides survive the flip');
  assert.equal(row(db, 'scorp').active, 0);
});

test('refresh deletes a manifest-backed row whose manifest is gone and leaves the rest', t => {
  const { db } = store(t);
  const root = scratch(t);
  for (const id of Object.values(ALIASES)) if (id !== 'charitable-giving') cpSync(join(REPO_PACKS, id), join(root, id), { recursive: true });
  refreshPackState(db, { packDirs: [root] });
  assert.equal(row(db, 'giving'), undefined);
  assert.deepEqual(rows(db).map(r => r.id).sort(), DEMO_IDS.filter(id => id !== 'giving'));
});

test('refresh loads a your-plans pack from the data dir as an active manifest row', t => {
  const { db, dataDir } = store(t);
  writePack(yourPlansDir(dataDir));
  const result = refreshPackState(db, { packDirs: defaultPackDirs(dataDir) });
  assert.deepEqual(result.warnings, []);
  const yp = row(db, 'your-plans');
  assert.ok(yp, 'your-plans row exists');
  assert.equal(yp.def.manifest, 'your-plans');
  assert.equal(yp.def.status, 'active');
  assert.equal(yp.def.entryList[0].id, '01-synthetic-plan-entry');
});

test('a broken your-plans pack is skipped with a warning that carries none of its contents', t => {
  const { db, dataDir } = store(t);
  const dir = yourPlansDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{"id": "your-plans", "name": "SYNTHETIC-PRIVATE-PLAN-TEXT"');
  const logged = [];
  for (const name of ['log', 'info', 'warn', 'error']) t.mock.method(console, name, (...args) => { logged.push(args.map(String).join(' ')); });
  const result = refreshPackState(db, { packDirs: defaultPackDirs(dataDir) });
  assert.ok(result.warnings.length >= 1);
  assert.ok(result.warnings.every(w => !w.includes('SYNTHETIC-PRIVATE-PLAN-TEXT')));
  assert.ok(logged.every(line => !line.includes('SYNTHETIC-PRIVATE-PLAN-TEXT')));
  assert.equal(row(db, 'your-plans'), undefined);
  assert.equal(row(db, 'scorp').def.manifest, 's-corp-owner', 'repo packs still load');
});

test('a broken pack directory other than your-plans fails loudly', t => {
  const { db } = store(t);
  const root = scratch(t);
  mkdirSync(join(root, 'broken'));
  writeFileSync(join(root, 'broken', 'manifest.json'), '{ not json');
  assert.throws(() => refreshPackState(db, { packDirs: [root] }));
});

// ---------------------------------------------------------------- demo upgrade (R2)

// A store at schema 001 holding the pre-change demo pack rows (defs without manifest or label).
function preChangeStore(t, mode) {
  const dataDir = scratch(t);
  const db = openDb(join(dataDir, 'fathom.sqlite'));
  t.after(() => db.close());
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  db.exec(readFileSync(join(MIGRATIONS_DIR, '001-foundation.sql'), 'utf8'));
  db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (1, 'foundation', '2026-11-01T00:00:00Z')").run();
  setSetting(db, 'mode', mode);
  const insert = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                             VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, '2026-11-01T00:00:00Z')`);
  demo.packs.forEach((p, i) => insert.run(p.id, JSON.stringify(p), i));
  const fact = db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                           VALUES (?, ?, 'you', '2026-11-05', 1, NULL, NULL, NULL, '2026-11-05T00:00:00Z')`);
  for (const [key, value] of Object.entries(FACTS)) fact.run(key, JSON.stringify(value));
  return db;
}

test('an existing demo store upgrades through the migration: ids, names and overrides kept, no duplicates', t => {
  const db = preChangeStore(t, 'demo');
  db.prepare("UPDATE packs_state SET active = 1 WHERE id = 'giving'").run();
  db.prepare("UPDATE packs_state SET exploring = 1, what_if_asked = 1, what_if_done = 1 WHERE id = 'scorp'").run();
  const applied = migrate(db).applied;
  assert.ok(applied.length >= 1 && !applied.includes(1));
  for (const [id, manifestId] of Object.entries(ALIASES)) {
    const def = row(db, id).def;
    assert.equal(def.manifest, manifestId, `${id} is tagged by the migration`);
    assert.equal(def.label, demo.packs.find(p => p.id === id).name);
  }
  refreshPackState(db, { packDirs: [REPO_PACKS_DIR] });
  assert.deepEqual(rows(db).map(r => r.id).sort(), DEMO_IDS, 'no duplicate manifest rows');
  assert.equal(row(db, 'giving').active, 1);
  assert.equal(row(db, 'giving').def.version, manifestOf('charitable-giving').version);
  assert.equal(row(db, 'scorp').exploring, 1);
  assert.equal(row(db, 'scorp').what_if_done, 1);
  assert.equal(row(db, 'scorp').def.name, 'S corp owner');
  for (const id of ILLUSTRATIVE) assert.equal(row(db, id).def.manifest, undefined);
});

test('a real store is not tagged by the migration, so its never-manifest rows stay untouched', t => {
  const db = preChangeStore(t, 'real');
  const scorpBefore = row(db, 'scorp');
  migrate(db);
  assert.equal(row(db, 'scorp').def.manifest, undefined);
  refreshPackState(db, { packDirs: [REPO_PACKS_DIR] });
  assert.deepEqual(row(db, 'scorp').def, scorpBefore.def);
  assert.equal(row(db, 's-corp-owner').def.manifest, 's-corp-owner', 'the manifest gets its own row');
});

// ---------------------------------------------------------------- refresher

test('the refresher detects fact and packs.generation changes by fingerprint and serves entries', t => {
  const { db, dataDir } = store(t);
  const packs = createPackRefresher(db, { dataDir });
  packs.refresh();
  assert.deepEqual(packs.loaded().map(p => p.id).sort(), Object.values(ALIASES).sort());
  assert.equal(packs.refreshIfFactsChanged(), false, 'nothing changed');
  upsertFact(db, { key: 'giving.charitable', value: true, src: 'you', confirmed: true });
  assert.equal(packs.refreshIfFactsChanged(), true);
  assert.equal(row(db, 'giving').def.status, 'active', 'the refresh ran');
  assert.equal(packs.refreshIfFactsChanged(), false);
  db.prepare("UPDATE facts SET value = 'false' WHERE key = 'giving.charitable'").run();
  assert.equal(packs.refreshIfFactsChanged(), true, 'a direct db write is seen');
  assert.equal(row(db, 'giving').def.status, 'suggested');
  setSetting(db, 'packs.generation', 1);
  assert.equal(packs.refreshIfFactsChanged(), true, 'a generation bump is seen');
  assert.equal(packs.refreshIfFactsChanged(), false);

  const entry = packs.entry('giving', 'bunching');
  const manifest = manifestOf('charitable-giving');
  assert.equal(entry.id, 'bunching');
  assert.equal(entry.title, manifest.entries.find(e => e.file === 'bunching.md').title);
  assert.equal(entry.body, readFileSync(join(REPO_PACKS, 'charitable-giving', 'bunching.md'), 'utf8'));
  assert.ok(entry.cites.length > 0);
  assert.equal(packs.entry('giving', 'no-such-entry'), null);
  assert.equal(packs.entry('contractor', 'bunching'), null, 'illustrative rows serve no entries');
  assert.equal(packs.entry('no-such-pack', 'bunching'), null);
});

test('the refresher recomputes its dirs on every refresh, so a new your-plans pack appears without a restart', t => {
  const { db, dataDir } = store(t);
  const packs = createPackRefresher(db, { dataDir });
  packs.refresh();
  assert.ok(!packs.loaded().some(p => p.id === 'your-plans'));
  writePack(yourPlansDir(dataDir));
  setSetting(db, 'packs.generation', 1);
  assert.equal(packs.refreshIfFactsChanged(), true);
  assert.ok(packs.loaded().some(p => p.id === 'your-plans'));
  assert.equal(row(db, 'your-plans').def.status, 'active');
  const entry = packs.entry('your-plans', '01-synthetic-plan-entry');
  assert.equal(entry.title, 'Synthetic plan entry');
  assert.match(entry.body, /synthetic plan/);
});

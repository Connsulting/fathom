// AC2: the frozen facts seam (src/store/facts.mjs): upsertFact ownership rules,
// provenance columns, and getFacts parsing every row.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { upsertFact, getFacts } from '../src/store/facts.mjs';
import { scratch, createRealStore } from './helpers/real-store.mjs';

const S = scratch('fathom-facts-');
after(() => S.cleanup());
const fresh = async () => S.track(await createRealStore(S.dir()));
const row = (db, key) => db.prepare('SELECT * FROM facts WHERE key = ?').get(key);

function addFile(db, id) {
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
              VALUES (?, 'synthetic.csv', 'text/csv', 1, 'x', 'bank_csv', '2026-11-01T00:00:00Z', NULL, 'parsed', NULL)`).run(id);
}

test('AC2: upsertFact inserts a row with JSON value and provenance columns', async () => {
  const db = await fresh();
  addFile(db, 'file-a');
  const out = upsertFact(db, {
    key: 'income.sCorp', value: true, src: 'planner', asOf: '2026-11-05', confirmed: false,
    provenance: { fileId: 'file-a', parser: 'planner', locator: { rule: 'entity', rows: [{ table: 'documents', id: 1 }], count: 1 } },
  });
  assert.equal(out.written, true);
  const r = row(db, 'income.sCorp');
  assert.equal(JSON.parse(r.value), true);
  assert.deepEqual([r.src, r.as_of, r.confirmed, r.file_id, r.parser], ['planner', '2026-11-05', 0, 'file-a', 'planner']);
  assert.deepEqual(JSON.parse(r.locator), { rule: 'entity', rows: [{ table: 'documents', id: 1 }], count: 1 });
  assert.ok(r.updated_at);
});

test('AC2: a confirmed row is never overwritten by an unconfirmed write', async () => {
  const db = await fresh();
  upsertFact(db, { key: 'accounts.has529', value: false, src: 'you', confirmed: true });
  const out = upsertFact(db, { key: 'accounts.has529', value: true, src: 'planner', confirmed: false });
  assert.deepEqual(out, { written: false, reason: 'confirmed' });
  const r = row(db, 'accounts.has529');
  assert.deepEqual([JSON.parse(r.value), r.src, r.confirmed], [false, 'you', 1]);
  // liveness: a confirmed write may replace it
  assert.equal(upsertFact(db, { key: 'accounts.has529', value: true, src: 'you', confirmed: true }).written, true);
  assert.equal(JSON.parse(row(db, 'accounts.has529').value), true);
});

test('AC2: an unconfirmed row is replaced by any write, and provenance is replaced with it', async () => {
  const db = await fresh();
  upsertFact(db, { key: 'benefits.hsa', value: true, src: 'planner', provenance: { parser: 'planner', locator: { rule: 'hsa' } } });
  const out = upsertFact(db, { key: 'benefits.hsa', value: false, src: 'you', confirmed: true });
  assert.equal(out.written, true);
  const r = row(db, 'benefits.hsa');
  assert.deepEqual([JSON.parse(r.value), r.src, r.confirmed, r.parser], [false, 'you', 1, null]);
  assert.ok(r.locator == null || JSON.parse(r.locator) == null, 'old locator dropped');
});

test('AC2: getFacts returns every row parsed by dotted key', async () => {
  const db = await fresh();
  upsertFact(db, { key: 'household.state', value: 'VA', src: 'you', confirmed: true });
  upsertFact(db, { key: 'household.dependentAges', value: [2], src: 'you', confirmed: true });
  upsertFact(db, { key: 'business.salaryRange', value: { min: 50000, max: 110000 }, src: 'you', confirmed: true });
  upsertFact(db, { key: 'household.expectingChild', value: true, src: 'you' });
  upsertFact(db, { key: 'household.dependents', value: 1, src: 'you' });
  assert.deepEqual(getFacts(db), {
    'household.state': 'VA',
    'household.dependentAges': [2],
    'business.salaryRange': { min: 50000, max: 110000 },
    'household.expectingChild': true,
    'household.dependents': 1,
  });
  assert.deepEqual(getFacts(await fresh()), {}, 'empty store, empty facts');
});

// MGI4 (plan R6-4): identical fact writes are no-ops in the shared upsertFact helper: no statement,
// no change flag, no updated_at churn. Provenance (src, as_of, confirmed, file_id, parser, locator)
// is part of identity, so a provenance-only change still writes.

const T1 = '2026-11-01T09:00:00.000Z';
const T2 = '2026-11-02T09:00:00.000Z';
const changes = db => db.prepare('SELECT total_changes() AS n').get().n;
const FACT = Object.freeze({ key: 'income.agiEstimate', value: 180000, src: 'planner', asOf: '2026-11-01', confirmed: false });

test('MGI4: an identical upsert writes nothing', async () => {
  const db = await fresh();
  addFile(db, 'file-a');
  const provenance = { fileId: 'file-a', parser: 'planner', locator: { rule: 'agi', rows: [{ table: 'figures', id: 1 }] } };
  assert.deepEqual(upsertFact(db, { ...FACT, provenance, now: T1 }), { written: true, changed: true });
  const before = changes(db);
  const out = upsertFact(db, { ...FACT, provenance: { ...provenance, locator: { ...provenance.locator } }, now: T2 });
  assert.deepEqual(out, { written: false, changed: false, reason: 'unchanged' });
  assert.equal(changes(db), before, 'no statement changed a row');
  assert.equal(row(db, FACT.key).updated_at, T1, 'updated_at is not churned');
});

test('MGI4: a provenance-only change still writes', async () => {
  const db = await fresh();
  addFile(db, 'file-a');
  upsertFact(db, { ...FACT, provenance: { fileId: 'file-a', parser: 'planner', locator: { rule: 'agi' } }, now: T1 });
  const out = upsertFact(db, { ...FACT, provenance: { fileId: 'file-a', parser: 'planner', locator: { rule: 'agi', count: 2 } }, now: T2 });
  assert.deepEqual(out, { written: true, changed: false });
  const r = row(db, FACT.key);
  assert.equal(r.updated_at, T2);
  assert.deepEqual(JSON.parse(r.locator), { rule: 'agi', count: 2 });
  // liveness: a changed value writes and reports the change
  assert.deepEqual(upsertFact(db, { ...FACT, value: 190000, provenance: { fileId: 'file-a', parser: 'planner', locator: { rule: 'agi', count: 2 } }, now: T2 }),
    { written: true, changed: true });
  assert.equal(JSON.parse(row(db, FACT.key).value), 190000);
});

test('MGI4: recordFact treats an identical value as accepted', async () => {
  const { recordFact } = await import('../src/ingest/confirm.mjs');
  const db = await fresh();
  addFile(db, 'file-a');
  const args = { key: 'income.w2', value: true, confidence: 0.95, sourceId: 'ing:extract-w2:all', fileId: 'file-a', parser: 'extract-w2', locator: { document: 'w2', field: 'employerName' }, asOf: '2026-12-31' };
  assert.deepEqual(recordFact(db, { ...args, now: T1 }), { written: true, changed: true, queued: false });
  const before = changes(db);
  assert.deepEqual(recordFact(db, { ...args, now: T2 }), { written: true, changed: false, queued: false });
  assert.equal(changes(db), before, 'nothing was written');
  assert.equal(row(db, 'income.w2').updated_at, T1);
});

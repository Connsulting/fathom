// AC2: the frozen facts seam (src/store/facts.mjs): upsertFact ownership and idempotence rules,
// provenance columns, and getFacts parsing every row.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { upsertFact, getFacts } from '../src/store/facts.mjs';
import { scratch, createRealStore } from './helpers/real-store.mjs';

const S = scratch('fathom-facts-');
after(() => S.cleanup());
const fresh = () => S.track(createRealStore(S.dir()));
const row = (db, key) => db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
const pause = ms => new Promise(r => setTimeout(r, ms));

function addFile(db, id) {
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
              VALUES (?, 'synthetic.csv', 'text/csv', 1, 'x', 'bank_csv', '2026-11-01T00:00:00Z', NULL, 'parsed', NULL)`).run(id);
}

test('AC2: upsertFact inserts a row with JSON value and provenance columns', () => {
  const db = fresh();
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

test('AC2: an identical write changes nothing and reports unchanged', async () => {
  const db = fresh();
  const fact = { key: 'giving.annualEstimate', value: 2500, src: 'planner', asOf: '2026-11-05', provenance: { parser: 'planner', locator: { rule: 'giving' } } };
  assert.equal(upsertFact(db, fact).written, true);
  const before = { ...row(db, fact.key) };
  await pause(10);
  assert.deepEqual(upsertFact(db, fact), { written: false, reason: 'unchanged' });
  assert.deepEqual({ ...row(db, fact.key) }, before, 'updated_at untouched');
  // liveness: a different value is written and moves updated_at
  await pause(10);
  assert.equal(upsertFact(db, { ...fact, value: 2600 }).written, true);
  assert.equal(JSON.parse(row(db, fact.key).value), 2600);
  assert.notEqual(row(db, fact.key).updated_at, before.updated_at);
});

test('AC2: a confirmed row is never overwritten by an unconfirmed write', () => {
  const db = fresh();
  upsertFact(db, { key: 'accounts.has529', value: false, src: 'you', confirmed: true });
  const out = upsertFact(db, { key: 'accounts.has529', value: true, src: 'planner', confirmed: false });
  assert.deepEqual(out, { written: false, reason: 'confirmed' });
  const r = row(db, 'accounts.has529');
  assert.deepEqual([JSON.parse(r.value), r.src, r.confirmed], [false, 'you', 1]);
  // liveness: a confirmed write may replace it
  assert.equal(upsertFact(db, { key: 'accounts.has529', value: true, src: 'you', confirmed: true }).written, true);
  assert.equal(JSON.parse(row(db, 'accounts.has529').value), true);
});

test('AC2: an unconfirmed row is replaced by any write, and provenance is replaced with it', () => {
  const db = fresh();
  upsertFact(db, { key: 'benefits.hsa', value: true, src: 'planner', provenance: { parser: 'planner', locator: { rule: 'hsa' } } });
  const out = upsertFact(db, { key: 'benefits.hsa', value: false, src: 'you', confirmed: true });
  assert.equal(out.written, true);
  const r = row(db, 'benefits.hsa');
  assert.deepEqual([JSON.parse(r.value), r.src, r.confirmed, r.parser], [false, 'you', 1, null]);
  assert.ok(r.locator == null || JSON.parse(r.locator) == null, 'old locator dropped');
});

test('AC2: getFacts returns every row parsed by dotted key', () => {
  const db = fresh();
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
  assert.deepEqual(getFacts(fresh()), {}, 'empty store, empty facts');
});

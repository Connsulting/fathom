import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateCases, manifestOf } from '../../evals/imports/generate.mjs';
import { validateSourceRef } from '../../src/ingest/model-contract.mjs';
import { readWorkbook } from '../../src/ingest/workbook.mjs';

test('24 base oracles reproduce their committed checksums and bytes from seed 20320417', () => {
  const cases = generateCases(); const repeat = generateCases();
  assert.equal(cases.length, 24); assert.equal(new Set(cases.map(c => c.family)).size, 12);
  assert.deepEqual(manifestOf(cases), JSON.parse(readFileSync(new URL('../../evals/imports/manifest.json', import.meta.url))));
  for (let i = 0; i < cases.length; i++) {
    assert.deepEqual(cases[i].bytes, repeat[i].bytes);
    assert.deepEqual(cases[i].oracle, repeat[i].oracle);
    assert.ok(cases[i].oracle.source.refs.length > 0);
    assert.ok(cases[i].oracle.expected.length > 0);
    const source = { ...cases[i].oracle.source, refs: Object.fromEntries(cases[i].oracle.source.refs.map(r => {
      const { id, value, ...ref } = r;
      return [id, ref];
    })) };
    for (const ref of Object.values(source.refs)) assert.equal(validateSourceRef(ref, source).valid, true);
    for (const row of cases[i].oracle.expected) {
      for (const field of Object.values(row.fields ?? {})) for (const id of field.refs) assert.ok(source.refs[id], id);
    }
    if (cases[i].format === 'xlsx') assert.ok(readWorkbook({ bytes: cases[i].bytes }).sheets.length > 0);
  }
  assert.notDeepEqual(manifestOf(generateCases(20320418)), manifestOf(cases));
});

test('oracles preserve blank versus zero, formulas, hidden regions, both epochs and note spans', () => {
  const cases = generateCases();
  const refs = cases.flatMap(c => c.oracle.source.refs);
  assert.ok(refs.some(r => r.value === 0)); assert.ok(refs.some(r => r.valueType === 'empty'));
  assert.ok(refs.some(r => r.formula && r.cached)); assert.ok(refs.some(r => r.formula && !r.cached));
  assert.ok(refs.some(r => r.hidden)); assert.ok(refs.some(r => r.mergedAnchor));
  assert.deepEqual([...new Set(cases.filter(c => c.format === 'xlsx').map(c => c.oracle.source.epoch))].sort(), ['1900', '1904']);
  for (const c of cases.filter(c => c.format === 'text')) {
    for (const r of c.oracle.source.refs) assert.equal(c.bytes.subarray(r.byteStart, r.byteEnd).toString('utf8'), r.value);
    assert.equal(c.oracle.expected.find(r => r.target === 'expected_transaction').amount, null);
  }
});


test('account-scoped ids and equal repeated postings survive in source-derived oracle outputs', () => {
  for (const c of generateCases().filter(c => c.family === 'reordered_sheets')) {
    const rows = c.oracle.expected;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].externalId, rows[1].externalId);
    assert.notEqual(rows[0].accountId, rows[1].accountId);
    assert.equal(rows[1].amount, rows[2].amount);
    assert.deepEqual(rows.slice(1).map(r => r.occurrence), [1, 2]);
  }
  const formulas = generateCases().filter(c => c.family === 'formula_cache');
  assert.deepEqual(formulas.map(c => c.oracle.reconciliation), ['match', 'conflict']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeXlsx } from '../helpers/xlsx.mjs';
import { indexSource, resolveField } from '../../src/ingest/model-source.mjs';

const file = (bytes, format = 'xlsx') => ({ fileId: 'f-synthetic', bytes: Buffer.from(bytes), format });
const field = (refs, transform = { op: 'identity' }) => ({ refs, transform });

test('indexes all sheets, hidden cells, cached formulas, merged anchors and both epochs', async () => {
  for (const epoch of ['1900', '1904']) {
    const source = await indexSource(file(writeXlsx([
      { name: 'Synthetic private', rows: [['Label', 'Amount'], ['Income', 25], [{ formula: 'B2*2', cached: 50 }, { formula: 'B2*3' }]], merges: ['A1:B1'] },
      { name: 'Other', hidden: true, rows: [['Hidden', 0], [{ empty: true }]] },
    ], { workbookExtra: `<workbookPr date1904="${epoch === '1904' ? 1 : 0}"/>` })));
    assert.equal(source.epoch, epoch);
    assert.equal(source.sheets.length, 2);
    const refs = Object.entries(source.refs);
    const id = (sheet, cell) => refs.find(([, r]) => r.sheet.index === sheet && r.cell === cell)[0];
    assert.equal(source.refs[id(0, 'A1')].mergedAnchor, 'A1');
    assert.equal(source.refs[id(1, 'B1')].hidden, true);
    assert.equal(resolveField(source, field([id(1, 'B1')])), 0);
    assert.equal(resolveField(source, field([id(0, 'A3')])), 50);
    assert.throws(() => resolveField(source, field([id(0, 'B3')])));
    assert.throws(() => resolveField(source, field([id(1, 'A2')])));
    assert.equal(Object.keys(source.inventory).length, source.regions.length);
    assert.ok(Object.values(source.inventory).every(r => r.disposition));
  }
});

test('CSV and TSV keep duplicate headers and column ordinals', async () => {
  for (const format of ['csv', 'tsv']) {
    const sep = format === 'csv' ? ',' : '\t';
    const s = await indexSource(file(`Amount${sep}Amount\n12${sep}34\n`, format));
    const values = Object.entries(s.refs).filter(([, r]) => r.row === 2);
    assert.equal(values.length, 2);
    assert.equal(resolveField(s, field([values[1][0]], { op: 'currency_decode', currency: 'USD' })), 34);
    assert.notEqual(values[0][1].headerRef, values[1][1].headerRef);
  }
});

test('UTF-8 spans and scrubbed leaves preserve quantities only as local references', async () => {
  const original = 'Syntheticperson café paid $123.45 on 2032-04-17, 18%. Account 123456789012. token=syntheticcredential';
  const s = await indexSource(file(original, 'text'), { householdNames: { owner: 'Syntheticperson' } });
  const sent = JSON.stringify(s.envelope);
  for (const value of ['Syntheticperson', '123.45', '2032-04-17', '18%', '123456789012', 'syntheticcredential', s.sha256]) assert.ok(!sent.includes(value), value);
  const amount = Object.entries(s.values).find(([, value]) => value === '$123.45');
  assert.ok(amount);
  const ref = s.refs[amount[0]];
  assert.equal(s.bytes.subarray(ref.byteStart, ref.byteEnd).toString(), '$123.45');
  assert.equal(resolveField(s, field([amount[0]], { op: 'currency_decode', currency: 'USD' })), 123.45);
});

test('long semantic leaves split without losing covered bytes; invalid formats refuse', async () => {
  const s = await indexSource(file('ordinary text '.repeat(150), 'text'));
  assert.ok(s.regions.length > 1);
  const chunks = Object.values(s.refs).filter(r => r.valueType === 'text');
  assert.equal(chunks.reduce((n, r) => n + r.byteEnd - r.byteStart, 0), s.bytes.length);
  await assert.rejects(indexSource(file('a,"unterminated', 'csv')));
  await assert.rejects(indexSource(file('x', 'unsupported')));
});

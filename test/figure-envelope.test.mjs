import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, fromStored, fromPace, figure, rowsSource, mergeSources, UNITS, GAP_CODES } from '../src/calc/figure.mjs';

const ref = { tool: 'household', args: { operation: 'figures',  keys: ['synthetic.total'] }, path: '0' };
const options = { unit: 'usd', label: 'Stored total', asOf: '2032-06-01', ref };

test('units and gap codes publish the frozen contract', () => {
  assert.ok(Object.isFrozen(UNITS));
  assert.ok(Object.isFrozen(GAP_CODES));
  assert.deepEqual([...UNITS].sort(), ['usd', 'usd_per_month', 'usd_per_year', 'ratio', 'days', 'months', 'years', 'age', 'date', 'count'].sort());
  assert.deepEqual([...GAP_CODES].sort(), ['uncategorized_rows', 'guessed_rows', 'account_no_history', 'incomplete_month',
    'stale_account', 'outside_household_ledger', 'missing_fact', 'carried_balance', 'unclassified_category',
    'no_cost_basis', 'unequal_periods'].sort());
});

test('envelopes keep their context and round only their output by unit', () => {
  const window = { from: '2032-01', to: '2032-03', months: 3 };
  const provenance = { calc: 'synthetic', formula: 'stored total', inputs: [{ value: 1 / 3, unit: 'ratio', label: 'Share' }],
    sources: [{ table: 'figures', ids: ['synthetic.total'], count: 1 }], steps: [{ label: 'Stored total', formula: 'identity', value: 1 / 3 }] };
  const result = envelope(123.456, { ...options, kind: 'a', window, provenance });
  assert.deepEqual(result, { value: 123.46, unit: 'usd', label: options.label, kind: 'a', asOf: options.asOf,
    ref, window, provenance, gaps: [] });
  assert.equal(provenance.inputs[0].value, 1 / 3);
  assert.equal(envelope(1, options).kind, 'e');
  for (const [unit, value, expected, extra] of [
    ['usd', 1.005, 1.01], ['usd_per_month', 123.456, 123.46], ['usd_per_year', 123.454, 123.45],
    ['years', 12.345, 12.35], ['days', -12.346, -12.35], ['age', 59.26, 59.5],
    ['count', 2.6, 3], ['months', 12.2, 12], ['months', 12.2, 13, { projection: true }],
  ]) {
    assert.equal(envelope(value, { ...options, unit, ...extra }).value, expected, `${unit} precision`);
  }
});

test('ratio results preserve full precision and allow changes outside rate argument bounds', () => {
  for (const value of [1 / 3, 1.4, -0.2, 0]) assert.equal(envelope(value, { ...options, unit: 'ratio' }).value, value);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => envelope(value, { ...options, unit: 'ratio' }));
  assert.equal(envelope(1 / 3, { ...options, unit: 'ratio' }).value, 1 / 3);
});

test('invalid units, gap codes and numeric values are refused while valid figures remain live', () => {
  assert.throws(() => envelope(1, { ...options, unit: 'percent' }));
  assert.equal(envelope(1, { ...options, unit: 'count' }).value, 1);
  assert.throws(() => envelope(1, { ...options, gaps: [{ code: 'invented_gap', message: 'Unknown input' }] }));
  const gaps = [{ code: 'missing_fact', message: 'A stored input is missing', count: 1 }];
  assert.deepEqual(envelope(1, { ...options, gaps }).gaps, gaps);
  for (const value of [NaN, Infinity, -Infinity, '12', undefined]) assert.throws(() => envelope(value, options));
  assert.equal(envelope(12, options).value, 12);
});

test('date values require a real ISO calendar date and unknown data dates remain null', () => {
  for (const value of ['2032-02-30', '2031-02-29', '2032-6-01', '2032-06-01T00:00:00Z', 20320601]) {
    assert.throws(() => envelope(value, { ...options, unit: 'date' }));
  }
  assert.equal(envelope('2032-02-29', { ...options, unit: 'date' }).value, '2032-02-29');
  assert.equal(envelope(1, { ...options, asOf: null }).asOf, null);
});

test('null is reserved for an explicitly unavailable figure', () => {
  assert.throws(() => envelope(null, options));
  for (const unavailable of ['', '  ', null]) assert.throws(() => envelope(null, { ...options, unavailable }));
  const gaps = [{ code: 'missing_fact', message: 'The stored input is unavailable' }];
  const result = envelope(null, { ...options, unavailable: 'missing_fact', gaps });
  assert.equal(result.value, null);
  assert.equal(result.unavailable, 'missing_fact');
  assert.deepEqual(result.gaps, gaps);
  assert.equal(envelope(0, options).value, 0);
});

test('fromStored maps locator metadata and retains parsed source provenance', () => {
  const locator = { unit: 'usd_per_year', calc: 'synthetic.total', formula: 'sum stored values', computedOn: '2032-05-31',
    window: { from: '2032-01', to: '2032-05', months: 5 }, inputs: { stored: 123.456 },
    sources: [rowsSource('balances', [1, 2])], steps: [{ label: 'Total', formula: 'sum', value: 123.456 }] };
  for (const storedLocator of [locator, JSON.stringify(locator)]) {
    const result = fromStored({ v: 123.456, src: 'calc:synthetic', kind: 'a', label: 'Annual total 2032',
      locator: storedLocator, src_as_of: '2032-04-30' }, { ref });
    assert.equal(result.value, 123.46);
    assert.equal(result.unit, 'usd_per_year');
    assert.equal(result.kind, 'a');
    assert.equal(result.label, 'Annual total 2032');
    assert.equal(result.asOf, locator.computedOn);
    assert.deepEqual(result.window, locator.window);
    assert.equal(result.provenance.calc, locator.calc);
    assert.deepEqual(result.provenance.inputs, locator.inputs);
    assert.deepEqual(result.provenance.sources, locator.sources);
    assert.deepEqual(result.provenance.steps, locator.steps);
    assert.deepEqual(result.provenance.stored, { src: 'calc:synthetic', locator });
    assert.deepEqual(result.ref, ref);
  }
});

test('fromStored defaults legacy money and keeps literal locators and unavailable reasons', () => {
  const row = { v: 123.456, src: 'statement', kind: 'a', label: 'Statement total', locator: 'fig.total', src_as_of: '2032-05-31' };
  const live = fromStored(row, { ref });
  assert.equal(live.unit, 'usd');
  assert.equal(live.value, 123.46);
  assert.equal(live.asOf, row.src_as_of);
  assert.equal(live.provenance.calc, row.src);
  assert.deepEqual(live.provenance.stored, { src: row.src, locator: row.locator });
  const unavailable = fromStored({ ...row, unavailable_reason: 'waiting for a replacement statement' }, { ref });
  assert.equal(unavailable.value, null);
  assert.equal(unavailable.unavailable, 'waiting for a replacement statement');
  assert.ok(unavailable.gaps.some(gap => gap.code === 'missing_fact' && gap.message));
  assert.equal(fromStored({ ...row, src_as_of: null }, { ref }).asOf, null);
});

test('fromPace requires an explicit unit, uses dataThrough and maps provenance', () => {
  const locator = { calc: 'paceMeter', unit: 'ratio', dataThrough: '2032-05-31', computedOn: '2032-06-29',
    inputs: { used: 1, limit: 3 }, sources: [rowsSource('facts', ['pace.retirement.2032'])],
    steps: [{ label: 'Share used', formula: 'used / limit', value: 1 / 3 }] };
  const pace = { v: 1 / 3, src: 'calc:pace', kind: 'e', label: 'Share used', locator };
  const result = fromPace(pace, { ref });
  assert.equal(result.value, 1 / 3);
  assert.equal(result.unit, 'ratio');
  assert.equal(result.asOf, locator.dataThrough);
  for (const key of ['calc', 'inputs', 'sources', 'steps']) assert.deepEqual(result.provenance[key], locator[key]);
  assert.deepEqual(result.ref, ref);
  const { unit, ...withoutUnit } = locator;
  assert.throws(() => fromPace({ ...pace, locator: withoutUnit }, { ref }));
  assert.equal(fromPace(pace, { ref }).unit, unit);
  assert.equal(fromPace({ ...pace, locator: { ...locator, dataThrough: null } }, { ref }).asOf, null);
});

test('moved legacy helpers retain target source identity and bounded row provenance', () => {
  const ids = Array.from({ length: 55 }, (_, i) => i + 1);
  assert.deepEqual(rowsSource('balances', ids), { rows: { table: 'balances', ids: ids.slice(0, 50), count: 55 } });
  assert.deepEqual(mergeSources([rowsSource('balances', [1, 2]), rowsSource('balances', [2, 3]), null,
    rowsSource('facts', ['plan'])]), [rowsSource('balances', [1, 2, 3]), rowsSource('facts', ['plan'])]);
  const legacy = figure(123.456, { label: 'Target total', calc: 'synthetic', clock: '2032-06-29',
    sources: [rowsSource('balances', [1])], formula: 'stored total', notes: ['A stored value', '', '   '] });
  assert.equal(legacy.v, 123.46);
  assert.equal(legacy.src, 'calc:targets');
  assert.equal(legacy.kind, 'e');
  assert.deepEqual(legacy.notes, ['A stored value']);
  assert.deepEqual(legacy.locator.steps, [{ label: 'Target total', formula: 'stored total', value: 123.46 }]);
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { callTool } from '../src/tools/index.mjs';
import { tempDb } from './helpers/server.mjs';
import { validateBlock } from '../src/blocks/validate.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';

let store, calls, figures, pace;
const ref = (call, path = '') => ({ tool: call.name, args: call.args, path });
const table = () => ({ source: ref(calls[1], 'series.goals.reserve.series'), columns: ['month', 'plan.envelope'] });
const reason = (op, args, expected, results = calls) => assert.deepEqual(validateBlock(op, args, results), { ok: false, reason: expected });
before(async () => {
  store = await tempDb(); seedDemo(store.db);
  const ctx = { db: store.db, dataDir: store.dataDir, now: new Date('2026-11-05T15:00:00Z') };
  calls = [];
  for (const [name, args] of [['household', { operation: 'figures' }], ['goals', { operation: 'pace' }],
    ['transactions', { operation: 'search', limit: 4 }], ['household', { operation: 'deadlines' }]]) {
    calls.push({ name, args, result: await callTool(name, args, ctx) });
  }
  figures = calls[0].result;
  pace = { source: ref(calls[1], 'series.goals.reserve.series'), x: 'month', kind: 'line', series: [{ path: 'plan.envelope' }] };
});
after(() => store?.close());

test('real demo tool results validate without re-running their calls', () => {
  assert.equal(validateBlock('chart', pace, calls).ok, true);
  assert.equal(validateBlock('table', table(), calls).ok, true);
  assert.equal(validateBlock('table', { source: ref(calls[2], 'rows'), columns: ['date', 'amount'] }, calls).ok, true);
  assert.equal(validateBlock('timeline', { source: ref(calls[3]), date: 'date' }, calls).ok, true);
});

test('bad_input rejects unknown fields, malformed paths, enums and numeric titles', () => {
  for (const title of ['Save ten thousand', 'Save 10', 'Save half', 'Save a dozen', 'Save percent', 'Save €', 'Save ２０', '', 'a'.repeat(81)])
    reason('table', { ...table(), title }, 'bad_input');
  reason('table', { ...table(), data: [1] }, 'bad_input');
  reason('chart', { ...pace, kind: 'pie' }, 'bad_input');
  reason('chart', { ...pace, stacked: true }, 'bad_input');
  reason('table', { ...table(), columns: ['__proto__.value'] }, 'bad_input');
  reason('table', { ...table(), columns: ['a.b.c.d.e.f.g'] }, 'bad_input');
  reason('table', { ...table(), source: { ...table().source, html: '<b>' } }, 'bad_input');
  reason('compare', { source: ref(calls[0]), options: [{ source: ref(calls[0], '0') }], fields: ['value'] }, 'bad_input');
});

test('not_in_answer requires exact arguments and a successful earlier call', () => {
  reason('table', { ...table(), source: { ...table().source, args: { operation: 'pace', selector: 'other' } } }, 'not_in_answer');
  reason('table', table(), 'not_in_answer', [{ ...calls[1], isError: true }]);
  const source = ref(calls[2], 'rows');
  source.args = { limit: calls[2].args.limit, operation: 'search' };
  assert.equal(validateBlock('table', { source, columns: ['amount'] }, calls).ok, true);
});

test('not_a_read refuses writes, undo, show and unknown tools even when recorded', () => {
  for (const name of ['update_goal', 'undo', 'show', 'unknown']) {
    const call = { name, args: { operation: 'list' }, result: figures };
    reason('table', { source: ref(call), columns: ['value'] }, 'not_a_read', [call]);
  }
});

test('bad_path refuses a wrong container, missing target and inherited path', () => {
  reason('table', { ...table(), source: ref(calls[0], 'missing') }, 'bad_path');
  reason('table', { ...table(), source: ref(calls[0], '0') }, 'bad_path');
  reason('compare', { options: [{ source: ref(calls[0]) }, { source: ref(calls[0], '1') }], fields: ['value'] }, 'bad_path');
});

test('bad_field refuses bare numbers, objects, missing values and numeric text outside the allowlist', () => {
  reason('table', { ...table(), columns: ['v'] }, 'bad_field');
  reason('table', { ...table(), columns: ['provenance'] }, 'bad_field');
  reason('table', { ...table(), columns: ['absent'] }, 'bad_field');
  const altered = structuredClone(calls);
  altered[1].result.series.goals.reserve.series[0].label = 'Invented 2026';
  altered[0].result[0].key = 'permitted 2026';
  altered[0].result[0].label = 'Invented 2026';
  reason('table', { ...table(), columns: ['label'] }, 'bad_field', altered);
  assert.equal(validateBlock('table', table(), altered).ok, true);
  const broken = structuredClone(calls);
  broken[1].result.series.goals.reserve.series[0].plan.envelope.unit = 'imaginary';
  reason('table', table(), 'bad_field', broken);
});

test('mixed_units enforces the chart axis, table column, comparison field and timeline date units', () => {
  const altered = structuredClone(calls);
  altered[1].result.series.goals.reserve.series[0].plan.envelope.unit = 'count';
  reason('table', table(), 'mixed_units', altered);
  reason('chart', { kind: 'bar', source: table().source, x: 'month', series: [{ path: 'plan.envelope' }] }, 'mixed_units', altered);
  reason('compare', { options: [{ source: ref(calls[1], 'series.goals.reserve.series.0') }, { source: ref(calls[1], 'series.goals.reserve.series.1') }], fields: ['plan.envelope'] }, 'mixed_units', altered);
  reason('timeline', { source: table().source, date: 'plan.envelope' }, 'mixed_units');
  const dates = structuredClone(calls);
  dates[1].result.series.goals.reserve.series.forEach(r => { r.plan.envelope.unit = 'date'; r.plan.envelope.value = '2026-11-05'; });
  reason('chart', { kind: 'line', source: table().source, x: 'month', series: [{ path: 'plan.envelope' }] }, 'mixed_units', dates);
});

test('too_large enforces item, field, series and serialized UTF-8 snapshot limits', () => {
  for (const [op, args, count] of [
    ['table', table(), 201],
    ['chart', { kind: 'bar', source: table().source, x: 'month', series: [{ path: 'plan.envelope' }] }, 121],
    ['compare', { source: table().source, fields: ['plan.envelope'] }, 9],
    ['timeline', { source: ref(calls[3]), date: 'date' }, 61],
  ]) {
    const altered = structuredClone(calls); if (op === 'timeline') altered[3].result = Array(count).fill(altered[3].result[0]);
    else altered[1].result.series.goals.reserve.series = Array.from({ length: count }, (_, n) => ({ ...altered[1].result.series.goals.reserve.series[0], month: `row_${n}` }));
    reason(op, args, 'too_large', altered);
  }
  reason('table', { ...table(), columns: Array(9).fill('plan.envelope') }, 'too_large');
  reason('chart', { ...pace, series: Array(5).fill({ path: 'plan.envelope' }) }, 'too_large');
  const huge = structuredClone(calls);
  huge[1].result.series.goals.reserve.series[0].plan.envelope.provenance.formula = 'é'.repeat(40_000);
  reason('table', table(), 'too_large', huge);
});

test('too_many counts only successful show results', () => {
  const shown = { name: 'show', args: { operation: 'table' }, result: { status: 'shown', block: 'b1' } };
  reason('table', table(), 'too_many', [...calls, ...Array(4).fill(shown)]);
  assert.equal(validateBlock('table', table(), [...calls, ...Array(3).fill(shown), { ...shown, result: { status: 'dropped' } }]).ok, true);
});

test('misaligned rejects duplicate or missing x values, accepts source alignment in a different order', () => {
  const changed = structuredClone(calls);
  const rows = changed[1].result.series.goals.reserve.series;
  rows[1].month = rows[0].month;
  reason('chart', pace, 'misaligned', changed);
  const other = structuredClone(calls[1]); other.args = { operation: 'pace', selector: 'other' };
  other.result.series.goals.reserve.series.reverse();
  const aligned = { ...pace, series: [...pace.series, { path: 'plan.envelope', source: ref(other, 'series.goals.reserve.series') }] };
  assert.equal(validateBlock('chart', aligned, [...calls, other]).ok, true);
  other.result.series.goals.reserve.series.pop();
  reason('chart', aligned, 'misaligned', [...calls, other]);
});

test('an argument-echo figure label is replaced with the field or source fallback', async () => {
  const source = ref(calls[0], '0');
  const args = { operation: 'round_up', operands: [{ ref: { ...source, path: '0' } }], places: 1, label: 'Save ten thousand' };
  const result = await callTool('calculate', args, { db: store.db, now: new Date('2026-11-05T15:00:00Z') });
  const call = { name: 'calculate', args, result };
  const spec = { options: [{ source: ref(call) }, { source: ref(call) }], fields: ['figure'] };
  assert.equal(validateBlock('compare', spec, [...calls, call]).ok, true);
  const snapshot = buildSnapshot('compare', spec, [...calls, call]);
  assert.equal(snapshot.fields[0].label, 'Amount');
  snapshot.options.forEach(o => assert.equal(o.cells[0].fig.label, 'Amount'));
});

test('size boundaries stay live with bounded source provenance', () => {
  const results = structuredClone(calls);
  const row = results[1].result.series.goals.reserve.series[0];
  results[1].result.series.goals.reserve.series = Array.from({ length: 120 }, (_, i) => ({ ...row,
    month: `point_${i}`, plan: { envelope: { ...row.plan.envelope, provenance: { calc: 'synthetic_fixture' } } } }));
  assert.equal(validateBlock('chart', pace, results).ok, true);
  const four = { ...pace, series: Array(4).fill({ path: 'plan.envelope' }) };
  const short = structuredClone(calls);
  short[1].result.series.goals.reserve.series = short[1].result.series.goals.reserve.series.slice(0, 2);
  assert.equal(validateBlock('chart', four, short).ok, true);
  const rowRef = ref(calls[2], 'rows');
  results[2].result.rows = Array(200).fill(calls[2].result.rows[0]);
  assert.equal(validateBlock('table', { source: rowRef, columns: ['amount'] }, results).ok, true);
  assert.equal(validateBlock('table', { source: rowRef, columns: Array(8).fill('amount') }, calls).ok, true);
  results[1].result.series.goals.reserve.series = results[1].result.series.goals.reserve.series.slice(0, 8);
  assert.equal(validateBlock('compare', { source: table().source, fields: ['plan.envelope'] }, results).ok, true);
  results[3].result = Array(60).fill(calls[3].result[0]);
  assert.equal(validateBlock('timeline', { source: ref(calls[3]), date: 'date' }, results).ok, true);
});

test('missing alignment fields, non-date timeline text and empty data fail closed', () => {
  const other = structuredClone(calls[1]); other.args = { operation: 'pace', selected: 'other' };
  delete other.result.series.goals.reserve.series[0].month;
  reason('chart', { ...pace, series: [{ path: 'plan.envelope', source: ref(other, 'series.goals.reserve.series') }] }, 'bad_field', [...calls, other]);
  const results = structuredClone(calls);
  results[3].result[0].date = '2026-02-30';
  reason('timeline', { source: ref(calls[3]), date: 'date' }, 'mixed_units', results);
  results[1].result.series.goals.reserve.series = [];
  reason('table', table(), 'too_large', results);
  reason('compare', { options: [], fields: ['figure'] }, 'too_large');
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { callTool } from '../src/tools/index.mjs';
import { tempDb } from './helpers/server.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { validateBlock } from '../src/blocks/validate.mjs';
import { assertSnapshotShape } from '../src/blocks/snapshot-shape.mjs';

let store, calls;
const ref = (i, path = '') => ({ tool: calls[i].name, args: calls[i].args, path });
before(async () => {
  store = await tempDb(); seedDemo(store.db);
  calls = [];
  for (const [name, args] of [['household', { operation: 'figures' }], ['goals', { operation: 'pace' }],
    ['transactions', { operation: 'search', limit: 4 }], ['household', { operation: 'deadlines' }]])
    calls.push({ name, args, result: await callTool(name, args, { db: store.db, now: new Date('2026-11-05T15:00:00Z') }) });
});
after(() => store?.close());
const check = (op, spec) => {
  assert.equal(validateBlock(op, spec, calls).ok, true);
  const before = structuredClone(calls);
  const snapshot = buildSnapshot(op, spec, calls);
  assertSnapshotShape(op, snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 65_536);
  assert.deepEqual(calls, before);
  return snapshot;
};
const sameFigure = (snapshot, figure, source) => {
  for (const key of ['value', 'unit', 'label', 'kind', 'asOf', 'quote', 'gaps']) assert.deepEqual(snapshot[key], figure[key], key);
  assert.equal(snapshot.source, source);
};

test('line, bar and area preserve ordered source figures, units and data-derived labels', () => {
  const rows = calls[1].result.series.goals.reserve.series;
  for (const kind of ['line', 'bar', 'area']) {
    const s = check('chart', { kind, source: ref(1, 'series.goals.reserve.series'), x: 'month', series: [{ path: 'plan.envelope' }] });
    assert.equal(s.series[0].label, rows[0].plan.envelope.label);
    assert.equal(s.x[0].text, 'Jan 2026');
    s.series[0].points.forEach((f, i) => sameFigure(f, rows[i].plan.envelope, 'your goals'));
  }
});

test('scatter preserves repeated x values and allows a different unit on each axis', () => {
  const spec = { kind: 'scatter', source: ref(1, 'series.goals.reserve.series'), x: 'plan.envelope', series: [{ path: 'plan.envelope' }] };
  const s = check('chart', spec);
  const rows = calls[1].result.series.goals.reserve.series;
  s.points.forEach((p, i) => {
    sameFigure(p.x, rows[i].plan.envelope, 'your goals');
    sameFigure(p.y, rows[i].plan.envelope, 'your goals');
    assert.equal(p.label, new Date(`${rows[i].month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
  });
});

test('table figures and row amounts retain their source and sort points at a column index', () => {
  const s = check('table', { source: ref(1, 'series.goals.reserve.series'), columns: ['month', 'plan.envelope'], sort: { column: 'plan.envelope', dir: 'desc' } });
  s.rows.forEach((r, i) => sameFigure(r.cells[1].fig, calls[1].result.series.goals.reserve.series[i].plan.envelope, 'your goals'));
  assert.deepEqual(s.sort, { column: 1, dir: 'desc' });
  const rows = check('table', { source: ref(2, 'rows'), columns: ['date', 'amount'] });
  rows.rows.forEach((r, i) => {
    assert.equal(r.cells[1].t, 'row');
    assert.equal(r.cells[1].value, calls[2].result.rows[i].amount);
    assert.equal(r.cells[1].unit, 'usd');
    assert.equal(r.cells[1].row.date, calls[2].result.rows[i].date);
    assert.equal(r.cells[1].row.description, calls[2].result.rows[i].description);
  });
});

test('compare uses object references and option labels from source data', () => {
  const s = check('compare', { options: [{ source: ref(1, 'series.goals.reserve.series.0') }, { source: ref(1, 'series.goals.reserve.series.1') }], fields: ['plan.envelope'], title: 'Account comparison' });
  assert.equal(s.title, 'Account comparison');
  s.options.forEach((o, i) => {
    assert.equal(o.label, new Date(`${calls[1].result.series.goals.reserve.series[i].month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
    sameFigure(o.cells[0].fig, calls[1].result.series.goals.reserve.series[i].plan.envelope, 'your goals');
  });
});

test('timeline stores sorted valid ISO dates and source labels without invented figures', () => {
  const s = check('timeline', { source: ref(3), date: 'date' });
  assert.equal(s.events.length, calls[3].result.length);
  assert.deepEqual(s.events.map(e => e.date), calls[3].result.map(e => e.date).sort());
  s.events.forEach((e, i) => assert.equal(e.label, calls[3].result[i].label));
});

test('unavailable envelopes retain null, gaps and bounded provenance without losing popover data', () => {
  const altered = structuredClone(calls);
  const f = altered[1].result.series.goals.reserve.series[0].plan.envelope;
  f.value = null; f.quote = null; f.gaps = [{ code: 'missing_fact', message: 'No balance on file' }];
  f.provenance.steps = Array.from({ length: 25 }, (_, i) => ({ label: `step ${i}`, value: i }));
  f.provenance.inputs = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`input_${i}`, i]));
  const spec = { options: [{ source: ref(1, 'series.goals.reserve.series.0') }, { source: ref(1, 'series.goals.reserve.series.1') }], fields: ['plan.envelope'] };
  assert.equal(validateBlock('compare', spec, altered).ok, true);
  const s = buildSnapshot('compare', spec, altered); assertSnapshotShape('compare', s);
  const out = s.options[0].cells[0].fig;
  assert.equal(out.value, null); assert.deepEqual(out.gaps, f.gaps);
  assert.equal(out.provenance.steps.length, 20); assert.equal(Object.keys(out.provenance.inputs).length, 20);
  assert.deepEqual(out.provenance.more, { steps: 5, inputs: 4 });
  out.gaps[0].message = 'changed'; assert.equal(f.gaps[0].message, 'No balance on file');
});

test('shape check rejects malformed renderer contracts', () => {
  assert.throws(() => assertSnapshotShape('table', { title: 'Broken', columns: [], rows: [] }));
  assert.throws(() => assertSnapshotShape('unknown', {}));
});

test('alignment reorders secondary series to the primary x data', () => {
  const other = structuredClone(calls[1]); other.args = { operation: 'pace', selected: 'comparison' };
  const rows = other.result.series.goals.reserve.series;
  rows.reverse();
  const spec = { kind: 'line', source: ref(1, 'series.goals.reserve.series'), x: 'month', series: [
    { path: 'plan.envelope' }, { path: 'plan.envelope', source: { tool: other.name, args: other.args, path: 'series.goals.reserve.series' } },
  ] };
  const results = [...calls, other];
  assert.equal(validateBlock('chart', spec, results).ok, true);
  const s = buildSnapshot('chart', spec, results); assertSnapshotShape('chart', s);
  assert.deepEqual(s.series[1].points, s.series[0].points);
});

test('scatter keeps mixed axis units, duplicate x values, flags and unavailable values', () => {
  const results = structuredClone(calls), rows = results[1].result.series.goals.reserve.series;
  rows.forEach((row, i) => {
    row.x = { ...structuredClone(row.plan.envelope), value: rows[0].plan.envelope.value, label: 'Available cash' };
    row.y = { ...structuredClone(row.plan.envelope), unit: 'ratio', value: i / rows.length, label: 'Share' };
    row.id = row.month; row.current = i === 0; row.frontier = i % 2 === 0;
  });
  rows[0].y.value = null; rows[0].y.quote = null; rows[0].y.gaps = [{ code: 'missing_fact', message: 'Share unknown' }];
  const spec = { kind: 'scatter', source: ref(1, 'series.goals.reserve.series'), x: 'x', series: [{ path: 'y' }] };
  assert.equal(validateBlock('chart', spec, results).ok, true);
  const s = buildSnapshot('chart', spec, results); assertSnapshotShape('chart', s);
  assert.equal(s.xUnit, 'usd'); assert.equal(s.yUnit, 'ratio');
  s.points.forEach((p, i) => {
    assert.equal(p.id, rows[i].id); assert.equal(p.current, rows[i].current); assert.equal(p.frontier, rows[i].frontier);
    sameFigure(p.x, rows[i].x, 'your goals'); sameFigure(p.y, rows[i].y, 'your goals');
  });
});

test('row-number charts build figure envelopes with row provenance', () => {
  const spec = { kind: 'scatter', source: ref(2, 'rows'), x: 'amount', series: [{ path: 'amount' }] };
  assert.equal(validateBlock('chart', spec, calls).ok, true);
  const s = buildSnapshot('chart', spec, calls); assertSnapshotShape('chart', s);
  s.points.forEach((p, i) => {
    assert.equal(p.y.value, calls[2].result.rows[i].amount);
    assert.equal(p.y.provenance.sources[0].description, calls[2].result.rows[i].description);
  });
});

test('timeline date envelopes and optional value preserve their figure data', () => {
  const results = structuredClone(calls), rows = results[3].result;
  rows.forEach(row => { row.when = { ...calls[0].result[0], unit: 'date', value: row.date }; row.amount = calls[0].result[0]; });
  const spec = { source: ref(3), date: 'when', value: 'amount' };
  assert.equal(validateBlock('timeline', spec, results).ok, true);
  const s = buildSnapshot('timeline', spec, results); assertSnapshotShape('timeline', s);
  s.events.forEach((event, i) => { assert.equal(event.date, rows[i].date); sameFigure(event.value, rows[i].amount, 'household summary'); });
});

test('separate comparison calls label the single differing assumption from provenance', async () => {
  const results = [...calls], refs = [];
  for (const evidence of ['Use a 3 percent real return.', 'Use a 4 percent real return.']) {
    const value = evidence.includes('3') ? 0.03 : 0.04;
    const args = { operation: 'multiply', operands: [{ ref: ref(0, '0') },
      { assumption: { name: 'realReturn', value, unit: 'ratio', source: 'owner', evidence } }], label: 'Projected return' };
    const result = await callTool('calculate', args, { db: store.db, ownerStatements: () => [evidence] });
    results.push({ name: 'calculate', args, result }); refs.push({ source: { tool: 'calculate', args, path: '' } });
  }
  const spec = { options: refs, fields: ['figure'] };
  assert.equal(validateBlock('compare', spec, results).ok, true);
  const s = buildSnapshot('compare', spec, results); assertSnapshotShape('compare', s);
  assert.deepEqual(s.options.map(o => o.label), ['Real Return 3%', 'Real Return 4%']);
  refs[1].source.args = { ...refs[1].source.args, label: 'Another label' };
  results.at(-1).args = refs[1].source.args;
  assert.deepEqual(buildSnapshot('compare', spec, results).options.map(o => o.label), ['calculated figures', 'calculated figures']);
});

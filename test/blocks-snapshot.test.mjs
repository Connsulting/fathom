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

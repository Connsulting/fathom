// AV2 automatic Ask visuals (src/blocks/auto.mjs): autoSpecs picks a drawable shape from this
// turn's successful reads and autoBlocks builds at most two blocks through the same validate and
// snapshot path the show tool uses. Every expected value is read from real tool results on a
// seeded demo store; war-game figures are planted with synthetic values because the demo store is
// never planned.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { seedDemo } from '../demo/seed.mjs';
import { callTool } from '../src/tools/index.mjs';
import { tempDb } from './helpers/server.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { validateBlock } from '../src/blocks/validate.mjs';
import { assertSnapshotShape } from '../src/blocks/snapshot-shape.mjs';
import { dateText } from '../src/blocks/labels.mjs';
import { autoSpecs, autoBlocks } from '../src/blocks/auto.mjs';

const NOW = new Date('2026-11-05T15:00:00Z');
const READS = {
  month: ['spending', { operation: 'total', groupBy: 'month', window: 'ytd' }],
  single: ['spending', { operation: 'total', window: 'ytd' }],
  projection: ['spending', { operation: 'projection' }],
  netWorth: ['accounts', { operation: 'net_worth', series: true }],
  category: ['spending', { operation: 'total', groupBy: 'category', window: 'ytd' }],
  twoRows: ['spending', { operation: 'total', groupBy: 'category', window: 'ytd', include: { categories: ['housing', 'childcare'] } }],
  deadlines: ['household', { operation: 'deadlines' }],
  obligations: ['spending', { operation: 'obligations' }],
  recurring: ['spending', { operation: 'recurring' }],
  deferral: ['recommendations', { operation: 'wargame', name: 'deferral' }],
  salary: ['recommendations', { operation: 'wargame', name: 'salary' }],
};

// Synthetic stored war-game figures (the planner's figure keys), so the options carry values.
const WARGAME_FIELDS = { salary: ['salary', 'payroll', 'dist', 'tax', 'x', 'y'], deferral: ['amount', 'net', 'decCash', 'need', 'gap', 'tax2026', 'tax2027'] };
function plantWargames(db) {
  const { wargame } = buildScenario(db);
  const put = db.prepare(`INSERT OR REPLACE INTO figures (key, v, kind, label, parser, updated_at) VALUES (?, ?, 'm', ?, 'planner', '2026-11-05')`);
  for (const name of ['salary', 'deferral']) (name === 'salary' ? wargame.salary.points : wargame.deferral.options).forEach((item, i) =>
    WARGAME_FIELDS[name].forEach((field, j) => put.run(`wg.${name}.${item.id}.${field}`, 1000 * (i + 1) + 10 * j, field)));
  put.run('wg.deferral.base.income', 5000, 'income');
}

let store, ctx, unplannedDeferral;
const calls = {};
before(async () => {
  store = await tempDb(); seedDemo(store.db);
  ctx = { db: store.db, now: NOW, dataDir: store.dataDir, services: {} };
  const [name, args] = READS.deferral;
  unplannedDeferral = { name, args, result: await callTool(name, args, ctx) };
  plantWargames(store.db);
  for (const [key, [tool, args]] of Object.entries(READS)) calls[key] = { name: tool, args, result: await callTool(tool, args, ctx) };
});
after(async () => { store?.close(); if (store) await rm(store.dataDir, { recursive: true, force: true }); });

const ref = (key, path) => ({ tool: calls[key].name, args: calls[key].args, path });
const values = figures => figures.map(f => f?.value ?? null);

// Every built block is a valid show block whose stored snapshot is exactly what the shared
// snapshot builder makes from the same reads.
function checkBlock(block, results) {
  for (const key of ['id', 'op', 'spec', 'calls', 'snapshot', 'asOf', 'builtAt', 'origin']) assert.ok(Object.hasOwn(block, key), key);
  assert.equal(block.origin, 'auto');
  assert.match(block.id, /^b[1-9][0-9]*$/);
  assert.equal(Object.hasOwn(block.spec, 'operation'), false, 'spec carries no show operation');
  assert.deepEqual(validateBlock(block.op, block.spec, results), { ok: true });
  assert.deepEqual(block.snapshot, buildSnapshot(block.op, block.spec, results));
  assertSnapshotShape(block.op, block.snapshot);
  assert.equal(block.builtAt, NOW.toISOString());
  assert.ok(block.asOf === null || typeof block.asOf === 'string');
  const source = block.spec.source ?? block.spec.options?.[0]?.source;
  assert.deepEqual(block.calls, [{ tool: source.tool, args: source.args }]);
  assert.ok(Buffer.byteLength(JSON.stringify(block), 'utf8') <= 65_536);
  return block;
}
function only(results) {
  const before = structuredClone(results);
  const blocks = autoBlocks(results, { now: NOW });
  assert.deepEqual(results, before, 'autoBlocks does not mutate the reads');
  assert.equal(blocks.length, 1);
  return checkBlock(blocks[0], results);
}

test('month spending becomes a bar chart in chronological order with the tool figures', () => {
  const results = [calls.month];
  const [candidate] = autoSpecs(results);
  assert.equal(candidate.shape, 'series'); assert.equal(candidate.op, 'chart');
  assert.equal(candidate.spec.kind, 'bar');
  assert.deepEqual(candidate.spec.source, ref('month', 'groups'));
  assert.equal(candidate.spec.x, 'key');
  assert.deepEqual(candidate.spec.series, [{ path: 'figure' }]);
  const block = only(results);
  assert.equal(block.op, 'chart'); assert.equal(block.id, 'b1');
  const groups = [...calls.month.result.groups].sort((a, b) => a.key.localeCompare(b.key));
  assert.ok(groups.length >= 2);
  assert.notDeepEqual(calls.month.result.groups.map(g => g.key), groups.map(g => g.key), 'the tool returns months out of order');
  assert.deepEqual(block.snapshot.x.map(x => x.text), groups.map(g => dateText(g.key)));
  assert.deepEqual(values(block.snapshot.series[0].points), groups.map(g => g.figure.value));
});

test('the spending projection becomes a line chart of years', () => {
  const results = [calls.projection];
  const [candidate] = autoSpecs(results);
  assert.equal(candidate.shape, 'series');
  assert.deepEqual(candidate.spec.source, ref('projection', 'years'));
  assert.equal(candidate.spec.x, 'year');
  assert.deepEqual(candidate.spec.series, [{ path: 'spending' }]);
  const block = only(results);
  assert.equal(block.op, 'chart'); assert.equal(block.snapshot.kind, 'line');
  const years = calls.projection.result.years;
  assert.ok(years.length >= 2 && years.every(y => Number.isInteger(y.year)));
  assert.deepEqual(block.snapshot.x.map(x => x.text), years.map(y => String(y.year)));
  assert.deepEqual(values(block.snapshot.series[0].points), years.map(y => y.spending.value));
});

test('a net worth series read becomes one line chart even though it also has groups', () => {
  const results = [calls.netWorth];
  assert.equal(autoSpecs(results)[0].shape, 'series');
  const block = only(results);
  assert.equal(block.op, 'chart'); assert.equal(block.snapshot.kind, 'line');
  assert.deepEqual(block.spec.source, ref('netWorth', 'series'));
  assert.equal(block.spec.x, 'month');
  assert.deepEqual(block.spec.series, [{ path: 'total' }]);
  const series = [...calls.netWorth.result.series].sort((a, b) => a.month.localeCompare(b.month));
  assert.deepEqual(block.snapshot.x.map(x => x.text), series.map(s => dateText(s.month)));
  assert.deepEqual(values(block.snapshot.series[0].points), series.map(s => s.total.value));
});

test('a category breakdown becomes a table sorted by figure descending with drill links', () => {
  const results = [calls.category];
  const [candidate] = autoSpecs(results);
  assert.equal(candidate.shape, 'breakdown'); assert.equal(candidate.op, 'table');
  const block = only(results);
  assert.equal(block.op, 'table');
  assert.deepEqual(block.spec.source, ref('category', 'groups'));
  assert.equal(block.spec.columns.at(-1), 'figure');
  assert.ok(['label', 'key'].includes(block.spec.columns[0]));
  assert.deepEqual(block.spec.sort, { column: 'figure', dir: 'desc' });
  assert.deepEqual(block.snapshot.sort, { column: block.spec.columns.indexOf('figure'), dir: 'desc' });
  const groups = calls.category.result.groups;
  assert.ok(groups.length >= 3 && groups.length <= 12);
  const figureCells = block.snapshot.rows.map(r => r.cells[block.snapshot.sort.column]);
  assert.deepEqual(figureCells.map(c => c.fig.value), groups.map(g => g.figure.value));
  figureCells.forEach((cell, i) => {
    if (i) assert.ok(cell.fig.value <= figureCells[i - 1].fig.value, 'rows run largest first');
    assert.equal(cell.drill.route, 'spending');
    assert.equal(cell.drill.query.category, groups[i].key);
  });
});

test('war games become compare blocks; only the open deferral game carries an action', () => {
  const deferral = only([calls.deferral]);
  assert.equal(deferral.op, 'compare');
  assert.deepEqual(deferral.spec.source, ref('deferral', 'deferral.options'));
  assert.ok(deferral.spec.fields.length >= 1 && deferral.spec.fields.every(f => f.startsWith('figures.')));
  assert.equal(calls.deferral.result.status, 'open');
  assert.equal(deferral.snapshot.action.kind, 'wargame');
  assert.equal(deferral.snapshot.action.name, 'deferral');
  assert.equal(deferral.snapshot.options.length, calls.deferral.result.deferral.options.length);
  assert.equal(autoSpecs([calls.deferral])[0].shape, 'wargame');

  const salary = only([calls.salary]);
  assert.equal(salary.op, 'compare');
  assert.deepEqual(salary.spec.source, ref('salary', 'salary.points'));
  assert.equal(calls.salary.result.status, 'decided');
  assert.equal(salary.snapshot.action, undefined);
});

test('household deadlines become a dated timeline', () => {
  const [candidate] = autoSpecs([calls.deadlines]);
  assert.equal(candidate.shape, 'events'); assert.equal(candidate.op, 'timeline');
  const block = only([calls.deadlines]);
  assert.deepEqual(block.spec.source, ref('deadlines', ''));
  assert.equal(block.spec.date, 'date');
  assert.equal(block.snapshot.events.length, calls.deadlines.result.length);
  assert.deepEqual(block.snapshot.events.map(e => e.date), calls.deadlines.result.map(d => d.date).sort());
});

test('spending obligations become a timeline of end dates', () => {
  const block = only([calls.obligations]);
  assert.equal(block.op, 'timeline');
  assert.deepEqual(block.spec.source, ref('obligations', 'obligations'));
  assert.equal(block.spec.date, 'endDate');
  const obligations = calls.obligations.result.obligations;
  assert.ok(obligations.length >= 2);
  assert.equal(block.snapshot.events.length, obligations.length);
  assert.deepEqual(block.snapshot.events.map(e => e.date).filter(Boolean).sort(),
    obligations.map(o => o.endDate.value).filter(Boolean).sort());
});

test('a single figure read draws nothing', () => {
  assert.deepEqual(calls.single.result.groups, []);
  assert.deepEqual(autoSpecs([calls.single]), []);
  assert.deepEqual(autoBlocks([calls.single], { now: NOW }), []);
});

test('gap-only results draw nothing', () => {
  const gapOnly = structuredClone(calls.month);
  for (const g of gapOnly.result.groups) {
    g.figure.value = null; g.figure.quote = null;
    g.figure.gaps = [{ code: 'missing_fact', message: 'Synthetic unavailable month' }];
    assert.ok(g.figure.provenance && typeof g.figure.provenance === 'object');
    assert.equal(g.figure.unit, 'usd');
  }
  assert.deepEqual(autoBlocks([gapOnly], { now: NOW }), []);
  // The unplanned demo war game is a real gap-only read: every option figure is unavailable.
  const options = unplannedDeferral.result.deferral.options;
  assert.ok(options.every(o => Object.values(o.figures).every(f => f.value === null && f.gaps.length > 0)));
  assert.deepEqual(autoBlocks([unplannedDeferral], { now: NOW }), []);
});

test('a two-row breakdown and an empty recurring list draw nothing', () => {
  assert.equal(calls.twoRows.result.groups.length, 2);
  assert.ok(!autoSpecs([calls.twoRows]).some(c => c.op === 'table'));
  assert.deepEqual(autoBlocks([calls.twoRows], { now: NOW }), []);
  assert.deepEqual(calls.recurring.result.charges, []);
  assert.deepEqual(autoBlocks([calls.recurring], { now: NOW }), []);
});

test('errored reads are ignored', () => {
  const errored = { ...calls.month, isError: true };
  assert.deepEqual(autoSpecs([errored]), []);
  assert.deepEqual(autoBlocks([errored], { now: NOW }), []);
  const results = [errored, calls.projection];
  const blocks = autoBlocks(results, { now: NOW });
  assert.equal(blocks.length, 1);
  checkBlock(blocks[0], results);
  assert.deepEqual(blocks[0].calls, [{ tool: 'spending', args: calls.projection.args }]);
});

test('more than two drawable reads give exactly two blocks in priority then read order', () => {
  const results = [calls.deadlines, calls.category, calls.projection, calls.month];
  const specs = autoSpecs(results);
  assert.deepEqual(specs.map(s => s.shape), ['series', 'series', 'breakdown', 'events']);
  const blocks = autoBlocks(results, { now: NOW });
  assert.equal(blocks.length, 2);
  blocks.forEach(b => checkBlock(b, results));
  assert.deepEqual(blocks.map(b => b.id), ['b1', 'b2']);
  assert.deepEqual(blocks.map(b => b.op), ['chart', 'chart']);
  assert.ok(isDeepStrictEqual(blocks[0].calls[0].args, calls.projection.args));
  assert.ok(isDeepStrictEqual(blocks[1].calls[0].args, calls.month.args));
});

test('new ids skip ids already used in the answer', () => {
  const results = [calls.month, calls.projection];
  const blocks = autoBlocks(results, { now: NOW, ids: ['b1', 'b3'] });
  assert.deepEqual(blocks.map(b => b.id), ['b2', 'b4']);
  blocks.forEach(b => checkBlock(b, results));
});

test('goal pace reads become line charts of the monthly plan, household savings included', async () => {
  const pace = { name: 'goals', args: { operation: 'pace' }, result: await callTool('goals', { operation: 'pace' }, ctx) };
  const goal = Object.entries(pace.result.series.goals).find(([id, g]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) && g.series?.length >= 2);
  assert.ok(goal, 'the demo store paces at least one goal with a monthly series');
  const block = checkBlock(only([pace]), [pace]);
  assert.equal(block.op, 'chart'); assert.equal(block.snapshot.kind, 'line');
  assert.equal(block.spec.source.path, `series.goals.${goal[0]}.series`);
  assert.deepEqual(values(block.snapshot.series[0].points), goal[1].series.map(p => p.plan.envelope.value));
  // The household savings plan has the same monthly shape as a goal's series.
  const savings = structuredClone(pace);
  savings.result.series = { goals: {}, householdSavings: structuredClone(goal[1]) };
  const saved = checkBlock(only([savings]), [savings]);
  assert.equal(saved.spec.source.path, 'series.householdSavings.series');
  // A goal id outside the block path grammar cannot be a source and draws nothing.
  const hyphen = structuredClone(pace);
  hyphen.result.series = { goals: { 'checking-range': structuredClone(goal[1]) }, householdSavings: { series: null } };
  assert.deepEqual(autoBlocks([hyphen], { now: NOW }), []);
});

test('recurring charges become a timeline labelled by merchant', () => {
  const charges = calls.month.result.groups.slice(0, 2).map((g, i) => ({ merchant: ['Streamwave', 'Corner Gym'][i], cadence: 'monthly',
    firstDate: '2026-01-03', lastDate: '2026-10-03', nextExpected: ['2026-12-03', '2026-11-20'][i], typicalAmount: g.figure, status: 'active' }));
  const recurring = { name: 'spending', args: { operation: 'recurring' }, result: { charges, totalAnnual: calls.month.result.total, gaps: [] } };
  const block = checkBlock(only([recurring]), [recurring]);
  assert.equal(block.op, 'timeline');
  assert.deepEqual(block.snapshot.events.map(e => [e.date, e.label]), [['2026-11-20', 'Corner Gym'], ['2026-12-03', 'Streamwave']]);
});

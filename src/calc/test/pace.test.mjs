import test from 'node:test';
import assert from 'node:assert/strict';
import { goalPace, paceRollup, monthlyPace, paceMeter } from '../pace.mjs';

const clock = '2032-06-29';
const goal = { id: 'cash', title: 'Cash cushion', target: 36600, targetDate: '2033-01-01', pace: { startDate: '2032-01-01', startValue: 0 } };
const actual = (v, date = clock) => ({ v, src: 'balances', kind: 'a', label: 'Savings', dataThrough: date,
  locator: { rows: { table: 'balances', ids: [1], count: 1 } }, dependencies: [{ kind: 'balances', asOf: date }] });

test('linear goal path gives signed dollars and slope-derived time, with a seven day tolerance', () => {
  const ahead = goalPace({ goal, actual: actual(21500), clock });
  assert.equal(ahead.status, 'ahead');
  assert.equal(ahead.expected.v, 18000);
  assert.equal(ahead.gap.v, 3500);
  assert.equal(ahead.gapDays.v, 35);
  assert.equal(ahead.timeGap, '5 weeks ahead');
  const behind = goalPace({ goal, actual: actual(14500), clock });
  assert.equal(behind.status, 'behind');
  assert.equal(behind.gapDays.v, -35);
  assert.equal(behind.timeGap, '5 weeks behind');
  assert.equal(goalPace({ goal, actual: actual(18700), clock }).status, 'on pace');
  assert.equal(goalPace({ goal, actual: actual(18701), clock }).status, 'ahead');
  assert.equal(goalPace({ goal, actual: actual(17300), clock }).status, 'on pace');
});

test('missing, projected, undated and stale actuals never become known health', () => {
  for (const value of [null, { ...actual(18000), kind: 'p' }, { ...actual(18000), dependencies: [] }]) {
    assert.equal(goalPace({ goal, actual: value, clock }).status, 'unknown');
  }
  const stale = goalPace({ goal, actual: actual(18000, '2032-03-01'), clock });
  assert.equal(stale.status, 'unknown');
  assert.equal(stale.reason, 'stale_data');
  assert.equal(stale.dataThrough, '2032-03-01');
  assert.equal(stale.actual.v, 18000);
  const mixed = actual(18000);
  mixed.dependencies.push({ kind: 'balances', asOf: '2032-03-01' });
  assert.equal(goalPace({ goal, actual: mixed, clock }).status, 'unknown');
});

test('targets, missing baselines, flat paths and overdue goals have explicit outcomes', () => {
  assert.equal(goalPace({ goal: { id: 'life' }, actual: null, clock }).status, 'no target');
  assert.equal(goalPace({ goal: { ...goal, targetDate: null }, actual: actual(0), clock }).status, 'no target');
  assert.equal(goalPace({ goal: { ...goal, pace: null }, actual: actual(0), clock }).reason, 'missing_plan_start');
  const flat = { ...goal, pace: { ...goal.pace, startValue: goal.target } };
  assert.equal(goalPace({ goal: flat, actual: actual(18000), clock }).reason, 'non_increasing_path');
  const overdue = goalPace({ goal, actual: actual(33000, '2033-02-01'), clock: '2033-02-01' });
  assert.equal(overdue.status, 'behind');
  assert.equal(overdue.expected.v, 36600);
  assert.equal(overdue.gapDays.v, -36);
  assert.equal(goalPace({ goal, actual: actual(36600, '2033-02-01'), clock: '2033-02-01' }).status, 'on pace');
});

test('rollup counts per-goal health, excludes no target, and uses fixed headlines', () => {
  const result = (status, dataThrough = null) => ({ id: status, status, dataThrough });
  let rollup = paceRollup([result('behind'), result('ahead'), result('on pace'), result('unknown'), result('no target')], clock);
  assert.equal(rollup.headline, '1 goal behind');
  assert.deepEqual(Object.fromEntries(Object.entries(rollup.counts).map(([k, f]) => [k, f.v])), { behind: 1, ahead: 1, onPace: 1, unknown: 1 });
  assert.equal(rollup.total.v, 4);
  rollup = paceRollup([result('on pace'), result('on pace'), result('on pace'), result('ahead')], clock);
  assert.equal(rollup.headline, '3 of 4 goals on pace');
  assert.equal(paceRollup([result('unknown', '2032-03-01')], clock).headline, 'Pace unknown: data through Mar 1');
  assert.equal(paceRollup([result('unknown')], clock).headline, 'Pace unknown: data missing');
  assert.equal(paceRollup([result('no target')], clock).headline, 'No goals with targets');
  assert.equal(paceRollup([result('ahead')], clock).headline, '1 goal ahead');
});

test('each figure carries source rows, calculator inputs, parameters and steps', () => {
  const r = goalPace({ goal, actual: actual(21500), clock });
  for (const key of ['actual', 'expected', 'gap', 'gapDays', 'tolerance', 'target']) {
    const f = r[key];
    assert.equal(typeof f.v, 'number');
    assert.ok(f.src && f.kind && f.label);
    assert.ok(f.locator.calc && f.locator.inputs && f.locator.parameters && f.locator.steps.length);
    assert.equal(f.locator.computedOn, clock);
    assert.ok(f.locator.sources.length);
  }
});

test('monthly deltas keep holes, compare at the data date, and project only beyond data end', () => {
  const m = monthlyPace({ goal, observations: [actual(2500, '2032-01-31'), actual(14500)], clock });
  assert.equal(m.dataEnd, clock);
  assert.equal(m.series.length, 12);
  assert.equal(m.series[0].gap.v, -500);
  assert.equal(m.series[1].gap, null);
  assert.equal(m.series[1].reason, 'missing_month_actual');
  assert.equal(m.series[5].gap.v, -3500);
  assert.equal(m.series[6].projected, true);
  assert.equal(m.series[6].gap.v, -3500);
  assert.equal(m.series[6].gap.kind, 'p');
  assert.equal(m.series[5].projected, false);
  assert.equal(monthlyPace({ goal, observations: [], clock }).series, null);
  assert.ok(monthlyPace({ goal, observations: [], clock }).reason);
});

test('meters require both inputs, and expose the deterministic ratio without clamping overages', () => {
  assert.equal(paceMeter({ used: null, limit: actual(100), clock }).meter, null);
  const r = paceMeter({ used: actual(120), limit: actual(100), clock });
  assert.equal(r.meter.used.v, 120);
  assert.equal(r.meter.limit.v, 100);
  assert.equal(r.meter.ratio.v, 1.2);
  assert.ok(r.meter.ratio.locator.sources.length);
});

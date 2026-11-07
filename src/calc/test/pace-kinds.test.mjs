// Pace per goal kind (goal model v2, docs/plans/goal-model-v2.md decisions 7 to 12 and plan review
// r1 items 2 and 3): rangePace on the low end with a position, floorPace holding or breached,
// contributionPace on a straight line from Jan 1 of the tax year to the deadline, and the pure
// qualifyingContributions rule. Every figure is a calc:pace figure with sources. Pure: no store.
//
// Interpretations recorded for the implementer:
// 1. contributionPace takes `reason` for a missing progress source the store reader already
//    classified (partial_contribution_coverage); without it a missing actual is missing_contributions.
// 2. contributionPace takes `people` as [{person, actual}] (the reader's per-person actuals); targets
//    come from goal.split.
// 3. qualifyingContributions(rows, accountIds, {taxYear, clock}) returns the qualifying rows; rows
//    are {id, account_id, date, amount, description, category}.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../pace.mjs';
import { goalPathChanged } from '../../pace/build.mjs';

const CLOCK = '2026-07-02';
const BAL = [{ rows: { table: 'balances', ids: [1], count: 1 } }];

function act(v, date = CLOCK, { kind = 'a', depKind = 'balances', sources = BAL } = {}) {
  return { v, src: 'calc:pace', kind, label: 'Synthetic tracked value', dataThrough: date,
    dependencies: [{ kind: depKind, asOf: date }], locator: { sources } };
}

// Every figure-shaped object in a result, by path; locator inputs are not walked.
function figuresIn(value, path = 'result', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (typeof value.v === 'number' && Number.isFinite(value.v) && typeof value.src === 'string') { out.push([path, value]); return out; }
  for (const [k, v] of Object.entries(value)) if (k !== 'locator') figuresIn(v, `${path}.${k}`, out);
  return out;
}

/* ---------- range ---------- */

const RANGE = Object.freeze({ id: 'rng', title: 'Checking in range', kind: 'range', targetLow: 20000, targetHigh: 30000,
  targetDate: '2026-12-31', track: { accounts: ['a'] }, pace: { startDate: '2026-01-01', startValue: 10000 } });

test('a range runs the balance path on its low end and reports below, in or above', () => {
  for (const [v, position] of [[10000, 'below'], [19999.99, 'below'], [20000, 'in'], [25000, 'in'], [30000, 'in'], [35000, 'above']]) {
    const r = P.rangePace({ goal: RANGE, actual: act(v), clock: CLOCK });
    const base = P.goalPace({ goal: { ...RANGE, target: RANGE.targetLow }, actual: act(v), clock: CLOCK });
    assert.equal(r.status, base.status, `${v} status`);
    assert.equal(r.expected?.v, base.expected?.v, `${v} expected`);
    assert.equal(r.target?.v, 20000, 'the target is the low end');
    assert.equal(r.range.low.v, 20000);
    assert.equal(r.range.high.v, 30000);
    assert.equal(r.range.low.kind, 't');
    assert.equal(r.range.low.label, 'Range low end');
    assert.equal(r.range.high.label, 'Range high end');
    assert.equal(r.range.position, position, `${v} is ${position}`);
  }
  const none = P.rangePace({ goal: RANGE, actual: null, clock: CLOCK });
  assert.equal(none.range.position, null, 'no reading, no position');
  assert.equal(none.status, 'unknown');
  const stale = P.rangePace({ goal: RANGE, actual: act(25000, '2026-03-01'), clock: CLOCK });
  assert.equal(stale.reason, 'stale_data');
  assert.equal(stale.range.position, 'in', 'a stale reading still places the value');
});

test('a range without both ends is no target', () => {
  for (const goal of [{ ...RANGE, targetHigh: null }, { ...RANGE, targetLow: undefined }, { ...RANGE, targetLow: null, targetHigh: null }]) {
    const r = P.rangePace({ goal, actual: act(25000), clock: CLOCK });
    assert.equal(r.status, 'no target', JSON.stringify(goal));
    assert.equal(r.reason, 'no_target');
    assert.equal(r.range?.position ?? null, null);
  }
  // Liveness: both ends present is a measured range.
  assert.notEqual(P.rangePace({ goal: RANGE, actual: act(25000), clock: CLOCK }).status, 'no target');
});

/* ---------- floor ---------- */

const FLOOR = Object.freeze({ id: 'flr', title: 'Business floor', kind: 'floor', floor: 20000, track: { accounts: ['a'] } });

test('a floor holds at or above its amount and is breached below it', () => {
  const hold = P.floorPace({ goal: FLOOR, actual: act(20000), clock: CLOCK });
  assert.equal(hold.status, 'on pace');
  assert.equal(hold.timeGap, 'Holding');
  assert.equal(hold.gap.v, 0);
  assert.equal(hold.floor.state, 'holding', 'exactly at the floor is holding');
  assert.equal(hold.target.v, 20000);
  assert.equal(hold.target.kind, 't');
  assert.equal(hold.target.label, 'Floor');
  assert.equal(hold.actual.v, 20000);
  for (const k of ['expected', 'gapDays', 'tolerance', 'targetDate']) assert.equal(hold[k], null, `${k} is null for a floor`);
  assert.equal(hold.id, 'flr');
  assert.equal(hold.title, 'Business floor');
  assert.equal(hold.dataThrough, CLOCK);
  assert.equal(hold.stale, false);

  const above = P.floorPace({ goal: FLOOR, actual: act(26000), clock: CLOCK });
  assert.equal(above.status, 'on pace');
  assert.equal(above.gap.v, 6000);

  const breach = P.floorPace({ goal: FLOOR, actual: act(19999.99), clock: CLOCK });
  assert.equal(breach.status, 'behind');
  assert.equal(breach.timeGap, 'Below floor');
  assert.equal(breach.gap.v, -0.01);
  assert.equal(breach.floor.state, 'breached');

  for (const goal of [{ ...FLOOR, floor: null }, { ...FLOOR, floor: undefined }]) {
    const r = P.floorPace({ goal, actual: act(20000), clock: CLOCK });
    assert.equal(r.status, 'no target');
    assert.equal(r.floor?.state ?? null, null);
  }
  const missing = P.floorPace({ goal: FLOOR, actual: null, clock: CLOCK });
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.floor.state, null, 'no reading, no state');
});

test('a stale floor reading keeps its state but not a known status', () => {
  const back = '2026-03-24'; // 100 days before the clock
  const breached = P.floorPace({ goal: FLOOR, actual: act(15000, back), clock: CLOCK });
  assert.equal(breached.status, 'unknown');
  assert.equal(breached.reason, 'stale_data');
  assert.equal(breached.stale, true);
  assert.equal(breached.floor.state, 'breached', 'the last reading still reports the state');
  assert.equal(breached.dataThrough, back);
  const holding = P.floorPace({ goal: FLOOR, actual: act(25000, back), clock: CLOCK });
  assert.equal(holding.status, 'unknown');
  assert.equal(holding.floor.state, 'holding');
  assert.equal(P.floorPace({ goal: FLOOR, actual: act(15000, '2026-12-01'), clock: CLOCK }).status, 'unknown', 'a reading after the clock is not current');
});

test('floors count in the rollup as on pace when holding and behind when breached', () => {
  const holding = P.floorPace({ goal: { ...FLOOR, id: 'f1' }, actual: act(25000), clock: CLOCK });
  const breached = P.floorPace({ goal: { ...FLOOR, id: 'f2', title: 'Second floor' }, actual: act(1000), clock: CLOCK });
  const rollup = P.paceRollup([holding, breached], CLOCK);
  assert.equal(rollup.headline, '1 goal behind');
  assert.equal(rollup.counts.onPace.v, 1);
  assert.equal(rollup.counts.behind.v, 1);
  assert.equal(rollup.total.v, 2);
  assert.equal(P.paceRollup([holding], CLOCK).headline, '1 of 1 goals on pace');
});

/* ---------- contribution ---------- */

// Straight line from 0 on 2026-01-01 to 6000 on 2026-12-31 (364 days): 3000 expected on 2026-07-02.
const CONTRIB = Object.freeze({ id: 'ctb', title: 'Fill the IRA', kind: 'contribution', target: 6000, taxYear: 2026, targetDate: '2026-12-31',
  accounts: ['r1', 'r2'], split: [{ person: 'owner', amount: 3000 }, { person: 'spouse', amount: 3000 }] });
const TXN = [{ rows: { table: 'transactions', ids: [11, 12], count: 2 } }, { rows: { table: 'accounts', ids: ['r1', 'r2'], count: 2 } }];
const txnActual = (v, date = '2026-07-01', sources = TXN) => act(v, date, { depKind: 'bank_csv', sources });
const ENTERED = [{ rows: { table: 'goals', ids: ['ctb'], count: 1 }, field: 'entered', src: 'you' }];
const enteredActual = (v, date = '2026-07-01') => ({ ...act(v, date, { sources: ENTERED }), label: 'Contributed so far, as entered' });

test('a contribution runs a straight line from Jan 1 of the tax year to its deadline', () => {
  const on = P.contributionPace({ goal: CONTRIB, actual: txnActual(3000), basis: 'transactions', clock: CLOCK });
  assert.equal(on.expected.v, 3000);
  assert.equal(on.status, 'on pace');
  assert.equal(on.actual.v, 3000);
  assert.equal(on.target.v, 6000);
  assert.equal(on.contribution.basis, 'transactions');
  assert.equal(on.contribution.taxYear, 2026);
  assert.equal(on.contribution.deadline, '2026-12-31');
  assert.equal(on.contribution.remaining.v, 3000);
  assert.equal(on.contribution.remaining.label, 'Left to contribute');
  assert.ok(on.actual.locator.sources.some(s => s.rows?.table === 'transactions'), 'the transactions are listed');
  assert.equal(P.contributionPace({ goal: CONTRIB, actual: txnActual(4000), basis: 'transactions', clock: CLOCK }).status, 'ahead');
  const behind = P.contributionPace({ goal: CONTRIB, actual: txnActual(1000), basis: 'transactions', clock: CLOCK });
  assert.equal(behind.status, 'behind');
  assert.notEqual(behind.timeGap, 'Deadline passed', 'before the deadline a gap is a time gap');
  // The deadline may sit in the next year (the April deadline for the prior tax year).
  const april = P.contributionPace({ goal: { ...CONTRIB, targetDate: '2027-04-15' }, actual: txnActual(3000), basis: 'transactions', clock: CLOCK });
  assert.ok(april.expected.v < 3000, 'a later deadline lowers the plan today');
});

test('a contribution falls back to the entered amount with provenance you', () => {
  const r = P.contributionPace({ goal: CONTRIB, actual: enteredActual(2000), basis: 'entered',
    people: [{ person: 'owner', actual: enteredActual(1200) }, { person: 'spouse', actual: enteredActual(800) }], clock: CLOCK });
  assert.equal(r.contribution.basis, 'entered');
  assert.equal(r.actual.v, 2000);
  assert.ok(r.actual.locator.sources.some(s => s.field === 'entered' && s.src === 'you' && s.rows?.table === 'goals' && s.rows.ids[0] === 'ctb'));
  assert.equal(r.status, 'behind', '2000 against 3000 planned');
});

test('per-person figures follow the split, then entered persons, with null when a share or actual is unknown', () => {
  const r = P.contributionPace({ goal: CONTRIB, actual: txnActual(3000), basis: 'transactions',
    people: [{ person: 'spouse', actual: txnActual(2000) }, { person: 'owner', actual: txnActual(1000) }], clock: CLOCK });
  assert.deepEqual(r.contribution.people.map(p => p.person), ['owner', 'spouse']);
  const [owner, spouse] = r.contribution.people;
  assert.equal(owner.target.v, 3000);
  assert.equal(owner.target.label, 'Share of the contribution');
  assert.equal(owner.target.kind, 't');
  assert.equal(owner.actual.v, 1000);
  assert.equal(owner.actual.label, 'Contributed so far');
  assert.equal(owner.actual.kind, 'a');
  assert.equal(spouse.actual.v, 2000);

  const total = P.contributionPace({ goal: CONTRIB, actual: txnActual(3000), basis: 'transactions', people: [], clock: CLOCK });
  assert.deepEqual(total.contribution.people.map(p => [p.person, p.target?.v ?? null, p.actual]), [['owner', 3000, null], ['spouse', 3000, null]],
    'no attribution: shares only, the total still shows');
  assert.equal(total.actual.v, 3000);

  const noSplit = P.contributionPace({ goal: { ...CONTRIB, split: null }, actual: enteredActual(2000), basis: 'entered',
    people: [{ person: 'spouse', actual: enteredActual(800) }, { person: 'owner', actual: enteredActual(1200) }], clock: CLOCK });
  assert.deepEqual(noSplit.contribution.people.map(p => [p.person, p.target, p.actual?.v]), [['owner', null, 1200], ['spouse', null, 800]]);
});

test('a contribution at its amount is Reached and past its deadline below it is Deadline passed', () => {
  const reached = P.contributionPace({ goal: CONTRIB, actual: txnActual(6000), basis: 'transactions', clock: CLOCK });
  assert.equal(reached.status, 'ahead');
  assert.equal(reached.timeGap, 'Reached');
  const over = P.contributionPace({ goal: CONTRIB, actual: txnActual(6500), basis: 'transactions', clock: CLOCK });
  assert.equal(over.timeGap, 'Reached');
  const after = '2027-01-10';
  const late = P.contributionPace({ goal: CONTRIB, actual: txnActual(6000, '2027-01-05'), basis: 'transactions', clock: after });
  assert.equal(late.status, 'ahead', 'reached stays ahead after the deadline');
  assert.equal(late.timeGap, 'Reached');
  const missed = P.contributionPace({ goal: CONTRIB, actual: txnActual(5000, '2027-01-05'), basis: 'transactions', clock: after });
  assert.equal(missed.status, 'behind');
  assert.equal(missed.timeGap, 'Deadline passed');
  const stale = P.contributionPace({ goal: CONTRIB, actual: txnActual(5000, '2027-01-05'), basis: 'transactions', clock: '2027-03-01' });
  assert.equal(stale.status, 'unknown', 'a stale reading never reads missed');
  assert.equal(stale.reason, 'stale_data');
  assert.equal(stale.timeGap, null);
});

test('a contribution with no recorded or entered amount is unknown with missing_contributions', () => {
  const r = P.contributionPace({ goal: CONTRIB, actual: null, basis: null, people: [], clock: CLOCK });
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'missing_contributions');
  assert.equal(r.actual, null);
  assert.equal(r.contribution.basis, null);
  assert.equal(r.contribution.remaining ?? null, null);
  const late = P.contributionPace({ goal: CONTRIB, actual: null, basis: null, people: [], clock: '2027-02-01' });
  assert.equal(late.status, 'unknown', 'past the deadline with nothing known is unknown, not behind');
  assert.equal(late.reason, 'missing_contributions');
});

test('a contribution whose destination accounts are only partly covered is unknown with partial_contribution_coverage', () => {
  const r = P.contributionPace({ goal: CONTRIB, actual: null, basis: null, people: [], reason: 'partial_contribution_coverage', clock: CLOCK });
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'partial_contribution_coverage');
  // Liveness: with a progress source the same goal is measured.
  assert.equal(P.contributionPace({ goal: CONTRIB, actual: enteredActual(3000), basis: 'entered', clock: CLOCK }).status, 'on pace');
});

test('an entered amount dated after the clock is not current', () => {
  const r = P.contributionPace({ goal: CONTRIB, actual: enteredActual(2000, '2026-08-01'), basis: 'entered', clock: CLOCK });
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'undated_actual');
});

test('a contribution without an amount, tax year or valid deadline is no target', () => {
  for (const goal of [{ ...CONTRIB, target: null }, { ...CONTRIB, taxYear: null }, { ...CONTRIB, taxYear: 2026.5 }, { ...CONTRIB, targetDate: 'soon' }]) {
    const r = P.contributionPace({ goal, actual: txnActual(3000), basis: 'transactions', clock: CLOCK });
    assert.equal(r.status, 'no target', JSON.stringify(goal));
    assert.equal(r.contribution.basis, 'transactions');
    assert.deepEqual(r.contribution.people, []);
  }
});

/* ---------- provenance ---------- */

test('every figure in each kind result is a calc:pace figure with sources', () => {
  const results = {
    range: P.rangePace({ goal: RANGE, actual: act(25000), clock: CLOCK }),
    floor: P.floorPace({ goal: FLOOR, actual: act(19000), clock: CLOCK }),
    staleFloor: P.floorPace({ goal: FLOOR, actual: act(19000, '2026-03-01'), clock: CLOCK }),
    transactions: P.contributionPace({ goal: CONTRIB, actual: txnActual(3000), basis: 'transactions',
      people: [{ person: 'owner', actual: txnActual(1000) }, { person: 'spouse', actual: txnActual(2000) }], clock: CLOCK }),
    entered: P.contributionPace({ goal: CONTRIB, actual: enteredActual(2000), basis: 'entered',
      people: [{ person: 'owner', actual: enteredActual(1200) }, { person: 'spouse', actual: enteredActual(800) }], clock: CLOCK }),
    missing: P.contributionPace({ goal: CONTRIB, actual: null, basis: null, people: [], clock: CLOCK }),
  };
  const expect = { range: ['target', 'actual', 'range.low', 'range.high'], floor: ['target', 'actual', 'gap'],
    transactions: ['target', 'actual', 'expected', 'contribution.remaining', 'contribution.people.0.target', 'contribution.people.0.actual'],
    entered: ['actual', 'contribution.people.1.actual'] };
  for (const [name, r] of Object.entries(results)) {
    const figs = figuresIn(r);
    assert.ok(figs.length > 0, `${name} has figures`);
    for (const [path, f] of figs) {
      assert.equal(f.src, 'calc:pace', `${name} ${path} src`);
      assert.ok(f.label && f.kind, `${name} ${path} label and kind`);
      assert.ok(Array.isArray(f.locator?.sources) && f.locator.sources.length > 0, `${name} ${path} lists its sources`);
      assert.equal(f.locator.computedOn, CLOCK, `${name} ${path} computedOn`);
      assert.ok(f.locator.calc, `${name} ${path} names its calculator`);
    }
    const paths = figs.map(([p]) => p.replace(/^result\./, ''));
    for (const p of expect[name] || []) assert.ok(paths.includes(p), `${name} has ${p} (${paths.join(', ')})`);
  }
  const ppl = results.entered.contribution.people[0].actual;
  assert.ok(ppl.locator.sources.some(s => s.field === 'entered' && s.src === 'you'), 'a person figure carries that person\'s sources');
  assert.equal(results.range.range.low.locator.calc, 'rangePace');
  assert.equal(results.floor.target.locator.calc, 'floorPace');
  assert.equal(results.transactions.contribution.remaining.locator.calc, 'contributionPace');
});

/* ---------- qualifying contributions ---------- */

const row = (id, account_id, date, amount, description = 'Deposit', category = null) => ({ id, account_id, date, amount, description, category });

test('qualifying contributions are deposits into a destination account within the tax year up to the clock', () => {
  const clock = '2026-11-05';
  const rows = [
    row(1, 'r1', '2026-02-01', 1000, 'Deposit'),
    row(2, 'r2', '2026-04-01', 1500, 'Transfer from checking'),
    row(3, 'r1', '2026-03-01', -200, 'Fee'),
    row(4, 'r1', '2025-12-20', 500, 'Deposit'),
    row(5, 'r1', '2026-12-15', 700, 'Deposit'),
    row(6, 'r2', '2027-01-10', 300, 'Deposit'),
    row(7, 'c1', '2026-05-01', 9999, 'Deposit'),
    row(8, 'r1', '2026-11-05', 50, 'Deposit'),
  ];
  const ids = P.qualifyingContributions(rows, ['r1', 'r2'], { taxYear: 2026, clock }).map(r => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 8], 'a plain deposit and an outside transfer count, on the clock day included; debits, prior-year, future-dated and other accounts do not');
  assert.deepEqual(P.qualifyingContributions(rows, ['r1', 'r2'], { taxYear: 2025, clock }).map(r => r.id), [4]);
  assert.deepEqual(P.qualifyingContributions([], ['r1'], { taxYear: 2026, clock }), []);
});

test('interest, dividends, reinvestments and capital gains are investment income, not contributions', () => {
  const clock = '2026-11-05';
  const rows = [
    row(1, 'r1', '2026-03-31', 12.5, 'Interest payment'),
    row(2, 'r1', '2026-06-30', 40, 'DIV REINVEST VTI'),
    row(3, 'r1', '2026-06-30', 41, 'Quarterly distribution', 'Dividends'),
    row(4, 'r1', '2026-09-30', 42, 'Dividend reinvestment'),
    row(5, 'r1', '2026-10-15', 43, 'Capital gain distribution'),
    row(6, 'r1', '2026-10-01', 44, 'Cap gain short term'),
    row(7, 'r1', '2026-04-01', 2000, 'Contribution'),
    row(8, 'r1', '2026-04-02', 100, 'Deposit', 'Transfer'),
  ];
  assert.deepEqual(P.qualifyingContributions(rows, ['r1'], { taxYear: 2026, clock }).map(r => r.id).sort((a, b) => a - b), [7, 8]);
});

test('a move between two destination accounts is excluded on both sides, matched one to one within five days', () => {
  const clock = '2026-11-05';
  const rows = [
    row(10, 'r1', '2026-03-01', -500, 'Transfer to Roth'),
    row(11, 'r2', '2026-03-02', 500, 'Transfer from IRA'),
    row(12, 'r2', '2026-03-04', 500, 'Deposit'),
    row(20, 'r1', '2026-05-01', -300, 'Transfer out'),
    row(21, 'r2', '2026-05-10', 300, 'Transfer in'),
    row(30, 'r1', '2026-06-01', -250, 'Transfer to brokerage'),
    row(31, 'x9', '2026-06-01', 250, 'Transfer in'),
  ];
  const ids = P.qualifyingContributions(rows, ['r1', 'r2'], { taxYear: 2026, clock }).map(r => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [12, 21], 'the first matching credit pairs with the debit; a credit nine days later is not a move; a non-destination account never counts');
});

/* ---------- path capture ---------- */

test('goalPathChanged recaptures when the range low end or the kind changes', () => {
  const range = { kind: 'range', targetLow: 20000, targetHigh: 30000, targetDate: '2026-12-31', track: { accounts: ['a'] } };
  assert.equal(goalPathChanged(range, { ...range }), false);
  assert.equal(goalPathChanged(range, { ...range, targetLow: 21000 }), true);
  assert.equal(goalPathChanged(range, { ...range, kind: 'balance', target: 20000 }), true);
  const balance = { target: 100, targetDate: '2026-12-31', track: { accounts: ['a'] } };
  assert.equal(goalPathChanged(balance, { ...balance, kind: 'balance' }), false, 'a missing kind is balance');
  assert.equal(goalPathChanged(balance, { ...balance, kind: 'range' }), true);
});

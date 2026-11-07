// Goal model v2 on Home and Plan (web/horizon/screens/home-model.js): priority order, kind chips,
// kind lines with pace figure keys, the pace reason for a breached floor or a missed deadline, plain
// reason text, the served-goal and Plan row order, and homeModel cards on a synthetic scenario and on
// the seeded demo store. Pace entries follow the plan's Interface (range, floor and contribution
// objects beside the goalPace fields). Fixtures are synthetic.
//
// Interpretation recorded for the implementer: kindLine returns an object whose figure fields hold
// scenario figure keys (strings under `pace.goals.<i>.`), with these field names, matching the
// Home templates in the plan: range {low, high, positionLabel, asOf}; floor {floor, stateLabel,
// asOf}; contribution {actual, target, remaining, basisLabel, taxYear, deadline, asOf,
// people: [{person, actual, target}]}. A figure the entry lacks is null.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as H from '../web/horizon/screens/home-model.js';
import { PRIORITIES, priorityRank } from '../src/shared/goals.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { buildScenario, loadLinkedRecs } from '../src/scenario/build.mjs';
import { tempDb } from './helpers/server.mjs';

const CLOCK = '2026-11-05';
const fig = (v, kind = 'e', label = 'Synthetic figure') => ({ v, src: 'calc:pace', kind, label, locator: { sources: [{ rows: { table: 'goals', ids: ['x'], count: 1 } }] } });

// A balance entry shaped like goalPace output.
function pg(id, status, o = {}) {
  const noTarget = status === 'no target';
  return {
    id, title: o.title ?? `Goal ${id}`, targetDate: noTarget ? null : '2027-12-31', status,
    reason: o.reason !== undefined ? o.reason : noTarget ? 'no_target' : status === 'unknown' ? 'stale_data' : null,
    dataThrough: o.dataThrough ?? '2026-10-31', stale: o.stale ?? (status === 'unknown'),
    target: noTarget ? null : fig(1000, 't'), actual: noTarget ? null : fig(500, 'a'), expected: noTarget ? null : fig(450, 'p'),
    gap: noTarget ? null : fig(50), gapDays: o.gapDays ?? null, tolerance: noTarget ? null : fig(5), timeGap: o.timeGap ?? null,
    kind: 'balance', owner: o.owner ?? null, priority: o.priority ?? null,
  };
}
const rangeP = (id, status, position, o = {}) => ({ ...pg(id, status, o), kind: 'range',
  range: { low: fig(4000, 't', 'Range low end'), high: fig(8000, 't', 'Range high end'), position } });
const floorP = (id, status, state, o = {}) => ({ ...pg(id, status, o), kind: 'floor', targetDate: null,
  target: fig(10000, 't', 'Floor'), expected: null, gapDays: null, tolerance: null,
  timeGap: o.timeGap !== undefined ? o.timeGap : status === 'on pace' ? 'Holding' : status === 'behind' ? 'Below floor' : null,
  floor: { state } });
function contribP(id, status, o = {}) {
  const missing = o.missing === true;
  return { ...pg(id, status, o), kind: 'contribution', targetDate: '2027-04-15', target: fig(14000, 't'),
    actual: missing ? null : fig(4500, 'a', 'Contributed so far'), reason: missing ? 'missing_contributions' : (o.reason ?? null),
    contribution: { basis: missing ? null : (o.basis ?? 'entered'), taxYear: 2026, deadline: '2027-04-15',
      remaining: missing ? null : fig(9500, 'e', 'Left to contribute'),
      people: [{ person: 'owner', target: fig(7000, 't'), actual: missing ? null : fig(3000, 'a') },
        { person: 'spouse', target: fig(7000, 't'), actual: missing ? null : fig(1500, 'a') }] } };
}

const KEY = { 'on pace': 'onPace', ahead: 'ahead', behind: 'behind', unknown: 'unknown' };
function paceOf(goals) {
  const included = goals.filter(g => g.status !== 'no target');
  const n = { behind: 0, ahead: 0, onPace: 0, unknown: 0 };
  for (const g of included) n[KEY[g.status]] += 1;
  return { clock: CLOCK, rollup: { headline: 'Synthetic headline', dataThrough: included.map(g => g.dataThrough).sort()[0] ?? null,
    counts: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, fig(v)])), total: fig(included.length) },
  goals, series: { goals: {}, householdSavings: { series: null, dataEnd: null, reason: 'missing_household_savings_plan' } }, meters: {} };
}
const goal = (id, o = {}) => ({ id, title: `Goal ${id}`, origin: 'owner', status: 'open', archived: false, kind: 'balance', owner: null, priority: null, ...o });
const ids = list => list.map(x => x.id);

/* ---------- priority ---------- */

test('PRIORITY_RANK matches PRIORITIES in src/shared/goals.mjs', () => {
  assert.deepEqual(Object.entries(H.PRIORITY_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k), [...PRIORITIES]);
  for (const [i, p] of PRIORITIES.entries()) assert.equal(H.PRIORITY_RANK[p], i, p);
  for (const p of [...PRIORITIES, null, undefined, '', 'urgent']) assert.equal(H.priorityRankOf(p), priorityRank(p), String(p));
  assert.equal(H.priorityRankOf(null), PRIORITIES.length, 'unset sorts last');
});

test('orderGoals puts done goals last and orders by priority; orderServes orders served goals by priority', () => {
  const goals = [
    goal('a'), goal('b', { priority: 'low' }), goal('c', { priority: 'high', status: 'done' }), goal('d', { priority: 'high' }),
    goal('e', { priority: 'medium' }), goal('f', { priority: 'high' }), goal('g', { status: 'done' }), goal('h', { origin: 'seed', status: 'open', statusLabel: 'on track' }),
  ];
  const before = JSON.stringify(goals);
  assert.deepEqual(ids(H.orderGoals(goals)), ['d', 'f', 'e', 'b', 'a', 'h', 'c', 'g'], 'stable within a rank; done goals last, by priority');
  assert.equal(JSON.stringify(goals), before, 'the input is not reordered in place');
  assert.deepEqual(H.orderGoals([]), []);

  const serves = [{ id: 'a', title: 'A', origin: 'owner' }, { id: 'b', title: 'B', origin: 'owner' }, { id: 'zz', title: 'Gone', origin: 'seed' },
    { id: 'd', title: 'D', origin: 'owner' }, { id: 'e', title: 'E', origin: 'owner' }];
  assert.deepEqual(ids(H.orderServes(serves, goals)), ['d', 'e', 'b', 'a', 'zz'], 'an unknown goal sorts with unset, keeping its place');
  assert.deepEqual(ids(H.orderServes(serves.slice(0, 2), [])), ['a', 'b'], 'no goals: the order is kept');
});

test('planOrder sorts Plan rows by deadline, then the best priority among served open goals, then the existing order', () => {
  const goals = [goal('hi', { priority: 'high' }), goal('med', { priority: 'medium' }), goal('lo', { priority: 'low' }),
    goal('doneHi', { priority: 'high', status: 'done' }), goal('archHi', { priority: 'high', archived: true }), goal('none')];
  const r = (id, days, serves = []) => ({ id, title: `Rec ${id}`, status: 'proposed', window: { days }, serves: serves.map(g => ({ id: g, title: g, origin: 'owner' })) });
  const recs = [
    r('r1', 30, ['none']), r('r2', 30, ['lo', 'med']), r('r3', 10), r('r4', 30, ['hi']), r('r5', 30, ['doneHi']),
    r('r6', 30, ['archHi', 'lo']), r('r7', 30), r('r8', 5, ['lo']),
  ];
  assert.deepEqual(ids(H.planOrder(recs, goals)), ['r8', 'r3', 'r4', 'r2', 'r6', 'r1', 'r5', 'r7'],
    'days first; within a day the best served open priority; done and archived goals do not count; ties keep their order');
  assert.deepEqual(ids(H.planOrder(recs.slice(0, 3), [])), ['r3', 'r1', 'r2'], 'no goals: by days, then the existing order');
});

/* ---------- chips ---------- */

test('goalChip says In range, Above range, Holding, Below floor even when stale, Reached and Deadline passed', () => {
  const cases = [
    [rangeP('r', 'on pace', 'in', { timeGap: 'On pace' }), { tone: 'ok', label: 'In range' }],
    [rangeP('r', 'ahead', 'in', { timeGap: '3 weeks ahead' }), { tone: 'ok', label: 'In range' }],
    [rangeP('r', 'ahead', 'above', { timeGap: 'Reached' }), { tone: 'ok', label: 'Above range' }],
    [rangeP('r', 'behind', 'below', { timeGap: '2 weeks behind' }), { tone: 'warn', label: '2 weeks behind' }],
    [rangeP('r', 'unknown', 'in'), { tone: 'bad', label: 'Data stale' }],
    [floorP('f', 'on pace', 'holding'), { tone: 'ok', label: 'Holding' }],
    [floorP('f', 'behind', 'breached'), { tone: 'warn', label: 'Below floor' }],
    [floorP('f', 'unknown', 'breached'), { tone: 'warn', label: 'Below floor' }],
    [floorP('f', 'unknown', 'holding'), { tone: 'bad', label: 'Data stale' }],
    [floorP('f', 'unknown', null, { reason: 'missing_actual', stale: false }), { tone: 'mute', label: 'Pace unknown' }],
    [contribP('c', 'ahead', { timeGap: 'Reached' }), { tone: 'ok', label: 'Reached' }],
    [contribP('c', 'behind', { timeGap: 'Deadline passed' }), { tone: 'warn', label: 'Deadline passed' }],
    [contribP('c', 'unknown', { missing: true, stale: false }), { tone: 'mute', label: 'Pace unknown' }],
  ];
  for (const [p, want] of cases) assert.deepEqual(H.goalChip(p), want, JSON.stringify([p.kind, p.status, p.range?.position ?? p.floor?.state ?? p.timeGap]));
  // A balance goal keeps its chip.
  assert.deepEqual(H.goalChip(pg('b', 'on pace', { timeGap: 'On pace' })), { tone: 'ok', label: 'On pace' });
});

test('a current breach raises the health chip', () => {
  assert.deepEqual(H.healthChip(paceOf([floorP('f', 'behind', 'breached'), pg('b', 'on pace')])), { tone: 'warn', label: '1 goal behind' });
  assert.deepEqual(H.healthChip(paceOf([floorP('f', 'on pace', 'holding')])), { tone: 'ok', label: 'On pace' });
});

/* ---------- kind lines ---------- */

test('kindLine gives range ends, floor state and contribution progress as pace figure keys', () => {
  assert.equal(H.kindLine(null, 0), null, 'no pace, no line');
  assert.equal(H.kindLine(pg('b', 'on pace'), 0), null, 'a balance goal has no kind line');

  const range = H.kindLine(rangeP('r', 'on pace', 'in', { stale: false }), 2);
  assert.equal(range.low, 'pace.goals.2.range.low');
  assert.equal(range.high, 'pace.goals.2.range.high');
  assert.equal(range.positionLabel, 'In range');
  assert.equal(H.kindLine(rangeP('r', 'behind', 'below'), 0).positionLabel, 'Below range');
  assert.equal(H.kindLine(rangeP('r', 'ahead', 'above'), 0).positionLabel, 'Above range');
  assert.equal(H.kindLine(rangeP('r', 'unknown', null, { reason: 'missing_actual', stale: false }), 0).positionLabel ?? null, null);

  const holding = H.kindLine(floorP('f', 'on pace', 'holding', { stale: false }), 1);
  assert.equal(holding.floor, 'pace.goals.1.target');
  assert.equal(holding.stateLabel, 'Holding');
  assert.equal(holding.asOf ?? null, null, 'current data needs no as-of date');
  const stale = H.kindLine(floorP('f', 'unknown', 'breached', { dataThrough: '2026-08-30' }), 1);
  assert.equal(stale.stateLabel, 'Below floor');
  assert.equal(stale.asOf, '2026-08-30', 'stale data shows its date');

  const c = H.kindLine(contribP('c', 'ahead', { basis: 'entered', stale: false }), 3);
  assert.equal(c.actual, 'pace.goals.3.actual');
  assert.equal(c.target, 'pace.goals.3.target');
  assert.equal(c.remaining, 'pace.goals.3.contribution.remaining');
  assert.equal(c.basisLabel, 'As you entered');
  assert.equal(c.taxYear, 2026);
  assert.equal(c.deadline, '2027-04-15');
  assert.deepEqual(c.people.map(p => [p.person, p.actual, p.target]), [
    ['owner', 'pace.goals.3.contribution.people.0.actual', 'pace.goals.3.contribution.people.0.target'],
    ['spouse', 'pace.goals.3.contribution.people.1.actual', 'pace.goals.3.contribution.people.1.target'],
  ]);
  assert.equal(H.kindLine(contribP('c', 'ahead', { basis: 'transactions' }), 0).basisLabel, 'From recorded contributions');
  const none = H.kindLine(contribP('c', 'unknown', { missing: true }), 0);
  assert.equal(none.actual, null, 'no progress figure, no key');
  assert.equal(none.remaining, null);
  assert.deepEqual(none.people.map(p => [p.actual, p.target]), [[null, 'pace.goals.0.contribution.people.0.target'], [null, 'pace.goals.0.contribution.people.1.target']]);
});

/* ---------- reasons ---------- */

test('paceReason names a breached floor and a missed deadline in plain words', () => {
  assert.equal(H.paceReason(paceOf([floorP('f', 'behind', 'breached', { title: 'Business floor' }), pg('b', 'on pace')])), 'Business floor is below its floor.');
  assert.equal(H.paceReason(paceOf([contribP('c', 'behind', { title: 'Fill both IRAs', timeGap: 'Deadline passed' })])), 'Fill both IRAs missed its deadline.');
  const two = H.paceReason(paceOf([floorP('f', 'behind', 'breached', { title: 'Business floor' }), pg('b', 'behind', { title: 'Cash goal', timeGap: '5 weeks behind', gapDays: fig(-35) })]));
  assert.match(two, /^2 goals are behind plan; .+ is furthest, .+\.$/, 'the multi-goal sentence keeps its form');
  // Liveness: an ordinary behind balance goal reads as before.
  assert.equal(H.paceReason(paceOf([pg('b', 'behind', { title: 'Cash goal', timeGap: '5 weeks behind' })])), 'Cash goal is 5 weeks behind plan.');
});

test('REASON_TEXT has plain text for missing_contributions and kind_not_charted', () => {
  assert.equal(H.REASON_TEXT.missing_contributions, 'No contributions are recorded or entered yet.');
  assert.equal(H.REASON_TEXT.kind_not_charted, 'This kind of goal has no monthly chart.');
  assert.equal(H.reasonText('missing_contributions'), H.REASON_TEXT.missing_contributions);
  for (const [code, text] of Object.entries(H.REASON_TEXT)) {
    assert.doesNotMatch(text, /_|\u2013|\u2014|\$\s?\d/, `${code} reads as plain words`);
  }
});

/* ---------- homeModel ---------- */

function household() {
  const goals = [
    goal('g_none'), goal('g_low', { priority: 'low', owner: 'spouse' }), goal('g_range', { kind: 'range', priority: 'medium', owner: 'joint' }),
    goal('g_floor', { kind: 'floor', priority: 'high', owner: 'owner' }), goal('g_bal', { priority: 'medium' }),
    goal('g_contrib', { kind: 'contribution', priority: 'high', owner: 'joint' }), goal('g_done', { priority: 'high', status: 'done' }),
    goal('g_seed', { origin: 'seed', status: 'open', statusLabel: 'on track', kind: undefined, owner: undefined, priority: undefined }),
    goal('g_extra', { priority: 'low' }),
  ];
  const pace = paceOf([
    pg('g_none', 'behind', { timeGap: '1 week behind' }), pg('g_low', 'on pace', { priority: 'low', owner: 'spouse' }),
    rangeP('g_range', 'on pace', 'in', { priority: 'medium', owner: 'joint' }), floorP('g_floor', 'unknown', 'holding', { priority: 'high', owner: 'owner' }),
    pg('g_bal', 'ahead', { priority: 'medium' }), contribP('g_contrib', 'ahead', { priority: 'high', owner: 'joint' }), pg('g_seed', 'on pace'),
  ]);
  return { goals, pace, recs: [], suggestions: [], clock: CLOCK, filter: 'both' };
}

test('homeModel orders cards high, medium, low, unset, keeping pace order within a priority', () => {
  const m = H.homeModel(household());
  assert.deepEqual(ids(m.cards), ['g_floor', 'g_contrib', 'g_range', 'g_bal', 'g_low', 'g_extra', 'g_none', 'g_seed']);
});

test('cards carry kind, owner, priority and line, and a done goal has no card', () => {
  const h = household();
  const m = H.homeModel(h);
  const card = id => m.cards.find(c => c.id === id);
  assert.equal(card('g_done'), undefined);
  for (const c of m.cards) {
    const g = h.goals.find(x => x.id === c.id);
    assert.equal(c.kind, g.kind || 'balance', `${c.id} kind`);
    assert.equal(c.owner, g.owner ?? null, `${c.id} owner`);
    assert.equal(c.priority, g.priority ?? null, `${c.id} priority`);
    assert.equal(c.paceIndex, h.pace.goals.findIndex(p => p.id === c.id), `${c.id} paceIndex`);
    assert.deepEqual(c.line, c.pace ? H.kindLine(c.pace, c.paceIndex) : null, `${c.id} line`);
    assert.deepEqual(c.chip, H.goalChip(c.pace), `${c.id} chip`);
  }
  assert.equal(card('g_seed').kind, 'balance', 'a goal without a kind reads balance');
  assert.equal(card('g_bal').line, null, 'balance goals have no kind line');
  assert.equal(card('g_extra').line, null, 'no pace entry, no line');
  assert.equal(card('g_floor').line.floor, `pace.goals.${card('g_floor').paceIndex}.target`);
  assert.equal(card('g_contrib').line.people.length, 2);
});

/* ---------- the demo ---------- */

test('over the seeded demo store each kind goal card has a kind line whose figure keys exist in scenario.fig', async () => {
  const t = await tempDb();
  try {
    seedDemo(t.db);
    const sc = buildScenario(t.db);
    const recs = loadLinkedRecs(t.db, sc.live.clock);
    const m = H.homeModel({ goals: sc.goals, pace: sc.pace, recs, filter: 'both', suggestions: sc.suggestions, clock: sc.meta.clock });
    assert.deepEqual(ids(m.cards).slice(0, 3), ['biz-floor', 'checking-range', 'ira-fill'], 'high first, then the two medium goals in pace order');
    const ranks = m.cards.map(c => H.priorityRankOf(c.priority));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'cards never step up in priority');
    const card = id => m.cards.find(c => c.id === id);
    for (const [id, kind] of [['biz-floor', 'floor'], ['checking-range', 'range'], ['ira-fill', 'contribution']]) {
      const c = card(id);
      assert.equal(c.kind, kind);
      assert.ok(c.line, `${id} has a kind line`);
      const keys = [];
      (function walk(v) {
        if (typeof v === 'string' && v.startsWith('pace.goals.')) keys.push(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      })(c.line);
      assert.ok(keys.length > 0, `${id} line names figures`);
      for (const k of keys) {
        assert.ok(k.startsWith(`pace.goals.${c.paceIndex}.`), `${id} key ${k} is its own entry`);
        assert.ok(sc.fig[k] && Number.isFinite(sc.fig[k].v), `${id} figure ${k} exists in scenario.fig`);
      }
    }
    assert.equal(card('biz-floor').owner, 'owner');
    assert.equal(card('biz-floor').priority, 'high');
    assert.equal(card('biz-floor').line.stateLabel, 'Holding');
    assert.equal(card('biz-floor').line.asOf, sc.pace.goals[card('biz-floor').paceIndex].dataThrough, 'the demo balances are stale, so the line dates them');
    assert.equal(card('checking-range').line.positionLabel, 'In range');
    const ira = card('ira-fill');
    assert.equal(ira.line.basisLabel, 'As you entered');
    assert.equal(ira.line.people.length, 2);
    assert.deepEqual(ira.line.people.map(p => p.person), ['owner', 'spouse']);
    assert.equal(ira.chip.tone, 'ok', 'the entered contribution is ahead');
    for (const c of m.cards.filter(x => x.kind === 'balance')) assert.equal(c.line, null, `${c.id} balance card has no kind line`);
  } finally {
    t.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  }
});

/* ---------- entered progress draft and fields (regression: saving an unrelated edit kept progress) ---------- */

const PEOPLE = { asOf: '2026-11-01', people: [{ person: 'owner', amount: 1500 }, { person: 'spouse', amount: 1000 }] };
const TOTAL = { asOf: '2026-11-01', total: 2500 };
const SPLIT = [{ person: 'owner', amount: 3000 }, { person: 'spouse', amount: 3000 }];
const blank = { enteredTotal: '', enteredOwner: '', enteredSpouse: '', enteredAsOf: '' };

test('enteredDraft turns the stored progress into string fields', () => {
  assert.deepEqual(H.enteredDraft(null), { enteredTotal: '', enteredOwner: '', enteredSpouse: '', enteredAsOf: '' });
  assert.deepEqual(H.enteredDraft(PEOPLE), { enteredTotal: '', enteredOwner: '1500', enteredSpouse: '1000', enteredAsOf: '2026-11-01' });
  assert.deepEqual(H.enteredDraft(TOTAL), { enteredTotal: '2500', enteredOwner: '', enteredSpouse: '', enteredAsOf: '2026-11-01' });
});

test('enteredFields round trips every stored shape, with or without a split', () => {
  assert.deepEqual(H.enteredFields(H.enteredDraft(PEOPLE), null, 'x'), { entered: PEOPLE }, 'people and no split');
  assert.deepEqual(H.enteredFields(H.enteredDraft(TOTAL), SPLIT, 'x'), { entered: TOTAL }, 'total and a two-person split');
  assert.deepEqual(H.enteredFields(H.enteredDraft(PEOPLE), SPLIT, 'x'), { entered: PEOPLE }, 'people and a matching split');
  assert.deepEqual(H.enteredFields(H.enteredDraft(TOTAL), null, 'x'), { entered: TOTAL }, 'total and no split');
  assert.deepEqual(H.enteredFields(H.enteredDraft(null), null, 'x'), { entered: null });
  assert.deepEqual(H.enteredFields(H.enteredDraft(null), SPLIT, 'x'), { entered: null });
});

test('enteredFields keeps only non-blank people in owner then spouse order and defaults asOf', () => {
  assert.deepEqual(H.enteredFields({ ...blank, enteredSpouse: '40' }, null, '2026-11-08'), { entered: { asOf: '2026-11-08', people: [{ person: 'spouse', amount: 40 }] } });
  assert.deepEqual(H.enteredFields({ ...blank, enteredOwner: '10', enteredSpouse: '40', enteredAsOf: '2026-10-01' }, null, 'x'),
    { entered: { asOf: '2026-10-01', people: [{ person: 'owner', amount: 10 }, { person: 'spouse', amount: 40 }] } });
  assert.deepEqual(H.enteredFields({ ...blank, enteredTotal: '75', enteredAsOf: '  ' }, [], '2026-11-08'), { entered: { asOf: '2026-11-08', total: 75 } });
  assert.deepEqual(H.enteredFields({ ...blank, enteredOwner: '0' }, null, 'x'), { entered: { asOf: 'x', people: [{ person: 'owner', amount: 0 }] } });
  assert.deepEqual(H.enteredFields({ ...blank, enteredOwner: '  ', enteredTotal: '5' }, null, 'x'), { entered: { asOf: 'x', total: 5 } }, 'a whitespace amount is blank');
});

test('enteredFields rejects bad amounts and amounts for a person with no share', () => {
  const NO_SHARE = 'Contributed amounts are only for people with a share.';
  const BAD = 'What was contributed must be zero or more.';
  assert.deepEqual(H.enteredFields({ ...blank, enteredSpouse: '5' }, [{ person: 'owner', amount: 100 }], 'x'), { err: NO_SHARE });
  assert.deepEqual(H.enteredFields({ ...blank, enteredOwner: '5' }, [{ person: 'spouse', amount: 100 }], 'x'), { err: NO_SHARE });
  assert.ok(H.enteredFields({ ...blank, enteredOwner: '5' }, null, 'x').entered, 'no split means no share check');
  assert.ok(H.enteredFields({ ...blank, enteredOwner: '5' }, [], 'x').entered, 'an empty split means no share check');
  for (const bad of ['-1', 'abc', '1e', '-0.5']) {
    assert.deepEqual(H.enteredFields({ ...blank, enteredOwner: bad }, null, 'x'), { err: BAD }, `owner ${bad}`);
    assert.deepEqual(H.enteredFields({ ...blank, enteredSpouse: bad }, SPLIT, 'x'), { err: BAD }, `spouse ${bad}`);
    assert.deepEqual(H.enteredFields({ ...blank, enteredTotal: bad }, null, 'x'), { err: BAD }, `total ${bad}`);
  }
});

test('enteredInputs shows the inputs for the stored representation', () => {
  assert.deepEqual(H.enteredInputs(blank, null), { people: false, total: true });
  assert.deepEqual(H.enteredInputs(blank, []), { people: false, total: true });
  assert.deepEqual(H.enteredInputs(blank, SPLIT), { people: true, total: false });
  assert.deepEqual(H.enteredInputs(H.enteredDraft(PEOPLE), null), { people: true, total: true }, 'people stored with no split');
  assert.deepEqual(H.enteredInputs(H.enteredDraft(TOTAL), SPLIT), { people: true, total: true }, 'total stored with a split');
  assert.deepEqual(H.enteredInputs(H.enteredDraft(TOTAL), null), { people: false, total: true });
  assert.deepEqual(H.enteredInputs(H.enteredDraft(PEOPLE), SPLIT), { people: true, total: false });
});

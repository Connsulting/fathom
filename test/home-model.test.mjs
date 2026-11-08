// The goals-first Home view model (web/horizon/screens/home-model.js): owner filter, goal links,
// housekeeping, next actions, one card per live goal with its suggested target, the due list before
// Dec 31, the headline, pace chips, the health chip, the pace board reason and charts, pace bars,
// reason text and the data-health line. The module is pure ESM with no DOM
// work at import, so node imports it directly. Fixtures are synthetic and built inline; pace goal
// entries follow the shape of src/calc/pace.mjs goalPace output, and rec fixtures carry the shape
// loadLinkedRecs gives (owner, housekeeping, serves). One test builds them from a seeded demo store.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  ownerMatches, servedGoalIds, isHousekeepingItem, isOpen, goalChip, healthChip,
  paceReason, paceBar, REASON_TEXT, reasonText, homeModel, homeHeadline, healthLine, boardCharts, cardChip, paceMeters
} from '../web/horizon/screens/home-model.js';
import { OWNERS } from '../src/shared/rec-links.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { buildScenario, loadLinkedRecs } from '../src/scenario/build.mjs';
import { tempDb } from './helpers/server.mjs';

/* ---------- fixtures ---------- */

const fig = (v, kind = 'e', label = 'Synthetic figure') => ({ v, src: 'calc:pace', kind, label });

// A pace goal entry. Defaults describe a current, behind-plan goal with a target.
function pg(id, status, o = {}) {
  const noTarget = status === 'no target';
  return {
    id,
    title: o.title ?? `Goal ${id}`,
    targetDate: noTarget ? null : '2027-12-31',
    status,
    reason: o.reason !== undefined ? o.reason : noTarget ? 'no_target' : status === 'unknown' ? 'stale_data' : null,
    dataThrough: o.dataThrough !== undefined ? o.dataThrough : '2026-10-31',
    stale: o.stale ?? (status === 'unknown' && (o.reason ?? 'stale_data') === 'stale_data'),
    target: 'target' in o ? o.target : noTarget ? null : fig(1000, 't', 'Goal target'),
    actual: 'actual' in o ? o.actual : noTarget ? null : fig(500, 'a', 'Latest tracked value'),
    expected: 'expected' in o ? o.expected : noTarget ? null : fig(450, 'p', 'Expected today'),
    gap: 'gap' in o ? o.gap : noTarget ? null : fig(50, 'e', 'Tracked value minus plan'),
    gapDays: 'gapDays' in o ? o.gapDays : null,
    tolerance: noTarget ? null : fig(5, 'e', 'On pace tolerance'),
    timeGap: o.timeGap ?? null
  };
}

const KEY = { 'on pace': 'onPace', ahead: 'ahead', behind: 'behind', unknown: 'unknown' };

// A scenario.pace object around a list of pace goal entries, with a consistent rollup.
function paceOf(goals, o = {}) {
  const included = goals.filter((g) => g.status !== 'no target');
  const n = { behind: 0, ahead: 0, onPace: 0, unknown: 0 };
  for (const g of included) n[KEY[g.status]] += 1;
  const dates = included.map((g) => g.dataThrough).filter(Boolean).sort();
  return {
    clock: '2026-11-05',
    rollup: {
      headline: o.headline ?? 'Synthetic headline',
      dataThrough: 'dataThrough' in o ? o.dataThrough : dates[0] ?? null,
      counts: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, fig(v, 'e', `Goals ${k}`)])),
      total: fig(included.length, 'e', 'Goals with targets')
    },
    goals,
    series: {
      goals: o.seriesGoals ?? {},
      householdSavings: o.householdSavings ?? { series: null, dataEnd: null, reason: 'missing_household_savings_plan' }
    },
    meters: {
      retirement: { meter: null, reason: 'missing_meter_inputs', dataThrough: null, deadline: '2026-12-31' },
      tax: { meter: null, reason: 'missing_meter_inputs', dataThrough: null, deadline: '2026-12-31' },
      income: { meter: null, reason: 'missing_meter_inputs', dataThrough: null, deadline: '2026-12-31' }
    }
  };
}

// A rec as loadLinkedRecs returns it: an owner, the open goals it serves as { id, title, origin },
// and housekeeping exactly when it serves none. `o.serves` lists goal ids.
function rec(id, o = {}) {
  const serves = (o.serves ?? []).map((g) => ({ id: g, title: `Goal ${g}`, origin: 'seed' }));
  return {
    id, title: o.title ?? `Task ${id}`, status: o.status ?? 'proposed', window: { days: o.days ?? 30 },
    owner: o.owner ?? 'both', housekeeping: serves.length === 0, serves
  };
}

const goal = (id, o = {}) => ({ id, title: `Goal ${id}`, status: o.status ?? 'on track', archived: o.archived ?? false });
const ids = (list) => list.map((x) => x.id);
const cardOf = (m, id) => m.cards.find((c) => c.id === id);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} is not ${b}`);

/* ---------- owners ---------- */

test('ownerMatches: Both matches every action, Me is you or both, Spouse is spouse or both', () => {
  const expect = {
    both: ['you', 'spouse', 'both', 'advisor', 'automatic'],
    me: ['you', 'both'],
    spouse: ['spouse', 'both']
  };
  for (const [filter, yes] of Object.entries(expect)) {
    for (const o of OWNERS) assert.equal(ownerMatches(rec('r', { owner: o }), filter), yes.includes(o), `filter ${filter}, owner ${o}`);
  }
});

test('ownerMatches treats an unknown filter like Both', () => {
  for (const o of OWNERS) {
    assert.equal(ownerMatches(rec('r', { owner: o }), 'everyone'), true, o);
    assert.equal(ownerMatches(rec('r', { owner: o }), undefined), true, o);
  }
});

/* ---------- goal links and housekeeping ---------- */

test('servedGoalIds maps the served goal objects to their ids', () => {
  assert.deepEqual(servedGoalIds(rec('r')), []);
  assert.deepEqual(servedGoalIds(rec('r', { serves: ['a', 'b'] })), ['a', 'b']);
  assert.deepEqual(servedGoalIds({ serves: [{ id: 'a', title: 'A', origin: 'seed' }, { id: 7, title: 'Seven', origin: 'owner' }] }), ['a', '7']);
});

test('isHousekeepingItem counts open, waiting and snoozed housekeeping, not closed recs or goal work', () => {
  for (const status of ['proposed', 'doing', 'waiting', 'snoozed']) {
    assert.equal(isHousekeepingItem(rec('r', { status })), true, status);
  }
  for (const status of ['done', 'dismissed', 'hidden']) {
    assert.equal(isHousekeepingItem(rec('r', { status })), false, status);
  }
  for (const status of ['proposed', 'doing', 'waiting', 'snoozed']) {
    assert.equal(isHousekeepingItem(rec('r', { status, serves: ['g'] })), false, `${status} serving a goal`);
  }
});

test('isOpen is proposed or doing only', () => {
  assert.equal(isOpen({ status: 'proposed' }), true);
  assert.equal(isOpen({ status: 'doing' }), true);
  for (const s of ['waiting', 'snoozed', 'done', 'dismissed', 'hidden', undefined]) assert.equal(isOpen({ status: s }), false, String(s));
});

/* ---------- goal chip ---------- */

test('goalChip maps each pace status to a tone and label', () => {
  const cases = [
    [pg('a', 'ahead', { timeGap: '3 weeks ahead' }), { tone: 'ok', label: '3 weeks ahead' }],
    [pg('a', 'ahead'), { tone: 'ok', label: 'Ahead' }],
    [pg('a', 'ahead', { timeGap: 'Reached' }), { tone: 'ok', label: 'Reached' }],
    [pg('a', 'on pace', { timeGap: 'On pace' }), { tone: 'ok', label: 'On pace' }],
    [pg('a', 'on pace'), { tone: 'ok', label: 'On pace' }],
    [pg('a', 'behind', { timeGap: '5 weeks behind' }), { tone: 'warn', label: '5 weeks behind' }],
    [pg('a', 'behind'), { tone: 'warn', label: 'Behind' }],
    [pg('a', 'unknown', { reason: 'stale_data' }), { tone: 'bad', label: 'Data stale' }],
    [pg('a', 'unknown', { reason: 'unknown_freshness', stale: false }), { tone: 'mute', label: 'Pace unknown' }],
    [pg('a', 'unknown', { reason: 'missing_plan_start', stale: false }), { tone: 'mute', label: 'Pace unknown' }],
    [pg('a', 'no target'), { tone: 'mute', label: 'No target' }],
    [null, { tone: 'mute', label: 'No target' }]
  ];
  for (const [p, want] of cases) assert.deepEqual(goalChip(p), want, JSON.stringify(p && [p.status, p.reason, p.timeGap]));
});

test('goalChip never says On pace for stale or otherwise not current pace', () => {
  // Even a leftover On pace time gap must not leak through when the status is not on pace.
  for (const status of ['unknown', 'ahead', 'behind', 'no target']) {
    for (const reason of ['stale_data', 'unknown_freshness', 'undated_actual', null]) {
      const chip = goalChip(pg('a', status, { reason, timeGap: 'On pace', stale: reason === 'stale_data' }));
      assert.notEqual(chip.label, 'On pace', `${status} ${reason}`);
    }
  }
  // Liveness: a current on pace goal does say On pace.
  assert.equal(goalChip(pg('a', 'on pace', { timeGap: 'On pace' })).label, 'On pace');
});

/* ---------- health chip ---------- */

test('healthChip: behind first, then stale or unknown, then no targets, then on pace', () => {
  assert.deepEqual(healthChip(paceOf([pg('a', 'behind'), pg('b', 'on pace')])), { tone: 'warn', label: '1 goal behind' });
  assert.deepEqual(healthChip(paceOf([pg('a', 'behind'), pg('b', 'behind'), pg('c', 'unknown')])), { tone: 'warn', label: '2 goals behind' });
  assert.deepEqual(healthChip(paceOf([pg('a', 'unknown'), pg('b', 'on pace')])), { tone: 'bad', label: 'Data stale' });
  assert.deepEqual(healthChip(paceOf([pg('a', 'unknown', { reason: 'unknown_freshness', stale: false }), pg('b', 'on pace')])), { tone: 'mute', label: 'Pace unknown' });
  assert.deepEqual(healthChip(paceOf([pg('a', 'no target'), pg('b', 'no target')])), { tone: 'mute', label: 'No targets yet' });
  assert.deepEqual(healthChip(paceOf([])), { tone: 'mute', label: 'No targets yet' });
  assert.deepEqual(healthChip(paceOf([pg('a', 'on pace'), pg('b', 'ahead'), pg('c', 'no target')])), { tone: 'ok', label: 'On pace' });
});

test('healthChip never says On pace while any goal with a target is stale or unknown', () => {
  const stale = paceOf([pg('a', 'on pace'), pg('b', 'ahead'), pg('c', 'unknown')]);
  assert.notEqual(healthChip(stale).label, 'On pace');
  const unknown = paceOf([pg('a', 'on pace'), pg('c', 'unknown', { reason: 'undated_actual', stale: false })]);
  assert.notEqual(healthChip(unknown).label, 'On pace');
  // Liveness: once every included goal is current and within plan, it does say On pace.
  assert.equal(healthChip(paceOf([pg('a', 'on pace'), pg('b', 'on pace')])).label, 'On pace');
});

/* ---------- pace board reason ---------- */

test('paceReason names the most-behind goal and its time gap', () => {
  const pace = paceOf([
    pg('a', 'behind', { title: 'Small slip', gapDays: fig(-10), timeGap: '1 week behind' }),
    pg('b', 'behind', { title: 'Big slip', gapDays: fig(-40), timeGap: '6 weeks behind' }),
    pg('c', 'on pace', { timeGap: 'On pace', gapDays: fig(1) })
  ]);
  const s = paceReason(pace);
  assert.ok(s.includes('Big slip'), s);
  assert.ok(s.includes('6 weeks behind'), s);
  assert.ok(!s.includes('Small slip'), s);
  assert.ok(!s.includes('$'), s);
});

test('paceReason explains unknown pace from the data date and the unknown count', () => {
  const two = paceOf([pg('a', 'unknown', { dataThrough: '2026-08-07' }), pg('b', 'unknown', { dataThrough: '2026-08-07' })], { dataThrough: '2026-08-07' });
  assert.equal(paceReason(two), 'Data through Aug 7 is past its update cadence, so pace is unknown for 2 goals; later months are projected.');
  const one = paceOf([pg('a', 'unknown', { dataThrough: '2026-08-07' }), pg('b', 'on pace', { dataThrough: '2026-08-07' })], { dataThrough: '2026-08-07' });
  assert.equal(paceReason(one), 'Data through Aug 7 is past its update cadence, so pace is unknown for 1 goal; later months are projected.');
});

test('paceReason does not blame the update cadence when no unknown goal is stale', () => {
  const pace = paceOf([pg('a', 'unknown', { reason: 'missing_plan_start', stale: false, dataThrough: '2026-08-07' }), pg('b', 'on pace', { dataThrough: '2026-08-07' })], { dataThrough: '2026-08-07' });
  const s = paceReason(pace);
  assert.ok(!s.includes('cadence'), s);
  assert.equal(s, 'Data runs through Aug 7, but pace is unknown for 1 goal because the data or plan is incomplete; later months are projected.');
});

test('paceReason says every goal is within plan, and counts goals without a target', () => {
  const all = paceOf([pg('a', 'on pace'), pg('b', 'ahead', { timeGap: '2 weeks ahead' }), pg('c', 'on pace')]);
  assert.equal(paceReason(all), 'All 3 goals with targets are within plan.');
  const withNone = paceOf([pg('a', 'on pace'), pg('b', 'ahead'), pg('c', 'on pace'), pg('x', 'no target'), pg('y', 'no target')]);
  assert.equal(paceReason(withNone), 'All 3 goals with targets are within plan. 2 goals without a target are not counted.');
  const unknownWithNone = paceOf([pg('a', 'unknown', { dataThrough: '2026-08-07' }), pg('x', 'no target')], { dataThrough: '2026-08-07' });
  const s = paceReason(unknownWithNone);
  assert.ok(s.startsWith('Data through Aug 7 is past its update cadence, so pace is unknown for 1 goal; later months are projected. '), s);
  assert.ok(s.includes('1 goal without a target'), s);
  for (const p of [all, withNone, unknownWithNone]) assert.ok(!paceReason(p).includes('$'));
});

/* ---------- pace bar ---------- */

test('paceBar is actual and expected over target, muted unless pace is current', () => {
  const b = paceBar(pg('a', 'behind'));
  assert.deepEqual(Object.keys(b).sort(), ['fill', 'muted', 'tick']);
  near(b.fill, 0.5, 'fill');
  near(b.tick, 0.45, 'tick');
  assert.equal(b.muted, false);
  for (const s of ['ahead', 'on pace', 'behind']) assert.equal(paceBar(pg('a', s)).muted, false, s);
  assert.equal(paceBar(pg('a', 'unknown')).muted, true, 'stale');
  assert.equal(paceBar(pg('a', 'unknown', { reason: 'unknown_freshness', stale: false })).muted, true, 'unknown freshness');
});

test('paceBar clamps fill and tick to the bar', () => {
  const over = paceBar(pg('a', 'ahead', { actual: fig(1500, 'a'), expected: fig(2000, 'p') }));
  assert.equal(over.fill, 1);
  assert.equal(over.tick, 1);
  const under = paceBar(pg('a', 'behind', { actual: fig(-200, 'a'), expected: fig(-1, 'p') }));
  assert.equal(under.fill, 0);
  assert.equal(under.tick, 0);
  const zero = paceBar(pg('a', 'behind', { actual: fig(0, 'a'), expected: fig(0, 'p') }));
  assert.equal(zero.fill, 0);
  assert.equal(zero.tick, 0);
});

test('paceBar is null without a positive target and finite actual and expected', () => {
  assert.equal(paceBar(null), null);
  assert.equal(paceBar(pg('a', 'no target')), null);
  assert.equal(paceBar(pg('a', 'behind', { target: null })), null);
  assert.equal(paceBar(pg('a', 'behind', { actual: null })), null);
  assert.equal(paceBar(pg('a', 'unknown', { expected: null, reason: 'missing_plan_start', stale: false })), null);
  assert.equal(paceBar(pg('a', 'behind', { target: fig(0, 't') })), null);
  assert.equal(paceBar(pg('a', 'behind', { target: fig(-5, 't') })), null);
  assert.equal(paceBar(pg('a', 'behind', { actual: fig(Number.NaN, 'a') })), null);
  assert.equal(paceBar(pg('a', 'behind', { expected: fig(Number.POSITIVE_INFINITY, 'p') })), null);
  assert.equal(paceBar(pg('a', 'behind', { target: { v: '1000', src: 'calc:pace', kind: 't', label: 'x' } })), null);
  // Liveness: a stale goal with every figure still draws a (muted) bar.
  assert.notEqual(paceBar(pg('a', 'unknown')), null);
});

/* ---------- reason text ---------- */

const CODES = [
  'stale_data', 'unknown_freshness', 'undated_actual', 'projected_actual', 'missing_actual', 'missing_plan_start',
  'invalid_plan_dates', 'non_increasing_path', 'no_target', 'missing_actual_history', 'missing_household_savings_plan',
  'missing_meter_inputs', 'missing_month_actual'
];

test('reasonText has plain text for every reason code the pace engine emits', () => {
  assert.equal(typeof REASON_TEXT, 'object');
  for (const code of CODES) {
    const t = reasonText(code);
    assert.equal(typeof t, 'string', code);
    assert.ok(t.trim().length > 0, code);
    assert.equal(t, REASON_TEXT[code], code);
    assert.ok(!t.includes('_'), `${code} reads as plain text: ${t}`);
    assert.ok(!/[\u2013\u2014]/.test(t), `${code} has no en or em dash`);
    assert.ok(!/\$\d/.test(t), `${code} has no dollar amount`);
  }
});

test('reasonText falls back for an unknown code', () => {
  assert.equal(reasonText('not_a_code'), 'Not enough data yet');
  assert.equal(reasonText(undefined), 'Not enough data yet');
  assert.equal(reasonText(null), 'Not enough data yet');
});

/* ---------- home model ---------- */

// The scenario clock the household fixtures use: Nov 5, 56 days before Dec 31.
const CLOCK = '2026-11-05';
const TO_YEAR_END = 56;

// A suggestion record in the contract shape (only the fields the Home model reads matter here).
function sugg(goalId, state = 'suggested', o = {}) {
  const asks = state === 'question';
  return {
    goalId, title: `Goal ${goalId}`, kind: o.kind ?? (asks ? null : 'cushion'), state,
    targetDate: asks ? null : '2027-06-30', dateSource: asks ? null : 'projected', horizonLabel: 'This year',
    track: asks ? null : { accounts: ['acct'] }, trackLabel: asks ? null : 'Synthetic checking',
    accept: asks ? null : { target: 1000, targetDate: '2027-06-30', track: { accounts: ['acct'] } },
    figures: asks ? {} : { target: `suggest.${goalId}.target` },
    window: asks ? null : { from: '2026-02', to: '2026-07', months: 6 },
    params: {}, editable: [], covered: false, why: 'Synthetic reason.',
    missing: asks ? ['unsupported_goal'] : [], ask: asks ? 'What amount would make this real?' : null,
    fingerprint: 'f'.repeat(64)
  };
}

// The contract calls `pending` the suggested records among the cards; homeHeadline compares it to 2.
// Read either an array of records or a count, so the test pins the number, not the container.
const pendingCount = (p) => (Array.isArray(p) ? p.length : p);
const pendingIds = (p) => (Array.isArray(p) ? p.map((r) => r.goalId ?? r.id) : null);

// One household: goals in a different order than pace.goals, a done and an archived goal, a goal
// without a pace entry, recs for every owner, a rec serving two goals, ties, and housekeeping in
// open, waiting, snoozed and hidden states.
function household() {
  const goals = [goal('g_extra'), goal('g_on'), goal('g_done', { status: 'done' }), goal('g_behind'), goal('g_arch', { archived: true }),
    goal('g_stale'), goal('g_none', { status: 'open' }), goal('g_ahead')];
  const pace = paceOf([
    pg('g_behind', 'behind', { timeGap: '5 weeks behind', gapDays: fig(-35) }),
    pg('g_on', 'on pace', { timeGap: 'On pace' }),
    pg('g_arch', 'on pace', { timeGap: 'On pace' }),
    pg('g_stale', 'unknown'),
    pg('g_none', 'no target'),
    pg('g_ahead', 'ahead', { timeGap: '2 weeks ahead' })
  ]);
  const recs = [
    rec('r1', { serves: ['g_behind', 'g_stale'], days: 10, title: 'Same title' }),
    rec('r2', { serves: ['g_behind'], days: 5, title: 'Move cash', status: 'doing', owner: 'spouse' }),
    rec('r3', { serves: ['g_on'], days: 30, title: 'Fund account', status: 'doing', owner: 'you' }),
    rec('r4', { serves: ['g_ahead'], days: 8, status: 'waiting' }),
    rec('r5', { days: 3, title: 'Renew policy' }),
    rec('r7', { days: 12, title: 'Automatic chore', status: 'doing', owner: 'automatic' }),
    rec('r8', { serves: ['g_stale'], days: 1, status: 'done' }),
    rec('r9', { serves: ['g_stale'], days: 10, title: 'Same title' }),
    rec('r10', { serves: ['g_extra'], days: 40, title: 'Extra work' }),
    rec('r11', { serves: ['g_none'], days: 50, title: 'No target work', status: 'doing', owner: 'both' }),
    rec('r12', { serves: ['g_on'], days: 2, status: 'snoozed' }),
    rec('r14', { days: -2, title: 'Late fee' }),
    rec('r15', { days: 20, title: 'Spouse chore', owner: 'spouse' }),
    rec('r16', { serves: ['g_arch'], days: 4, title: 'Archived goal work', status: 'dismissed' }),
    rec('r17', { days: 6, title: 'Waiting chore', status: 'waiting', owner: 'you' }),
    rec('r18', { days: 1, title: 'Hidden chore', status: 'hidden' }),
    rec('r19', { days: 25, title: 'Snoozed chore', status: 'snoozed', owner: 'spouse' })
  ];
  return { goals, pace, recs, clock: CLOCK, suggestions: [] };
}

test('homeModel orders cards by pace.goals then the remaining goals, skipping done and archived', () => {
  const h = household();
  const m = homeModel({ ...h, filter: 'both' });
  assert.equal(m.filter, 'both');
  assert.deepEqual(ids(m.cards), ['g_behind', 'g_on', 'g_stale', 'g_none', 'g_ahead', 'g_extra']);
  for (const c of m.cards) {
    assert.deepEqual(c.goal, h.goals.find((g) => g.id === c.id), c.id);
    const i = h.pace.goals.findIndex((p) => p.id === c.id);
    assert.equal(c.paceIndex, i, c.id);
    assert.deepEqual(c.pace ?? null, i < 0 ? null : h.pace.goals[i], c.id);
    assert.deepEqual(c.chip, cardChip(c.pace), c.id);
    assert.deepEqual(c.bar, paceBar(c.pace), c.id);
  }
  assert.equal(cardOf(m, 'g_extra').paceIndex, -1);
  assert.equal(cardOf(m, 'g_extra').pace ?? null, null);
});

test('homeModel groups a rec that serves two goals under both, ordered by window then title then id', () => {
  const m = homeModel({ ...household(), filter: 'both' });
  assert.deepEqual(ids(cardOf(m, 'g_behind').actions), ['r2', 'r1']);
  assert.deepEqual(ids(cardOf(m, 'g_stale').actions), ['r1', 'r9'], 'tie on days and title breaks by id; done r8 is left out');
  assert.equal(cardOf(m, 'g_behind').next.id, 'r2');
  assert.equal(cardOf(m, 'g_stale').next.id, 'r1');
  assert.deepEqual(ids(cardOf(m, 'g_on').actions), ['r3'], 'snoozed r12 is not open');
  assert.deepEqual(ids(cardOf(m, 'g_ahead').actions), [], 'waiting r4 is not open');
  assert.equal(cardOf(m, 'g_ahead').next, null);
  assert.deepEqual(ids(cardOf(m, 'g_none').actions), ['r11']);
  assert.deepEqual(ids(cardOf(m, 'g_extra').actions), ['r10']);
});

test('homeModel has no quiet grouping: every live goal is a card, with no collapsed or expanded lists', () => {
  const m = homeModel({ ...household(), filter: 'both' });
  assert.equal('collapsed' in m, false, 'no collapsed list');
  assert.equal('expanded' in m, false, 'no expanded list');
  for (const c of m.cards) assert.equal('collapsed' in c, false, `${c.id} carries no collapsed flag`);
  // No target, no pace entry, and on pace or ahead with nothing due are all still cards.
  for (const id of ['g_none', 'g_extra', 'g_ahead']) assert.ok(cardOf(m, id), id);
  for (const key of ['filter', 'counts', 'cards', 'queue', 'due', 'nextThing', 'afterThat', 'housekeeping', 'pending']) {
    assert.ok(key in m, `homeModel returns ${key}`);
  }
});

test('homeModel queue holds every open filtered rec once; due drops housekeeping; next and after come from due', () => {
  const m = homeModel({ ...household(), filter: 'both' });
  assert.deepEqual(ids(m.queue), ['r14', 'r5', 'r2', 'r1', 'r9', 'r7', 'r15', 'r3', 'r10', 'r11']);
  assert.deepEqual(ids(m.due), ['r2', 'r1', 'r9', 'r3', 'r10', 'r11'], 'housekeeping r14, r5, r7 and r15 are not due items');
  assert.equal(m.nextThing.id, 'r2', 'earlier housekeeping r14 and r5 do not take the next slot');
  assert.deepEqual(ids(m.afterThat), ['r1', 'r9', 'r3']);
  assert.deepEqual(ids(m.housekeeping), ['r14', 'r5', 'r17', 'r7', 'r15', 'r19'], 'waiting r17 and snoozed r19 count; hidden r18 does not');
  assert.deepEqual(m.counts, { both: 10, me: 7, spouse: 8 });
});

test('homeModel due: earlier housekeeping cannot displace three qualifying goal actions', () => {
  const goals = [goal('g1'), goal('g2')];
  const pace = paceOf([pg('g1', 'behind'), pg('g2', 'no target')]);
  const recs = [
    rec('h1', { days: 1, title: 'Chore one' }),
    rec('h2', { days: 2, title: 'Chore two' }),
    rec('h3', { days: 3, title: 'Chore three' }),
    rec('a1', { serves: ['g1'], days: 10 }),
    rec('a2', { serves: ['g2'], days: 11 }),
    rec('a3', { serves: ['g1'], days: 12 }),
    rec('a4', { serves: ['g2'], days: 13 })
  ];
  const m = homeModel({ goals, pace, recs, filter: 'both', clock: CLOCK, suggestions: [] });
  assert.deepEqual(ids(m.due), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(m.nextThing.id, 'a1');
  assert.deepEqual(ids(m.afterThat), ['a2', 'a3', 'a4']);
  assert.deepEqual(ids(m.housekeeping), ['h1', 'h2', 'h3'], 'housekeeping stays in its own row');
  for (const r of [m.nextThing, ...m.afterThat]) assert.equal(r.housekeeping, false, r.id);
});

test('homeModel due stops at Dec 31 of the clock year, inclusive, sorted by window', () => {
  const goals = [goal('g1')];
  const pace = paceOf([pg('g1', 'behind')]);
  const recs = [
    rec('late', { serves: ['g1'], days: TO_YEAR_END + 1, title: 'After the year ends' }),
    rec('edge', { serves: ['g1'], days: TO_YEAR_END, title: 'On Dec 31' }),
    rec('soon', { serves: ['g1'], days: 7 }),
    rec('over', { serves: ['g1'], days: -3, title: 'Overdue' })
  ];
  const m = homeModel({ goals, pace, recs, filter: 'both', clock: CLOCK, suggestions: [] });
  assert.deepEqual(ids(m.queue), ['over', 'soon', 'edge', 'late'], 'the queue keeps everything open');
  assert.deepEqual(ids(m.due), ['over', 'soon', 'edge'], 'an item due after Dec 31 is not in the due list');
  assert.equal(m.nextThing.id, 'over');
  assert.deepEqual(ids(m.afterThat), ['soon', 'edge']);

  // The clock decides the year end: in late December only the next few days qualify.
  const dec = homeModel({ goals, pace, recs, filter: 'both', clock: '2026-12-20', suggestions: [] });
  assert.deepEqual(ids(dec.due), ['over', 'soon'], 'eleven days to Dec 31');
});

test('homeModel next thing falls back to the first goal action past Dec 31, never to housekeeping', () => {
  const goals = [goal('g1')];
  const pace = paceOf([pg('g1', 'behind')]);
  const recs = [rec('chore', { days: 2, title: 'Chore' }), rec('far', { serves: ['g1'], days: 120 }), rec('farther', { serves: ['g1'], days: 200 })];
  const m = homeModel({ goals, pace, recs, filter: 'both', clock: CLOCK, suggestions: [] });
  assert.deepEqual(m.due, []);
  assert.equal(m.nextThing.id, 'far');
  assert.deepEqual(m.afterThat, []);

  const onlyChores = homeModel({ goals, pace, recs: [rec('chore', { days: 2 })], filter: 'both', clock: CLOCK, suggestions: [] });
  assert.equal(onlyChores.nextThing, null, 'housekeeping alone leaves no next thing');
  assert.deepEqual(onlyChores.afterThat, []);
  assert.deepEqual(ids(onlyChores.housekeeping), ['chore']);
});

test('homeModel Me keeps you and both actions; Spouse keeps spouse and both; due follows the filter', () => {
  const me = homeModel({ ...household(), filter: 'me' });
  assert.equal(me.filter, 'me');
  assert.deepEqual(ids(me.queue), ['r14', 'r5', 'r1', 'r9', 'r3', 'r10', 'r11']);
  assert.deepEqual(ids(me.due), ['r1', 'r9', 'r3', 'r10', 'r11'], 'spouse r2 is not due for Me');
  assert.equal(me.nextThing.id, 'r1');
  assert.deepEqual(ids(me.afterThat), ['r9', 'r3', 'r10']);
  assert.deepEqual(ids(cardOf(me, 'g_behind').actions), ['r1'], 'spouse r2 is hidden for Me');
  assert.deepEqual(ids(me.housekeeping), ['r14', 'r5', 'r17'], 'your waiting r17 shows for Me; automatic r7 and spouse r15, r19 do not');

  const sp = homeModel({ ...household(), filter: 'spouse' });
  assert.deepEqual(ids(sp.queue), ['r14', 'r5', 'r2', 'r1', 'r9', 'r15', 'r10', 'r11']);
  assert.deepEqual(ids(sp.due), ['r2', 'r1', 'r9', 'r10', 'r11'], 'your r3 is not due for Spouse; spouse chore r15 is housekeeping');
  assert.equal(sp.nextThing.id, 'r2');
  assert.deepEqual(ids(sp.afterThat), ['r1', 'r9', 'r10']);
  assert.deepEqual(ids(cardOf(sp, 'g_on').actions), [], 'your r3 is hidden for Spouse');
  assert.ok(cardOf(sp, 'g_on'), 'on pace with nothing due for this filter is still a card');
  assert.equal(cardOf(sp, 'g_on').next, null);
  assert.deepEqual(ids(sp.housekeeping), ['r14', 'r5', 'r15', 'r19'], 'spouse snoozed r19 shows for Spouse; your r17 does not');
  // Counts do not depend on the active filter.
  assert.deepEqual(me.counts, { both: 10, me: 7, spouse: 8 });
  assert.deepEqual(sp.counts, { both: 10, me: 7, spouse: 8 });
});

test('homeModel with nothing open: cards for every goal, an empty queue, due list and next thing', () => {
  const goals = [goal('u1'), goal('u2'), goal('b1')];
  const pace = paceOf([pg('u1', 'unknown'), pg('u2', 'unknown', { reason: 'undated_actual', stale: false }), pg('b1', 'behind')]);
  const m = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [] });
  assert.deepEqual(ids(m.cards), ['u1', 'u2', 'b1']);
  assert.equal(m.nextThing, null);
  assert.deepEqual(m.afterThat, []);
  assert.deepEqual(m.queue, []);
  assert.deepEqual(m.due, []);
  assert.deepEqual(m.housekeeping, []);
  assert.deepEqual(m.counts, { both: 0, me: 0, spouse: 0 });
  assert.equal(pendingCount(m.pending), 0);
});

test('homeModel cards carry their suggestion record or null, and pending counts the suggested ones', () => {
  const h = household();
  const records = [
    sugg('g_none'),
    sugg('g_extra', 'question'),
    sugg('g_ahead', 'dismissed'),
    sugg('g_arch'),            // archived goal: no card, so not pending
    sugg('g_gone')             // no such goal
  ];
  const m = homeModel({ ...h, filter: 'both', suggestions: records });
  for (const c of m.cards) {
    const want = records.find((r) => r.goalId === c.id) || null;
    assert.deepEqual(c.suggestion ?? null, want, c.id);
  }
  assert.equal(cardOf(m, 'g_behind').suggestion ?? null, null);
  assert.equal(pendingCount(m.pending), 1, 'only the suggested record on a live card is pending');
  const pids = pendingIds(m.pending);
  if (pids) assert.deepEqual(pids, ['g_none']);

  const none = homeModel({ ...h, filter: 'both', suggestions: undefined });
  for (const c of none.cards) assert.equal(c.suggestion ?? null, null, `${c.id} without suggestions`);
  assert.equal(pendingCount(none.pending), 0);
});

/* ---------- headline ---------- */

const headline = (m, pace) => homeHeadline({ cards: m.cards, pace, pending: m.pending, due: m.due, filter: m.filter });

test('homeHeadline verdict: any goal with a target says covered or how many things need you', () => {
  const goals = [goal('t'), goal('a'), goal('b')];
  const pace = paceOf([pg('t', 'on pace', { timeGap: 'On pace' }), pg('a', 'no target'), pg('b', 'no target')], { headline: 'Pace headline' });
  const two = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [sugg('a'), sugg('b')] });
  assert.deepEqual(headline(two, pace), { title: 'You are covered through Dec 31', verdict: 'covered', needs: 0 });
  const one = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [sugg('a'), sugg('b', 'question')] });
  assert.deepEqual(headline(one, pace), { title: 'You are covered through Dec 31', verdict: 'covered', needs: 0 });
});

test('homeHeadline verdict counts the goal actions due before Dec 31 for the filter, never housekeeping or later ones', () => {
  const goals = [goal('t')];
  const pace = paceOf([pg('t', 'behind', { timeGap: '2 months behind' })]);
  const recs = [rec('r1', { serves: ['t'], days: 10 }), rec('r2', { serves: ['t'], days: 20, owner: 'spouse' }), rec('hk', { days: 5 }), rec('late', { serves: ['t'], days: 400 })];
  const both = homeModel({ goals, pace, recs, filter: 'both', clock: CLOCK });
  assert.deepEqual(headline(both, pace), { title: '2 things need you before Dec 31', verdict: 'needs', needs: 2 });
  const me = homeModel({ goals, pace, recs, filter: 'me', clock: CLOCK });
  assert.equal(headline(me, pace).title, '1 thing needs you before Dec 31');
  const spouse = homeModel({ goals, pace, recs: recs.filter((r) => r.id !== 'r1'), filter: 'spouse', clock: CLOCK });
  assert.equal(headline(spouse, pace).title, '1 thing needs your spouse before Dec 31');
  const spouseFree = homeModel({ goals, pace, recs: [rec('mine', { serves: ['t'], days: 10, owner: 'you' })], filter: 'spouse', clock: CLOCK });
  assert.equal(headline(spouseFree, pace).title, 'Your spouse is covered through Dec 31');
});

test('homeHeadline verdict is never a data excuse, even when every targeted goal is stale or unknown', () => {
  const goals = [goal('t'), goal('u'), goal('a')];
  const stalePace = paceOf([pg('t', 'unknown'), pg('u', 'unknown', { reason: 'unknown_freshness', stale: false }), pg('a', 'no target')], { headline: 'Pace is unknown: data is stale' });
  for (const recs of [[], [rec('r1', { serves: ['t'], days: 3 })]]) {
    const m = homeModel({ goals, pace: stalePace, recs, filter: 'both', clock: CLOCK, suggestions: [sugg('a')] });
    const t = headline(m, stalePace).title;
    assert.notEqual(t, stalePace.rollup.headline);
    assert.doesNotMatch(t, /stale|unknown|data|missing/i, t);
    assert.match(t, /^(You are covered|1 thing needs you)/, t);
  }
});

test('homeHeadline: no targets and pending suggestions say how many goals have a suggested target', () => {
  const goals = [goal('a'), goal('b'), goal('c')];
  const pace = paceOf([pg('a', 'no target'), pg('b', 'no target'), pg('c', 'no target')], { headline: 'No goals with targets' });
  const two = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [sugg('a'), sugg('b'), sugg('c', 'question')] });
  assert.equal(pendingCount(two.pending), 2);
  assert.deepEqual(headline(two, pace), { title: 'Suggested targets for 2 goals' });
  const one = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [sugg('a'), sugg('b', 'question'), sugg('c', 'dismissed')] });
  assert.equal(pendingCount(one.pending), 1);
  assert.deepEqual(headline(one, pace), { title: 'Suggested targets for 1 goal' });
});

test('homeHeadline: questions or dismissals only say how many goals need a target', () => {
  const goals = [goal('a'), goal('b'), goal('c')];
  const pace = paceOf([pg('a', 'no target'), pg('b', 'no target'), pg('c', 'no target')], { headline: 'No goals with targets' });
  const asks = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [sugg('a', 'question'), sugg('b', 'question'), sugg('c', 'question')] });
  assert.deepEqual(headline(asks, pace), { title: '3 goals need a target' });
  const mixed = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [sugg('a', 'question'), sugg('b', 'dismissed'), sugg('c', 'dismissed')] });
  assert.deepEqual(headline(mixed, pace), { title: '3 goals need a target' });
  // Seed goals carry no records at all and still count.
  const bare = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: [] });
  assert.equal(headline(bare, pace).title, '3 goals need a target');
  // Singular: "1 goal", never "1 goals". The verb form is the implementer's (the contract pins only the noun).
  const single = homeModel({ goals: [goal('a')], pace: paceOf([pg('a', 'no target')]), recs: [], filter: 'both', clock: CLOCK, suggestions: [sugg('a', 'question')] });
  const t = headline(single, paceOf([pg('a', 'no target')])).title;
  assert.match(t, /^1 goal \S+ a target$/, t);
  assert.doesNotMatch(t, /1 goals/, t);
});

test('homeHeadline never says No goals with targets', () => {
  const pace = paceOf([pg('a', 'no target'), pg('b', 'no target')], { headline: 'No goals with targets' });
  const goals = [goal('a'), goal('b')];
  for (const records of [[], [sugg('a')], [sugg('a'), sugg('b')], [sugg('a', 'question')], [sugg('a', 'dismissed'), sugg('b', 'question')]]) {
    const m = homeModel({ goals, pace, recs: [], filter: 'both', clock: CLOCK, suggestions: records });
    const h = headline(m, pace);
    assert.notEqual(h.title, 'No goals with targets', JSON.stringify(records.map((r) => r.state)));
    assert.ok(typeof h.title === 'string' && h.title.length > 0);
  }
});

test('homeModel over the seeded demo store matches the server housekeeping count, goal links and suggestions', async () => {
  const t = await tempDb();
  try {
    await seedDemo(t.db);
    const sc = await buildScenario(t.db);
    const recs = await loadLinkedRecs(t.db, sc.live.clock);
    assert.ok(recs.length > 0, 'the demo seeds recs');
    for (const r of recs) {
      assert.ok(OWNERS.includes(r.owner), `${r.id} owner ${r.owner}`);
      assert.equal(typeof r.housekeeping, 'boolean', r.id);
      assert.ok(Array.isArray(r.serves), r.id);
      assert.equal(r.housekeeping, r.serves.length === 0, r.id);
      for (const g of r.serves) assert.deepEqual(Object.keys(g).sort(), ['id', 'origin', 'title'], r.id);
    }
    assert.ok(Array.isArray(sc.suggestions), 'the scenario carries suggestions');
    const m = homeModel({ goals: sc.goals, pace: sc.pace, recs, filter: 'both', suggestions: sc.suggestions, clock: sc.meta.clock });
    assert.ok(sc.live.housekeeping > 0, 'the demo has housekeeping');
    assert.equal(m.housekeeping.length, sc.live.housekeeping);
    assert.equal(m.cards.length, sc.goals.filter((g) => !g.archived && g.status !== 'done').length, 'every live goal is a card');
    assert.ok(m.cards.some((c) => c.actions.length > 0), 'some goal has an open action');
    for (const c of m.cards) {
      for (const r of c.actions) assert.ok(servedGoalIds(r).includes(String(c.id)), `${r.id} serves ${c.id}`);
      assert.equal(c.suggestion ?? null, null, `seed goal ${c.id} gets no suggestion`);
    }
    assert.equal(pendingCount(m.pending), 0);
    for (const r of m.due) assert.equal(r.housekeeping, false, `${r.id} in due is not housekeeping`);
    // Seed goals with targets exist on the demo, so Home gives the verdict over the due list.
    const v = headline(m, sc.pace);
    assert.equal(v.needs, m.due.length);
    assert.equal(v.title, m.due.length ? `${m.due.length} thing${m.due.length === 1 ? ' needs' : 's need'} you before Dec 31` : 'You are covered through Dec 31');
  } finally {
    t.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  }
});

/* ---------- data-health line ---------- */

const ingestOf = (pending, statuses = []) => ({ pending, items: [], files: statuses.map((status, i) => ({ id: i + 1, name: `file-${i}.csv`, status })), waiting: [] });

// H1: failed files are counted by the Imports service line (services.attention), not here.
test('healthLine reports the data date, stale accounts and questions in order, leaving failed files to the Imports line', () => {
  const pace = paceOf([pg('a', 'unknown', { dataThrough: '2026-08-07' }), pg('b', 'unknown', { dataThrough: '2026-08-30' })]);
  const h = healthLine({
    pace,
    ingest: ingestOf(3, ['failed', 'parsed', 'failed']),
    accounts: [{ id: 'a1', fresh: 'stale' }, { id: 'a2', fresh: 'fresh' }, { id: 'a3', fresh: 'unknown' }],
    metaDataThrough: 'Aug 30, 2026'
  });
  assert.equal(h.dataThrough, '2026-08-07');
  assert.equal(h.dataLabel, 'Data through Aug 7');
  assert.equal(h.staleAccounts, 1);
  assert.equal(h.staleGoals, 2);
  assert.equal(h.pending, 3);
  assert.equal('failed' in h, false, 'no failed field');
  assert.equal(h.stale, true);
  assert.deepEqual(h.parts, ['Data through Aug 7', '1 account stale', '3 questions to confirm']);
});

test('healthLine names stale goals only when no account is stale, with singular wording', () => {
  const pace = paceOf([pg('a', 'unknown', { dataThrough: '2026-09-01' }), pg('b', 'on pace', { dataThrough: '2026-10-31' })]);
  const h = healthLine({ pace, ingest: ingestOf(1, ['failed']), accounts: [{ fresh: 'fresh' }], metaDataThrough: 'Oct 31, 2026' });
  assert.equal(h.dataLabel, 'Data through Sep 1', 'dates are UTC');
  assert.equal(h.staleAccounts, 0);
  assert.equal(h.staleGoals, 1);
  assert.deepEqual(h.parts, ['Data through Sep 1', 'pace data stale for 1 goal', '1 question to confirm']);

  const three = paceOf([pg('a', 'unknown'), pg('b', 'unknown'), pg('c', 'unknown')], { dataThrough: '2026-08-07' });
  assert.deepEqual(healthLine({ pace: three, ingest: ingestOf(0), accounts: [], metaDataThrough: null }).parts,
    ['Data through Aug 7', 'pace data stale for 3 goals']);

  const both = healthLine({ pace: three, ingest: ingestOf(0), accounts: [{ fresh: 'stale' }, { fresh: 'stale' }], metaDataThrough: null });
  assert.deepEqual(both.parts, ['Data through Aug 7', '2 accounts stale'], 'stale accounts replace the stale goals part');
  assert.equal(both.staleGoals, 3);
  assert.equal(both.stale, true);
});

test('healthLine owner-only data line: one "Fathom needs" link over the things only the owner can do', () => {
  const stalePace = paceOf([pg('a', 'unknown', { dataThrough: '2026-08-07' })]);
  // Stale goal pace alone is not an owner item: the line is the data date, with no link.
  const quiet = healthLine({ pace: stalePace, ingest: ingestOf(0), accounts: [{ fresh: 'fresh' }], metaDataThrough: null });
  assert.equal(quiet.line, 'Data through Aug 7');
  assert.deepEqual(quiet.owner, []);
  assert.equal(quiet.needs, 0);
  assert.equal(quiet.needsLabel, null);

  // Questions, then stale accounts; the link goes to the first. Failed files are not an owner item
  // here: the Imports service line counts them (H1).
  const all = healthLine({ pace: stalePace, ingest: ingestOf(3, ['failed']), accounts: [{ fresh: 'stale' }, { fresh: 'stale' }], metaDataThrough: null });
  assert.deepEqual(all.owner, [
    { key: 'confirm', text: '3 questions to confirm', go: 'confirm' },
    { key: 'accounts', text: '2 accounts stale', go: 'money' }
  ]);
  assert.equal(all.needs, 2);
  assert.equal(all.needsLabel, 'Fathom needs 2 things');
  assert.equal(all.needsGo, 'confirm');
  assert.equal(all.line, 'Data through Aug 7');

  const failedOnly = healthLine({ pace: stalePace, ingest: ingestOf(0, ['failed', 'failed']), accounts: [], metaDataThrough: null });
  assert.deepEqual(failedOnly.owner, [], 'failed files alone are not an owner item');
  assert.equal(failedOnly.needs, 0);
  assert.equal(failedOnly.needsLabel, null);
  assert.equal(failedOnly.needsGo, null);

  const one = healthLine({ pace: stalePace, ingest: ingestOf(1, ['failed', 'failed']), accounts: [], metaDataThrough: null });
  assert.equal(one.needsLabel, 'Fathom needs 1 thing');
  assert.equal(one.needsGo, 'confirm');
  assert.deepEqual(one.owner.map((x) => x.text), ['1 question to confirm']);
});

test('cardChip drops the stale and unknown chips a goal card used to carry, keeping progress chips', () => {
  assert.equal(cardChip(pg('a', 'unknown')), null, 'stale');
  assert.equal(cardChip(pg('a', 'unknown', { reason: 'unknown_freshness', stale: false })), null, 'unknown');
  assert.deepEqual(cardChip(pg('a', 'behind', { timeGap: '2 months behind' })), { tone: 'warn', label: '2 months behind' });
  assert.deepEqual(cardChip(pg('a', 'on pace')), { tone: 'ok', label: 'On pace' });
  assert.deepEqual(cardChip(pg('a', 'no target')), { tone: 'mute', label: 'No target' });
  assert.deepEqual(cardChip({ ...pg('f', 'unknown'), kind: 'floor', floor: { state: 'breached' } }), { tone: 'warn', label: 'Below floor' });
  for (const c of [pg('a', 'unknown'), pg('b', 'ahead'), pg('c', 'behind')]) assert.notEqual(cardChip(c)?.label, 'Data stale');
});

test('healthLine falls back to the meta label, then to No data yet, and is not stale when current', () => {
  const current = paceOf([pg('a', 'on pace')], { dataThrough: null });
  const meta = healthLine({ pace: current, ingest: ingestOf(0), accounts: [{ fresh: 'fresh' }], metaDataThrough: 'Aug 30, 2026' });
  assert.equal(meta.dataThrough, null);
  assert.ok(meta.dataLabel.startsWith('Data through'), meta.dataLabel);
  assert.ok(meta.dataLabel.includes('Aug 30, 2026'), meta.dataLabel);
  assert.equal(meta.stale, false);
  assert.deepEqual(meta.parts, [meta.dataLabel]);

  const none = healthLine({ pace: paceOf([], { dataThrough: null }), ingest: ingestOf(0), accounts: [], metaDataThrough: null });
  assert.equal(none.dataThrough, null);
  assert.equal(none.dataLabel, 'No data yet');
  assert.deepEqual(none.parts, ['No data yet']);
  assert.equal(none.stale, false);
  assert.equal(none.staleAccounts, 0);
  assert.equal(none.staleGoals, 0);
  assert.equal(none.pending, 0);
  assert.equal('failed' in none, false);
});

/* ---------- pace board charts ---------- */

const months = (n = 12) => Array.from({ length: n }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, gap: fig(i - 5) }));

test('boardCharts prefers household savings when its series exists', () => {
  const hs = { series: months(), dataEnd: '2026-08-30', reason: null };
  const pace = paceOf([pg('a', 'unknown')], { householdSavings: hs, seriesGoals: { a: { series: months(), dataEnd: '2026-08-07', reason: null } } });
  assert.deepEqual(boardCharts(pace), [{ id: 'householdSavings', title: 'Household savings', series: hs.series, dataEnd: '2026-08-30', figBase: 'pace.series.householdSavings.series' }]);
});

test('boardCharts falls back to one chart per pace goal with a series, in pace order', () => {
  const sa = months(), sc = months();
  const pace = paceOf([pg('c', 'unknown', { title: 'Third' }), pg('b', 'no target'), pg('a', 'behind', { title: 'First' })], {
    seriesGoals: {
      a: { series: sa, dataEnd: '2026-10-31', reason: null },
      b: { series: null, dataEnd: null, reason: 'missing_plan_start' },
      c: { series: sc, dataEnd: '2026-08-07', reason: null }
    }
  });
  const charts = boardCharts(pace);
  assert.deepEqual(charts.map((c) => c.id), ['c', 'a']);
  const [c, a] = charts;
  assert.equal(c.title, 'Third');
  assert.equal(c.figBase, 'pace.series.goals.c.series');
  assert.equal(c.series, sc);
  assert.equal(c.dataEnd, '2026-08-07');
  assert.equal(a.title, 'First');
  assert.equal(a.figBase, 'pace.series.goals.a.series');
  assert.equal(a.series, sa);
});

test('boardCharts is empty when no series exists', () => {
  assert.deepEqual(boardCharts(paceOf([pg('a', 'no target')], { seriesGoals: { a: { series: null, dataEnd: null, reason: 'no_target' } } })), []);
  assert.deepEqual(boardCharts(paceOf([])), []);
});

/* ---------- pace board This year ---------- */

test('paceMeters keeps only the This year meters that have figures, in order', () => {
  const meter = (ratio) => ({ meter: { used: fig(10), limit: fig(20), ratio: fig(ratio) }, reason: null, dataThrough: '2026-10-31' });
  const none = paceOf([]);
  assert.deepEqual(paceMeters(none.meters), [], 'no figures, no panel');
  assert.deepEqual(paceMeters(null), []);
  assert.deepEqual(paceMeters({ ...none.meters, tax: meter(0.5), income: meter(0.2) }), ['tax', 'income']);
  assert.deepEqual(paceMeters({ retirement: meter(0.1), tax: { meter: { ratio: { v: null } } }, income: meter(Infinity) }), ['retirement']);
});

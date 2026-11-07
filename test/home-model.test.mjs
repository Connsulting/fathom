// The goals-first Home view model (web/horizon/screens/home-model.js): owner filter, goal links,
// housekeeping, next actions, collapse rules, pace chips, the health chip, the pace board reason
// and charts, pace bars, reason text and the data-health line. The module is pure ESM with no DOM
// work at import, so node imports it directly. Fixtures are synthetic and built inline; pace goal
// entries follow the shape of src/calc/pace.mjs goalPace output.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNERS, ownerOf, ownerMatches, servedGoalIds, isHousekeeping, isOpen, goalChip, healthChip,
  paceReason, paceBar, REASON_TEXT, reasonText, homeModel, healthLine, boardCharts
} from '../web/horizon/screens/home-model.js';

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

// A rec as api.recs() returns it. `serves` is a list of goal ids, turned into seed objects.
function rec(id, o = {}) {
  const r = { id, title: o.title ?? `Task ${id}`, status: o.status ?? 'proposed', window: { days: o.days ?? 30 } };
  if (o.serves) r.serves = o.serves.map((g) => (typeof g === 'string' ? { id: g, title: `Goal ${g}`, origin: 'seed' } : g));
  if (o.owner !== undefined) r.owner = o.owner;
  if (o.housekeeping !== undefined) r.housekeeping = o.housekeeping;
  return r;
}

const goal = (id, o = {}) => ({ id, title: `Goal ${id}`, status: o.status ?? 'on track', archived: o.archived ?? false });
const ids = (list) => list.map((x) => x.id);
const cardOf = (m, id) => m.cards.find((c) => c.id === id);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} is not ${b}`);

/* ---------- owners ---------- */

test('OWNERS lists the five owner values in order', () => {
  assert.deepEqual(OWNERS, ['you', 'spouse', 'both', 'advisor', 'automatic']);
});

test('ownerOf keeps a known owner and defaults a missing or unknown one to both', () => {
  for (const o of OWNERS) assert.equal(ownerOf({ owner: o }), o, o);
  assert.equal(ownerOf({}), 'both');
  assert.equal(ownerOf({ owner: null }), 'both');
  assert.equal(ownerOf({ owner: '' }), 'both');
  assert.equal(ownerOf({ owner: 'neighbor' }), 'both');
  assert.equal(ownerOf({ owner: 'You' }), 'both', 'owner values are exact');
});

test('ownerMatches: Both matches every action, Me is you or both, Spouse is spouse or both', () => {
  const recs = Object.fromEntries([...OWNERS.map((o) => [o, { owner: o }]), ['missing', {}]]);
  const expect = {
    both: ['you', 'spouse', 'both', 'advisor', 'automatic', 'missing'],
    me: ['you', 'both', 'missing'],
    spouse: ['spouse', 'both', 'missing']
  };
  for (const [filter, yes] of Object.entries(expect)) {
    for (const [k, r] of Object.entries(recs)) {
      assert.equal(ownerMatches(r, filter), yes.includes(k), `filter ${filter}, owner ${k}`);
    }
  }
});

test('ownerMatches treats an unknown filter like Both', () => {
  for (const o of [...OWNERS, undefined]) {
    assert.equal(ownerMatches(o ? { owner: o } : {}, 'everyone'), true, String(o));
    assert.equal(ownerMatches(o ? { owner: o } : {}, undefined), true, String(o));
  }
});

/* ---------- goal links and housekeeping ---------- */

test('servedGoalIds reads objects and plain ids, dedupes, and is empty when serves is missing', () => {
  assert.deepEqual(servedGoalIds({}), []);
  assert.deepEqual(servedGoalIds({ serves: [] }), []);
  assert.deepEqual(servedGoalIds({ serves: null }), []);
  assert.deepEqual(servedGoalIds({ serves: [{ id: 'a', title: 'A', origin: 'seed' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(servedGoalIds({ serves: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(servedGoalIds({ serves: [{ id: 'a' }, 'b', 'a', { id: 'b' }] }), ['a', 'b']);
});

test('isHousekeeping falls back to having no goal links, and an explicit boolean wins', () => {
  assert.equal(isHousekeeping({}), true, 'no serves');
  assert.equal(isHousekeeping({ serves: [] }), true, 'empty serves');
  assert.equal(isHousekeeping({ serves: [{ id: 'a' }] }), false, 'serves a goal');
  assert.equal(isHousekeeping({ serves: [{ id: 'a' }], housekeeping: true }), true, 'explicit true beats serves');
  assert.equal(isHousekeeping({ housekeeping: false }), false, 'explicit false beats missing serves');
  assert.equal(isHousekeeping({ serves: [], housekeeping: 'yes' }), true, 'a non-boolean is ignored');
  assert.equal(isHousekeeping({ serves: [{ id: 'a' }], housekeeping: 1 }), false, 'a non-boolean is ignored');
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

// One household: goals in a different order than pace.goals, a done and an archived goal, a goal
// without a pace entry, recs for every owner, a rec serving two goals, ties and housekeeping.
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
    rec('r7', { days: 12, title: 'Unlinked', status: 'doing', owner: 'automatic', housekeeping: false }),
    rec('r8', { serves: ['g_stale'], days: 1, status: 'done' }),
    rec('r9', { serves: ['g_stale'], days: 10, title: 'Same title' }),
    rec('r10', { serves: ['g_extra'], days: 40, title: 'Extra work' }),
    rec('r11', { serves: ['g_none'], days: 50, title: 'No target work', status: 'doing', owner: 'both' }),
    rec('r12', { serves: ['g_on'], days: 2, status: 'snoozed' }),
    rec('r14', { days: -2, title: 'Late fee' }),
    rec('r15', { days: 20, title: 'Spouse chore', owner: 'spouse' }),
    rec('r16', { serves: ['g_arch'], days: 4, title: 'Archived goal work', status: 'dismissed' })
  ];
  return { goals, pace, recs };
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
    assert.deepEqual(c.chip, goalChip(c.pace), c.id);
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

test('homeModel queue holds every open filtered rec once, sorted, with the next thing and three after it', () => {
  const m = homeModel({ ...household(), filter: 'both' });
  assert.deepEqual(ids(m.queue), ['r14', 'r5', 'r2', 'r1', 'r9', 'r7', 'r15', 'r3', 'r10', 'r11']);
  assert.equal(m.nextThing.id, 'r14');
  assert.deepEqual(ids(m.afterThat), ['r5', 'r2', 'r1']);
  assert.deepEqual(ids(m.housekeeping), ['r14', 'r5', 'r15'], 'r7 says housekeeping false; serves-less r5, r14, r15 fall back to true');
  assert.deepEqual(m.counts, { both: 10, me: 7, spouse: 8 });
});

test('homeModel collapse: no target, no pace entry, and on pace or ahead with nothing due collapse', () => {
  const m = homeModel({ ...household(), filter: 'both' });
  const want = { g_behind: false, g_on: false, g_stale: false, g_none: true, g_ahead: true, g_extra: true };
  for (const [id, collapsed] of Object.entries(want)) assert.equal(cardOf(m, id).collapsed, collapsed, id);
  assert.deepEqual(ids(m.expanded), ['g_behind', 'g_on', 'g_stale']);
  assert.deepEqual(ids(m.collapsed), ['g_none', 'g_ahead', 'g_extra']);
});

test('homeModel Me keeps you and both actions; Spouse keeps spouse and both; the filter changes collapse', () => {
  const me = homeModel({ ...household(), filter: 'me' });
  assert.equal(me.filter, 'me');
  assert.deepEqual(ids(me.queue), ['r14', 'r5', 'r1', 'r9', 'r3', 'r10', 'r11']);
  assert.deepEqual(ids(cardOf(me, 'g_behind').actions), ['r1'], 'spouse r2 is hidden for Me');
  assert.equal(cardOf(me, 'g_on').collapsed, false, 'on pace with your action stays a card');
  assert.deepEqual(ids(me.housekeeping), ['r14', 'r5']);
  assert.deepEqual(ids(me.afterThat), ['r5', 'r1', 'r9']);

  const sp = homeModel({ ...household(), filter: 'spouse' });
  assert.deepEqual(ids(sp.queue), ['r14', 'r5', 'r2', 'r1', 'r9', 'r15', 'r10', 'r11']);
  assert.deepEqual(ids(cardOf(sp, 'g_on').actions), [], 'your r3 is hidden for Spouse');
  assert.equal(cardOf(sp, 'g_on').collapsed, true, 'on pace with nothing due for this filter collapses');
  assert.equal(cardOf(sp, 'g_on').next, null);
  assert.deepEqual(ids(sp.housekeeping), ['r14', 'r5', 'r15']);
  // Counts do not depend on the active filter.
  assert.deepEqual(me.counts, { both: 10, me: 7, spouse: 8 });
  assert.deepEqual(sp.counts, { both: 10, me: 7, spouse: 8 });
});

test('homeModel never collapses unknown or behind goals, even with nothing due', () => {
  const goals = [goal('u1'), goal('u2'), goal('b1')];
  const pace = paceOf([pg('u1', 'unknown'), pg('u2', 'unknown', { reason: 'undated_actual', stale: false }), pg('b1', 'behind')]);
  const m = homeModel({ goals, pace, recs: [], filter: 'both' });
  for (const c of m.cards) assert.equal(c.collapsed, false, c.id);
  assert.equal(m.nextThing, null);
  assert.deepEqual(m.afterThat, []);
  assert.deepEqual(m.queue, []);
  assert.deepEqual(m.housekeeping, []);
  assert.deepEqual(m.counts, { both: 0, me: 0, spouse: 0 });
});

test('homeModel: on pace with an open action stays a card, and ahead with nothing due collapses', () => {
  const goals = [goal('on'), goal('ah')];
  const pace = paceOf([pg('on', 'on pace', { timeGap: 'On pace' }), pg('ah', 'ahead', { timeGap: '1 week ahead' })]);
  const withAction = homeModel({ goals, pace, recs: [rec('x', { serves: ['on'] })], filter: 'both' });
  assert.equal(cardOf(withAction, 'on').collapsed, false);
  assert.equal(cardOf(withAction, 'ah').collapsed, true);
  // Liveness of the collapse rule: on pace with nothing due does collapse.
  const without = homeModel({ goals, pace, recs: [], filter: 'both' });
  assert.equal(cardOf(without, 'on').collapsed, true);
  assert.equal(cardOf(without, 'on').chip.label, 'On pace');
});

test('homeModel with recs that carry no owner treats every action as both', () => {
  const goals = [goal('g')];
  const pace = paceOf([pg('g', 'behind')]);
  const recs = [rec('a', { serves: ['g'], days: 3 }), rec('b', { days: 1 })];
  for (const filter of ['both', 'me', 'spouse']) {
    const m = homeModel({ goals, pace, recs, filter });
    assert.deepEqual(ids(m.queue), ['b', 'a'], filter);
    assert.equal(cardOf(m, 'g').next.id, 'a', filter);
  }
});

/* ---------- data-health line ---------- */

const ingestOf = (pending, statuses = []) => ({ pending, items: [], files: statuses.map((status, i) => ({ id: i + 1, name: `file-${i}.csv`, status })), waiting: [] });

test('healthLine reports the data date, stale accounts, questions and failed files in order', () => {
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
  assert.equal(h.failed, 2);
  assert.equal(h.stale, true);
  assert.deepEqual(h.parts, ['Data through Aug 7', '1 account stale', '3 questions to confirm', '2 files failed']);
});

test('healthLine names stale goals only when no account is stale, with singular wording', () => {
  const pace = paceOf([pg('a', 'unknown', { dataThrough: '2026-09-01' }), pg('b', 'on pace', { dataThrough: '2026-10-31' })]);
  const h = healthLine({ pace, ingest: ingestOf(1, ['failed']), accounts: [{ fresh: 'fresh' }], metaDataThrough: 'Oct 31, 2026' });
  assert.equal(h.dataLabel, 'Data through Sep 1', 'dates are UTC');
  assert.equal(h.staleAccounts, 0);
  assert.equal(h.staleGoals, 1);
  assert.deepEqual(h.parts, ['Data through Sep 1', 'pace data stale for 1 goal', '1 question to confirm', '1 file failed']);

  const three = paceOf([pg('a', 'unknown'), pg('b', 'unknown'), pg('c', 'unknown')], { dataThrough: '2026-08-07' });
  assert.deepEqual(healthLine({ pace: three, ingest: ingestOf(0), accounts: [], metaDataThrough: null }).parts,
    ['Data through Aug 7', 'pace data stale for 3 goals']);

  const both = healthLine({ pace: three, ingest: ingestOf(0), accounts: [{ fresh: 'stale' }, { fresh: 'stale' }], metaDataThrough: null });
  assert.deepEqual(both.parts, ['Data through Aug 7', '2 accounts stale'], 'stale accounts replace the stale goals part');
  assert.equal(both.staleGoals, 3);
  assert.equal(both.stale, true);
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
  assert.equal(none.failed, 0);
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

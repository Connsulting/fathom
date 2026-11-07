// The goals-first onboarding model (web/horizon/screens/onboard-model.js): the starter goals, which
// of them the household already has, the goal bodies the Goals step creates, the goals listed as
// already chosen, and the "Add your spouse" line. The module is pure ESM with no DOM work at
// import, so node imports it directly. Fixtures are synthetic and built inline.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STARTERS, existingStarterIds, otherGoals, goalsToCreate, inviteLine
} from '../web/horizon/screens/onboard-model.js';
import { HORIZON_IDS, LIMITS, validateGoal } from '../src/shared/goals.mjs';

const goal = (id, title, o = {}) => ({ id, title, origin: 'owner', archived: false, ...o });

/* ---------- starters ---------- */

test('STARTERS are the four starter goals, in order, with their sub lines and horizons', () => {
  assert.deepEqual(STARTERS.map((s) => ({ id: s.id, title: s.title, sub: s.sub, horizon: s.horizon })), [
    { id: 'cushion', title: 'A cash cushion', sub: 'Months of spending you never touch', horizon: 'now' },
    { id: 'work-optional', title: 'Work less, on our terms', sub: 'The year work becomes optional', horizon: '3-10y' },
    { id: 'family', title: 'Kids and family', sub: 'School, childcare, a new arrival', horizon: '1-3y' },
    { id: 'tax', title: 'Pay less tax, without stress', sub: 'Use every window before Dec 31', horizon: 'now' }
  ]);
  assert.ok(Object.isFrozen(STARTERS), 'the starter list is frozen');
  for (const s of STARTERS) {
    assert.ok(HORIZON_IDS.includes(s.horizon), `${s.id} has a known horizon`);
    assert.ok(s.title.length <= LIMITS.title, `${s.id} title fits the goal limit`);
    assert.ok(s.sub.length <= LIMITS.note, `${s.id} sub fits the note limit`);
  }
});

/* ---------- which starters already exist ---------- */

test('existingStarterIds matches titles trimmed and case-insensitively, in starter order', () => {
  const goals = [
    goal('g1', 'pay less tax, WITHOUT stress'),
    goal('g2', '  A cash cushion  '),
    goal('g3', 'Replace the roof')
  ];
  assert.deepEqual(existingStarterIds(goals), ['cushion', 'tax']);
});

test('existingStarterIds ignores archived goals and tolerates missing input', () => {
  assert.deepEqual(existingStarterIds([goal('g1', 'A cash cushion', { archived: true })]), []);
  assert.deepEqual(existingStarterIds([]), []);
  assert.deepEqual(existingStarterIds(undefined), []);
  assert.deepEqual(existingStarterIds([null, goal('g2', 'Kids and family')]), ['family']);
});

test('existingStarterIds needs the whole title, not a part of it', () => {
  assert.deepEqual(existingStarterIds([goal('g1', 'A cash cushion for the boat'), goal('g2', 'Kids')]), []);
});

/* ---------- goals already chosen ---------- */

test('otherGoals lists non-archived goals that are not a starter, in their order', () => {
  const goals = [
    goal('g1', 'Replace the roof'),
    goal('g2', 'a cash cushion'),
    goal('g3', 'Old plan', { archived: true }),
    goal('g4', 'Sabbatical in the mountains')
  ];
  assert.deepEqual(otherGoals(goals).map((g) => g.id), ['g1', 'g4']);
  assert.deepEqual(otherGoals(undefined), []);
});

/* ---------- bodies to create ---------- */

test('goalsToCreate makes one body per selected starter, with the sub as the note and no target', () => {
  const bodies = goalsToCreate({ starterIds: ['family', 'cushion'], ownTitles: [], goals: [] });
  assert.deepEqual(bodies, [
    { title: 'A cash cushion', note: 'Months of spending you never touch', horizon: 'now' },
    { title: 'Kids and family', note: 'School, childcare, a new arrival', horizon: '1-3y' }
  ], 'starters come out in starter order');
  for (const b of bodies) {
    assert.equal(Object.hasOwn(b, 'target'), false, 'no target key');
    assert.equal(Object.hasOwn(b, 'targetDate'), false, 'no targetDate key');
  }
});

test('goalsToCreate adds own goals trimmed, with an empty note and horizon now', () => {
  const bodies = goalsToCreate({ starterIds: [], ownTitles: ['  Sabbatical in the mountains '], goals: [] });
  assert.deepEqual(bodies, [{ title: 'Sabbatical in the mountains', note: '', horizon: 'now' }]);
});

test('goalsToCreate skips titles the household already has, ignoring archived goals', () => {
  const goals = [
    goal('g1', ' a CASH cushion'),
    goal('g2', 'Replace the roof'),
    goal('g3', 'Kids and family', { archived: true })
  ];
  const bodies = goalsToCreate({
    starterIds: ['cushion', 'family'],
    ownTitles: ['replace the ROOF', 'Learn to sail'],
    goals
  });
  assert.deepEqual(bodies.map((b) => b.title), ['Kids and family', 'Learn to sail'],
    'an existing starter and an existing own title are not created again; an archived title can be');
});

test('goalsToCreate dedupes own titles against each other and against selected starters, and drops blanks', () => {
  const bodies = goalsToCreate({
    starterIds: ['tax'],
    ownTitles: ['Learn to sail', ' learn to SAIL ', '', '   ', 'pay less tax, without stress', 'A cash cushion'],
    goals: []
  });
  assert.deepEqual(bodies, [
    { title: 'Pay less tax, without stress', note: 'Use every window before Dec 31', horizon: 'now' },
    { title: 'Learn to sail', note: '', horizon: 'now' },
    { title: 'A cash cushion', note: '', horizon: 'now' }
  ], 'an own title equal to an unselected starter is still an own goal');
});

test('goalsToCreate ignores unknown starter ids, repeated ids and missing input', () => {
  assert.deepEqual(goalsToCreate({ starterIds: ['nope', 'tax', 'tax'], ownTitles: undefined, goals: undefined }).map((b) => b.title),
    ['Pay less tax, without stress']);
  assert.deepEqual(goalsToCreate({}), []);
  assert.deepEqual(goalsToCreate(), []);
});

test('every body goalsToCreate makes passes the server goal validation with no target', () => {
  const bodies = goalsToCreate({ starterIds: STARTERS.map((s) => s.id), ownTitles: ['Sabbatical in the mountains'], goals: [] });
  assert.equal(bodies.length, STARTERS.length + 1);
  for (const b of bodies) {
    const res = validateGoal(b, { accounts: [], figures: {} });
    assert.equal(res.ok, true, `${b.title}: ${res.error || ''}`);
    assert.equal(res.value.target, null);
    assert.equal(res.value.targetDate, null);
  }
});

/* ---------- the Add your spouse line ---------- */

test('inviteLine: a link to the household page for an admin on a real store', () => {
  assert.deepEqual(inviteLine({ mode: 'real', identity: { role: 'admin', name: 'Owner' } }), { kind: 'link', href: '/admin/users' });
});

test('inviteLine: nothing for a member or a missing identity on a real store', () => {
  assert.deepEqual(inviteLine({ mode: 'real', identity: { role: 'member' } }), { kind: 'none' });
  assert.deepEqual(inviteLine({ mode: 'real', identity: null }), { kind: 'none' });
  assert.deepEqual(inviteLine({ mode: 'real' }), { kind: 'none' });
});

test('inviteLine: explanatory text only on the demo, whoever is looking', () => {
  assert.deepEqual(inviteLine({ mode: 'demo' }), { kind: 'text' });
  assert.deepEqual(inviteLine({ mode: 'demo', identity: { role: 'admin' } }), { kind: 'text' });
});

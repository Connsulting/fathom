// Goal model v2 (docs/plans/goal-model-v2.md): whose goal, priority, kinds and a done state, as the
// shared model in src/shared/goals.mjs validates them. Every refusal has a realistic valid input
// beside it that must be accepted. The last test proves a reset demo store has one goal of each
// kind and that their defs pass the same validation. Fixtures are synthetic.
//
// The model is imported as a namespace so one missing export fails its own tests, not the file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import * as G from '../src/shared/goals.mjs';
import * as seed from '../demo/seed.mjs';
import demo from '../demo/scenario.mjs';
import { buildScenario, loadFigures } from '../src/scenario/build.mjs';
import { goalCreate } from '../src/api/goals.mjs';
import { demoReset } from '../src/api/handlers.mjs';
import { tempInstance } from './helpers/server.mjs';

const ACCOUNTS = Object.freeze([
  { id: 'chk', kind: 'checking' }, { id: 'biz', kind: 'business' },
  { id: 'r1', kind: 'roth' }, { id: 'r2', kind: 'roth' }, { id: 'ret', kind: 'retirement' },
]);
const opts = (o = {}) => ({ accounts: ACCOUNTS, figures: {}, ...o });
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = s => new RegExp(`^${escape(s)}$`);

function ok(fields, o) {
  const r = G.validateGoal(fields, opts(o));
  assert.equal(r.ok, true, `${JSON.stringify(fields)} should pass: ${r.error}`);
  return r.value;
}
function bad(fields, re, o) {
  const r = G.validateGoal(fields, opts(o));
  assert.equal(r.ok, false, `${JSON.stringify(fields)} should be refused`);
  assert.match(r.error, re, JSON.stringify(fields));
}

const RANGE = Object.freeze({ title: 'Checking in a working range', kind: 'range', targetLow: 4000, targetHigh: 8000, targetDate: '2026-12-31', track: { accounts: ['chk'] } });
const FLOOR = Object.freeze({ title: 'Business cash floor', kind: 'floor', floor: 10000, track: { accounts: ['biz'] } });
const CONTRIB = Object.freeze({ title: 'Fill both IRAs', kind: 'contribution', target: 14000, taxYear: 2026, targetDate: '2027-04-15' });
const SPLIT = Object.freeze([{ person: 'owner', amount: 7000 }, { person: 'spouse', amount: 7000 }]);

/* ---------- constants ---------- */

test('the model names its kinds, kind fields, priorities, statuses, people and limits', () => {
  assert.deepEqual([...G.GOAL_KINDS], ['balance', 'range', 'floor', 'contribution']);
  assert.deepEqual(Object.keys(G.KIND_LABEL).sort(), [...G.GOAL_KINDS].sort());
  assert.deepEqual(G.KIND_LABEL, { balance: 'Reach a balance', range: 'Stay in a range', floor: 'Keep a floor', contribution: 'Make a contribution' });
  assert.deepEqual(Object.fromEntries(Object.entries(G.KIND_FIELDS).map(([k, v]) => [k, [...v]])), {
    balance: ['target', 'targetDate', 'track'],
    range: ['targetLow', 'targetHigh', 'targetDate', 'track'],
    floor: ['floor', 'track'],
    contribution: ['target', 'taxYear', 'targetDate', 'accounts', 'split', 'entered'],
  });
  assert.deepEqual([...G.PRIORITIES], ['high', 'medium', 'low']);
  assert.deepEqual(G.PRIORITY_LABEL, { high: 'High', medium: 'Medium', low: 'Low' });
  assert.deepEqual([...G.GOAL_STATUSES], ['open', 'done', 'archived']);
  assert.deepEqual([...G.PERSONS], ['owner', 'spouse']);
  assert.equal(G.LIMITS.people, 2);
  assert.equal(G.LIMITS.taxYearMin, 2000);
  assert.equal(G.LIMITS.taxYearMax, 2100);
  assert.deepEqual(['high', 'medium', 'low', null, undefined, 'urgent'].map(G.priorityRank), [0, 1, 2, 3, 3, 3]);
});

test('kindOf reads the model kind and treats a missing kind or a legacy topic as balance', () => {
  for (const k of G.GOAL_KINDS) assert.equal(G.kindOf({ kind: k }), k);
  assert.equal(G.kindOf({}), 'balance');
  assert.equal(G.kindOf(null), 'balance');
  assert.equal(G.kindOf({ kind: 'education' }), 'balance', 'a legacy topic is not a model kind');
});

test('goalStatusOf derives done, archived or open from the row columns', () => {
  assert.equal(G.goalStatusOf({ archived_at: '2026-11-01T00:00:00Z', done_at: '2026-10-01T00:00:00Z' }), 'done', 'a done goal archives itself and reads done');
  assert.equal(G.goalStatusOf({ archived_at: '2026-11-01T00:00:00Z', done_at: null }), 'archived');
  assert.equal(G.goalStatusOf({ archived_at: null, done_at: '2026-10-01T00:00:00Z' }), 'done');
  assert.equal(G.goalStatusOf({ archived_at: null, done_at: null }), 'open');
  assert.equal(G.goalStatusOf({}), 'open', 'a row from before migration 026 has no done_at');
  assert.equal(G.goalStatusOf(null), 'open');
});

/* ---------- common fields ---------- */

test('validateGoal defaults a new goal to kind balance, status open, owner and priority unset', () => {
  assert.deepEqual(ok({ title: 'A year of cash' }), {
    title: 'A year of cash', horizon: 'now', kind: 'balance', owner: null, priority: null, status: 'open',
    target: null, targetDate: null, track: null,
  });
  // A balance goal written the old way (no kind) keeps validating as before.
  const v = ok({ title: 'A year of cash', target: 60000.004, targetDate: '2027-06-30', track: { accounts: ['chk'] } });
  assert.equal(v.kind, 'balance');
  assert.equal(v.target, 60000);
  assert.deepEqual(v.track, { accounts: ['chk'] });
  assert.equal(ok({ title: 'Explicit', kind: 'balance', target: 100 }).kind, 'balance');
});

test('validateGoal accepts owner, spouse, joint and dependent keys as whose goal', () => {
  for (const owner of ['owner', 'spouse', 'joint', 'kid', 'kid2', 'kid10']) assert.equal(ok({ title: 'x', owner }).owner, owner);
  for (const owner of ['', null]) assert.equal(ok({ title: 'x', owner }).owner, null, JSON.stringify(owner));
  const msg = exact('owner must be owner, spouse, joint or a dependent key such as kid');
  for (const owner of ['you', 'both', 'Person A', 7, 'kidx', 'kid100', 'business', 'Owner', { id: 'owner' }]) bad({ title: 'x', owner }, msg);
  for (const id of ['owner', 'spouse', 'joint', 'kid', 'kid3']) assert.equal(G.isGoalOwner(id), true, id);
  for (const id of ['you', 'kidx', '', null, 'business']) assert.equal(G.isGoalOwner(id), false, String(id));
  assert.equal(G.isDependentKey('kid'), true);
  assert.equal(G.isDependentKey('kid12'), true);
  assert.equal(G.isDependentKey('kids'), false);
  assert.equal(G.isDependentKey('joint'), false);
});

test('validateGoal accepts high, medium or low priority, or unset', () => {
  for (const priority of ['high', 'medium', 'low']) assert.equal(ok({ title: 'x', priority }).priority, priority);
  for (const priority of ['', null]) assert.equal(ok({ title: 'x', priority }).priority, null);
  for (const priority of ['urgent', 'High', 1, true]) bad({ title: 'x', priority }, /priority/);
});

test('validateGoal accepts status open, done and archived only', () => {
  for (const status of ['open', 'done', 'archived']) assert.equal(ok({ title: 'x', status }).status, status);
  for (const status of ['closed', 'on track', 'Done', '', 1]) bad({ title: 'x', status }, /status/);
  // A partial edit never invents a status, kind, owner or priority.
  const partial = ok({ title: 'Renamed' }, { partial: true });
  for (const k of ['status', 'kind', 'owner', 'priority']) assert.equal(Object.hasOwn(partial, k), false, k);
  assert.equal(ok({ status: 'done' }, { partial: true }).status, 'done');
});

test('validateGoal refuses a kind outside the model kinds', () => {
  const msg = exact('kind must be one of balance, range, floor, contribution');
  for (const kind of ['savings', 'Range', 'education', 'cash']) bad({ title: 'x', kind }, msg);
  ok({ ...RANGE });
  ok({ ...FLOOR });
  ok({ ...CONTRIB });
});

/* ---------- range ---------- */

test('a range needs both ends with the low end not above the high end', () => {
  const v = ok({ ...RANGE, owner: 'joint', priority: 'medium' });
  assert.equal(v.kind, 'range');
  assert.equal(v.targetLow, 4000);
  assert.equal(v.targetHigh, 8000);
  assert.equal(v.targetDate, '2026-12-31');
  assert.deepEqual(v.track, { accounts: ['chk'] });
  assert.equal(v.owner, 'joint');
  assert.equal(v.priority, 'medium');
  const both = exact('a range needs a low end and a high end');
  bad({ ...RANGE, targetHigh: undefined }, both);
  bad({ ...RANGE, targetLow: undefined }, both);
  bad({ ...RANGE, targetHigh: null }, both);
  bad({ ...RANGE, targetLow: 60, targetHigh: 50 }, exact('the low end must not be above the high end'));
  bad({ ...RANGE, targetLow: -1 }, exact('targetLow must not be negative'));
  bad({ ...RANGE, targetHigh: '8000' }, exact('targetHigh must be a number'));
  bad({ ...RANGE, targetHigh: 1e11 }, exact('targetHigh is too large'));
  assert.equal(ok({ ...RANGE, targetLow: 5000.004, targetHigh: 5000.004 }).targetLow, 5000, 'low equal to high is a valid range');
  // Target date and tracking stay optional for a range; absent ones default to null.
  const bare = ok({ title: 'Bare range', kind: 'range', targetLow: 1, targetHigh: 2 });
  assert.equal(bare.targetDate, null);
  assert.equal(bare.track, null);
});

/* ---------- floor ---------- */

test('a floor needs an amount and something tracked, and refuses a target date', () => {
  const v = ok({ ...FLOOR, owner: 'owner', priority: 'high' });
  assert.equal(v.kind, 'floor');
  assert.equal(v.floor, 10000);
  assert.deepEqual(v.track, { accounts: ['biz'] });
  assert.equal(ok({ ...FLOOR, floor: 0 }).floor, 0, 'a zero floor is an amount');
  bad({ ...FLOOR, floor: undefined }, exact('a floor needs an amount'));
  bad({ ...FLOOR, floor: null }, exact('a floor needs an amount'));
  bad({ ...FLOOR, floor: -5 }, exact('floor must not be negative'));
  bad({ ...FLOOR, track: undefined }, exact('a floor needs something to track'));
  bad({ ...FLOOR, track: null }, exact('a floor needs something to track'));
  bad({ ...FLOOR, track: { accounts: ['nope'] } }, /unknown account/);
  bad({ ...FLOOR, targetDate: '2026-12-31' }, exact('targetDate does not apply to a floor goal'));
  bad({ ...FLOOR, target: 10000 }, exact('target does not apply to a floor goal'));
});

/* ---------- contribution ---------- */

test('a contribution needs an amount, a tax year and a deadline after Jan 1 of the tax year', () => {
  const v = ok({ ...CONTRIB });
  assert.equal(v.kind, 'contribution');
  assert.equal(v.target, 14000);
  assert.equal(v.taxYear, 2026);
  assert.equal(v.targetDate, '2027-04-15');
  for (const k of ['accounts', 'split', 'entered']) assert.equal(v[k], null, `${k} defaults to null`);

  bad({ ...CONTRIB, target: undefined }, exact('a contribution needs an amount'));
  bad({ ...CONTRIB, target: 0 }, exact('a contribution needs an amount'));
  bad({ ...CONTRIB, target: null }, exact('a contribution needs an amount'));
  bad({ ...CONTRIB, taxYear: undefined }, exact('a contribution needs a tax year'));
  bad({ ...CONTRIB, taxYear: null }, exact('a contribution needs a tax year'));
  bad({ ...CONTRIB, targetDate: undefined }, exact('a contribution needs a deadline'));
  bad({ ...CONTRIB, targetDate: null }, exact('a contribution needs a deadline'));
  for (const taxYear of [1999, 2101, 2026.5, '2026']) bad({ ...CONTRIB, taxYear }, /taxYear|tax year/);
  for (const taxYear of [2000, 2100]) ok({ ...CONTRIB, taxYear, targetDate: `${taxYear}-12-31` });

  const deadline = exact('the deadline must be after January 1 of the tax year');
  bad({ ...CONTRIB, targetDate: '2025-12-31' }, deadline);
  bad({ ...CONTRIB, targetDate: '2026-01-01' }, deadline, 'on Jan 1 itself is refused');
  assert.equal(ok({ ...CONTRIB, targetDate: '2026-01-02' }).targetDate, '2026-01-02');
  assert.equal(ok({ ...CONTRIB, targetDate: '2027-04-15' }).targetDate, '2027-04-15', 'the April deadline for the prior tax year');
  bad({ ...CONTRIB, targetDate: '2027-02-30' }, /date/);
});

test('contribution destination accounts must be known accounts', () => {
  assert.deepEqual(ok({ ...CONTRIB, accounts: ['r1', 'r2'] }).accounts, ['r1', 'r2']);
  assert.equal(ok({ ...CONTRIB, accounts: [] }).accounts, null);
  assert.equal(ok({ ...CONTRIB, accounts: null }).accounts, null);
  bad({ ...CONTRIB, accounts: ['r1', 'nope'] }, /account/);
  bad({ ...CONTRIB, accounts: [7] }, /account/);
  bad({ ...CONTRIB, accounts: 'r1' }, /account/);
  const many = Array.from({ length: 21 }, (_, i) => `a${i}`);
  bad({ ...CONTRIB, accounts: many }, /account/, { accounts: many.map(id => ({ id, kind: 'roth' })) });
});

test('a contribution split names owner or spouse once each and adds up to the amount to the cent', () => {
  assert.deepEqual(ok({ ...CONTRIB, split: SPLIT }).split, SPLIT);
  assert.deepEqual(ok({ ...CONTRIB, split: [{ person: 'owner', amount: 14000 }] }).split, [{ person: 'owner', amount: 14000 }]);
  assert.equal(ok({ ...CONTRIB, split: [] }).split, null);
  assert.equal(ok({ ...CONTRIB, split: null }).split, null);
  // Cents: 0.1 plus 0.2 is 0.3.
  ok({ ...CONTRIB, target: 0.3, split: [{ person: 'owner', amount: 0.1 }, { person: 'spouse', amount: 0.2 }] });
  const sum = exact('the split must add up to the amount');
  bad({ ...CONTRIB, target: 15000, split: SPLIT }, sum);
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: 7000 }] }, sum);
  bad({ ...CONTRIB, split: [{ person: 'joint', amount: 7000 }, { person: 'spouse', amount: 7000 }] }, /split|person/);
  bad({ ...CONTRIB, split: [{ person: 'kid', amount: 7000 }, { person: 'spouse', amount: 7000 }] }, /split|person/);
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: 7000 }, { person: 'owner', amount: 7000 }] }, /split|person/);
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: 14000 }, { person: 'spouse', amount: 0 }] }, /split|amount/);
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: -1 }, { person: 'spouse', amount: 14001 }] }, /split|amount|negative/);
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: '7000' }, { person: 'spouse', amount: 7000 }] }, /split|amount|number/);
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: 7000, note: 'x' }, { person: 'spouse', amount: 7000 }] }, /split/);
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: 5000 }, { person: 'spouse', amount: 5000 }, { person: 'owner', amount: 4000 }] }, /split/);
  bad({ ...CONTRIB, split: { owner: 7000, spouse: 7000 } }, /split/);
});

test('a contribution entered amount is a dated total or per-person amounts within the split', () => {
  assert.deepEqual(ok({ ...CONTRIB, entered: { asOf: '2026-11-01', total: 4500 } }).entered, { asOf: '2026-11-01', total: 4500 });
  const people = { asOf: '2026-11-01', people: [{ person: 'owner', amount: 3000 }, { person: 'spouse', amount: 0 }] };
  assert.deepEqual(ok({ ...CONTRIB, split: SPLIT, entered: people }).entered, people, 'zero is a valid amount entered');
  assert.deepEqual(ok({ ...CONTRIB, entered: people }).entered, people, 'without a split either person may be entered');
  assert.equal(ok({ ...CONTRIB, entered: null }).entered, null);
  assert.equal(ok({ ...CONTRIB, entered: { asOf: '2026-11-01', total: 0 } }).entered.total, 0);

  bad({ ...CONTRIB, entered: { total: 4500 } }, /asOf|entered/);
  bad({ ...CONTRIB, entered: { asOf: '2026-02-30', total: 4500 } }, /asOf|date/);
  bad({ ...CONTRIB, entered: { asOf: '2026-11-01' } }, /entered|total|people/);
  bad({ ...CONTRIB, entered: { asOf: '2026-11-01', total: 4500, people: people.people } }, /entered|total|people/);
  bad({ ...CONTRIB, entered: { asOf: '2026-11-01', total: -1 } }, /entered|total|negative/);
  bad({ ...CONTRIB, entered: { asOf: '2026-11-01', people: [{ person: 'owner', amount: -1 }] } }, /entered|amount|negative/);
  bad({ ...CONTRIB, entered: { asOf: '2026-11-01', people: [{ person: 'joint', amount: 10 }] } }, /entered|person/);
  bad({ ...CONTRIB, entered: { asOf: '2026-11-01', people: [{ person: 'owner', amount: 1 }, { person: 'owner', amount: 2 }] } }, /entered|person/);
  bad({ ...CONTRIB, entered: '4500' }, /entered/);
  // With a split, an entered person must be one of the split persons.
  bad({ ...CONTRIB, split: [{ person: 'owner', amount: 14000 }], entered: { asOf: '2026-11-01', people: [{ person: 'spouse', amount: 100 }] } }, /split|entered|person/);
  ok({ ...CONTRIB, split: [{ person: 'owner', amount: 14000 }], entered: { asOf: '2026-11-01', people: [{ person: 'owner', amount: 100 }] } });
});

test('a full contribution body comes back normalized', () => {
  const v = ok({
    ...CONTRIB, title: '  Fill both IRAs  ', horizon: 'now', owner: 'joint', priority: 'high', accounts: ['r1', 'r2'],
    split: [{ person: 'owner', amount: 7000.004 }, { person: 'spouse', amount: 7000 }],
    entered: { asOf: '2026-11-01', people: [{ person: 'owner', amount: 3000.004 }, { person: 'spouse', amount: 1500 }] },
  });
  assert.equal(v.title, 'Fill both IRAs');
  assert.equal(v.owner, 'joint');
  assert.equal(v.priority, 'high');
  assert.equal(v.status, 'open');
  assert.deepEqual(v.split, SPLIT, 'amounts round to cents');
  assert.deepEqual(v.entered, { asOf: '2026-11-01', people: [{ person: 'owner', amount: 3000 }, { person: 'spouse', amount: 1500 }] });
  for (const k of G.KIND_FIELDS.contribution) assert.ok(Object.hasOwn(v, k), `${k} is in the value`);
});

/* ---------- other kinds' fields ---------- */

test('fields of another kind are refused', () => {
  bad({ title: 'Plain balance', targetLow: 5 }, exact('targetLow does not apply to a balance goal'));
  bad({ title: 'Plain balance', kind: 'balance', taxYear: 2026 }, exact('taxYear does not apply to a balance goal'));
  bad({ title: 'Plain balance', floor: 100 }, exact('floor does not apply to a balance goal'));
  bad({ ...RANGE, floor: 5 }, exact('floor does not apply to a range goal'));
  bad({ ...RANGE, target: 5 }, exact('target does not apply to a range goal'));
  bad({ ...FLOOR, split: SPLIT }, exact('split does not apply to a floor goal'));
  bad({ ...CONTRIB, track: { accounts: ['r1'] } }, exact('track does not apply to a contribution goal'));
  bad({ ...CONTRIB, targetHigh: 9 }, exact('targetHigh does not apply to a contribution goal'));
  // The same field on its own kind is accepted.
  ok({ title: 'Plain balance', target: 5, targetDate: '2027-01-31', track: { accounts: ['chk'] } });
  ok({ ...RANGE });
  ok({ ...CONTRIB, accounts: ['r1'] });
});

/* ---------- partial edits ---------- */

test('a partial edit validates against the stored def', () => {
  const previous = { id: 'g1', title: 'Checking range', note: '', horizon: 'now', kind: 'range', owner: null, priority: null,
    targetLow: 10, targetHigh: 20, targetDate: '2026-12-31', track: { accounts: ['chk'] }, pace: null };
  const edit = () => ({ partial: true, previous });
  bad({ targetHigh: 5 }, exact('the low end must not be above the high end'), edit());
  bad({ targetLow: 25 }, exact('the low end must not be above the high end'), edit());
  assert.equal(ok({ targetHigh: 25 }, edit()).targetHigh, 25);
  assert.deepEqual(ok({ title: 'Renamed' }, edit()), { title: 'Renamed' }, 'a title-only edit returns only the title');
  bad({ floor: 5 }, exact('floor does not apply to a range goal'), edit());
  assert.equal(ok({ priority: 'low', owner: 'spouse' }, edit()).priority, 'low');
});

test('a partial edit that changes kind drops the old kind fields instead of validating them', () => {
  const range = { id: 'g1', title: 'Checking range', kind: 'range', targetLow: 10, targetHigh: 20, targetDate: '2026-12-31', track: { accounts: ['chk'] } };
  const o = { partial: true, previous: range };
  assert.equal(ok({ kind: 'floor', floor: 5, track: { accounts: ['chk'] } }, o).kind, 'floor');
  // track is a floor field too, so the stored track carries over to the floor.
  assert.equal(ok({ kind: 'floor', floor: 5 }, o).floor, 5);
  bad({ kind: 'floor' }, exact('a floor needs an amount'), o);
  // targetDate is a contribution field, so the stored date is checked against the new tax year.
  ok({ kind: 'contribution', target: 100, taxYear: 2026 }, o);
  bad({ kind: 'contribution', target: 100, taxYear: 2027 }, exact('the deadline must be after January 1 of the tax year'), o);
  bad({ kind: 'contribution', target: 100 }, exact('a contribution needs a tax year'), o);
  // Back to balance: the range ends are dropped, never a reason to refuse.
  ok({ kind: 'balance', target: 30 }, o);

  const contribution = { id: 'g2', title: 'Fill both IRAs', kind: 'contribution', target: 14000, taxYear: 2026, targetDate: '2027-04-15',
    accounts: ['r1', 'r2'], split: SPLIT, entered: null };
  const c = { partial: true, previous: contribution };
  bad({ target: 16000 }, exact('the split must add up to the amount'), c);
  ok({ target: 16000, split: [{ person: 'owner', amount: 8000 }, { person: 'spouse', amount: 8000 }] }, c);
  ok({ target: 16000, split: null }, c);
  bad({ taxYear: 2028 }, exact('the deadline must be after January 1 of the tax year'), c);
  ok({ taxYear: 2027 }, c);
  bad({ entered: { asOf: '2026-11-01', people: [{ person: 'owner', amount: 1 }] }, split: [{ person: 'spouse', amount: 14000 }] }, /split|entered|person/, c);
  ok({ entered: { asOf: '2026-11-01', people: [{ person: 'spouse', amount: 1 }] } }, c);
  ok({ kind: 'floor', floor: 1000, track: { accounts: ['chk'] } }, c);
});

test('a stored def with a legacy topic as its kind edits as a balance goal', () => {
  const o = { partial: true, previous: { id: 'g3', title: 'College fund', kind: 'education', target: 50000, targetDate: '2034-08-31', track: null } };
  assert.equal(ok({ target: 60000 }, o).target, 60000);
  bad({ floor: 5 }, exact('floor does not apply to a balance goal'), o);
});

/* ---------- labels ---------- */

test('personLabel and goalOwnerOptions read household names and fall back to neutral labels', () => {
  const names = { me: 'Person One', spouse: 'Person Two', kid: 'Child One', kid2: 'Child Two', biz: 'Synthetic Business LLC' };
  assert.deepEqual(['owner', 'spouse', 'joint', 'kid', 'kid2'].map(id => G.personLabel(id, names)),
    ['Person One', 'Person Two', 'Joint', 'Child One', 'Child Two']);
  assert.deepEqual(G.goalOwnerOptions(names), [
    { id: 'owner', label: 'Person One' }, { id: 'spouse', label: 'Person Two' }, { id: 'joint', label: 'Joint' },
    { id: 'kid', label: 'Child One' }, { id: 'kid2', label: 'Child Two' },
  ], 'non-person keys such as biz are not offered');
  assert.deepEqual(['owner', 'spouse', 'joint', 'kid', 'kid3'].map(id => G.personLabel(id, {})), ['You', 'Your spouse', 'Joint', 'Your child', 'Your child']);
  assert.deepEqual(['owner', 'spouse'].map(id => G.personLabel(id)), ['You', 'Your spouse'], 'names default to none');
  assert.equal(G.personLabel('business', names), '');
  assert.equal(G.personLabel(null, names), '');
  assert.deepEqual(G.goalOwnerOptions({}), [
    { id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'joint', label: 'Joint' }, { id: 'kid', label: 'Your child' },
  ]);
  // The demo household's names come from content, never from code.
  const fromDemo = G.goalOwnerOptions(demo.names);
  assert.deepEqual(fromDemo.slice(0, 3).map(o => o.label), [demo.names.me, demo.names.spouse, 'Joint']);
  assert.deepEqual(fromDemo.filter(o => G.isDependentKey(o.id)).map(o => o.label),
    Object.keys(demo.names).filter(G.isDependentKey).sort().map(k => demo.names[k]));
});

/* ---------- topics and open goals ---------- */

test('goalTopics ignores model kinds, keeps a legacy topic and reads contribution accounts', () => {
  const topics = (goal, accounts = []) => [...G.goalTopics(goal, accounts)].sort();
  for (const kind of G.GOAL_KINDS) assert.deepEqual(topics({ kind, title: 'Plain words' }), [], `${kind} adds no topic`);
  assert.deepEqual(topics({ kind: 'floor', topic: 'education', title: 'Plain words' }), ['education']);
  assert.deepEqual(topics({ kind: 'education', title: 'Plain words' }), ['education'], 'a raw legacy def kind still links');
  assert.deepEqual(topics({ kind: 'contribution', title: 'Plain words', accounts: ['ret'] }, ACCOUNTS), ['retirement']);
  assert.deepEqual(topics({ kind: 'contribution', title: 'Plain words', accounts: ['nope'] }, ACCOUNTS), [], 'an unknown account adds nothing');
  assert.deepEqual(topics({ kind: 'floor', title: 'Plain words', track: { accounts: ['chk'] } }, ACCOUNTS), ['cash']);
  // A rec naming the legacy topic serves the goal through `topic`.
  const goals = [{ id: 'legacy', title: 'Plain words', kind: 'balance', topic: 'education', status: 'open' }];
  assert.deepEqual(G.servesGoals({ goalKinds: ['education'] }, goals).map(g => g.id), ['legacy']);
});

test('openGoal treats done and archived goals as closed', () => {
  assert.equal(G.openGoal({ status: 'done' }), false);
  assert.equal(G.openGoal({ archived: true, status: 'open' }), false);
  assert.equal(G.openGoal({ archived: true, status: 'archived' }), false);
  assert.equal(G.openGoal({ origin: 'seed', status: 'on track' }), true);
  assert.equal(G.openGoal({ origin: 'owner', status: 'open' }), true);
  assert.equal(G.openGoal({ origin: 'seed', status: 'open', statusLabel: 'watch' }), true);
  const goals = [{ id: 'a', title: 'Cash reserve', status: 'done' }, { id: 'b', title: 'Cash cushion', status: 'open' }];
  assert.deepEqual(G.servesGoals({ goalKinds: ['cash'] }, goals).map(g => g.id), ['b'], 'a done goal drops out of links');
});

/* ---------- the demo ---------- */

const KIND_IDS = ['checking-range', 'biz-floor', 'ira-fill'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(o, k)).map(k => [k, o[k]]));

test('a reset demo store has one goal of each kind (balance, range, floor, contribution)', async t => {
  // A demo instance, so demo reset gets the household context it clears the vault through.
  const s = await tempInstance({ mode: 'demo', init: seed.seedDemo });
  t.after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  const config = { clock: demo.meta.clock, dataDir: s.dataDir };
  const household = await s.household(config);
  const ctx = body => ({ db: s.db, config, body, params: {}, household, platform: s.platform });
  await goalCreate(ctx({ title: 'An extra goal that reset removes' }));
  await demoReset(ctx({}));

  assert.ok(Array.isArray(seed.KIND_GOALS), 'demo/seed.mjs exports KIND_GOALS');
  assert.deepEqual(seed.KIND_GOALS.map(g => g.id), KIND_IDS);
  assert.deepEqual(seed.KIND_GOALS.map(g => g.kind), ['range', 'floor', 'contribution']);

  const sc = await buildScenario(s.db, { clock: demo.meta.clock });
  assert.deepEqual(sc.goals.map(g => g.id), [...demo.goals.map(g => g.id), ...KIND_IDS], 'reset restores the seed goals, then the kind goals');
  const ofKind = k => sc.goals.filter(g => g.kind === k);
  assert.ok(ofKind('balance').some(g => typeof g.target === 'number' && g.track), 'a seed goal with a target is the balance example');
  for (const [kind, id] of [['range', 'checking-range'], ['floor', 'biz-floor'], ['contribution', 'ira-fill']]) {
    assert.deepEqual(ofKind(kind).map(g => g.id), [id], `exactly one ${kind} goal`);
  }

  const accounts = await s.db.prepare('SELECT id, kind FROM accounts').all();
  const figures = await loadFigures(s.db);
  for (const def of seed.KIND_GOALS) {
    const g = sc.goals.find(x => x.id === def.id);
    assert.equal(g.origin, 'seed', `${def.id} came with the demo`);
    assert.equal(g.archived, false);
    assert.equal(g.status, 'open', `${def.id} reads the canonical status`);
    assert.equal(g.statusLabel, def.status, `${def.id} keeps its display text as statusLabel`);
    assert.equal(g.owner, def.owner);
    assert.equal(g.priority, def.priority);
    assert.ok(G.isGoalOwner(def.owner) && G.PRIORITIES.includes(def.priority), def.id);
    const fields = pick(def, ['title', 'horizon', 'kind', 'owner', 'priority', ...G.KIND_FIELDS[def.kind]]);
    const r = G.validateGoal(fields, { accounts, figures });
    assert.equal(r.ok, true, `${def.id} def passes validateGoal: ${r.error}`);
    for (const text of [def.title, def.prose]) {
      assert.doesNotMatch(text, /\$\s?\d/, `${def.id} text has no dollar amount`);
      assert.doesNotMatch(text, /\btax(es)?\b/i, `${def.id} text avoids tax words`);
    }
  }

  const pace = id => sc.pace.goals.find(p => p.id === id);
  for (const def of seed.KIND_GOALS) assert.equal(pace(def.id)?.kind, def.kind, `${def.id} has a pace entry of its kind`);
  assert.ok(sc.pace.goals.filter(p => p.kind === 'balance').length > 0, 'balance goals keep their pace entries');
  assert.equal(pace('checking-range').range.position, 'in', 'the joint checking balance sits in its range');
  assert.equal(pace('biz-floor').floor.state, 'holding', 'business cash is above its floor');
  assert.equal(pace('biz-floor').status, 'unknown', 'the demo balances are stale');
  const ira = pace('ira-fill');
  assert.equal(ira.contribution.basis, 'entered', 'the IRAs have no transactions, so the entered amount is used');
  assert.equal(ira.actual.v, 11500);
  assert.equal(ira.status, 'ahead', 'the entered amount is current and ahead of the straight-line plan');
  assert.equal(ira.contribution.people.length, 2);
});

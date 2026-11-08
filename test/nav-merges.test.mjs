// SX5 navigation merges: four tabs with fewer views, old routes landing on their new homes, a
// three-step onboarding and a Plan grouped by who has each item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, SUBNAV, TAB_OF, GO, GO_MORE, OB_RAIL, obRailIndex, planGroups } from '../web/horizon/nav.js';
import { ROUTES, movedRoute, onboardStepOf, ONBOARD_STEPS } from '../src/shared/route-moves.mjs';

const keys = (views) => views.map(([k]) => k);

// AV1 B9 had not removed What-if when this landed, so it goes here; Conversations alone needs no
// sub-nav. A war-game page is still reached from its Plan decision and lights the Ask tab.
test('Ask has no sub-nav: no Packs and no What-if views', () => {
  assert.equal(SUBNAV.ask, undefined);
  assert.equal(TAB_OF.ask, 'ask');
  assert.equal(TAB_OF.wargame, 'ask');
});

test('Money has Overview, P&L and Files, with no separate Accounts view', () => {
  assert.deepEqual(keys(SUBNAV.money), ['money', 'pnl', 'add']);
  assert.equal(SUBNAV.money[0][1], 'Overview');
});

test('the four tabs stay Home, Plan, Ask and Money', () => {
  assert.deepEqual(TABS.map(([k]) => k), ['home', 'plan', 'ask', 'money']);
});

test('packs and the What Fathom knows page sit under the gear', () => {
  assert.equal(TAB_OF.packs, 'settings');
  assert.equal(TAB_OF.memories, 'settings');
});

test('#/accounts lands on the Money overview and #/brief on Home', () => {
  assert.deepEqual(movedRoute({ name: 'accounts', params: {} }), { name: 'money', params: {} });
  assert.deepEqual(movedRoute({ name: 'brief', params: {} }), { name: 'home', params: {} });
  assert.equal(movedRoute({ name: 'money', params: {} }), null);
  assert.equal(movedRoute({ name: 'packs', params: { id: 'x' } }), null);
});

test('every route a tab, sub-nav or switcher names is a live route, never a moved one', () => {
  const named = [
    ...TABS.map(([k]) => k), 'settings',
    ...Object.values(SUBNAV).flatMap(keys),
    ...Object.keys(TAB_OF),
    ...GO.map((g) => g[1]),
    ...GO_MORE.map(([k]) => k)
  ];
  for (const name of named) {
    assert.ok(ROUTES.has(name), `${name} is a known route`);
    assert.equal(movedRoute({ name, params: {} }), null, `${name} is not a moved route`);
  }
});

test('every moved route lands on a live route', () => {
  for (const name of ROUTES) {
    const to = movedRoute({ name, params: {} });
    if (!to) continue;
    assert.ok(ROUTES.has(to.name), `${name} moves to known ${to.name}`);
    assert.equal(movedRoute(to), null, `${name} moves in one hop`);
  }
});

test('the switcher has no Accounts entry and names the memories page What Fathom knows', () => {
  assert.ok(!GO.some((g) => g[1] === 'accounts'));
  assert.ok(!GO_MORE.some(([k]) => k === 'accounts'));
  assert.deepEqual(GO_MORE.find(([k]) => k === 'memories'), ['memories', 'What Fathom knows']);
});

test('onboarding runs Tell us, What we understood and Build', () => {
  assert.deepEqual(OB_RAIL, ['Tell us', 'What we understood', 'Build']);
  assert.deepEqual(ONBOARD_STEPS, [0, 3, 4, 5]);
  assert.equal(obRailIndex(0), -1);
  assert.equal(obRailIndex(3), 0);
  assert.equal(obRailIndex(4), 1);
  assert.equal(obRailIndex(5), 2);
});

test('the cut Goals and Curve steps land on Tell us', () => {
  assert.equal(onboardStepOf(1, { real: false }), 3);
  assert.equal(onboardStepOf(2, { real: false }), 3);
  assert.equal(onboardStepOf(1, { real: true }), 3);
  assert.equal(onboardStepOf(2, { real: true }), 3);
});

test('a demo starts on the welcome step and a real store on Tell us', () => {
  assert.equal(onboardStepOf(0, { real: false }), 0);
  assert.equal(onboardStepOf(0, { real: true }), 3);
  assert.equal(onboardStepOf(undefined, { real: true }), 3);
  assert.equal(onboardStepOf(4, { real: true }), 4);
  assert.equal(onboardStepOf(9, { real: false }), 5);
  assert.equal(onboardStepOf(-2, { real: false }), 0);
});

const rec = (id, status) => ({ id, status });

test('Plan groups read Needs you, Fathom has it and Done, with Done collapsed', () => {
  const recs = [rec('a', 'proposed'), rec('b', 'doing'), rec('c', 'waiting'), rec('d', 'snoozed'), rec('e', 'done'), rec('f', 'dismissed'), rec('g', 'proposed')];
  const ny = [recs[0], recs[6]];
  const groups = planGroups(recs, ny);
  assert.deepEqual(groups.map((g) => [g.key, g.title, g.collapsed]), [
    ['needs', 'Needs you', false], ['fathom', 'Fathom has it', false], ['done', 'Done', true]
  ]);
  assert.deepEqual(groups[0].list.map((r) => r.id), ['a', 'g']);
  assert.deepEqual(groups[1].list.map((r) => r.id), ['b', 'c', 'd']);
  assert.deepEqual(groups[2].list.map((r) => r.id), ['e', 'f']);
});

test('Plan groups keep the order they are given and skip hidden items', () => {
  const recs = [rec('z', 'done'), rec('y', 'hidden'), rec('x', 'doing'), rec('w', 'proposed')];
  const groups = planGroups(recs, [recs[3]]);
  assert.deepEqual(groups.map((g) => g.list.map((r) => r.id)), [['w'], ['x'], ['z']]);
});

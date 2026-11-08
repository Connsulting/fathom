// Keyboard layer: key normalization, typing guard, fuzzy ranking and the dispatcher.
// DOM elements are duck typed; the clock is fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey, isTypingTarget, passesGuard, fuzzyScore, rankItems, createKeys } from '../web/horizon/keys.js';

const ev = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const DIV = { tagName: 'DIV' };
const INPUT = { tagName: 'INPUT' };

/* ---------- normalizeKey ---------- */

test('normalizeKey: Ctrl+K and Meta+K are both mod+k', () => {
  assert.equal(normalizeKey(ev('k', { ctrlKey: true })), 'mod+k');
  assert.equal(normalizeKey(ev('k', { metaKey: true })), 'mod+k');
  assert.equal(normalizeKey(ev('K', { ctrlKey: true })), 'mod+k');
});

test('normalizeKey: letters lower case, Shift prefixes letters only', () => {
  assert.equal(normalizeKey(ev('x')), 'x');
  assert.equal(normalizeKey(ev('X', { shiftKey: true })), 'shift+x');
  assert.equal(normalizeKey(ev('G')), 'g');
  assert.equal(normalizeKey(ev('?', { shiftKey: true })), '?');
  assert.equal(normalizeKey(ev('/')), '/');
});

test('normalizeKey: named keys lower cased', () => {
  assert.equal(normalizeKey(ev('Escape')), 'escape');
  assert.equal(normalizeKey(ev('Enter')), 'enter');
  assert.equal(normalizeKey(ev('ArrowDown')), 'arrowdown');
  assert.equal(normalizeKey(ev('ArrowUp')), 'arrowup');
  assert.equal(normalizeKey(ev('Tab')), 'tab');
});

test('normalizeKey: Alt and bare modifiers are null', () => {
  assert.equal(normalizeKey(ev('k', { altKey: true })), null);
  assert.equal(normalizeKey(ev('k', { ctrlKey: true, altKey: true })), null);
  for (const m of ['Shift', 'Control', 'Meta', 'Alt']) assert.equal(normalizeKey(ev(m)), null, m);
});

/* ---------- isTypingTarget and passesGuard ---------- */

test('isTypingTarget: form fields and contenteditable are typing targets', () => {
  assert.equal(isTypingTarget(INPUT), true);
  assert.equal(isTypingTarget({ tagName: 'input' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
});

test('isTypingTarget: a div, null and undefined are not', () => {
  assert.equal(isTypingTarget(DIV), false);
  assert.equal(isTypingTarget({ tagName: 'A', isContentEditable: false }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
});

test('passesGuard: escape and mod+k pass while typing, plain keys do not', () => {
  for (const t of [INPUT, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
    assert.equal(passesGuard('escape', t), true);
    assert.equal(passesGuard('mod+k', t), true);
    assert.equal(passesGuard('g', t), false);
    assert.equal(passesGuard('shift+x', t), false);
  }
});

test('passesGuard liveness: any key passes outside a typing target', () => {
  assert.equal(passesGuard('g', DIV), true);
  assert.equal(passesGuard('g', null), true);
  assert.equal(passesGuard('?', DIV), true);
});

/* ---------- fuzzyScore ---------- */

test('fuzzyScore: null when the query is not a subsequence', () => {
  assert.equal(fuzzyScore('xyz', 'Plan'), null);
  assert.equal(fuzzyScore('lp', 'Plan'), null);
});

test('fuzzyScore: empty query scores zero with no hits', () => {
  assert.deepEqual(fuzzyScore('', 'Plan'), { score: 0, hits: [] });
});

test('fuzzyScore: hits are matched indices, case insensitive, spaces ignored', () => {
  assert.deepEqual(fuzzyScore('pl', 'Plan').hits, [0, 1]);
  assert.deepEqual(fuzzyScore('PL', 'plan').hits, [0, 1]);
  assert.deepEqual(fuzzyScore('g p', 'Go to Plan').hits, [0, 6]);
});

test('fuzzyScore: hits prefer a word start over an earlier mid-word letter', () => {
  assert.deepEqual(fuzzyScore('ya', 'Year end Accounts').hits, [0, 9]);
});

test('fuzzyScore: exact prefix beats word start beats scattered', () => {
  const prefix = fuzzyScore('pla', 'Plan things').score;
  const word = fuzzyScore('pla', 'Go to Plans').score;
  const scattered = fuzzyScore('pla', 'xpxlxaxxxxx').score;
  assert.ok(prefix > word, `prefix ${prefix} > word start ${word}`);
  assert.ok(word > scattered, `word start ${word} > scattered ${scattered}`);
});

test('fuzzyScore: word starts include camel case, hyphen, slash and parenthesis', () => {
  assert.ok(fuzzyScore('b', 'fooBar').score > fuzzyScore('b', 'foobar').score);
  assert.ok(fuzzyScore('r', 'ab-rc').score > fuzzyScore('r', 'abxrc').score);
  assert.ok(fuzzyScore('r', 'ab/rc').score > fuzzyScore('r', 'abxrc').score);
  assert.ok(fuzzyScore('r', 'ab(rc').score > fuzzyScore('r', 'abxrc').score);
});

test('fuzzyScore: consecutive runs beat gaps, shorter text wins for the same prefix', () => {
  assert.ok(fuzzyScore('abc', 'abcxxxxx').score > fuzzyScore('abc', 'axbxcxxx').score);
  assert.ok(fuzzyScore('pla', 'Plan').score > fuzzyScore('pla', 'Planning ahead').score);
});

/* ---------- rankItems ---------- */

const ITEMS = [
  { key: 'go:plan', title: 'Plan', group: 'Go to' },
  { key: 'go:packs', title: 'Packs', group: 'Go to' },
  { key: 'rec:a', title: 'Pay the plan fee', group: 'Recommendations' },
  { key: 'acc:x', title: 'Checking', group: 'Accounts' }
];
const keysOf = (rows) => rows.map((r) => r.item.key);

test('rankItems: empty query lists recents first in recents order, then the rest in input order', () => {
  const rows = rankItems(ITEMS, '', ['acc:x', 'rec:a']);
  assert.deepEqual(keysOf(rows), ['acc:x', 'rec:a', 'go:plan', 'go:packs']);
  assert.deepEqual(rows.map((r) => r.recent), [true, true, false, false]);
  assert.deepEqual(keysOf(rankItems(ITEMS, '   ', ['go:packs'])), ['go:packs', 'go:plan', 'rec:a', 'acc:x']);
});

test('rankItems: unknown recent keys are ignored', () => {
  assert.deepEqual(keysOf(rankItems(ITEMS, '', ['zz:gone', 'go:packs'])), ['go:packs', 'go:plan', 'rec:a', 'acc:x']);
});

test('rankItems: a typed query filters to matches and orders by score', () => {
  const rows = rankItems(ITEMS, 'pla', []);
  assert.deepEqual(keysOf(rows), ['go:plan', 'rec:a']);
  for (const r of rows) {
    assert.equal(typeof r.score, 'number');
    assert.ok(Array.isArray(r.hits) && r.hits.length === 3);
    assert.equal(r.recent, false);
  }
});

test('rankItems: a recent match beats a non-recent one of equal or slightly higher score', () => {
  const items = [{ key: 'a', title: 'Plan one', group: 'G' }, { key: 'b', title: 'Plan two', group: 'G' }];
  assert.deepEqual(keysOf(rankItems(items, 'plan', [])), ['a', 'b']);
  const boosted = rankItems(items, 'plan', ['b']);
  assert.deepEqual(keysOf(boosted), ['b', 'a']);
  assert.equal(boosted[0].recent, true);
  const near = [{ key: 'x', title: 'Plan', group: 'G' }, { key: 'y', title: 'Plans', group: 'G' }];
  assert.deepEqual(keysOf(rankItems(near, 'plan', [])), ['x', 'y']);
  assert.deepEqual(keysOf(rankItems(near, 'plan', ['y'])), ['y', 'x']);
});

test('rankItems: ties keep input order', () => {
  const items = ['c', 'd', 'e'].map((k) => ({ key: k, title: 'Same title', group: 'G' }));
  assert.deepEqual(keysOf(rankItems(items, 'same', [])), ['c', 'd', 'e']);
});

/* ---------- createKeys ---------- */

function setup() {
  const clock = { t: 0 };
  const calls = [];
  const keys = createKeys({ now: () => clock.t });
  const b = (k, name, extra = {}) => ({ keys: [k], label: name, group: 'Test', action: (e) => calls.push([name, e]), ...extra });
  return { clock, calls, keys, b, names: () => calls.map((c) => c[0]) };
}

test('createKeys liveness: g then p on a non-typing target navigates', () => {
  const { keys, b, names } = setup();
  keys.register('global', [b('g p', 'plan')]);
  assert.equal(keys.handle(ev('g'), DIV), true);
  assert.equal(keys.handle(ev('p'), DIV), true);
  assert.deepEqual(names(), ['plan']);
});

test('createKeys: g then p within the 1.5 s window runs the sequence and clears the prefix', async () => {
  const { clock, keys, b, names } = setup();
  keys.register('global', [b('g p', 'plan')]);
  assert.equal(keys.handle(ev('g'), DIV), true);
  assert.equal(await keys.pending(), 'g');
  clock.t += 1400;
  assert.equal(keys.handle(ev('p'), DIV), true);
  assert.deepEqual(names(), ['plan']);
  assert.equal(await keys.pending(), '');
});

test('createKeys: after 1.6 s the prefix expires and p is handled fresh', async () => {
  const { clock, keys, b, names } = setup();
  keys.register('global', [b('g p', 'plan')]);
  keys.handle(ev('g'), DIV);
  clock.t += 1600;
  assert.equal(keys.handle(ev('p'), DIV), false);
  assert.deepEqual(names(), []);
  assert.equal(await keys.pending(), '');

  const s = setup();
  s.keys.register('global', [s.b('g p', 'plan'), s.b('p', 'single')]);
  s.keys.handle(ev('g'), DIV);
  s.clock.t += 1600;
  assert.equal(s.keys.handle(ev('p'), DIV), true);
  assert.deepEqual(s.names(), ['single']);
});

test('createKeys: g then an unbound key clears the prefix', async () => {
  const { keys, b, names } = setup();
  keys.register('global', [b('g p', 'plan')]);
  keys.handle(ev('g'), DIV);
  assert.equal(keys.handle(ev('z'), DIV), false);
  assert.equal(await keys.pending(), '');
  assert.equal(keys.handle(ev('p'), DIV), false);
  assert.deepEqual(names(), []);
});

test('createKeys: g then a key with its own binding runs that key fresh', async () => {
  const { keys, b, names } = setup();
  keys.register('global', [b('g p', 'plan'), b('j', 'next')]);
  keys.handle(ev('g'), DIV);
  assert.equal(keys.handle(ev('j'), DIV), true);
  assert.deepEqual(names(), ['next']);
  assert.equal(await keys.pending(), '');
});

test('createKeys: a first token with its own single binding runs it instead of waiting', async () => {
  const { keys, b, names } = setup();
  keys.register('global', [b('g', 'single'), b('g p', 'plan')]);
  assert.equal(keys.handle(ev('g'), DIV), true);
  assert.deepEqual(names(), ['single']);
  assert.equal(await keys.pending(), '');
});

test('createKeys: the action receives the event, repeat is allowed, composing and null keys are ignored', () => {
  const { calls, keys, b } = setup();
  keys.register('global', [b('j', 'next')]);
  const e = ev('j', { repeat: true });
  assert.equal(keys.handle(e, DIV), true);
  assert.equal(calls[0][1], e);
  assert.equal(keys.handle(ev('j', { isComposing: true }), DIV), false);
  assert.equal(keys.handle(ev('Shift', { shiftKey: true }), DIV), false);
  assert.equal(keys.handle(ev('j', { altKey: true }), DIV), false);
  assert.equal(calls.length, 1);
});

test('createKeys: screen scope wins over global for the same key', () => {
  const { keys, b, names } = setup();
  keys.register('global', [b('j', 'global-j')]);
  keys.register('plan', [b('j', 'plan-j')]);
  keys.setScreen('plan');
  assert.equal(keys.screen(), 'plan');
  keys.handle(ev('j'), DIV);
  keys.setScreen('ask');
  assert.equal(keys.screen(), 'ask');
  keys.handle(ev('j'), DIV);
  assert.deepEqual(names(), ['plan-j', 'global-j']);
});

test('createKeys: setScreen swaps scopes and an unregistered scope no longer fires', () => {
  const { keys, b, names } = setup();
  const off = keys.register('plan', [b('j', 'plan-j')]);
  keys.setScreen('ask');
  assert.equal(keys.handle(ev('j'), DIV), false);
  keys.setScreen('plan');
  assert.equal(keys.handle(ev('j'), DIV), true);
  off();
  assert.equal(keys.handle(ev('j'), DIV), false);
  assert.deepEqual(names(), ['plan-j']);
});

test('createKeys: when false skips the binding and lets global handle the key', () => {
  const { keys, b, names } = setup();
  let on = false;
  keys.register('plan', [b('a', 'accept', { when: () => on })]);
  keys.setScreen('plan');
  assert.equal(keys.handle(ev('a'), DIV), false);
  on = true;
  assert.equal(keys.handle(ev('a'), DIV), true);
  assert.deepEqual(names(), ['accept']);

  const s = setup();
  s.keys.register('global', [s.b('j', 'global-j')]);
  s.keys.register('plan', [s.b('j', 'plan-j', { when: () => false })]);
  s.keys.setScreen('plan');
  s.keys.handle(ev('j'), DIV);
  assert.deepEqual(s.names(), ['global-j']);
});

test('createKeys: the guard blocks g in an input but lets mod+k and escape through', async () => {
  const { keys, b, names } = setup();
  keys.register('global', [b('g p', 'plan'), b('mod+k', 'switcher'), b('escape', 'close')]);
  assert.equal(keys.handle(ev('g'), INPUT), false);
  assert.equal(await keys.pending(), '');
  assert.equal(keys.handle(ev('k', { ctrlKey: true }), INPUT), true);
  assert.equal(keys.handle(ev('Escape'), { isContentEditable: true }), true);
  assert.deepEqual(names(), ['switcher', 'close']);
});

test('createKeys: a typing target clears a pending prefix', async () => {
  const { keys, b, names } = setup();
  keys.register('global', [b('g p', 'plan')]);
  keys.handle(ev('g'), DIV);
  assert.equal(keys.handle(ev('p'), INPUT), false);
  assert.equal(await keys.pending(), '');
  assert.equal(keys.handle(ev('p'), DIV), false);
  assert.deepEqual(names(), []);
});

test('createKeys: active lists screen bindings then global, with scope and when applied', () => {
  const { keys, b } = setup();
  keys.register('global', [b('?', 'Shortcuts'), b('mod+k', 'Switcher', { when: () => false })]);
  keys.register('plan', [b('j', 'Next'), b('a', 'Accept', { when: () => false, sheetWhen: () => true })]);
  keys.register('ask', [b('c', 'Compose')]);
  keys.setScreen('plan');
  const act = keys.active();
  assert.deepEqual(act.map((x) => [x.scope, x.label]), [['plan', 'Next'], ['global', 'Shortcuts']]);
  const sheet = keys.active({ forSheet: true });
  assert.deepEqual(sheet.map((x) => [x.scope, x.label]), [['plan', 'Next'], ['plan', 'Accept'], ['global', 'Shortcuts']]);
});

test('createKeys: hintText formats keys for display', () => {
  const { keys } = setup();
  assert.equal(keys.hintText('g p'), 'G then P');
  assert.equal(keys.hintText('shift+x'), 'Shift+X');
  assert.equal(keys.hintText('mod+k'), 'Ctrl+K');
  assert.equal(keys.hintText('?'), '?');
  assert.equal(keys.hintText('arrowdown'), 'Down');
  assert.equal(keys.hintText('escape'), 'Esc');
  assert.equal(keys.hintText('enter'), 'Enter');
  assert.equal(keys.hintText('j'), 'J');
});

test('createKeys: handle with globalOnly skips the screen table and still runs global keys', () => {
  const { keys, b } = setup();
  const ran = [];
  keys.register('global', [{ ...b('?', 'Shortcuts'), action: () => ran.push('global') }]);
  keys.register('confirm', [{ ...b('1', 'Option 1'), action: () => ran.push('screen') }]);
  keys.setScreen('confirm');
  // A layer above the screen (the Ask panel) has focus: the screen's own keys stay out.
  assert.equal(keys.handle(ev('1'), DIV, { globalOnly: true }), false);
  assert.equal(keys.handle(ev('?'), DIV, { globalOnly: true }), true);
  assert.deepEqual(ran, ['global']);
  // Liveness: without the option the screen key still runs.
  assert.equal(keys.handle(ev('1'), DIV), true);
  assert.deepEqual(ran, ['global', 'screen']);
});

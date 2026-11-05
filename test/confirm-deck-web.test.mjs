// The Confirm deck's key table and the Year banner's copy, from the Horizon ingest screen module.
// The module is plain ESM with no DOM work at import, so node imports it directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_KEYS, deckBindings, quickCheckMinutes, quickChecksText, minutesText } from '../web/horizon/screens/ingest.js';
import { normalizeKey } from '../web/horizon/keys.js';

const EXPECTED = [
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => [key, 'pick']),
  ['Enter', 'guess'],
  ['j', 'next'], ['ArrowRight', 'next'],
  ['k', 'prev'], ['ArrowLeft', 'prev'],
  ['z', 'undo'], ['u', 'undo'],
  ['Escape', 'leave'],
];

test('DECK_KEYS is an array of {key, label, action} rows with nonempty labels', () => {
  assert.ok(Array.isArray(DECK_KEYS));
  assert.ok(DECK_KEYS.length > 0);
  for (const row of DECK_KEYS) {
    assert.equal(typeof row, 'object');
    assert.deepEqual(Object.keys(row).sort(), ['action', 'key', 'label'], JSON.stringify(row));
    assert.equal(typeof row.key, 'string');
    assert.equal(typeof row.action, 'string');
    assert.equal(typeof row.label, 'string');
    assert.ok(row.label.trim().length > 0, `label for ${row.key}`);
  }
});

test('DECK_KEYS covers exactly the pinned keys with their actions', () => {
  const keys = DECK_KEYS.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'no key appears twice');
  const actual = new Map(DECK_KEYS.map((r) => [r.key, r.action]));
  assert.deepEqual([...actual.keys()].sort(), EXPECTED.map(([k]) => k).sort());
  for (const [key, action] of EXPECTED) assert.equal(actual.get(key), action, `action for ${key}`);
});

test('DECK_KEYS has no G-prefix or help sheet keys', () => {
  const keys = DECK_KEYS.map((r) => r.key);
  for (const k of ['g', 'G', '?']) assert.ok(!keys.includes(k), `unexpected key ${k}`);
  assert.ok(!DECK_KEYS.some((r) => r.action === 'help' || r.action === 'go'));
});

// deckBindings: the deck keys as keyboard registry rows, one row per action, in this order.
const BINDINGS = [
  ['pick', ['1', '2', '3', '4', '5', '6', '7', '8', '9']],
  ['guess', ['enter']],
  ['next', ['j', 'arrowright']],
  ['prev', ['k', 'arrowleft']],
  ['undo', ['z', 'u']],
  ['leave', ['escape']],
];

function recorder() {
  const calls = [];
  const run = (name, e) => { calls.push([name, e]); };
  return { calls, run };
}

const ev = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test('deckBindings returns six Confirm rows with the pinned keys in order', () => {
  const { run } = recorder();
  const rows = deckBindings(run);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, BINDINGS.length);
  rows.forEach((row, i) => {
    assert.deepEqual(row.keys, BINDINGS[i][1], `keys of row ${i}`);
    assert.equal(row.group, 'Confirm', `group of row ${i}`);
    assert.equal(typeof row.label, 'string');
    assert.ok(row.label.trim().length > 0, `label of row ${i}`);
    assert.equal(typeof row.action, 'function', `action of row ${i}`);
    if (row.when !== undefined) assert.equal(typeof row.when, 'function', `when of row ${i}`);
    if (row.sheetWhen !== undefined) assert.equal(typeof row.sheetWhen, 'function', `sheetWhen of row ${i}`);
  });
  const all = rows.flatMap((r) => r.keys);
  assert.equal(new Set(all).size, all.length, 'no key is bound twice');
});

test('each deckBindings action calls run with its action name and the event', () => {
  const { calls, run } = recorder();
  const rows = deckBindings(run);
  rows.forEach((row, i) => {
    const e = { key: row.keys[0], marker: `event-${i}` };
    const before = calls.length;
    row.action(e);
    assert.equal(calls.length, before + 1, `row ${i} calls run once`);
    const [name, got] = calls[calls.length - 1];
    assert.equal(name, BINDINGS[i][0], `action name of row ${i}`);
    assert.equal(got, e, `row ${i} passes the event through`);
  });
});

test('deckBindings keys are in normalizeKey form', () => {
  const { run } = recorder();
  const keys = new Set(deckBindings(run).flatMap((r) => r.keys));
  const samples = [
    ev('Enter'), ev('ArrowRight'), ev('ArrowLeft'), ev('Escape'),
    ev('j'), ev('k'), ev('z'), ev('u'), ev('1'), ev('9'),
  ];
  for (const e of samples) {
    const k = normalizeKey(e);
    assert.ok(keys.has(k), `${e.key} normalizes to ${k}, which a row binds`);
  }
  for (const k of keys) {
    const e = ev(k.length === 1 ? k : k.replace(/^arrow(.)/, (m, c) => 'Arrow' + c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase()));
    assert.equal(normalizeKey(e), k, `binding key ${k} is its own normal form`);
  }
});

test('deckBindings binds neither g nor ?', () => {
  const { run } = recorder();
  const keys = deckBindings(run).flatMap((r) => r.keys);
  for (const k of ['g', 'G', '?', 'shift+g']) assert.ok(!keys.includes(k), `unexpected key ${k}`);
  assert.ok(!keys.some((k) => k.startsWith('g ')), 'no G sequence');
});

test('quickCheckMinutes is ceil(n * 5 / 60) with a minimum of 1', () => {
  assert.equal(quickCheckMinutes(0), 1);
  assert.equal(quickCheckMinutes(1), 1);
  assert.equal(quickCheckMinutes(12), 1);
  assert.equal(quickCheckMinutes(13), 2);
  assert.equal(quickCheckMinutes(61), 6);
});

test('quickChecksText pluralizes', () => {
  assert.equal(quickChecksText(1), '1 quick check');
  assert.equal(quickChecksText(61), '61 quick checks');
});

test('minutesText pluralizes the estimate', () => {
  assert.equal(minutesText(1), 'About 1 minute');
  assert.equal(minutesText(61), 'About 6 minutes');
});

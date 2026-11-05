// The Confirm deck's key table and the Year banner's copy, from the Horizon ingest screen module.
// The module is plain ESM with no DOM work at import, so node imports it directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_KEYS, quickCheckMinutes, quickChecksText, minutesText } from '../web/horizon/screens/ingest.js';

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

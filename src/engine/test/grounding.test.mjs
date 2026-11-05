import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGrounding } from '../grounding.mjs';

test('tool and stored values ground dollars, conventional rounding, compact amounts and percentages', () => {
  const data = [{ value: 12345.67 }, { rate: 0.153 }, { count: 3 }, { loss: -25 }];
  for (const text of ['$12,345.67', '$12,346', '$12.3k', '15.3%', 'three', '-$25']) {
    assert.equal(checkGrounding(text, { toolResults: data }).ok, true, text);
  }
  assert.equal(checkGrounding('$12,347', { toolResults: data }).ok, false);
  assert.equal(checkGrounding('153', { toolResults: data }).ok, false);
});

test('figure tokens must resolve and unknown years, dates, counts and spelled numbers are flagged', () => {
  assert.equal(checkGrounding('{f:tax} {fk:tax}', { figures: { tax: { v: 50 } } }).ok, true);
  assert.equal(checkGrounding('{f:invented}', { figures: {} }).ok, false);
  for (const prose of ['Save $999.', 'In 2027.', 'On 03/05.', 'twenty accounts']) {
    assert.equal(checkGrounding(prose, { toolResults: [{ value: 50 }] }).ok, false, prose);
  }
  assert.equal(checkGrounding('The year is 2026.', { data: { year: 2026 } }).ok, true);
});

test('grounding reports offsets and does not learn numbers from the prose being checked', () => {
  const result = checkGrounding('Budget $700 and 3 accounts.');
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2);
  assert.ok(result.violations.every(v => Number.isInteger(v.index)));
  assert.equal(checkGrounding('Ask the advisor.').ok, true);
});

test('compound numeric words are checked as an amount and Unicode minus retains sign', () => {
  assert.equal(checkGrounding('one hundred twenty-five', { data: { amount: 125 } }).ok, true);
  assert.equal(checkGrounding('twenty-three', { data: [20, 3] }).ok, false);
  assert.equal(checkGrounding('thirty', { data: [30] }).ok, true);
  assert.equal(checkGrounding('\u221225', { data: [25] }).ok, false);
  assert.equal(checkGrounding('\u221225', { data: [-25] }).ok, true);
  assert.equal(checkGrounding('.5', { data: [5] }).ok, false);
  assert.equal(checkGrounding('.5', { data: [0.5] }).ok, true);
  assert.equal(checkGrounding('1e3', { data: [1000] }).ok, true);
});

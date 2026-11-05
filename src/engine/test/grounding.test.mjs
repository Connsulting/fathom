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

test('figure tokens must resolve and unknown amounts, counts and spelled numbers are flagged', () => {
  assert.equal(checkGrounding('{f:tax} {fk:tax}', { figures: { tax: { v: 50 } } }).ok, true);
  assert.equal(checkGrounding('{f:invented}', { figures: {} }).ok, false);
  for (const prose of ['Save $999.', '75 accounts.', 'twenty accounts']) {
    assert.equal(checkGrounding(prose, { toolResults: [{ value: 50 }] }).ok, false, prose);
  }
  assert.equal(checkGrounding('The year is 2026.', { data: { year: 2026 } }).ok, true);
});

test('calculator input echoes cannot launder an invented amount', () => {
  const calculator = { value: 10, inputs: { invented: 98765 }, steps: [{ label: 'tax', formula: 'ignored', value: 10 }], lawRefs: [] };
  assert.equal(checkGrounding('$98,765', { toolResults: [{ args: { invented: 98765 }, result: calculator }] }).ok, false);
  assert.equal(checkGrounding('$10', { toolResults: [{ result: calculator }] }).ok, true);
  assert.equal(checkGrounding('$98,765', { toolResults: [{ result: { storedBalance: 98765 } }, { result: calculator }] }).ok, true);
});

test('ISO date components never become financial sources', () => {
  for (const text of ['$2,026', '$11', '$5']) {
    assert.equal(checkGrounding(text, { toolResults: [{ asOf: '2026-11-05T12:30:00Z' }] }).ok, false, text);
  }
});

test('compact K/M/B figures require matching magnitude and tightly bounded display rounding', () => {
  assert.equal(checkGrounding('$1M', { data: [600000] }).ok, false);
  assert.equal(checkGrounding('$1K', { data: [600] }).ok, false);
  assert.equal(checkGrounding('$2B', { data: [2] }).ok, false);
  assert.equal(checkGrounding('$2B', { data: [2000000000] }).ok, true);
  assert.equal(checkGrounding('$1M', { data: [999999] }).ok, true);
  assert.equal(checkGrounding('$1.23M', { data: [1234567] }).ok, true);
  assert.equal(checkGrounding('$1.23M', { data: [1240000] }).ok, false);
  assert.equal(checkGrounding('$2B', { toolResults: [{ balance: '$2B' }] }).ok, true);
});

test('a percentage requires a percentage source, rather than an unrelated number', () => {
  assert.equal(checkGrounding('15.3%', { data: [{ amount: 15.3 }, { amount: 0.153 }] }).ok, false);
  assert.equal(checkGrounding('15.3%', { data: [{ rate: 0.153 }] }).ok, true);
  assert.equal(checkGrounding('15.3%', { data: [{ value: 15.3, unit: 'percent' }] }).ok, true);
  assert.equal(checkGrounding('15.3%', { toolResults: [{ description: 'The stored rate is 15.3%.' }] }).ok, true);
  assert.equal(checkGrounding('15.3%', { data: { pct: { taxRate: 15.3 } } }).ok, true);
  assert.equal(checkGrounding('$50,000', { data: { corporate: 50000 } }).ok, true);
  assert.equal(checkGrounding('2026%').ok, false);
  assert.equal(checkGrounding('529%').ok, false);
});

test('tax identifiers, years and dates are vocabulary while nearby money still needs grounding', () => {
  const identifiers = ['401(k)', '401k', '403(b)', '457(b)', '529', 'W-2', 'W-4', '1099', '1099-NEC', '1099-DIV',
    'Form 1040', 'Form 1040-SR', 'Form 8606', 'Schedule A', 'Schedule SE', 'Schedule 1-A',
    'Section 199A(b)(3)(B)', 'IRC 401(k)(2)', '§ 223(b)(3)', 'subsection (b)(3)', '(b)(3)(B)',
    'Notice 2025-67', '2026', 'tax year 2027', 'For 2026', 'November 5, 2026', '5 November 2026', 'Nov 5th', '03/05/2026', '2026-11-05'];
  for (const text of identifiers) assert.equal(checkGrounding(text).ok, true, text);
  for (const text of ['$529', '$401k', '$2026', '$2,026', 'Form 1040 saves $999.', '3 accounts']) {
    assert.equal(checkGrounding(text).ok, false, text);
  }
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

test('a hyphen glued to a preceding letter or digit is not a minus sign, in the answer and in evidence', () => {
  // Answer side: K-12 is not -12.
  assert.ok(!checkGrounding('Private K-12 tuition can qualify.').violations.some(v => v.text.startsWith('-')));
  assert.equal(checkGrounding('Private K-12 tuition can qualify.', { data: [{ count: 12 }] }).ok, true);
  // Evidence side: K-12 and 2026-01 never yield a negative.
  for (const text of ['-12', '−12', '-$12']) {
    assert.equal(checkGrounding(text, { data: ['K-12'] }).ok, false, `K-12 grounds ${text}`);
    assert.equal(checkGrounding(text, { toolResults: [{ note: 'Private K-12 tuition can qualify.' }] }).ok, false, `K-12 prose grounds ${text}`);
  }
  for (const text of ['-1', '−1', '-$1']) {
    assert.equal(checkGrounding(text, { toolResults: [{ period: '2026-01' }] }).ok, false, `2026-01 grounds ${text}`);
  }
  // A real minus sign still reads as one on both sides.
  assert.equal(checkGrounding('a change of -12', { data: [{ change: -12 }] }).ok, true);
  assert.equal(checkGrounding('a change of -12', { data: [{ change: 12 }] }).ok, false);
  assert.equal(checkGrounding('-$12', { data: ['a change of -$12 this year'] }).ok, true);
  assert.equal(checkGrounding('-$25', { toolResults: [{ note: 'a loss of -$25' }] }).ok, true);
  assert.equal(checkGrounding('-$25', { toolResults: [{ note: 'a loss of $25' }] }).ok, false);
});

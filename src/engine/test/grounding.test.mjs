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

test('only recognized letter-code vocabulary is masked; arbitrary short codes are checked numbers', () => {
  for (const text of ['Your benefit is X-873 dollars.', 'Your benefit is AB-500 dollars.', 'You get Q-12 more.', 'The credit is ZZ-40 this year.']) {
    const result = checkGrounding(text);
    assert.equal(result.ok, false, text);
    assert.ok(!result.violations.some(v => v.text.startsWith('-')), `the glued hyphen is not a minus sign: ${text}`);
  }
  assert.deepEqual(checkGrounding('Your benefit is X-873 dollars.').violations.map(v => v.text), ['873']);
  assert.equal(checkGrounding('Your benefit is X-873 dollars.', { data: [873] }).ok, true);
  for (const text of ['K-12', 'K-1', 'I-9', 'W-2', 'W-4', '1099-K', 'Private K-12 tuition', 'Schedule K-1', 'Form I-9']) {
    assert.equal(checkGrounding(text).ok, true, text);
  }
});

test('a numeric expression in evidence is one quantity: exponents and decimals never split', () => {
  // literal() parses the exponent, so $1e3 in evidence is 1000.
  const evidence = [{ note: 'The allowance is $1e3.' }, { note: 'The fee is $4.50 a month.' }, { note: 'The rate is 12.5% now.' }];
  for (const text of ['$1,000', '$4.50', '12.5%']) assert.equal(checkGrounding(text, { toolResults: evidence }).ok, true, text);
  for (const text of ['$1', '$3', '$4', '50', '12%', '5%']) assert.equal(checkGrounding(text, { toolResults: evidence }).ok, false, text);
});

test('a worded magnitude is one quantity: 8.7 million grounds on 8700000, never on 8.7', () => {
  assert.equal(checkGrounding('about 8.7 million', { data: [8700000] }).ok, true);
  assert.equal(checkGrounding('about 8.7 million', { data: [8.7] }).ok, false);
});

test('a magnitude word followed by percent is one percent quantity and needs percent evidence', () => {
  const cases = [['1 thousand percent', 1000], ['2.5 million %', 2500000], ['3 billion percent', 3000000000]];
  for (const [text, value] of cases) {
    assert.equal(checkGrounding(text, { data: [value] }).ok, false, `${text} must not ground on the plain number`);
    assert.equal(checkGrounding(text, { data: [{ note: `The change is ${text}.` }] }).ok, true, `${text} grounds on matching percent text`);
  }
  assert.equal(checkGrounding('1 thousand percent', { data: [{ value: 1000, unit: 'percent' }] }).ok, true);
  assert.equal(checkGrounding('about 1 thousand percent', { data: [{ value: 1000 }] }).ok, false);
  // Plain scaled amounts and plain percents are unchanged.
  assert.equal(checkGrounding('$1 thousand', { data: [1000] }).ok, true);
  assert.equal(checkGrounding('12%', { data: [{ rate_pct: 12 }] }).ok, true);
  assert.equal(checkGrounding('12%', { data: [12] }).ok, false);
});

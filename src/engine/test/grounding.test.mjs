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

test('a spelled number followed by a percent sign is one percent quantity and needs percent evidence', () => {
  const cases = [['one thousand %', 1000], ['one thousand%', 1000], ['twenty %', 20], ['two million %', 2000000]];
  for (const [phrase, value] of cases) {
    const text = `The change is ${phrase}.`;
    assert.equal(checkGrounding(text, { data: [value] }).ok, false, `${phrase} must not ground on the plain number`);
    assert.equal(checkGrounding(text, { data: [{ value, unit: 'percent' }] }).ok, true, `${phrase} grounds on a percent unit`);
    assert.equal(checkGrounding(text, { data: [{ note: `The change is ${phrase}.` }] }).ok, true, `${phrase} grounds on matching percent text`);
  }
  assert.equal(checkGrounding('The change is one thousand %.', { data: [{ note: 'The change is one thousand percent.' }] }).ok, true);
  assert.equal(checkGrounding('The change is twenty %.', { data: [{ note: 'The change is 20%.' }] }).ok, true);
  // Existing word-number behavior is unchanged.
  assert.equal(checkGrounding('twenty percent', { data: [{ value: 20, unit: 'percent' }] }).ok, true);
  assert.equal(checkGrounding('one thousand', { data: [1000] }).ok, true);
});

const WORD_REASON = 'numeric word absent from sources';
const wordViolations = (prose, sources) => checkGrounding(prose, sources).violations.filter(v => v.reason === WORD_REASON);
const bullets = (count, marker = '-') => Array.from({ length: count }, (_, i) => `${marker} Item ${String.fromCharCode(97 + (i % 26))}${i >= 26 ? 'x' : ''}`).join('\n');
const numbered = (count, style = '.') => Array.from({ length: count }, (_, i) => `${i + 1}${style} Entry ${String.fromCharCode(97 + (i % 26))}`).join('\n');

test('a lone spelled count with no list after it is not structural and is still flagged, numerals included', () => {
  assert.equal(checkGrounding('three', { toolResults: [{ value: 50 }] }).ok, false);
  assert.deepEqual(wordViolations('There are three things to watch.', { toolResults: [{ value: 50 }] }).map(v => v.text), ['three']);
  assert.equal(checkGrounding('three', { toolResults: [{ count: 3 }] }).ok, true, 'a sourced count still grounds');
  for (const text of ['$12,345.67', '15.3%', '-$25']) assert.equal(checkGrounding(text).ok, false, `${text} is checked without sources`);
});

test('a spelled count equal to the bullet list that follows its paragraph is structural', () => {
  for (const marker of ['-', '*']) {
    assert.equal(checkGrounding(`There are three things to watch:\n\n${bullets(3, marker)}`).ok, true, `blank line, ${marker}`);
    assert.equal(checkGrounding(`There are three things to watch:\n${bullets(3, marker)}`).ok, true, `next line, ${marker}`);
  }
  assert.equal(checkGrounding(`There are three things to watch:\n\n${bullets(3)}\n\nThat is all.`).ok, true, 'text after the list');
});

test('a spelled count equal to a numbered list that follows its paragraph is structural', () => {
  for (const style of ['.', ')']) {
    assert.deepEqual(wordViolations(`There are three things to watch:\n\n${numbered(3, style)}`), [], `blank line, 1${style}`);
    assert.deepEqual(wordViolations(`There are three things to watch:\n${numbered(3, style)}`), [], `next line, 1${style}`);
  }
});

test('a spelled "one" before a one-item list is structural', () => {
  assert.equal(checkGrounding(`There is one thing to watch:\n\n${bullets(1)}`).ok, true);
  assert.equal(checkGrounding(`There is one thing to watch:\n${bullets(1)}`).ok, true);
  assert.equal(checkGrounding(`There is one thing to watch:\n\n${bullets(2)}`).ok, false, 'two items do not match one');
});

test('a spelled count that does not equal the list length is flagged', () => {
  for (const items of [2, 4]) {
    const result = checkGrounding(`There are three things to watch:\n\n${bullets(items)}`);
    assert.equal(result.ok, false, `${items} items`);
    assert.deepEqual(result.violations.map(v => [v.text, v.reason]), [['three', WORD_REASON]], `${items} items`);
  }
  assert.equal(checkGrounding(`There are three things to watch:\n\n${bullets(2)}`, { data: [3] }).ok, true, 'a sourced count still grounds');
});

test('a spelled count is flagged when another paragraph sits between it and the list', () => {
  const result = checkGrounding(`There are three things to watch.\n\nThe first matters most.\n\n${bullets(3)}`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(v => v.text), ['three']);
});

test('indented continuation lines inside a list item are not extra items', () => {
  const list = '- First item\n  continues on a second line\n  and a third line\n- Second item\n  more detail\n- Third item';
  assert.equal(checkGrounding(`There are three things to watch:\n\n${list}`).ok, true, 'three top-level items');
  assert.equal(checkGrounding(`There are five things to watch:\n\n${list}`).ok, false, 'continuations do not count toward five');
  const numberedList = '1. First entry\n   continues here\n2. Second entry\n   more here\n3. Third entry';
  assert.deepEqual(wordViolations(`There are three things to watch:\n\n${numberedList}`), []);
  assert.deepEqual(wordViolations(`There are five things to watch:\n\n${numberedList}`).map(v => v.text), ['five']);
});

test('scale and hundred words are never structural even when the count matches the list', () => {
  const cases = [['two hundred', 2], ['one hundred', 1], ['three thousand', 3], ['two million', 2]];
  for (const [phrase, items] of cases) {
    const prose = `There are ${phrase} things to watch:\n\n${bullets(items)}`;
    assert.equal(checkGrounding(prose).ok, false, `${phrase} before ${items} items`);
  }
  assert.equal(checkGrounding(`There are two hundred things to watch:\n\n${bullets(2)}`, { data: [200] }).ok, true);
  assert.equal(checkGrounding(`There are three thousand things to watch:\n\n${bullets(3)}`, { data: [3000] }).ok, true);
});

test('a spelled count followed by a money, percent, time or data-count unit is a figure claim, not structural', () => {
  const cases = [
    ['three', 'dollars', 3], ['three', 'percent', 3], ['three', 'years', 3], ['twelve', 'months', 12],
    ['two', 'accounts', 2], ['two', 'children', 2], ['three', 'transactions', 3], ['three', 'weeks', 3],
    ['three', 'hours', 3], ['three', 'payments', 3],
  ];
  for (const [word, unit, items] of cases) {
    const prose = `You have ${word} ${unit}:\n\n${bullets(items)}`;
    const value = items;
    const sourced = unit === 'percent' ? [{ value, unit: 'percent' }] : [value];
    const result = checkGrounding(prose);
    assert.equal(result.ok, false, `${word} ${unit} before ${items} items is flagged`);
    assert.deepEqual(result.violations.map(v => v.text), [word], `${word} ${unit}`);
    assert.equal(checkGrounding(prose, { data: sourced }).ok, true, `${word} ${unit} grounds when the value is in the sources`);
  }
});

test('the pronoun "one" and fixed phrases with "one" are not quantities', () => {
  const prose = [
    'A late-December birth gets the same credit as a January one.',
    'Take the one that fits.',
    'Use this one.',
    'Which one is better?',
    'Review each one.',
    'Pick any one.',
    'No one knows yet.',
    'One of the accounts is closed.',
    'Add one more.',
    'They help one another.',
    'Pick another one.',
  ];
  for (const text of prose) assert.equal(checkGrounding(text).ok, true, text);
});

test('"one" as a quantity is still checked: units, scales, compounds and the bare quantity', () => {
  const cases = [
    ['It takes one year.', 1],
    ['It costs one million.', 1e6],
    ['It costs one hundred.', 100],
    ['It costs twenty one.', 21],
    ['It costs one account.', 1],
    ['Take one.', 1],
  ];
  for (const [text, value] of cases) {
    assert.equal(checkGrounding(text).ok, false, `${text} is flagged without sources`);
    assert.equal(checkGrounding(text, { data: [value] }).ok, true, `${text} grounds when ${value} is in the sources`);
  }
  assert.equal(checkGrounding('The rate rose one percent.').ok, false);
  assert.equal(checkGrounding('The rate rose one percent.', { data: [{ value: 1, unit: 'percent' }] }).ok, true);
});

test('the structural-count rule is for spelled words only: a numeral count is still checked', () => {
  const prose = `There are 3 things to watch:\n\n${bullets(3)}`;
  const result = checkGrounding(prose);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(v => v.text), ['3']);
  assert.equal(checkGrounding(prose, { data: [3] }).ok, true);
});

test('a structural count does not hide an unsourced spelled figure elsewhere in the response', () => {
  const prose = `There are three things to watch:\n\n${bullets(3)}\n\nThe plan pays off in five months.`;
  const result = checkGrounding(prose);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(v => v.text), ['five']);
});

test('"one" after a determiner is a pronoun only with at most one non-verb word between', () => {
  for (const text of ['The total is one.', 'The answer is one.', 'The count equals one.', 'This is one.', 'That was one.', 'Each has one.', 'The result becomes one.']) {
    assert.equal(checkGrounding(text).ok, false, `${text} is a quantity`);
    assert.equal(checkGrounding(text, { data: [1] }).ok, true, `${text} grounds when 1 is in the sources`);
  }
  for (const text of ['Take the one that fits.', 'Pick the next one.', 'A late-December birth gets the same credit as a January one.', 'Which one is better?', 'No one knows yet.', 'Pick another one.', 'One of the accounts is closed.', 'Add one more.']) {
    assert.equal(checkGrounding(text).ok, true, text);
  }
});

test('a structural count must sit in the last sentence of a paragraph that ends with a colon', () => {
  for (const prose of [
    `Your reserve lasts three full years.\n\n${bullets(3)}`,
    `Your reserve lasts three years. Watch these:\n\n${bullets(3)}`,
    `There are three things. Watch these:\n\n${bullets(3)}`,
    `Here are three things\n\n${bullets(3)}`,
    `Here are three things\n${bullets(3)}`,
    `Here are three things.\n\n${bullets(3)}`,
  ]) {
    const result = checkGrounding(prose);
    assert.equal(result.ok, false, prose);
    assert.deepEqual(result.violations.map(v => v.text), ['three'], prose);
  }
  assert.equal(checkGrounding(`There are three things. Watch these:\n\n${bullets(3)}`, { data: [3] }).ok, true, 'a sourced count still grounds');
  for (const prose of [
    `There are three things to watch:\n\n${bullets(3)}`,
    `There are three things to watch:\n\n${numbered(3)}`,
    `There is one thing to watch:\n\n${bullets(1)}`,
    `There is one thing to watch:\n\n${numbered(1)}`,
    `The review is quick. There are three things to watch:\n\n${bullets(3)}`,
  ]) assert.deepEqual(wordViolations(prose), [], prose);
});

test('a unit word one word after the count still makes it a figure claim', () => {
  const cases = [['three', 'full years', 3], ['three', 'more accounts', 3], ['two', 'recent payments', 2]];
  for (const [word, rest, items] of cases) {
    const prose = `You have ${word} ${rest}:\n\n${bullets(items)}`;
    const result = checkGrounding(prose);
    assert.equal(result.ok, false, `${word} ${rest}`);
    assert.deepEqual(result.violations.map(v => v.text), [word], `${word} ${rest}`);
    assert.equal(checkGrounding(prose, { data: [items] }).ok, true, `${word} ${rest} grounds when the value is in the sources`);
  }
});

test('"one" is a pronoun only right after a determiner, or after one allowlisted adjective or capitalized word', () => {
  for (const text of ['That totals one.', 'The total is one.', 'This equals one.', 'The balance stays one.']) {
    assert.equal(checkGrounding(text).ok, false, `${text} is a quantity`);
    assert.equal(checkGrounding(text, { data: [1] }).ok, true, `${text} grounds when 1 is in the sources`);
  }
  for (const text of ['Take the one that fits.', 'A late-December birth gets the same credit as a January one.', 'Which one is better?', 'No one knows yet.', 'Pick another one.',
    'Pick the next one.', 'Use the same one.', 'Choose a different one.', 'Take the other one.', 'Pick the best one.', 'One of the accounts is closed.', 'Add one more.']) {
    assert.equal(checkGrounding(text).ok, true, text);
  }
});

test('any unit word between the count and the end of its paragraph denies the structural exemption', () => {
  for (const intro of [
    'Your reserve lasts three full calendar years:',
    'Your plan covers three of your accounts:',
    'There are three things to watch over the next month:',
  ]) {
    const prose = `${intro}\n\n${bullets(3)}`;
    const result = checkGrounding(prose);
    assert.equal(result.ok, false, intro);
    assert.deepEqual(result.violations.map(v => v.text), ['three'], intro);
    assert.equal(checkGrounding(prose, { data: [3] }).ok, true, `${intro} grounds when 3 is in the sources`);
  }
  assert.deepEqual(wordViolations(`There are three things to watch:\n\n${bullets(3)}`), []);
});

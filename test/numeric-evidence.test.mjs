import test from 'node:test';
import assert from 'node:assert/strict';
import { statedAmounts, requireEvidence } from '../src/actions/evidence.mjs';

test('SEC2: numeric evidence excludes identifier and date spans', () => {
  for (const text of [
    'account ending in 4821', 'account ending 4821', 'account last four 4821',
    'card ending with 4821', 'account ends in 4821', 'account ends with 4821',
    'the last four digits are 4821', 'the last 4 digits is 4821',
    'account 4821 (last4)', 'account (last4) 4821', 'account x4821',
    'account xx4821', 'account ****4821', 'account ...4821', 'account …4821',
    'account number 4821', 'routing number 4821', 'reference #4821',
    'account AB4821', 'account AB-4821', 'confirmation 4821', 'ID: 4821',
    'Form 4821', '401(k)', '529 account', 'W-2', '1099-NEC',
    'Due 2028-09-17', 'Due 09/17/2028', 'Due September 17, 2028',
    'Due 17 September 2028',
    '123-45-6789', '555-010-1234', '192.0.2.21',
  ]) assert.deepEqual(statedAmounts(text), [], text);
});

test('SEC2: amounts keep their sign, magnitude and percent units', () => {
  for (const text of ['-$4,821', '$-4,821', 'minus $4,821', 'MINUS $4,821', '−$4,821']) {
    assert.deepEqual(statedAmounts(text), [-4821], text);
  }
  assert.deepEqual(statedAmounts('Save $4.821k in account ending in 4821 by 2028-09-17'), [4821]);
  assert.deepEqual(statedAmounts('Save 4,821 dollars'), [4821]);
  assert.deepEqual(statedAmounts('Save 4.821 thousand'), [4821]);
  assert.deepEqual(statedAmounts('The rate is 4.821%'), [0.04821]);
  assert.deepEqual(statedAmounts('The target is 4821'), [4821]);
  assert.deepEqual(statedAmounts('Save $529 for the 529 account'), [529]);
  assert.deepEqual(statedAmounts('Save 529 dollars for the 529 account'), [529]);
});

test('SEC2: evidence excerpts cannot turn identifiers, date parts or partial quantities into numbers', () => {
  for (const [ownerText, evidence, value] of [
    ['account ending in 4821', '4821', 4821],
    ['Due September 17, 2028', '2028', 2028],
    ['Due 2028-09-17', '09', 9],
    ['The amount is -4821', '4821', 4821],
    ['The amount is $14,821', '4,821', 4821],
    ['The rate is 4821%', '4821', 4821],
    ['The amount is 4.821k', '4.821', 4.821],
  ]) assert.throws(async () => await requireEvidence({ ownerText }, value, { evidence }), /stated|evidence/, ownerText);
  assert.doesNotThrow(async () => await requireEvidence({ ownerText: 'account ending in 4821, target $4,821' }, 4821, { evidence: 'target $4,821' }));
});

test('SEC2: range separators preserve both bounds without reversing a loss', () => {
  for (const text of ['$4,000-$8,000', '$4,000 - $8,000', '4000-8000', '4000 - 8000']) {
    assert.deepEqual(statedAmounts(text), [4000, 8000], text);
  }
  assert.deepEqual(statedAmounts('-$4,000 to -$2,000'), [-4000, -2000]);
});

test('SEC2: map evidence retains key attribution and the shared numeric guard', () => {
  const shape = { type: 'map', values: { type: 'number', unit: 'USD' } };
  assert.doesNotThrow(async () => await requireEvidence({ ownerText: 'Rental income is $4,821.' }, { rental: 4821 }, { shape }));
  assert.throws(async () => await requireEvidence({ ownerText: 'Rental account ending in 4821.' }, { rental: 4821 }, { shape }), /stated/);
  assert.throws(async () => await requireEvidence({ ownerText: 'Income is $4,821.' }, { rental: 4821 }, { shape }), /stated/);
});

test('SEC2: a generic number phrase is evidence while labelled identifier numbers are excluded', () => {
 assert.deepEqual(statedAmounts('Use the number 5000 for the target'),[5000]);
 assert.doesNotThrow(async ()=>await requireEvidence({ownerText:'Use the number 5000 for the target'},5000));
 for(const text of ['invoice number 12','account number 5000','routing number 5000','policy number 5000','reference number 5000','ID number 5000']) {
  assert.deepEqual(statedAmounts(text),[],text);
  assert.throws(async ()=>await requireEvidence({ownerText:text},Number(text.match(/\d+/)[0])),/stated/);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { statedAmounts, requireEvidence } from '../src/actions/evidence.mjs';

test('SEC2: numeric evidence excludes identifier and date spans', () => {
  for (const text of [
    'account ending in 4821', 'account ending 4821', 'account last four 4821',
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
  ]) assert.throws(() => requireEvidence({ ownerText }, value, { evidence }), /stated|evidence/, ownerText);
  assert.doesNotThrow(() => requireEvidence({ ownerText: 'account ending in 4821, target $4,821' }, 4821, { evidence: 'target $4,821' }));
});

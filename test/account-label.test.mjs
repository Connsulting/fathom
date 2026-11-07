import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAccountLabel, accountLabel, accountSubtitle, duplicateMasks, validateDisplayName } from '../src/shared/account-label.mjs';

const names = { me: 'Avery Example', spouse: 'Blair Example' };

test('default labels drop repeated masks, slugs, manual, generic brokerage and holder names', () => {
  assert.equal(defaultAccountLabel({ inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking' }), 'Chase checking');
  assert.equal(defaultAccountLabel({ name: 'business-operating' }), 'Business operating');
  assert.equal(defaultAccountLabel({ name: 'personal-checking' }), 'Personal checking');
  assert.equal(defaultAccountLabel({ name: 'Manual' }), 'Account');
  assert.equal(defaultAccountLabel({ inst: 'Harbor', name: 'Individual - TOD', kind: 'taxable', mask: '2290' }), 'Harbor brokerage');
  assert.equal(defaultAccountLabel({ inst: 'Harbor', name: 'Individual - 529 - TOD', kind: '529', mask: '1042' }), 'Harbor 529');
  assert.equal(defaultAccountLabel({
    inst: 'Harbor', name: 'Avery Example and Blair Example', kind: 'checking', mask: '4455', householdNames: names,
  }), 'Harbor checking');
  assert.equal(accountSubtitle({ inst: '', owner: 'Business' }), 'Business');
  assert.equal(accountSubtitle({ inst: ',', owner: 'Business' }), 'Business');
  assert.equal(accountSubtitle({ inst: 'Harbor', owner: '' }), 'Harbor');
});

test('an owner display name wins, and clearing it returns the default', () => {
  const row = { inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking', display_name: 'Household cash' };
  assert.equal(accountLabel(row), 'Household cash');
  assert.equal(accountLabel({ ...row, display_name: null }), 'Chase checking');
  assert.equal(accountLabel({ ...row, displayName: '   ' }), 'Chase checking');
});

test('display names use the goal title rules', () => {
  assert.deepEqual(validateDisplayName('  Household cash  '), { ok: true, value: 'Household cash' });
  assert.deepEqual(validateDisplayName(''), { ok: true, value: null });
  assert.deepEqual(validateDisplayName(null), { ok: true, value: null });
  assert.equal(validateDisplayName('x'.repeat(121)).ok, false);
  assert.equal(validateDisplayName('line\nbreak').ok, false);
});

test('a mask the bridge is not sure about is left out of the composed label', () => {
  assert.equal(defaultAccountLabel({ inst: 'Chase', name: 'Checking', kind: 'checking', mask: '2738', maskSure: false }), 'Checking');
});

test('the label is the custom name, whatever the last 4', () => {
  const row = { inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455' };
  assert.equal(accountLabel({ ...row, displayName: 'Household cash' }), 'Household cash');
  assert.equal(accountLabel({ ...row, display_name: 'Household cash' }), 'Household cash');
});

test('the label is the default name when none is set, with no ending suffix', () => {
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455' }), 'Everyday checking');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Rollover IRA', kind: 'retirement', mask: '1042' }), 'Rollover IRA');
  assert.equal(accountLabel({ inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking' }), 'Chase checking');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Individual - TOD', kind: 'taxable', mask: '2290' }), 'Harbor brokerage');
  assert.equal(accountLabel({ name: 'Manual', mask: '2290' }), 'Account');
  assert.doesNotMatch(accountLabel({ inst: 'Harbor', name: 'Individual - 529 - TOD', kind: '529', mask: '1042' }), /ending|1042/);
});

test('a name that already contains the digits is left as it is', () => {
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking 4455', kind: 'checking', mask: '4455' }), 'Everyday checking 4455');
  assert.equal(accountLabel({ name: 'Everyday checking', mask: '4455', displayName: 'Reserve 4455', labelMask: '4455' }), 'Reserve 4455');
});

test('a duplicate-name pair gets the last 4 as "Name (1234)", and only that pair', () => {
  const a = { id: 'a', inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455' };
  const b = { id: 'b', inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '9981' };
  const c = { id: 'c', inst: 'Harbor', name: 'Rollover IRA', kind: 'retirement', mask: '1042' };
  const masks = duplicateMasks([a, b, c]);
  assert.deepEqual([...masks], [['a', '4455'], ['b', '9981']]);
  assert.equal(accountLabel({ ...a, labelMask: masks.get('a') }), 'Everyday checking (4455)');
  assert.equal(accountLabel({ ...b, labelMask: masks.get('b') }), 'Everyday checking (9981)');
  assert.equal(accountLabel({ ...c, labelMask: masks.get('c') }), 'Rollover IRA');
});

test('a custom name that matches another account duplicates it too, case and spacing aside', () => {
  const a = { id: 'a', name: 'Everyday checking', mask: '4455', displayName: 'Household cash' };
  const b = { id: 'b', name: 'Savings', mask: '9981', display_name: ' household  cash ' };
  assert.deepEqual([...duplicateMasks([a, b])], [['a', '4455'], ['b', '9981']]);
});

test('an unsure mask is never added, even to a duplicate', () => {
  const a = { id: 'a', inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455', maskSure: false };
  const b = { id: 'b', inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '9981' };
  const masks = duplicateMasks([a, b]);
  assert.deepEqual([...masks], [['b', '9981']]);
  assert.equal(accountLabel({ ...a, labelMask: masks.get('a') }), 'Everyday checking');
});

test('no mask, or a mask that is not four digits, adds nothing', () => {
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking' }), 'Everyday checking');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: null, displayName: 'Household cash' }), 'Household cash');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '' }), 'Everyday checking');
  const a = { id: 'a', name: 'Checking', mask: '12' };
  const b = { id: 'b', name: 'Checking' };
  assert.equal(duplicateMasks([a, b]).size, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAccountLabel, accountLabel, accountSubtitle, validateDisplayName } from '../src/shared/account-label.mjs';

const names = { me: 'Avery Example', spouse: 'Blair Example' };

test('default labels drop repeated masks, slugs, manual, generic brokerage and holder names', () => {
  assert.equal(defaultAccountLabel({ inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking' }), 'Chase checking ending 2738');
  assert.equal(defaultAccountLabel({ name: 'business-operating' }), 'Business operating');
  assert.equal(defaultAccountLabel({ name: 'personal-checking' }), 'Personal checking');
  assert.equal(defaultAccountLabel({ name: 'Manual' }), 'Account');
  assert.equal(defaultAccountLabel({ inst: 'Harbor', name: 'Individual - TOD', kind: 'taxable', mask: '2290' }), 'Harbor brokerage ending 2290');
  assert.equal(defaultAccountLabel({ inst: 'Harbor', name: 'Individual - 529 - TOD', kind: '529', mask: '1042' }), 'Harbor 529 ending 1042');
  assert.equal(defaultAccountLabel({
    inst: 'Harbor', name: 'Avery Example and Blair Example', kind: 'checking', mask: '4455', householdNames: names,
  }), 'Harbor checking ending 4455');
  assert.equal(accountSubtitle({ inst: '', owner: 'Business' }), 'Business');
  assert.equal(accountSubtitle({ inst: ',', owner: 'Business' }), 'Business');
  assert.equal(accountSubtitle({ inst: 'Harbor', owner: '' }), 'Harbor');
});

test('an owner display name wins, and clearing it returns the default', () => {
  const row = { inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking', display_name: 'Household cash' };
  assert.equal(accountLabel(row), 'Household cash ending 2738');
  assert.equal(accountLabel({ ...row, display_name: null }), 'Chase checking ending 2738');
  assert.equal(accountLabel({ ...row, displayName: '   ' }), 'Chase checking ending 2738');
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

test('AC1: a custom display name gets the sure last four once', () => {
  const row = { inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455' };
  assert.equal(accountLabel({ ...row, displayName: 'Household cash' }), 'Household cash ending 4455');
  assert.equal(accountLabel({ ...row, display_name: 'Household cash' }), 'Household cash ending 4455');
});

test('AC1: a good imported name without the digits gets the ending suffix', () => {
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455' }), 'Everyday checking ending 4455');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Rollover IRA', kind: 'retirement', mask: '1042' }), 'Rollover IRA ending 1042');
});

test('AC1: a name that already contains the digits is not suffixed twice', () => {
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking 4455', kind: 'checking', mask: '4455' }), 'Everyday checking 4455');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455', displayName: 'Reserve 4455' }), 'Reserve 4455');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455', displayName: 'Reserve ending 4455' }), 'Reserve ending 4455');
});

test('AC1: a mask the bridge is not sure about adds nothing', () => {
  const row = { inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455', maskSure: false };
  assert.equal(accountLabel(row), 'Everyday checking');
  assert.equal(accountLabel({ ...row, displayName: 'Household cash' }), 'Household cash');
});

test('AC1: no mask, or a mask that is not four digits, adds nothing', () => {
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking' }), 'Everyday checking');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: null, displayName: 'Household cash' }), 'Household cash');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '' }), 'Everyday checking');
});

test('AC1: composed labels that already say ending are unchanged', () => {
  assert.equal(defaultAccountLabel({ inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking' }), 'Chase checking ending 2738');
  assert.equal(accountLabel({ inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking' }), 'Chase checking ending 2738');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Individual - TOD', kind: 'taxable', mask: '2290' }), 'Harbor brokerage ending 2290');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Individual - 529 - TOD', kind: '529', mask: '1042' }), 'Harbor 529 ending 1042');
});

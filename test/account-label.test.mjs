import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDb } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { accountNaming } from '../src/accounts/naming.mjs';
import { accountLabels } from '../src/pnl/shared.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { defaultAccountLabel, accountLabel, accountSubtitle, accountLabelParts, composeLabel, validateDisplayName } from '../src/shared/account-label.mjs';

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
  assert.equal(accountLabel(row), 'Household cash (2738)');
  assert.equal(accountLabel({ ...row, display_name: null }), 'Chase checking (2738)');
  assert.equal(accountLabel({ ...row, displayName: '   ' }), 'Chase checking (2738)');
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

const base = { inst: 'Harbor', name: 'Everyday checking', kind: 'checking', mask: '4455' };

test('the label is the account name and its sure last 4, never "ending"', () => {
  assert.equal(accountLabel(base), 'Everyday checking (4455)');
  assert.equal(accountLabel({ ...base, displayName: 'Household cash' }), 'Household cash (4455)');
  assert.equal(accountLabel({ ...base, display_name: 'Household cash' }), 'Household cash (4455)');
  assert.equal(accountLabel({ inst: 'Chase', name: 'Chase 2738 2738', mask: '2738', kind: 'checking' }), 'Chase checking (2738)');
  assert.equal(accountLabel({ inst: 'Harbor', name: 'Individual - TOD', kind: 'taxable', mask: '2290' }), 'Harbor brokerage (2290)');
  assert.equal(accountLabel({ name: 'Manual', mask: '2290' }), 'Account (2290)');
  assert.doesNotMatch(accountLabel({ inst: 'Harbor', name: 'Individual - 529 - TOD', kind: '529', mask: '1042' }), /ending/);
});

test('an unsure, missing or malformed mask adds no last 4', () => {
  assert.equal(accountLabel({ ...base, maskSure: false }), 'Everyday checking');
  assert.equal(accountLabel({ ...base, maskSure: false, displayName: 'Household cash' }), 'Household cash');
  assert.equal(accountLabel({ ...base, mask: null }), 'Everyday checking');
  assert.equal(accountLabel({ ...base, mask: '' , displayName: 'Household cash' }), 'Household cash');
  assert.equal(accountLabel({ ...base, mask: '12' }), 'Everyday checking');
});

test('a name that already carries the digits does not get them twice', () => {
  assert.equal(accountLabel({ ...base, name: 'Everyday checking 4455' }), 'Everyday checking 4455');
  assert.equal(accountLabel({ ...base, displayName: 'VentureX (4455)' }), 'VentureX (4455)');
});

test('the owner prefix is the possessive first name from the household names', () => {
  assert.equal(accountLabel({ ...base, owner: 'You', householdNames: names, displayName: 'VentureX' }), "Avery's VentureX (4455)");
  assert.equal(accountLabel({ ...base, owner: 'owner', householdNames: names, displayName: 'VentureX' }), "Avery's VentureX (4455)");
  assert.equal(accountLabel({ ...base, owner: 'Your spouse', householdNames: names, displayName: 'VentureX' }), "Blair's VentureX (4455)");
  assert.equal(accountLabel({ ...base, owner: 'Blair Example', householdNames: names, displayName: 'VentureX' }), "Blair's VentureX (4455)");
  assert.equal(accountLabel({ ...base, owner: 'Avery', householdNames: names }), "Avery's Everyday checking (4455)");
});

test('a joint account is prefixed Joint, and a business account by its business name when on file', () => {
  assert.equal(accountLabel({ ...base, owner: 'Joint', householdNames: names, displayName: 'Savings' }), 'Joint Savings (4455)');
  assert.equal(accountLabel({ ...base, owner: 'Household', displayName: 'Savings' }), 'Joint Savings (4455)');
  assert.equal(accountLabel({ ...base, owner: 'Business', businessName: 'Sample Studio LLC', displayName: 'Operating' }), 'Sample Studio LLC Operating (4455)');
  assert.equal(accountLabel({ ...base, owner: 'Business', displayName: 'Operating' }), 'Operating (4455)', 'no business on file, no prefix');
});

test('an unknown owner, or a person with no stored name, gets no prefix', () => {
  assert.equal(accountLabel({ ...base, displayName: 'VentureX' }), 'VentureX (4455)');
  assert.equal(accountLabel({ ...base, owner: 'Someone Else', householdNames: names, displayName: 'VentureX' }), 'VentureX (4455)');
  assert.equal(accountLabel({ ...base, owner: 'You', displayName: 'VentureX' }), 'VentureX (4455)', 'no household names stored');
});

test('a custom name that already starts with the owner prefix is not prefixed twice', () => {
  const row = { ...base, owner: 'You', householdNames: names };
  assert.equal(accountLabel({ ...row, displayName: "Avery's Venture One" }), "Avery's Venture One (4455)");
  assert.equal(accountLabel({ ...row, displayName: 'Avery\u2019s Venture One' }), 'Avery\u2019s Venture One (4455)');
  assert.equal(accountLabel({ ...row, displayName: "avery's venture one" }), "avery's venture one (4455)");
  assert.equal(accountLabel({ ...row, owner: 'Joint', displayName: 'Joint Savings' }), 'Joint Savings (4455)');
  assert.equal(accountLabel({ ...row, displayName: 'Averys Venture' }), "Avery's Averys Venture (4455)", 'a longer word is not the prefix');
});

test('the demo owner tokens stay tokens for the screen to resolve', () => {
  assert.equal(accountLabel({ ...base, owner: '{n:me}', displayName: 'SEP-IRA' }), "{n:me}'s SEP-IRA (4455)");
  assert.equal(accountLabel({ ...base, owner: '{n:spouse}', name: '{n:spouse}\u2019s checking' }), '{n:spouse}\u2019s checking (4455)');
  assert.equal(accountLabel({ ...base, owner: '{n:biz}', displayName: 'Operating' }), '{n:biz} Operating (4455)');
});

test('a caller that already worked out the prefix passes labelPrefix', () => {
  assert.equal(accountLabel({ ...base, owner: 'You', labelPrefix: "Sam's", displayName: 'VentureX' }), "Sam's VentureX (4455)");
  assert.equal(accountLabel({ ...base, owner: 'You', householdNames: names, labelPrefix: '', displayName: 'VentureX' }), 'VentureX (4455)');
});

test('label parts give a screen the bare name to edit and the pieces of the whole label', () => {
  const row = { ...base, owner: 'You', householdNames: names, displayName: 'VentureX' };
  assert.deepEqual(accountLabelParts(row), { labelPrefix: "Avery's", baseName: 'VentureX', labelMask: '4455' });
  assert.deepEqual(accountLabelParts({ ...base, maskSure: false }), { labelPrefix: '', baseName: 'Everyday checking', labelMask: '' });
  assert.equal(composeLabel("Avery's", 'Typed name', '4455'), "Avery's Typed name (4455)");
  assert.equal(composeLabel('', 'Typed name', ''), 'Typed name');
});

test('the demo store names accounts with resolved owner names, before and after a rename', async (t) => {
  const s = await tempDb();
  t.after(() => s.close());
  await seedDemo(s.db);
  const label = async (id) => accountLabel((await accountNaming(s.db)).byId.get(id));
  assert.equal(await label('a_biz'), 'Northbeam Labs Business checking (1918)');
  assert.equal(await label('a_bsep'), "Alex's SEP-IRA (3657)");
  assert.equal(await label('a_jsep'), "Sam's SEP-IRA (3276)");
  assert.equal(await label('a_personal'), 'Joint checking (6643)');
  assert.equal(await label('a_jcash'), 'Sam\u2019s checking', 'a name that starts with the prefix is not doubled');

  await s.db.prepare("UPDATE accounts SET display_name = 'Studio operating' WHERE id = 'a_biz'").run();
  await s.db.prepare("UPDATE accounts SET display_name = 'Retirement' WHERE id = 'a_bsep'").run();
  const naming = await accountNaming(s.db);
  const raw = await s.db.prepare("SELECT * FROM accounts WHERE id = 'a_biz'").get();
  assert.equal(await label('a_biz'), 'Northbeam Labs Studio operating (1918)');
  assert.equal(await label('a_bsep'), "Alex's Retirement (3657)");
  assert.equal(naming.label(raw), 'Northbeam Labs Studio operating (1918)', 'a raw row with the stored tokens reads the same');
  assert.equal((await accountLabels(s.db)).get('a_biz').label, 'Northbeam Labs Studio operating (1918)');
  const scenario = await buildScenario(s.db, {});
  assert.equal(scenario.accounts.find((a) => a.id === 'a_biz').name, 'Northbeam Labs Studio operating (1918)');
  for (const a of scenario.accounts) assert.doesNotMatch(a.name, /[{}]|ending/, `${a.id} has no token in its label`);
});

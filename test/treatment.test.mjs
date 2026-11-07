import test from 'node:test';
import assert from 'node:assert/strict';
import { KIND_OPTIONS } from '../src/ingest/confirm.mjs';
import { INVESTMENT_KINDS } from '../src/calc/targets.mjs';
import {
  ACCOUNT_TREATMENT, EMPLOYER_PLAN_TYPES, ACCESS_RULES, rmdStartAge,
} from '../src/calc/treatment.mjs';

const PLAN_TYPES = ['traditional_ira', 'roth_ira', 'sep_ira', '401k', 'roth_401k', 'solo_401k',
  '403b', '457b', 'hsa', '529', 'taxable'];

test('rmdStartAge returns 72, 73 and 75 for 1950, 1955 and 1965', () => {
  assert.equal(rmdStartAge('1949-06-30'), 70.5);
  assert.equal(rmdStartAge('1949-07-01'), 72);
  assert.equal(rmdStartAge('1950-06-15'), 72);
  assert.equal(rmdStartAge('1955-01-01'), 73);
  assert.equal(rmdStartAge('1965-12-31'), 75);
  assert.equal(rmdStartAge.packRef.pack, 'account-tax-treatment');
  assert.equal(rmdStartAge.packRef.entry, 'required-minimum-distributions');
});

test('every kind and plan type maps to a treatment', () => {
  for (const { id } of KIND_OPTIONS) {
    assert.equal(typeof ACCOUNT_TREATMENT.byKind[id].id, 'string', id);
    assert.equal(ACCOUNT_TREATMENT.byKind[id].packRef.pack, 'account-tax-treatment');
  }
  for (const kind of INVESTMENT_KINDS) {
    assert.equal(typeof ACCOUNT_TREATMENT.byKind[kind].id, 'string', kind);
  }
  assert.equal(ACCOUNT_TREATMENT.byKind.retirement.id, 'needs plan type');
  assert.equal(ACCOUNT_TREATMENT.byKind.ira.id, 'needs plan type');
  for (const planType of PLAN_TYPES) {
    assert.equal(typeof ACCOUNT_TREATMENT.byPlanType[planType].id, 'string', planType);
    assert.notEqual(ACCOUNT_TREATMENT.byPlanType[planType].id, 'needs plan type');
  }
  assert.deepEqual([...EMPLOYER_PLAN_TYPES], ['401k', 'roth_401k', 'solo_401k', '403b', '457b']);
  assert.equal(EMPLOYER_PLAN_TYPES.packRef.entry, 'penalty-free-access');
  assert.equal(ACCESS_RULES.penaltyFreeAge.years, 59);
  assert.equal(ACCESS_RULES.penaltyFreeAge.months, 6);
  assert.equal(ACCESS_RULES.ruleOf55.years, 55);
  assert.equal(ACCESS_RULES.governmental457b.planType, '457b');
  assert.equal(ACCESS_RULES.governmental457b.needsFact, 'governmental');
  assert.equal(ACCESS_RULES.governmental457b.additionalTaxAfterSeparation, false);
  assert.equal(ACCESS_RULES.governmental457b.rolledInExcepted, true);
  assert.equal(ACCESS_RULES.governmental457b.packRef.entry, 'penalty-free-access');
  assert.equal(ACCESS_RULES.fiveYear.years, 5);
  assert.equal(ACCESS_RULES.hsaAnyUse.years, 65);
  assert.equal(ACCESS_RULES.hsaAdditionalTax.rate, 0.2);
});

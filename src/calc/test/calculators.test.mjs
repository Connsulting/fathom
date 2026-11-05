import assert from 'node:assert/strict';
import test from 'node:test';
import {
  federalIncomeTax, payrollTax, selfEmploymentTax, solo401kRoom, sepRoom,
  estimatedPaymentSafeHarbor, virginiaIncomeTax, hsaLimit, dependentCareLimit,
  qbiDeduction, sCorpSalaryTradeoff,
} from '../index.mjs';

const confirmed = { planConfirmed: true, aggregationConfirmed: true };

test('federal brackets match hand-computed 2026 tax tables for every status', () => {
  for (const [filingStatus, taxableIncome, expected] of [
    ['single', 50400, 5800], ['mfj', 100800, 11600],
    ['mfs', 50400, 5800], ['hoh', 67450, 7740], ['qss', 100800, 11600],
    ['single', 105700, 17966], ['mfj', 768700, 206583.50],
    ['single', 12400.01, 1240], ['single', 0, 0],
  ]) assert.equal(federalIncomeTax({ filingStatus, taxableIncome }).value, expected);
  assert.equal(federalIncomeTax({ taxableIncome: 50401 }).value, 5800.22);
});

test('each public calculator carries input snapshots, calculation steps and primary law references', () => {
  const inputs = { taxableIncome: 20000, filingStatus: 'single' };
  const result = federalIncomeTax(inputs);
  assert.deepEqual(Object.keys(result).sort(), ['inputs', 'lawRefs', 'steps', 'value']);
  assert.ok(result.steps.length > 0);
  assert.ok(result.lawRefs.every(ref => ref.url.startsWith('https://') && ref.taxYear === 2026));
  inputs.taxableIncome = 1;
  assert.equal(result.inputs.taxableIncome, 20000);
  assert.deepEqual(result, federalIncomeTax({ taxableIncome: 20000, filingStatus: 'single' }));
});

test('invalid and unsupported tax inputs fail before figures are produced', () => {
  for (const taxableIncome of [-1, NaN, Infinity, '100', null]) {
    assert.throws(() => federalIncomeTax({ taxableIncome }), /taxableIncome/);
  }
  assert.throws(() => federalIncomeTax({ taxableIncome: 1, taxYear: 2025 }), /2026/);
  assert.throws(() => federalIncomeTax({ taxableIncome: 1, filingStatus: 'unknown' }), /filingStatus/);
});

test('payroll distinguishes employer withholding from household additional Medicare liability', () => {
  const low = payrollTax({ wages: 100000 }).value;
  assert.equal(low.employeeSocialSecurity, 6200);
  assert.equal(low.employeeMedicare, 1450);
  assert.equal(low.total, 15300);
  const high = payrollTax({ wages: 260000, filingStatus: 'mfj' }).value;
  assert.equal(high.employeeSocialSecurity, 11439);
  assert.equal(high.employerSocialSecurity, 11439);
  assert.equal(high.additionalMedicare, 90);
  assert.equal(high.additionalMedicareWithholding, 540);
  assert.equal(high.employerTotal, 15209);
  assert.equal(payrollTax({ wages: 10000, priorSocialSecurityWages: 180000 }).value.employeeSocialSecurity, 279);
  assert.equal(payrollTax({ wages: 10000, priorSocialSecurityWages: 184500 }).value.employeeSocialSecurity, 0);
  assert.equal(payrollTax({ wages: 10000, spouseMedicareWages: 250000, filingStatus: 'mfj' }).value.additionalMedicare, 90);
});

test('self-employment uses 92.35%, wage-base coordination and excludes additional tax from half deduction', () => {
  const v = selfEmploymentTax({ netProfit: 100000 }).value;
  assert.equal(v.taxableEarnings, 92350);
  assert.equal(v.socialSecurity, 11451.40);
  assert.equal(v.medicare, 2678.15);
  assert.equal(v.total, 14129.55);
  assert.equal(v.deductibleHalf, 7064.78);
  assert.equal(selfEmploymentTax({ netProfit: 400 }).value.total, 0);
  assert.ok(selfEmploymentTax({ netProfit: 434 }).value.total > 0);
  const w = selfEmploymentTax({ netProfit: 100000, w2SocialSecurityWages: 184500, w2MedicareWages: 200000 }).value;
  assert.equal(w.socialSecurity, 0);
  assert.equal(w.additionalMedicare, 831.15);
  assert.equal(w.deductibleHalf, 1339.08);
});

test('Solo 401(k) room respects all-plan deferrals, annual additions, compensation and catch-ups', () => {
  assert.deepEqual(solo401kRoom({ ...confirmed, compensation: 100000, age: 40 }).value,
    { employee: 24500, employer: 25000, catchUp: 0, total: 49500, rothCatchUp: 0 });
  const v = solo401kRoom({ ...confirmed, compensation: 300000, age: 61, priorYearSponsorWages: 160000 }).value;
  assert.equal(v.employee, 24500);
  assert.equal(v.employer, 47500);
  assert.equal(v.catchUp, 11250);
  assert.equal(v.total, 83250);
  assert.equal(v.rothCatchUp, 11250);
  const shared = solo401kRoom({ ...confirmed, compensation: 100000, age: 51, allPlanDeferrals: 20000 }).value;
  assert.equal(shared.employee, 4500);
  assert.equal(shared.catchUp, 8000);
  const low = solo401kRoom({ ...confirmed, compensation: 10000, age: 40, kind: 'self-employed' }).value;
  assert.equal(low.employee, 10000);
  assert.equal(low.employer, 0);
  assert.equal(solo401kRoom({ ...confirmed, compensation: 100000, age: 40, allPlanDeferrals: 24500 }).value.employee, 0);
  assert.throws(() => solo401kRoom({ compensation: 100000, age: 40 }), /confirmed/);
});

test('SEP room has hand-checked employee, self-employed, annual-cap and low-income cases', () => {
  assert.equal(sepRoom({ ...confirmed, kind: 'w2', compensation: 100000 }).value, 25000);
  assert.equal(sepRoom({ ...confirmed, kind: 'self-employed', netProfit: 100000 }).value, 18587.04);
  assert.equal(sepRoom({ ...confirmed, kind: 'w2', compensation: 400000 }).value, 72000);
  assert.equal(sepRoom({ ...confirmed, kind: 'self-employed', netProfit: 400 }).value, 80);
  assert.equal(sepRoom({ ...confirmed, kind: 'w2', compensation: 0 }).value, 0);
  assert.throws(() => sepRoom({ kind: 'w2', compensation: 100000 }), /confirmed/);
});

test('retirement separates this-plan catch-ups from annual additions and keeps SE compensation limits', () => {
  const v = solo401kRoom({ ...confirmed, compensation: 300000, age: 51,
    allPlanDeferrals: 32500, thisPlanDeferrals: 8000, thisPlanCatchUp: 8000 }).value;
  assert.equal(v.employee, 0);
  assert.equal(v.employer, 72000);
  assert.equal(v.catchUp, 0);
  const self = solo401kRoom({ ...confirmed, compensation: 30000, age: 40, kind: 'self-employed' }).value;
  assert.equal(self.employee, 24500);
  assert.equal(self.employer, 2750);
});

test('safe harbor deliberately preserves archived annual arithmetic and applicability gates', () => {
  const inputs = { currentYearTax: 68000, priorYearTax: 52000, priorYearAgi: 180000,
    filingStatus: 'mfj', withholding: 22000, paymentsMade: 24000,
    priorReturnFullYear: true, specialRulesAbsent: true };
  assert.deepEqual(estimatedPaymentSafeHarbor(inputs).value, { requiredAnnualPayment: 57200, remaining: 11200 });
  assert.equal(estimatedPaymentSafeHarbor({ ...inputs, priorYearAgi: 150000 }).value.requiredAnnualPayment, 52000);
  assert.equal(estimatedPaymentSafeHarbor({ ...inputs, filingStatus: 'mfs', priorYearAgi: 75000.01 }).value.requiredAnnualPayment, 57200);
  assert.equal(estimatedPaymentSafeHarbor({ ...inputs, currentYearTax: 22999 }).value.requiredAnnualPayment, 0);
  assert.ok(estimatedPaymentSafeHarbor({ ...inputs, currentYearTax: 23000 }).value.requiredAnnualPayment > 0);
  assert.throws(() => estimatedPaymentSafeHarbor({ ...inputs, priorReturnFullYear: false }), /confirmed/);
});

test('Virginia marginal brackets operate on Virginia taxable income', () => {
  for (const [taxableIncome, expected] of [[0, 0], [3000, 60], [5000, 120], [17000, 720], [18000, 777.50]]) {
    assert.equal(virginiaIncomeTax({ taxableIncome }).value, expected);
  }
});

test('HSA normal monthly proration, catch-up and already-contributed room', () => {
  assert.deepEqual(hsaLimit({ coverage: 'family', age: 56, eligibleMonths: 6, eligibilityConfirmed: true,
    employerContributions: 1000, personalContributions: 500 }).value, { limit: 4875, remaining: 3375 });
  assert.equal(hsaLimit({ coverage: 'self', age: 40, eligibilityConfirmed: true }).value.limit, 4400);
  assert.equal(hsaLimit({ coverage: 'self', age: 40, eligibleMonths: 0, eligibilityConfirmed: true }).value.limit, 0);
  assert.throws(() => hsaLimit({ coverage: 'family', age: 40 }), /confirmed/);
});

test('dependent-care exclusion is limited by 2026 cap, expenses and both spouses earned income', () => {
  const inputs = { filingStatus: 'mfj', ownerEarnedIncome: 50000, spouseEarnedIncome: 20000,
    qualifiedExpenses: 12000, eligibilityConfirmed: true };
  assert.equal(dependentCareLimit(inputs).value, 7500);
  assert.equal(dependentCareLimit({ ...inputs, spouseEarnedIncome: 3000 }).value, 3000);
  assert.equal(dependentCareLimit({ ...inputs, filingStatus: 'mfs' }).value, 3750);
  assert.equal(dependentCareLimit({ ...inputs, benefitsUsed: 7500 }).value, 0);
});

test('QBI handles wage limits, SSTB phase-in, capital gain cap and active-business minimum', () => {
  const basic = { qbi: 100000, taxableIncome: 150000, filingStatus: 'single', w2Wages: 0, qualifiedPropertyBasis: 0, isSstb: false };
  assert.equal(qbiDeduction(basic).value, 20000);
  assert.equal(qbiDeduction({ ...basic, taxableIncome: 276750 }).value, 0);
  assert.equal(qbiDeduction({ ...basic, taxableIncome: 239250 }).value, 10000);
  assert.equal(qbiDeduction({ ...basic, taxableIncome: 276750, w2Wages: 50000 }).value, 20000);
  assert.equal(qbiDeduction({ ...basic, taxableIncome: 276750, isSstb: true, w2Wages: 100000 }).value, 0);
  assert.equal(qbiDeduction({ ...basic, taxableIncome: 10000, netCapitalGain: 5000 }).value, 1000);
  assert.equal(qbiDeduction({ ...basic, qbi: 1000, taxableIncome: 10000, activeBusiness: true }).value, 400);
});

test('supplied salary versus distributions exposes the combined hand-checked tradeoff', () => {
  const inputs = { ...confirmed, profitBeforeSalary: 200000, salaryApproved: true,
    age: 40, filingStatus: 'mfj', deductions: 0, isSstb: false };
  const low = sCorpSalaryTradeoff({ ...inputs, salary: 60000 }).value;
  const high = sCorpSalaryTradeoff({ ...inputs, salary: 100000 }).value;
  assert.equal(low.payrollTax, 9180);
  assert.equal(high.payrollTax, 15300);
  assert.equal(low.employee401kRoom, 24500);
  assert.equal(low.employer401kRoom, 15000);
  assert.equal(high.employer401kRoom, 25000);
  assert.equal(low.distributions, 120410);
  assert.equal(high.distributions, 67350);
  assert.equal(low.qbiDeduction, 24082);
  assert.equal(high.qbiDeduction, 13470);
  assert.equal(low.federalIncomeTax, 18426.16);
  assert.equal(high.federalIncomeTax, 17887.60);
  assert.ok(Math.abs(high.totalFederalTax - low.totalFederalTax - 5581.44) < 0.000001);
  assert.throws(() => sCorpSalaryTradeoff({ ...inputs, salary: 60000, salaryApproved: false }), /approved/);
});

import { TAX_2026 as P, LAW_REFS } from './parameters-2026.mjs';
export { TAX_2026, LAW_REFS } from './parameters-2026.mjs';

function number(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER / 100 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a finite number in range`);
  }
  return value;
}

const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value, name) => round(number(value, name));
const positive = value => Math.max(0, value);
const step = (label, formula, value) => ({ label, formula, value: typeof value === 'number' ? round(value) : value });

function prepare(inputs) {
  if ((inputs.taxYear ?? 2026) !== 2026) throw new RangeError('Only tax year 2026 is supported');
}

function status(inputs) {
  const filingStatus = inputs.filingStatus ?? 'single';
  if (!Object.hasOwn(P.federal.ceilings, filingStatus)) throw new TypeError('Unsupported filingStatus');
  return filingStatus;
}

function envelope(inputs, value, steps, refs) {
  return { value, inputs: structuredClone(inputs), steps, lawRefs: [...new Set(refs)].map(key => LAW_REFS[key]) };
}

function bracketTax(taxableIncome, ceilings, rates) {
  let lower = 0;
  let centsTimesRate = 0;
  const steps = [];
  const incomeCents = Math.round(taxableIncome * 100);
  for (let i = 0; i < rates.length; i++) {
    const upper = i < ceilings.length ? Math.round(ceilings[i] * 100) : incomeCents;
    const band = Math.max(0, Math.min(incomeCents, upper) - lower);
    centsTimesRate += band * Math.round(rates[i] * 10000);
    steps.push(step(`Bracket ${i + 1}`, `${band / 100} * ${rates[i]}`, band * rates[i] / 100));
    lower = upper;
    if (incomeCents <= upper) break;
  }
  return { value: Math.round(centsTimesRate / 10000) / 100, steps };
}

export function federalIncomeTax(inputs) {
  prepare(inputs);
  const filing = status(inputs);
  const taxable = money(inputs.taxableIncome, 'taxableIncome');
  const result = bracketTax(taxable, P.federal.ceilings[filing], P.federal.rates);
  return envelope(inputs, result.value, result.steps, ['federal']);
}

export function payrollTax(inputs) {
  prepare(inputs);
  const filing = status(inputs);
  const wages = money(inputs.wages, 'wages');
  const priorSS = money(inputs.priorSocialSecurityWages ?? 0, 'priorSocialSecurityWages');
  const priorMedicare = money(inputs.priorMedicareWages ?? 0, 'priorMedicareWages');
  const spouse = money(inputs.spouseMedicareWages ?? 0, 'spouseMedicareWages');
  const p = P.payroll;
  const socialTaxable = Math.min(wages, positive(p.socialSecurityWageBase - priorSS));
  const social = round(socialTaxable * p.socialSecurityRate);
  const medicare = round(wages * p.medicareRate);
  const excess = threshold => positive(priorMedicare + spouse + wages - threshold) - positive(priorMedicare + spouse - threshold);
  const additional = round(excess(p.additionalThreshold[filing]) * p.additionalMedicareRate);
  const withheld = round((positive(priorMedicare + wages - p.withholdingThreshold) - positive(priorMedicare - p.withholdingThreshold)) * p.additionalMedicareRate);
  const employeeTotal = round(social + medicare + additional);
  const employerTotal = round(social + medicare);
  return envelope(inputs, {
    employeeSocialSecurity: social, employerSocialSecurity: social,
    employeeMedicare: medicare, employerMedicare: medicare,
    additionalMedicare: additional, additionalMedicareWithholding: withheld,
    employeeTotal, employerTotal, total: round(employeeTotal + employerTotal),
  }, [step('Social Security per side', 'min(wages, remaining employer wage base) * rate', social),
    step('Medicare per side', 'wages * Medicare rate', medicare),
    step('Additional Medicare liability', 'incremental household wages above filing threshold * rate', additional),
    step('Additional Medicare withholding', 'incremental employer wages above withholding threshold * rate', withheld)], ['payroll', 'additionalMedicare']);
}

export function selfEmploymentTax(inputs) {
  prepare(inputs);
  const filing = status(inputs);
  const netProfit = money(inputs.netProfit, 'netProfit');
  const ssWages = money(inputs.w2SocialSecurityWages ?? 0, 'w2SocialSecurityWages');
  const medicareWages = money(inputs.w2MedicareWages ?? 0, 'w2MedicareWages');
  const spouse = money(inputs.spouseMedicareWages ?? 0, 'spouseMedicareWages');
  const earnings = round(netProfit * P.selfEmployment.netEarningsFactor);
  const taxable = earnings < P.selfEmployment.minimumEarnings ? 0 : earnings;
  const ss = round(Math.min(taxable, positive(P.payroll.socialSecurityWageBase - ssWages)) * P.selfEmployment.socialSecurityRate);
  const medicare = round(taxable * P.selfEmployment.medicareRate);
  const threshold = P.payroll.additionalThreshold[filing];
  const additional = round((positive(medicareWages + spouse + taxable - threshold) - positive(medicareWages + spouse - threshold)) * P.payroll.additionalMedicareRate);
  const deductibleHalf = round((ss + medicare) / 2);
  return envelope(inputs, { taxableEarnings: taxable, socialSecurity: ss, medicare,
    additionalMedicare: additional, deductibleHalf, total: round(ss + medicare + additional) },
  [step('Net earnings', 'netProfit * net earnings factor, subject to minimum', taxable),
    step('Regular SE tax', 'Social Security after wage base coordination + Medicare', ss + medicare),
    step('Deductible half', '(Social Security + Medicare) / 2; additional tax excluded', deductibleHalf)], ['selfEmployment', 'payroll', 'additionalMedicare']);
}

function planGate(inputs) {
  if (inputs.planConfirmed !== true || inputs.aggregationConfirmed !== true) {
    throw new TypeError('Plan terms and related-employer treatment must be confirmed');
  }
}

export function solo401kRoom(inputs) {
  // Self-employed compensation is net profit after the deductible half of SE tax, before plan contributions.
  prepare(inputs);
  planGate(inputs);
  const compensation = money(inputs.compensation, 'compensation');
  const age = number(inputs.age, 'age', { max: 120 });
  const kind = inputs.kind ?? 'w2';
  if (!['w2', 'self-employed'].includes(kind)) throw new TypeError('Unsupported compensation kind');
  const p = P.retirement;
  const allDeferrals = money(inputs.allPlanDeferrals ?? 0, 'allPlanDeferrals');
  const thisDeferrals = money(inputs.thisPlanDeferrals ?? 0, 'thisPlanDeferrals');
  const thisCatchUp = money(inputs.thisPlanCatchUp ?? 0, 'thisPlanCatchUp');
  const employerPaid = money(inputs.employerContributions ?? 0, 'employerContributions');
  const priorWages = money(inputs.priorYearSponsorWages ?? 0, 'priorYearSponsorWages');
  if (thisDeferrals > allDeferrals) throw new RangeError('thisPlanDeferrals exceeds allPlanDeferrals');
  const base = Math.min(compensation, p.compensationCeiling);
  if (thisCatchUp > thisDeferrals || thisCatchUp > positive(allDeferrals - p.employeeDeferral)) {
    throw new RangeError('thisPlanCatchUp exceeds catch-up deferrals');
  }
  const regularThisPlan = thisDeferrals - thisCatchUp;
  if (regularThisPlan > p.employeeDeferral) throw new RangeError('Supply thisPlanCatchUp separately from regular deferrals');
  const additions = positive(Math.min(p.annualAdditions, base) - regularThisPlan - employerPaid);
  const availableComp = positive(base - thisDeferrals - employerPaid);
  const employee = round(Math.min(positive(p.employeeDeferral - allDeferrals), additions, availableComp));
  if (inputs.catchUpAllowed != null && typeof inputs.catchUpAllowed !== 'boolean') throw new TypeError('catchUpAllowed must be a boolean');
  const catchUpAllowed = inputs.catchUpAllowed !== false;
  const catchLimit = !catchUpAllowed || age < p.catchUpAge ? 0 : age >= p.enhancedCatchUpStart && age <= p.enhancedCatchUpEnd ? p.enhancedCatchUp : p.catchUp;
  const catchUp = round(Math.min(positive(catchLimit - positive(allDeferrals - p.employeeDeferral)), positive(availableComp - employee)));
  // K1: the employer room is the shared worksheet maximum with this plan's deferrals and catch-ups,
  // the new room included, less the employer contributions already made.
  const employerMax = employerLimit({ kind, compensation, regular: regularThisPlan + employee, catchUp: thisCatchUp + catchUp });
  const employer = round(positive(employerMax.limit - employerPaid));
  return envelope(inputs, { employee, employer, catchUp, total: round(employee + employer + catchUp),
    rothCatchUp: priorWages > p.rothCatchUpPriorWages ? catchUp : 0 },
  [step('Employee regular room', 'minimum of all-plan deferral, compensation and annual-additions headroom', employee),
    step('Catch-up room', 'age-specific catch-up less all-plan catch-ups already made', catchUp),
    step('Employer room', 'minimum of employer rate, compensation and annual-additions headroom', employer),
    ...(catchUpAllowed ? [] : [step('Catch-up not allowed under this plan', 'catch-up limit set to zero', 0)])], ['retirement', 'solo', 'sep']);
}

// Employer contribution maximum for one sponsor's plans (K1), the one worksheet every room
// calculator and the self-employed deduction worksheet use. Inputs are the sponsor's plan
// aggregate: compensation (W-2 wages, or for the self-employed net profit less the deductible half
// of SE tax, Pub 560 step 3), regular elective deferrals and catch-ups to that employer's plans.
// Self-employed: IRS Publication 560 chapter 5, Deduction Worksheet for Self-Employed, step 7
// (min(compensation * reduced rate, compensation limit * plan rate)), step 10 (415(c) dollar limit
// less deferrals), step 12 (half of compensation less deferrals) and step 13 (the smallest).
// W-2: IRC 404(a)(3)(A)(i) (plan rate times compensation up to the 401(a)(17) limit), 415(c)(1)
// (annual additions within the dollar limit and compensation, less deferrals).
// `limit` is step 13 further held to the compensation left after deferrals and catch-ups (IRC
// 415(c)(1)(B), 414(v)(2)(A)(ii)); it is below zero when deferrals already exceed compensation.
export function employerLimit({ kind, compensation, regular = 0, catchUp = 0 }) {
  if (!['w2', 'self-employed'].includes(kind)) throw new TypeError('Unsupported compensation kind');
  const p = P.retirement;
  const comp = money(compensation, 'compensation');
  const D = money(regular, 'regular');
  const K = money(catchUp, 'catchUp');
  const self = kind === 'self-employed';
  const s7 = round(self ? Math.min(comp * p.selfEmployedRate, p.compensationCeiling * p.employerRate) : Math.min(comp, p.compensationCeiling) * p.employerRate);
  const s10 = round((self ? p.annualAdditions : Math.min(p.annualAdditions, comp)) - D);
  const s12 = round(self ? (comp - D) / 2 : comp - D);
  const s13 = Math.min(s7, s10, s12);
  const left = round(comp - D - K);
  const limit = Math.min(s13, left);
  return {
    s7, s10, s12, s13, limit,
    steps: [
      step('Employer limit by plan rate', self ? 'min(compensation * reduced plan rate, compensation limit * plan rate)' : 'min(compensation, compensation limit) * plan rate', s7),
      step('Annual additions left for the employer', self ? 'annual additions limit - deferrals' : 'min(annual additions limit, compensation) - deferrals', s10),
      step('Compensation limit for the employer', self ? 'half of (compensation - deferrals)' : 'compensation - deferrals', s12),
      step('Employer maximum', 'smallest of the limits above, within compensation - deferrals - catch-ups', limit),
    ],
  };
}

export function sepRoom(inputs) {
  prepare(inputs);
  planGate(inputs);
  const kind = inputs.kind;
  if (!['w2', 'self-employed'].includes(kind)) throw new TypeError('Unsupported compensation kind');
  const halfTax = kind === 'self-employed' ? selfEmploymentTax(inputs).value.deductibleHalf : 0;
  const compensation = kind === 'self-employed' ? positive(money(inputs.netProfit, 'netProfit') - halfTax) : money(inputs.compensation, 'compensation');
  const contributed = money(inputs.employerContributions ?? 0, 'employerContributions');
  const thisDeferrals = money(inputs.thisPlanDeferrals ?? 0, 'thisPlanDeferrals');
  const thisCatchUp = money(inputs.thisPlanCatchUp ?? 0, 'thisPlanCatchUp');
  if (thisCatchUp > thisDeferrals) throw new RangeError('thisPlanCatchUp exceeds thisPlanDeferrals');
  // K1, Pub 560 multiple plans, IRC 415(f): a SEP shares the employer limit with the same
  // employer's 401(k), so its deferrals there reduce the SEP room.
  const max = employerLimit({ kind, compensation, regular: thisDeferrals - thisCatchUp, catchUp: thisCatchUp });
  const room = round(positive(max.limit - contributed));
  return envelope(inputs, room,
    [step('Adjusted compensation', 'net profit less deductible half SE tax, or eligible wages', compensation),
      ...max.steps,
      step('SEP room', 'employer maximum less employer contributions already made', room)], ['retirement', 'sep', 'selfEmployment']);
}

export function estimatedPaymentSafeHarbor(inputs) {
  // Tax inputs are after refundable credits. This is the ordinary annual target, excluding installment timing.
  prepare(inputs);
  if (inputs.priorReturnFullYear !== true || inputs.specialRulesAbsent !== true) throw new TypeError('Ordinary safe-harbor applicability must be confirmed');
  const filing = status(inputs);
  const current = money(inputs.currentYearTax, 'currentYearTax');
  const prior = money(inputs.priorYearTax, 'priorYearTax');
  const agi = money(inputs.priorYearAgi, 'priorYearAgi');
  const withholding = money(inputs.withholding ?? 0, 'withholding');
  const payments = money(inputs.paymentsMade ?? 0, 'paymentsMade');
  const threshold = filing === 'mfs' ? P.estimated.mfsHighIncomeAgi : P.estimated.highIncomeAgi;
  const multiplier = agi > threshold ? P.estimated.highIncomePriorRate : P.estimated.priorRate;
  const required = current - withholding < P.estimated.smallBalance ? 0 : round(Math.min(current * P.estimated.currentRate, prior * multiplier));
  return envelope(inputs, { requiredAnnualPayment: required, remaining: round(positive(required - withholding - payments)) },
    [step('Current-year target', 'current tax after credits * current-year percentage', current * P.estimated.currentRate),
      step('Prior-year target', 'prior full-year tax * income-dependent multiplier', prior * multiplier),
      step('Annual target', 'lesser target unless small-balance exception applies', required)], ['estimated']);
}

export function virginiaIncomeTax(inputs) {
  prepare(inputs);
  const result = bracketTax(money(inputs.taxableIncome, 'taxableIncome'), P.virginia.ceilings, P.virginia.rates);
  return envelope(inputs, result.value, result.steps, ['virginia']);
}

export function hsaLimit(inputs) {
  prepare(inputs);
  if (inputs.eligibilityConfirmed !== true) throw new TypeError('HSA monthly eligibility must be confirmed');
  if (!['self', 'family'].includes(inputs.coverage)) throw new TypeError('Unsupported coverage');
  const age = number(inputs.age, 'age', { max: 120 });
  const months = number(inputs.eligibleMonths ?? 12, 'eligibleMonths', { max: 12 });
  if (!Number.isInteger(months)) throw new TypeError('eligibleMonths must be an integer');
  const employer = money(inputs.employerContributions ?? 0, 'employerContributions');
  const personal = money(inputs.personalContributions ?? 0, 'personalContributions');
  const limit = round((P.hsa[inputs.coverage] + (age >= P.hsa.catchUpAge ? P.hsa.catchUp : 0)) * months / 12);
  return envelope(inputs, { limit, remaining: round(positive(limit - employer - personal)) },
    [step('Normal monthly limit', '(coverage limit + eligible catch-up) * eligible months / twelve', limit)], ['hsa', 'hsaEligibility']);
}

export function dependentCareLimit(inputs) {
  prepare(inputs);
  if (inputs.eligibilityConfirmed !== true) throw new TypeError('Dependent-care eligibility must be confirmed');
  const filing = status(inputs);
  const earned = money(inputs.ownerEarnedIncome, 'ownerEarnedIncome');
  const spouse = ['mfj', 'mfs'].includes(filing) ? money(inputs.spouseEarnedIncome, 'spouseEarnedIncome') : earned;
  const expenses = money(inputs.qualifiedExpenses, 'qualifiedExpenses');
  const used = money(inputs.benefitsUsed ?? 0, 'benefitsUsed');
  const limit = Math.min(filing === 'mfs' ? P.dependentCare.mfs : P.dependentCare.annual, earned, spouse, expenses);
  return envelope(inputs, round(positive(limit - used)),
    [step('Excludable room', 'minimum of statutory cap, expenses and applicable earned income, less benefits used', positive(limit - used))], ['dependentCare']);
}

export function qbiDeduction(inputs) {
  prepare(inputs);
  const filing = status(inputs);
  const qbi = money(inputs.qbi, 'qbi');
  const taxable = money(inputs.taxableIncome, 'taxableIncome');
  const wages = money(inputs.w2Wages ?? 0, 'w2Wages');
  const basis = money(inputs.qualifiedPropertyBasis ?? 0, 'qualifiedPropertyBasis');
  const gain = money(inputs.netCapitalGain ?? 0, 'netCapitalGain');
  if (typeof inputs.isSstb !== 'boolean') throw new TypeError('isSstb must be supplied');
  const p = P.qbi;
  const phase = Math.min(1, positive(taxable - p.threshold[filing]) / p.phaseIn[filing]);
  const applicable = inputs.isSstb ? 1 - phase : 1;
  const eligibleQbi = qbi * applicable;
  const tentative = eligibleQbi * p.rate;
  const wageLimit = Math.max(wages * p.wageRate, wages * p.alternativeWageRate + basis * p.propertyRate) * applicable;
  const phasedDeduction = tentative - positive(tentative - wageLimit) * phase;
  const incomeCap = positive(taxable - gain) * p.rate;
  const ordinary = Math.min(phasedDeduction, incomeCap);
  const minimum = inputs.activeBusiness === true && eligibleQbi >= p.activeMinimumIncome ? p.activeMinimumDeduction : 0;
  return envelope(inputs, round(Math.max(ordinary, minimum)),
    [step('Eligible QBI', 'qualified business income after SSTB phase-in', eligibleQbi),
      step('Wage/property limit', 'greater of wage limit or wage-plus-property limit', wageLimit),
      step('Phased QBI deduction', 'tentative less phased wage/property reduction', phasedDeduction),
      step('Taxable-income cap', 'taxable income excluding net capital gain * rate', incomeCap),
      step('Active-business floor', 'statutory minimum if eligible active income meets threshold', minimum)], ['qbi', 'qbiThresholds']);
}

export function sCorpSalaryTradeoff(inputs) {
  // otherTaxableIncome contains ordinary income only; deductions are supplied, including any standard deduction.
  prepare(inputs);
  if (inputs.salaryApproved !== true) throw new TypeError('Salary must be approved by a qualified professional');
  const filing = status(inputs);
  const profit = money(inputs.profitBeforeSalary, 'profitBeforeSalary');
  const salary = money(inputs.salary, 'salary');
  const other = money(inputs.otherTaxableIncome ?? 0, 'otherTaxableIncome');
  const deductions = money(inputs.deductions ?? 0, 'deductions');
  const spouseMedicareWages = filing === 'mfj' ? money(inputs.spouseMedicareWages ?? 0, 'spouseMedicareWages') : 0;
  const payroll = payrollTax({ wages: salary, filingStatus: filing, spouseMedicareWages }).value;
  const retirement = solo401kRoom({ ...inputs, compensation: salary, kind: 'w2' }).value;
  const employerPaid = money(inputs.employerContributions ?? 0, 'employerContributions');
  const employeePaid = money(inputs.thisPlanDeferrals ?? 0, 'thisPlanDeferrals');
  const catchUpPaid = money(inputs.thisPlanCatchUp ?? 0, 'thisPlanCatchUp');
  const paidRoth = (inputs.priorYearSponsorWages ?? 0) > P.retirement.rothCatchUpPriorWages ? catchUpPaid : 0;
  const employeeTotal = employeePaid + retirement.employee + retirement.catchUp;
  const distributions = round(profit - salary - payroll.employerTotal - employerPaid - retirement.employer);
  if (distributions < 0) throw new RangeError('Profit does not cover salary, employer payroll and employer contribution');
  const taxable = positive(other + salary - employeeTotal + paidRoth + retirement.rothCatchUp + distributions - deductions);
  const qbi = qbiDeduction({ ...inputs, qbi: distributions, taxableIncome: taxable, filingStatus: filing,
    w2Wages: salary, activeBusiness: inputs.activeBusiness ?? true }).value;
  const federal = federalIncomeTax({ taxableIncome: positive(taxable - qbi), filingStatus: filing }).value;
  const totalTax = round(federal + payroll.total);
  return envelope(inputs, { salary, distributions, payrollTax: payroll.total,
    employerPayrollTax: payroll.employerTotal, employeePayrollTax: payroll.employeeTotal,
    qbiIncome: distributions, qbiDeduction: qbi, employee401kRoom: round(retirement.employee + retirement.catchUp),
    employer401kRoom: retirement.employer, total401kRoom: retirement.total,
    federalIncomeTax: federal, totalFederalTax: totalTax,
    afterTaxCash: round(salary + distributions - payroll.employeeTotal - employeeTotal - federal) },
  [step('Distributions', 'profit less supplied salary, employer payroll and employer retirement', distributions),
    step('Retirement room', 'employee regular and catch-up plus employer room', retirement.total),
    step('QBI deduction', 'single-business deduction after salary and employer costs', qbi),
    step('Federal tax', 'ordinary income tax plus both payroll sides', totalTax)], ['salary', 'payroll', 'retirement', 'solo', 'qbi', 'qbiThresholds', 'federal']);
}

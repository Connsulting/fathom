function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const source = (title, url, section) => ({ title, url, section, taxYear: 2026 });

export const LAW_REFS = freeze({
  federal: source('IRS Revenue Procedure 2025-32', 'https://www.irs.gov/irb/2025-45_IRB', '4.01 tax rate tables'),
  payroll: source('IRS Publication 15 (2026)', 'https://www.irs.gov/publications/p15', 'Social security, Medicare and Additional Medicare Tax'),
  additionalMedicare: source('IRS Publication 505 (2026)', 'https://www.irs.gov/publications/p505', 'Additional Medicare Tax thresholds'),
  selfEmployment: source('IRS Publication 505 (2026)', 'https://www.irs.gov/publications/p505', 'Worksheet 2-3, estimated self-employment tax'),
  retirement: source('IRS Notice 2025-67', 'https://www.irs.gov/irb/2025-49_IRB', '2026 limitations under sections 401, 402, 414 and 415'),
  solo: source('IRS one-participant 401(k) plans', 'https://www.irs.gov/retirement-plans/one-participant-401k-plans', 'Contribution limits and self-employed computation'),
  sep: source('IRS Publication 560', 'https://www.irs.gov/publications/p560', 'Chapter 5, deduction worksheet for self-employed'),
  estimated: source('IRS Publication 505 (2026)', 'https://www.irs.gov/publications/p505', 'General rule, higher-income taxpayers, annual safe harbor'),
  virginia: source('Virginia Tax, miscellaneous filing', 'https://www.tax.virginia.gov/miscellaneous-filing', 'Virginia tax rate schedule'),
  hsa: source('IRS Revenue Procedure 2025-19', 'https://www.irs.gov/irb/2025-21_IRB#REV-PROC-2025-19', 'Section 2, HSA inflation adjusted items'),
  hsaEligibility: source('IRS Publication 969', 'https://www.irs.gov/publications/p969', 'Additional contributions and monthly contribution limit'),
  dependentCare: source('IRS Publication 15-B (2026)', 'https://www.irs.gov/publications/p15b', 'Dependent care assistance'),
  qbiThresholds: source('IRS Revenue Procedure 2025-32', 'https://www.irs.gov/irb/2025-45_IRB', '4.26 qualified business income'),
  qbi: source('26 USC 199A', 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section199A&num=0&edition=prelim', 'Subsections (a), (b), (d) and (i)'),
  salary: source('IRS S corporation compensation', 'https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues', 'Reasonable compensation before non-wage distributions'),
});

export const TAX_2026 = freeze({
  taxYear: 2026,
  verifiedOn: '2026-11-05',
  federal: {
    rates: [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37],
    ceilings: {
      single: [12400, 50400, 105700, 201775, 256225, 640600],
      mfj: [24800, 100800, 211400, 403550, 512450, 768700],
      mfs: [12400, 50400, 105700, 201775, 256225, 384350],
      hoh: [17700, 67450, 105700, 201750, 256200, 640600],
      qss: [24800, 100800, 211400, 403550, 512450, 768700],
    },
  },
  payroll: {
    socialSecurityWageBase: 184500, socialSecurityRate: 0.062, medicareRate: 0.0145,
    additionalMedicareRate: 0.009, withholdingThreshold: 200000,
    additionalThreshold: { single: 200000, mfj: 250000, mfs: 125000, hoh: 200000, qss: 200000 },
  },
  selfEmployment: { netEarningsFactor: 0.9235, minimumEarnings: 400, socialSecurityRate: 0.124, medicareRate: 0.029 },
  retirement: {
    employeeDeferral: 24500, annualAdditions: 72000, compensationCeiling: 360000,
    catchUpAge: 50, catchUp: 8000, enhancedCatchUpStart: 60, enhancedCatchUpEnd: 63,
    enhancedCatchUp: 11250, rothCatchUpPriorWages: 150000, employerRate: 0.25,
    selfEmployedRate: 0.20,
  },
  estimated: { currentRate: 0.90, priorRate: 1, highIncomePriorRate: 1.10, highIncomeAgi: 150000, mfsHighIncomeAgi: 75000, smallBalance: 1000 },
  virginia: { ceilings: [3000, 5000, 17000], rates: [0.02, 0.03, 0.05, 0.0575] },
  hsa: { self: 4400, family: 8750, catchUp: 1000, catchUpAge: 55 },
  dependentCare: { annual: 7500, mfs: 3750 },
  qbi: {
    rate: 0.20, wageRate: 0.50, alternativeWageRate: 0.25, propertyRate: 0.025,
    threshold: { single: 201750, mfj: 403500, mfs: 201775, hoh: 201750, qss: 201750 },
    phaseIn: { single: 75000, mfj: 150000, mfs: 75000, hoh: 75000, qss: 75000 },
    activeMinimumIncome: 1000, activeMinimumDeduction: 400,
  },
});

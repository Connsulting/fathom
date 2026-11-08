const upload = (kind, label) => ({ screen: 'upload', kind, label });
const answer = (key, label, prompt) => ({ screen: 'ask', key, label, prompt });
const taxforms = upload('taxforms', 'Upload a clearer tax form');
export const TAX_GAP_RULES = Object.freeze({
  paystub_ytd_missing: { text: who => `Wages from ${who} are not included: the paystub has no year-to-date pay.`, rough: true, fix: answer('income.payrollYtd', 'Enter year-to-date pay', 'Record my year-to-date gross pay for {employer}. Ask me for the amount, pay date and whose pay this is.') },
  paystub_gross_assumed: { text: who => `Projected wages from ${who} using per-period gross and assumed pay periods.`, fix: upload('paystub', 'Upload a paystub with year-to-date pay') },
  paystub_deferrals_unknown: { text: who => `Assumed no pre-tax deferrals at ${who}: the paystub has no year-to-date deferral total.`, fix: taxforms },
  deferral_split_unknown: { text: who => `Allocated regular deferrals before catch-up across the payroll records for ${who}: the plan split is unknown.`, fix: answer('retirement.otherPlanDeferrals', 'Enter other plan deferrals', 'Record my deferrals and catch-up contributions to other workplace plans, separately for each person.') },
  w2_box12_unreadable: { text: who => `Assumed no retirement or HSA deferrals at ${who}: the W-2 box twelve was unreadable.`, fix: taxforms },
  w2_wages_missing: { text: who => `Wages from ${who} are not included: the W-2 wages could not be read.`, rough: true, fix: taxforms },
  w2_medicare_wages_missing: { text: who => `Used box one wages for Medicare wages at ${who}: box five was unreadable.`, fix: taxforms },
  w2_plan_compensation_unknown: { text: who => `Used taxable wages for plan compensation at ${who}: deferrals were unreadable.`, fix: taxforms },
  w2_recipient_unknown: { text: who => `Wages from ${who} are not included: whose pay this is has not been stated.`, rough: true, fix: answer('income.payrollRecipient', 'Say whose pay this is', 'Record whether pay from {employer} belongs to owner or spouse.') },
  payroll_recipient_conflict: { text: who => `Wages from ${who} are not included: the payroll recipients disagree.`, rough: true, fix: answer('income.payrollRecipient', 'Correct the payroll recipient', 'Record whether pay from {employer} belongs to owner or spouse.') },
  w2_duplicate_unresolved: { text: who => `Used the most recently imported W-2 from ${who}: duplicate forms have not been reconciled.`, fix: taxforms },
  w2_correction_pending: { text: who => `Used the most recently imported W-2 from ${who}: the correction has not been confirmed.`, fix: taxforms },
  w2_correction_conflicting: { text: who => `Used the most recently imported W-2 from ${who}: the correction answers disagree.`, fix: taxforms },
  household_employer_unmatched: { text: who => `Wages from ${who} are not included: more detail is needed to match the household business.`, rough: true, fix: answer('business.employerEntity', 'Name the household business', 'Record which household business the employer {employer} refers to. Ask me for the business name.') },
  employer_relation_pending: { text: who => `Treated ${who} as an outside employer: its household relationship has not been answered.`, fix: answer('income.employerRelation', 'Describe the employer', 'Record whether {employer} is an outside employer or a household business.') },
  entity_unclassified: { text: who => `Business income from ${who} is not included: its tax classification is unknown.`, rough: true, fix: answer('business.entityTypes', 'Enter the business tax type', 'Record the tax type of {employer}. Ask whether it is an S corporation, sole proprietorship, single-member LLC, partnership or C corporation.') },
  partnership_incomplete: { text: who => `Incomplete partnership income from ${who} is not included.`, rough: true, fix: taxforms },
  k1_unmatched: { text: () => 'Unmatched partnership statements are not included in business income.', rough: true, fix: taxforms },
  k1_scorp_unmatched: { text: () => 'Unmatched S corporation shareholder income is not included without its business profit and loss.', rough: true, fix: upload('pnl', 'Upload the business profit and loss') },
  retirement_contribution_unattributed: { text: () => 'Retirement deductions with no identifiable business sponsor are not included.', fix: upload('taxforms', 'Upload the retirement plan statement') },
  retirement_contribution_over_limit: { text: () => 'Unverified retirement deductions are not included because the recorded contributions exceed the calculated limit.', fix: taxforms },
  retirement_other_deferrals_missing: { text: () => 'Unverified retirement deductions are not included because other workplace deferrals are unknown.', fix: answer('retirement.otherPlanDeferrals', 'Enter other plan deferrals', 'Record my deferrals and catch-up contributions to other workplace plans, separately for each person.') },
  va_itemized_missing: { text: () => 'Used the Virginia standard deduction because the Virginia itemized estimate is missing.', fix: answer('tax.vaItemizedEstimate', 'Enter Virginia deductions', 'Record my Virginia itemized deduction estimate.') },
  va529_answers_missing: { text: () => 'Unverified Virginia college savings deductions are not included.', fix: answer('accounts.va529', 'Enter college savings details', 'Record which of my college savings accounts are Virginia plans and their unused deduction carryforward.') },
  ctc_refundable_unsupported: { text: () => 'The refundable child tax credit is not modeled; the credit is limited to income tax.', fix: upload('taxforms', 'Upload the filed return when available') },
  no_income_inputs: { text: () => 'No usable income is recorded; this rough estimate excludes all unrecorded income.', rough: true, fix: upload('paystub', 'Upload an income document') },
  filing_status_assumed: { text: () => 'Assumed single filing status because no supported filing status is recorded.', fix: answer('household.filingStatus', 'Enter filing status', 'Record my household filing status.') },
});

export function taxGap(code, { employer = 'this business', person = null, message, impact = null } = {}) {
  const base = code.split(':')[0];
  const rule = TAX_GAP_RULES[base];
  if (!rule) throw new TypeError(`No tax gap rule for ${base}`);
  const fix = { ...rule.fix };
  if (fix.prompt) fix.prompt = fix.prompt.replace('{employer}', employer);
  return { code, employer, person, message: message || rule.text(employer), action: fix, rough: !!rule.rough, impact };
}

export function rankGaps(gaps) {
  return [...gaps].sort((a, b) => Number(b.rough) - Number(a.rough) || (b.impact ?? 0) - (a.impact ?? 0) || a.code.localeCompare(b.code));
}

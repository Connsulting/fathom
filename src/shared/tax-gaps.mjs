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
  household_employer_unmatched: { text: who => `Included wages from ${who} as household pay; its business tax classification or link is unresolved.`, rough: true, fix: answer('business.entities', 'Describe the household business', 'Record the household business for employer {employer}, its tax type and owner. Preserve existing business entries and explicit account links.') },
  employer_relation_pending: { text: who => `Treated ${who} as an outside employer: its household relationship has not been answered.`, fix: answer('income.employerRelation', 'Describe the employer', 'Record whether {employer} is an outside employer or a household business.') },
  entity_unclassified: { text: who => `Business income from ${who} is not included: its tax classification is unknown.`, rough: true, fix: answer('business.entities', 'Enter the business tax type', 'Record the tax type of {employer}. Ask whether it is an S corporation, sole proprietorship, single-member LLC, partnership or C corporation.') },
  partnership_incomplete: { text: who => `Incomplete partnership income from ${who} is not included.`, rough: true, fix: taxforms },
  k1_unmatched: { text: () => 'Unmatched partnership statements are not included in business income.', rough: true, fix: taxforms },
  k1_scorp_unmatched: { text: () => 'Unmatched S corporation shareholder income is not included without its business profit and loss.', rough: true, fix: upload('pnl', 'Upload the business profit and loss') },
  retirement_contribution_unattributed: { text: () => 'Retirement deductions with no identifiable business sponsor are not included.', fix: answer('retirement.contributions', 'Correct the contribution sponsors', 'Help me correct the recorded retirement contributions. Read the current list, ask which business sponsors each unassigned contribution, and preserve the other entries.') },
  retirement_sponsor_assumed: { text: who => `Assigned the retirement contribution to ${who}, the account owner's only business, because its recorded sponsor was missing or unmatched.`, fix: answer('retirement.contributions', 'Confirm the contribution sponsor', 'Help me correct the recorded retirement contribution sponsors. Read the current list and preserve the other entries.') },
  tax_payment_kind_unknown: { text: () => 'Excluded unlabeled tax payments because their payment type is unknown.', fix: upload('estimates', 'Upload a labeled payment log') },
  withholding_state_unknown: { text: () => 'Excluded state withholding whose state was not recorded.', fix: taxforms },
  withholding_recipient_unknown: { text: () => 'Excluded withholding whose recipient is unknown to avoid counting it twice.', fix: answer('tax.withholding.federal', 'Enter the withholding total', 'Record my total federal withholding for this tax year. Ask me for the amount.') },
  withholding_conflict_pending: { text: () => 'Excluded disputed withholding because the documents report conflicting amounts.', fix: taxforms },
  tax_year_unconfirmed: { text: () => 'Excluded estimated payments whose tax year has not been confirmed.', fix: upload('estimates', 'Upload a payment log with the tax year') },
  estimated_payer_unknown: { text: () => 'Excluded estimated payments because the log does not identify which payments belong to this return.', fix: upload('estimates', 'Upload a payment log naming the payer') },
  retirement_contribution_over_limit: { text: () => 'Unverified retirement deductions are not included because the recorded contributions exceed the calculated limit.', fix: answer('retirement.contributions', 'Correct the contribution amounts', 'Help me correct the recorded retirement contributions. Read the current list, ask which amounts need correcting, and preserve the other entries.') },
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

// Estimate assumptions (TX2): warned codes that shape the tax left to pay but are not TAX1 gaps, so
// they stay out of TAX_GAP_RULES (missing-data fixes and rec gaps read that map). Only the figures
// for the tax left to pay carry them.
export const ESTIMATE_GAP_RULES = Object.freeze({
  prior_year_missing: { text: () => "Last year's tax return is missing, so the federal target uses this year's projection.", fix: upload('taxforms', "Upload last year's return") },
  sstb_assumed: { text: () => 'Assumed each business is a specified service business, which can limit the business income deduction, because it has not been stated.',
    fix: answer('business.entities', 'Say which businesses are specified service', 'Record whether each household business is a specified service trade or business. Preserve existing business entries and explicit account links.') },
  filing_status_assumed: { text: TAX_GAP_RULES.filing_status_assumed.text, fix: TAX_GAP_RULES.filing_status_assumed.fix },
});

// TX2: the existing fix for a planner assumption code (src/jobs/planner/assumptions.mjs) that shapes a
// tax figure, only where that fix supplies the input the assumption stands in for. Codes with no such
// fix are shown as plain words only: a modelling choice (agi_as_magi_proxy), section125_unknown (no
// paystub field or answer holds pre-tax benefits) and qbi_no_prior_loss (the planner reads only an
// owner fact that no import or answer shape writes).
export const ASSUMPTION_FIXES = Object.freeze({
  addl_medicare_withholding_not_read: answer('tax.withholding.federal', 'Enter the withholding total', 'Record my total federal withholding for this tax year, including any Additional Medicare tax withheld. Ask me for the amount.'),
  paid_rows_as_estimates: upload('estimates', 'Upload a labeled payment log'),
});

// The same shape as taxGap for an estimate assumption code.
export function estimateGap(code) {
  const rule = ESTIMATE_GAP_RULES[code];
  if (!rule) throw new TypeError(`No estimate gap rule for ${code}`);
  return { code, employer: null, person: null, message: rule.text(), action: { ...rule.fix }, rough: !!rule.rough, impact: null };
}

export function rankGaps(gaps) {
  return [...gaps].sort((a, b) => Number(b.rough) - Number(a.rough) || (b.impact ?? (b.rough ? Infinity : 0)) - (a.impact ?? (a.rough ? Infinity : 0)) || a.code.localeCompare(b.code));
}

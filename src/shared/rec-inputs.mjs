// The inputs a recommendation reads, and which inputs each gap or hold code affects (RQ2). Every
// trigger in src/jobs/triggers/ declares `inputs`; a rec carries only the gaps on its own inputs and
// a trigger is held only by a code it reads, so a missing input never shows on an unrelated rec.
//
// Inputs:
//   income      wages, business income and partnership income (federal AGI and everything from it)
//   retirement  retirement contributions, deferrals and plan compensation
//   payments    estimated payments and withholding
//   filing      filing status
//   va          Virginia deductions and Virginia plan answers
//   credits     the child tax credit
//   hsa         HSA deferrals
//   ages        birth years
//
// inputsOf(code)              -> frozen input names a code affects (a suffix after ':' is ignored)
// reads(trigger, code)        -> true when the code affects an input the trigger declares
// gapsFor(trigger, gaps)      -> the gaps on the trigger's inputs
// blockedFor(ctx, trigger)    -> the first held code in ctx.info.blocked the trigger reads, else null

const f = (...names) => Object.freeze(names);
const TAX_RUN = f('income', 'retirement', 'filing');

export const INPUTS = f('income', 'retirement', 'payments', 'filing', 'va', 'credits', 'hsa', 'ages');

export const CODE_INPUTS = Object.freeze({
  // Payroll and business income.
  paystub_ytd_missing: f('income'),
  paystub_gross_assumed: f('income'),
  paystub_deferrals_unknown: f('income', 'retirement'),
  w2_wages_missing: f('income'),
  w2_medicare_wages_missing: f('income'),
  w2_recipient_unknown: f('income'),
  payroll_recipient_conflict: f('income'),
  w2_duplicate_unresolved: f('income'),
  w2_correction_pending: f('income'),
  w2_correction_conflicting: f('income'),
  household_employer_unmatched: f('income'),
  employer_relation_pending: f('income'),
  entity_unclassified: f('income'),
  partnership_incomplete: f('income'),
  k1_unmatched: f('income'),
  k1_scorp_unmatched: f('income'),
  no_income_inputs: f('income'),
  scorp_identity_missing: f('income'),
  pnl: f('income'),
  // Retirement contributions and plan compensation.
  w2_box12_unreadable: f('retirement', 'hsa'),
  w2_plan_compensation_unknown: f('retirement', 'income'),
  deferral_split_unknown: f('retirement'),
  retirement_contribution_unattributed: f('retirement'),
  retirement_sponsor_assumed: f('retirement'),
  retirement_contribution_over_limit: f('retirement'),
  retirement_other_deferrals_missing: f('retirement'),
  ira_room_missing: f('retirement'),
  // Payments and withholding.
  tax_payment_kind_unknown: f('payments'),
  withholding_state_unknown: f('payments'),
  withholding_recipient_unknown: f('payments'),
  withholding_conflict_pending: f('payments'),
  tax_year_unconfirmed: f('payments'),
  estimated_payer_unknown: f('payments'),
  tax_payments: f('payments'),
  // Filing, Virginia, credits and ages.
  filing_status_assumed: f('filing'),
  mfs_unsupported: f('filing'),
  va_itemized_missing: f('va'),
  va529_answers_missing: f('va'),
  ctc_refundable_unsupported: f('credits'),
  'household.birthYears': f('ages'),
  // A household tax run that could not finish holds everything that run reads.
  calc_failed: TAX_RUN,
});

// A code with no entry is treated as holding the household tax run, so an unmapped hold is never
// silently dropped from the recs that read household tax.
export function inputsOf(code) {
  const base = String(code ?? '').split(':')[0];
  return Object.hasOwn(CODE_INPUTS, base) ? CODE_INPUTS[base] : TAX_RUN;
}

export function reads(trigger, code) {
  const own = trigger?.inputs || [];
  return inputsOf(code).some(name => own.includes(name));
}

export function gapsFor(trigger, gaps) {
  return (gaps || []).filter(g => g && reads(trigger, g.code));
}

export function blockedFor(ctx, trigger) {
  return (ctx?.info?.blocked || []).find(code => reads(trigger, code)) ?? null;
}

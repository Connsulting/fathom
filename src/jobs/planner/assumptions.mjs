// Readable assumption notes (MGN1, R2-5, D2, D6). Figure locators keep `assumptions` as codes;
// notesFor(codes) turns them into the plain sentences shown beside a figure. No sentence holds a
// digit, so a note never states a number that did not come from a calculator.
//
// notesFor(codes) -> ['sentence', ...] (unknown codes skipped, duplicates dropped, at most five)

export const ASSUMPTION_TEXT = Object.freeze({
  household_business_tax_pending: 'Business tax treatment is pending. This projection uses known payroll and excludes business profit until its tax type is confirmed.',
  va_exemptions_omitted: 'Virginia personal exemptions are left out, so Virginia tax may be a little high.',
  agi_as_magi_proxy: 'Adjusted gross income stands in for modified adjusted gross income.',
  parameters_2026_proxy: "Next year uses this year's brackets and limits, because next year's are not published yet.",
  next_year_flat: "Next year's business income is assumed to match this year's.",
  plan_terms_pending: 'Assumption: plan terms and eligibility are suitable; advisor confirmation is pending.',
  plan_aggregation_pending: 'Assumption: no related business shares the plan limits; advisor confirmation is pending.',
  other_plan_deferrals_zero: 'Assumption: no deferrals to other workplace plans because none are on file.',
  plan_terms_confirmed: 'Assumes plan terms and eligibility are confirmed with your advisor.',
  age_unknown_no_catch_up: 'Catch-up room is left out because an age is missing.',
  qbi_material_participation: 'Assumes you materially participate in each business.',
  qbi_no_prior_loss: 'Assumes no business loss carried over from last year.',
  projection_target: "Based on this year's projection; the real test uses the tax on the return you file.",
  prior_return_full_year: "Assumes last year's return covered a full year.",
  plan_rate_max: 'Assumes the plan allows the full employer contribution rate.',
  roth_elective: "You can elect Roth for any of this; Roth contributions do not lower this year's tax.",
  roth_catch_up_unconfirmed: 'Catch-up room stays at zero until you confirm your plan offers Roth deferrals.',
  roth_catch_up_unavailable: 'Your plan has no Roth deferrals, so no catch-up is allowed once the Roth rule applies.',
  section125_unknown: 'Paystubs do not show pre-tax benefit deductions, so wages are projected from gross pay and may be a little high.',
  prior_tax_total_line: "Last year's target uses the total tax on your uploaded return as filed, which may include taxes the safe-harbor rule leaves out, so it may be a little high.",
  paid_rows_as_estimates: 'Every payment in your tax payment log is counted as an estimated payment.',
  w2_plan_compensation: 'The plan uses W-2 compensation: box one wages plus the elective deferrals box one leaves out.',
  ctc_refundable_unsupported: 'The refundable part of the child tax credit is left out; the credit is limited to income tax.',
  addl_medicare_withholding_not_read: 'Additional Medicare tax withheld by an employer is not read from your W-2s yet, so withholding may be a little low.',
});

export const MAX_NOTES = 5;

export function notesFor(codes) {
  const out = [];
  for (const code of Array.isArray(codes) ? codes : []) {
    const text = ASSUMPTION_TEXT[code];
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, MAX_NOTES);
}

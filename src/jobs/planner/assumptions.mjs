// Readable assumption notes (MGN1, R2-5, D2, D6). Figure locators keep `assumptions` as codes;
// notesFor(codes) turns them into the plain sentences shown beside a figure. No sentence holds a
// digit, so a note never states a number that did not come from a calculator.
//
// notesFor(codes) -> ['sentence', ...] (unknown codes skipped, duplicates dropped, at most five)

export const ASSUMPTION_TEXT = Object.freeze({
  va_exemptions_omitted: 'Virginia personal exemptions are left out, so Virginia tax may be a little high.',
  agi_as_magi_proxy: 'Adjusted gross income stands in for modified adjusted gross income.',
  parameters_2026_proxy: "Next year uses this year's brackets and limits, because next year's are not published yet.",
  next_year_flat: "Next year's business income is assumed to match this year's.",
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

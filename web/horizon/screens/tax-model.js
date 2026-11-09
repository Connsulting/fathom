/* Tax this year view model: which stored tax figures the screen shows per jurisdiction, and the gaps
   on them with their fixes. Pure; no DOM and no api, so node can import it. It never computes a
   figure: paid so far and left to pay are the planner's own figures (src/jobs/planner/figures.mjs),
   and every value the screen shows is one of the keys below, rendered through the figure helper. */

const arr = (a) => (Array.isArray(a) ? a : []);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const present = (fig, key) => !!(fig && fig[key] && finite(fig[key].v) && !fig[key].unavailable);

// One row per jurisdiction, in screen order. paid is the planner's paid-so-far total; withheld and
// estimates are its two parts.
const JURISDICTIONS = Object.freeze([
  Object.freeze({ id: 'fed', j: 'fed', title: 'Federal' }),
  Object.freeze({ id: 'state', j: 'va', title: 'State' })
]);
const ROW_KEYS = (j) => ({
  proj: `tax.${j}.proj`, paid: `tax.${j}.paidToDate`, withheld: `tax.${j}.withheld`, estimates: `tax.${j}.paid`, remaining: `tax.${j}.remaining`
});

// The one control for saying where tax money is set aside. No answer shape holds a tax reserve, so it
// is a prompt-only Ask that Ask keeps as a remembered household preference (update_preferences); it
// does not fill the meter's reserve figure, and the meter's words do not promise that it will.
export const TAX_RESERVE_FIX = Object.freeze({
  screen: 'ask', label: 'Tell Fathom where tax money is set aside',
  prompt: "Remember where we set aside money for this year's taxes. Ask me which account holds it."
});
// With no projection: upload an income document (TAX_GAP_RULES.no_income_inputs in src/shared/tax-gaps.mjs).
export const NO_PROJECTION_FIX = Object.freeze({ screen: 'upload', kind: 'paystub', label: 'Upload an income document' });

// The tax year the planner computed the figures for (it keeps planning last year until that return
// is due), never the calendar year. Null when no shown figure carries one.
const yearOf = (fig, rows) => rows.flatMap((r) => [r.keys.remaining, r.keys.paid]).filter(Boolean)
  .map((k) => fig[k].taxYear).find((y) => Number.isInteger(y)) ?? null;

// fig: the scenario's stored figures (S.fig). Returns { year, available, rows, gaps } where each row
// is { id, title, keys } holding only the keys stored, overpaid is the sign of the stored left-to-pay
// figure, and gaps is every gap on the rows' figures deduplicated by code and employer, rough first.
export function taxPanelModel(fig) {
  const rows = [];
  for (const { id, j, title } of JURISDICTIONS) {
    const keys = Object.fromEntries(Object.entries(ROW_KEYS(j)).filter(([, key]) => present(fig, key)));
    if (!Object.keys(keys).length) continue;
    rows.push({ id, title, keys, overpaid: keys.remaining ? fig[keys.remaining].v < 0 : false });
  }
  const gaps = [];
  for (const row of rows) {
    for (const key of Object.values(row.keys)) {
      for (const g of arr(fig[key].gaps)) {
        if (!g || typeof g.code !== 'string' || typeof g.message !== 'string' || !g.message) continue;
        const prior = gaps.find((x) => x.code === g.code && x.employer === (g.employer ?? null));
        if (prior) { if (!prior.rows.includes(row.id)) prior.rows.push(row.id); continue; }
        gaps.push({ code: g.code, employer: g.employer ?? null, text: g.message, fix: g.action || null, rough: !!g.rough, rows: [row.id] });
      }
    }
  }
  const ranked = gaps.map((g, i) => [g, i]).sort((a, b) => Number(b[0].rough) - Number(a[0].rough) || a[1] - b[1]).map(([g]) => g);
  return { year: yearOf(fig, rows), available: rows.some((r) => r.keys.proj), rows, gaps: ranked };
}

// The pace board's tax meter with no reserve recorded: the projected key per jurisdiction and its
// paid-so-far key (null when not stored) to show in words, or null when no federal projection is stored (the meter then
// keeps its own reason).
export function taxMeterFallback(fig) {
  if (!present(fig, 'tax.fed.proj')) return null;
  const parts = JURISDICTIONS.filter(({ j }) => present(fig, `tax.${j}.proj`))
    .map(({ id, j, title }) => ({ id, title, proj: `tax.${j}.proj`, paid: present(fig, `tax.${j}.paidToDate`) ? `tax.${j}.paidToDate` : null }));
  return { parts, fix: TAX_RESERVE_FIX };
}

// Plain-language titles for "what changed" events. A fixed map covers every frozen fact key
// (FROZEN_FACT_KEYS) and every event kind, so a title never shows a raw key and never holds a
// figure: amounts reach the owner only through the figure registry, never through a title.
//
// factEventTitle(key, {removed}) -> 'S corp income detected' (never a raw key, never a digit)
// kindFallbackTitle(kind)        -> the title used for a key the map does not know

// [noun for a boolean fact, 'detected' phrase override or null, 'no longer seen' phrase override or null]
const BOOL = Object.freeze({
  'household.expectingChild': ['A child on the way', 'Expected child noted', 'Expected child no longer noted'],
  'income.w2': ['Outside employer wages', 'Wages from an outside employer detected', 'Wages from an outside employer no longer seen'],
  'income.sCorp': ['S corp income', 'S corp income detected', 'S corp income no longer seen'],
  'income.selfEmployed': ['Self-employment income', 'Self-employment income detected', 'Self-employment income no longer seen'],
  'income.partnership': ['Partnership income', 'Partnership income detected', 'Partnership income no longer seen'],
  'benefits.hsa': ['HSA', 'HSA detected', 'HSA no longer seen'],
  'benefits.employer401k': ['Employer 401(k)', 'Employer 401(k) detected', 'Employer 401(k) no longer seen'],
  'retirement.solo401k': ['Solo 401(k)', 'Solo 401(k) detected', 'Solo 401(k) no longer seen'],
  'retirement.ira': ['IRA', 'IRA detected', 'IRA no longer seen'],
  'retirement.backdoorRothCandidate': ['Backdoor Roth', 'Backdoor Roth looks possible', 'Backdoor Roth no longer looks possible'],
  'accounts.has529': ['529 account', '529 account detected', '529 account no longer seen'],
  'giving.charitable': ['Charitable giving', 'Charitable giving detected', 'Charitable giving no longer seen'],
});

// Facts that hold a value rather than a yes: one phrase for any change, up or down.
const VALUE = Object.freeze({
  'household.state': 'Home state updated',
  'household.filingStatus': 'Filing status updated',
  'household.dependents': 'Number of dependents updated',
  'household.dependentAges': 'Dependent ages updated',
  'income.agiEstimate': 'Income estimate updated',
  'giving.annualEstimate': 'Yearly giving estimate updated',
});

export const FACT_TITLES = Object.freeze({
  ...Object.fromEntries(Object.entries(BOOL).map(([k, [, on, off]]) => [k, Object.freeze({ detected: on, removed: off })])),
  ...Object.fromEntries(Object.entries(VALUE).map(([k, t]) => [k, Object.freeze({ detected: t, removed: t })])),
});

// Every event kind the brief writes or the scenario carries, with the title for an unmapped fact.
export const KIND_FALLBACK = Object.freeze({
  income: 'Income change detected',
  life: 'Household change detected',
  account: 'Account change detected',
  calendar: 'Calendar change detected',
  milestone: 'Plan change detected',
});

export const kindFallbackTitle = kind => KIND_FALLBACK[kind] || 'Change detected';

export function factEventTitle(key, { removed = false, kind } = {}) {
  const entry = Object.hasOwn(FACT_TITLES, key) ? FACT_TITLES[key] : null;
  if (!entry) return kindFallbackTitle(kind);
  return removed ? entry.removed : entry.detected;
}

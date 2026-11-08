// Plain words and fixes for figure gaps, shown under an Ask answer as "What this leaves out".
//
// FACT_LABELS          fact key -> plain noun phrase
// FIGURE_GAP_RULES     gap code -> { text, fix | null }
// factFix(key)         -> { screen: 'ask', key, label, prompt } for the key's answer shape, else null
// plainGap(gap)        -> { code, text, fix }: the gap's own message when it is plain, else the rule text
// hasInternalName(s)   -> true when s holds a fact key or a snake_case token (every gap code is one)
//
// Fix shapes are TAX1's (tax-gaps.mjs). A leaf: it never imports answer shapes or src/api.

import { TAX_GAP_RULES, taxGap } from './tax-gaps.mjs';

export const FACT_LABELS = Object.freeze({
  'accounts.planType': 'its plan type',
  'accounts.separationDate': 'the date you left that employer',
  'accounts.rothBasis': 'its Roth contribution basis',
  'accounts.rothFirstContributionYear': 'the year of the first Roth contribution',
  'household.birthYears': 'birth years',
  'household.ownerBirthDate': 'your birth date',
  'household.spouseBirthDate': "your spouse's birth date",
  'household.retireAge': 'a retirement age',
  'household.dependentBirthDates': "the children's birth dates",
  'household.dependentAges': "the children's ages",
  'obligations.childcareChangeDate': 'when childcare changes',
  'obligations.childcare': 'the childcare cost',
  'obligations.mortgage': 'the mortgage terms',
  'obligations.mortgage.balance': 'the mortgage balance',
  'obligations.mortgage.rate': 'the mortgage rate',
  'obligations.mortgage.monthlyPayment': 'the monthly mortgage payment',
  'obligations.mortgage.escrowMonthly': 'the monthly escrow amount',
});

const ask = (label, prompt) => ({ screen: 'ask', label, prompt });
const upload = (kind, label) => ({ screen: 'upload', kind, label });

export const FIGURE_GAP_RULES = Object.freeze({
  uncategorized_rows: { text: 'Some transactions have no category yet, so category totals leave them out.',
    fix: ask('Categorize them', 'Show my uncategorized transactions and help me categorize them.') },
  guessed_rows: { text: 'Some transaction categories are guesses that have not been confirmed.',
    fix: ask('Check the guesses', 'Show the transactions whose categories are guesses so I can confirm them.') },
  account_no_history: { text: 'An account has no transaction history for this period.', fix: upload('bank', 'Upload statements') },
  incomplete_month: { text: 'The current month is not over, so its figures are partial.', fix: null },
  unequal_periods: { text: 'The periods compared are not the same length.', fix: null },
  stale_account: { text: 'An account has not updated recently, so its latest activity may be missing.',
    fix: upload('aggregator', 'Import recent transactions') },
  outside_household_ledger: { text: 'Part of this happens outside the household accounts Fathom reads.', fix: null },
  missing_fact: { text: 'A fact this needs is not stored yet.', fix: null },
  carried_balance: { text: 'A balance is carried forward from an older reading.', fix: upload('bank', 'Upload a recent statement') },
  unclassified_category: { text: 'Some spending categories are not classified yet.',
    fix: ask('Classify them', 'Help me classify my unclassified spending categories.') },
  no_cost_basis: { text: 'Cost basis is missing for some holdings.', fix: upload('brokerage', 'Upload a statement with cost basis') },
});

// The nearest labelled parent: obligations.mortgage.rate is answered as obligations.mortgage.
function baseKey(key) {
  let base = key;
  for (let parts = key.split('.'); parts.length > 2;) {
    parts.pop();
    if (Object.hasOwn(FACT_LABELS, parts.join('.'))) base = parts.join('.');
  }
  return base;
}

export function factFix(key) {
  if (!Object.hasOwn(FACT_LABELS, key)) return null;
  const noun = FACT_LABELS[key].replace(/^its /, 'the ');
  const mine = noun.replace(/\byour\b/g, 'my').replace(/\byou\b/g, 'I');
  return { screen: 'ask', key: baseKey(key), label: `Tell Fathom ${noun}`, prompt: `Help me record ${mine}.` };
}

export function hasInternalName(text) {
  return /\b[a-z]+\.[a-z][A-Za-z.]+\b/.test(text) || /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(text);
}

export function plainGap(gap) {
  const own = typeof gap.message === 'string' && gap.message.trim() && !hasInternalName(gap.message) ? gap.message : null;
  if (gap.taxCode && Object.hasOwn(TAX_GAP_RULES, String(gap.taxCode).split(':')[0])) {
    const tax = taxGap(gap.taxCode);
    return { code: gap.code, text: own ?? tax.message, fix: tax.action };
  }
  const rule = FIGURE_GAP_RULES[gap.code] ?? FIGURE_GAP_RULES.missing_fact;
  return { code: gap.code, text: own ?? rule.text, fix: (gap.fact && factFix(gap.fact)) || rule.fix };
}

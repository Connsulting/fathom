const spending = Object.freeze({ pack: 'spending-and-obligations', entry: 'spending-classes' });
const mortgage = Object.freeze({ pack: 'spending-and-obligations', entry: 'mortgage-and-housing' });
const care = Object.freeze({ pack: 'spending-and-obligations', entry: 'childcare-by-age' });
const education = Object.freeze({ pack: 'spending-and-obligations', entry: 'education-saving-timeline' });

const row = (name, packRef = spending) => Object.freeze({ class: name, packRef });

export const CATEGORY_CLASSES = Object.freeze({
  'Home & Garden': row('housing'),
  Mortgage: row('debt_service'),
  housing: row('debt_service'),
  Medical: row('healthcare'),
  'Healthcare Premiums': row('healthcare'),
  'Health & Wellness': row('healthcare'),
  health: row('healthcare'),
  Childcare: row('childcare'),
  'Family Care': row('childcare'),
  childcare: row('childcare'),
  Groceries: row('essential_other'),
  groceries: row('essential_other'),
  'Bills & Utilities': row('essential_other'),
  utilities: row('essential_other'),
  'Auto & Transport': row('essential_other'),
  Pets: row('essential_other'),
  Fees: row('essential_other'),
  Legal: row('essential_other'),
  Shopping: row('discretionary'),
  'Dining & Drinks': row('discretionary'),
  dining: row('discretionary'),
  'Entertainment & Rec.': row('discretionary'),
  'Travel & Vacation': row('discretionary'),
  'Software & Tech': row('discretionary'),
  'Personal Care': row('discretionary'),
  Gifts: row('discretionary'),
  'Charitable Donations': row('discretionary'),
  Uncategorized: row('unclassified'),
  'Cash & Checks': row('unclassified'),
  Investment: row('savings'),
  'Mortgage Principal': row('savings'),
  HSA: row('savings'),
  'Income Tax': row('taxes'),
  Taxes: row('taxes'),
  Business: row('business'),
  payroll: row('business'),
  software: row('business'),
  contractors: row('business'),
  fees: row('business'),
  Income: row('income'),
  income: row('income'),
  'Credit Card Payment': row('transfer'),
  'Internal Transfers': row('transfer'),
  'Savings Transfer': row('transfer'),
  transfer: row('transfer'),
  Ignore: row('excluded'),
});

const BUCKET_CLASSES = Object.freeze({
  business: 'business', income: 'income', transfer: 'transfer',
  tax: 'taxes', saving: 'savings', excluded: 'excluded',
});

export function classOf(category, bucket) {
  if (bucket != null && Object.hasOwn(BUCKET_CLASSES, bucket)) return BUCKET_CLASSES[bucket];
  if (category != null && Object.hasOwn(CATEGORY_CLASSES, category)) return CATEGORY_CLASSES[category].class;
  if (bucket === 'household') return 'unclassified';
  return null;
}

const definition = (id, name, def) => Object.freeze({ id, name, source: 'builtin', def: Object.freeze(def), packRef: spending });

export const BUILTIN_DEFINITIONS = Object.freeze({
  household_spending: definition('household_spending', 'Household spending', {}),
  essential: definition('essential', 'Essential', {
    include: Object.freeze({ classes: Object.freeze(['housing', 'debt_service', 'healthcare', 'childcare', 'essential_other']) }),
  }),
  discretionary: definition('discretionary', 'Discretionary', {
    include: Object.freeze({ classes: Object.freeze(['discretionary']) }),
  }),
  core_living: definition('core_living', 'Core living', {
    exclude: Object.freeze({ classes: Object.freeze(['debt_service']), buckets: Object.freeze(['tax']) }),
  }),
});

export const OBLIGATION_RULES = Object.freeze({
  mortgage: Object.freeze({
    escrowContinues: true,
    packRef: mortgage,
  }),
  childcare: Object.freeze({
    schoolEntryAge: 5,
    schoolEntryMonthDay: '09-01',
    afterCareEndAge: 13,
    packRef: care,
  }),
  plan529: Object.freeze({
    collegeAge: 18,
    packRef: education,
  }),
});

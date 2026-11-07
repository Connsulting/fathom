const treatment = Object.freeze({ pack: 'account-tax-treatment', entry: 'treatment-by-account-type' });
const access = Object.freeze({ pack: 'account-tax-treatment', entry: 'penalty-free-access' });
const rmd = Object.freeze({ pack: 'account-tax-treatment', entry: 'required-minimum-distributions' });
const rothBasis = Object.freeze({ pack: 'account-tax-treatment', entry: 'roth-contribution-basis' });
const special = Object.freeze({ pack: 'account-tax-treatment', entry: 'hsa-and-529-withdrawals' });
const gains = Object.freeze({ pack: 'account-tax-treatment', entry: 'basis-and-capital-gains' });

const row = (id, packRef) => Object.freeze({ id, packRef });

export const ACCOUNT_TREATMENT = Object.freeze({
  byKind: Object.freeze({
    checking: row('cash', treatment),
    cash: row('cash', treatment),
    card: row('liability', treatment),
    taxable: row('taxable', gains),
    brokerage: row('taxable', gains),
    retirement: row('needs plan type', treatment),
    ira: row('needs plan type', treatment),
    roth: row('roth', rothBasis),
    hsa: row('hsa', special),
    529: row('529', special),
    business: row('business', treatment),
    loan: row('loan', treatment),
  }),
  byPlanType: Object.freeze({
    traditional_ira: row('pretax', treatment),
    roth_ira: row('roth_ira', rothBasis),
    sep_ira: row('pretax', treatment),
    '401k': row('pretax', access),
    roth_401k: row('roth_401k', rothBasis),
    solo_401k: row('pretax', access),
    '403b': row('pretax', access),
    '457b': row('pretax', access),
    hsa: row('hsa', special),
    529: row('529', special),
    taxable: row('taxable', gains),
  }),
});

export const EMPLOYER_PLAN_TYPES = Object.freeze(Object.assign(
  ['401k', 'roth_401k', 'solo_401k', '403b', '457b'],
  { packRef: access },
));

export const ACCESS_RULES = Object.freeze({
  penaltyFreeAge: Object.freeze({ years: 59, months: 6, packRef: access }),
  ruleOf55: Object.freeze({ years: 55, employerPlansOnly: true, packRef: access }),
  // plan type 457b does not say governmental or not. The no-penalty-after-separation
  // rule applies only when a separate governmental fact is true. Rolled-in amounts
  // from other plan types stay under the usual additional tax.
  governmental457b: Object.freeze({
    planType: '457b',
    needsFact: 'governmental',
    additionalTaxAfterSeparation: false,
    rolledInExcepted: true,
    packRef: access,
  }),
  fiveYear: Object.freeze({ years: 5, packRef: rothBasis }),
  hsaAnyUse: Object.freeze({ years: 65, packRef: special }),
  hsaAdditionalTax: Object.freeze({ rate: 0.2, untilAge: 65, packRef: special }),
});

export function rmdStartAge(birthDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate ?? ''));
  if (!match) throw new TypeError('birthDate must be YYYY-MM-DD');
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  if (iso < '1949-07-01') return 70.5;
  if (iso <= '1950-12-31') return 72;
  if (iso <= '1959-12-31') return 73;
  return 75;
}
rmdStartAge.packRef = rmd;

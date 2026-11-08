// Shared pieces for trigger modules: gate builders, year-generic windows, grounded figure lists,
// confirm-form text and task padding. Template text here follows the prose rule: no digits outside
// tokens and no number words; dates are written as month and day.

import { ADVISOR_KEYS } from '../../facts/derive.mjs';
import { isIsoDate } from '../../scenario/build.mjs';
import { esc } from '../../shared/tokens.mjs';
import { personOwner } from '../../shared/rec-links.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
import { isCollegeAccount } from '../../shared/account-kinds.mjs';
import { MIN_BIRTH_YEAR, MAX_DEPENDENTS } from '../../shared/ages.mjs';
import { EMPLOYER_PLAN_TYPES } from '../../calc/treatment.mjs';
import { VIRGINIA_PLAN_QUESTION, activeInference } from '../../shared/va529-plan.mjs';

// Data-derived text (entity and account names) as stored rec HTML: escaped, braces included, so it
// can never carry markup or a scenario token.
export const dataText = v => esc(v).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

// Recs whose title and summary list their items even when every item is a question on the card.
export const LISTED_RECS = Object.freeze(new Set(['missing-data']));

export const isTrue = fact => ({ fact, op: 'eq', value: true });
export const absentOrFalse = fact => ({ any: [{ not: { fact, op: 'exists' } }, { fact, op: 'eq', value: false }] });
export const BUSINESS = { any: [isTrue('income.sCorp'), isTrue('income.selfEmployed'), isTrue('income.partnership')] };

export const yearOf = ctx => ctx.year ?? Number(ctx.clock.slice(0, 4));
export const has = (ctx, key) => !!(ctx.fig[key]);
export const positive = (ctx, key) => !!(ctx.fig[key] && ctx.fig[key].v > 0);
export const keyMatching = (ctx, re) => Object.keys(ctx.fig).find(k => re.test(k)) || null;
export const salaryProjKey = ctx => keyMatching(ctx, /^pnl\.[^.]+\.salaryProj$/);
export const salaryKey = ctx => keyMatching(ctx, /^pnl\.[^.]+\.salary$/);

// Last payroll of the tax year: fact business.lastPayrollDate, else Dec 15 (R10, T9.4).
export function lastPayroll(ctx) {
  const d = ctx.facts['business.lastPayrollDate'];
  return isIsoDate(d) && Number(d.slice(0, 4)) === ctx.year ? d : `${ctx.year}-12-15`;
}

export const factDate = (ctx, key) => (isIsoDate(ctx.facts[key]) ? ctx.facts[key] : null);

// Grounded figures for `mine`: existing ones only, at most five; confirm forms show actuals only.
export function mineOf(ctx, keys, { actualOnly = false } = {}) {
  return keys.filter(k => k && ctx.fig[k] && (!actualOnly || ctx.fig[k].kind === 'a')).slice(0, 5).map(k => ({ label: dataText(ctx.fig[k].label), fig: k }));
}

// Tasks are text, or {t, link} when the step is done on another page: link names where ('upload',
// 'confirm', 'ask' or 'accounts'). Duplicates go and at most six are kept; a short list is never
// padded with filler, since every step is one the owner reports with "I did this".
export function padTasks(list) {
  const seen = new Set();
  return list.filter(Boolean).map(x => (typeof x === 'string' ? { t: x } : x)).filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true))).slice(0, 6);
}

export const CONFIRM_TASKS = Object.freeze({
  'retirement.planTermsConfirmed': 'Confirm your retirement plan terms with your advisor',
  'retirement.aggregationConfirmed': 'Confirm no related business shares your plan limits',
  'benefits.hsaEligible': 'Confirm your health plan is HSA eligible for the whole year',
  'benefits.hsaCoverage': 'Tell us whether the HSA plan covers just you or your family',
  'business.salaryRange': 'Ask your advisor for a reasonable salary range and enter it',
  'business.cashBasis': 'Confirm the business keeps its books on a cash basis',
  'household.birthYears': 'Tell us the year you were born, and your spouse if you file jointly',
  'accounts.va529': 'Tell us which college savings accounts are Virginia plans, and any carryforward',
  'business.onlyEmployee': 'Tell us whether you own the whole business and it has no employees, your spouse included',
  'retirement.priorYearFicaWages': "Tell us last year's Social Security wages from your business",
  'retirement.planOffersRoth': 'Tell us whether your plan offers Roth deferrals',
  'retirement.otherPlanDeferrals': 'Tell us your deferrals to other workplace plans this year',
  'household.expectedDate': 'Tell us the expected date for the baby',
  'tax.vaItemizedEstimate': 'Enter your Virginia itemized deduction estimate',
  'household.filingStatus': 'Tell us your filing status',
});

const yesNo = label => ({ type: 'boolean', label });
const dollars = label => ({ type: 'number', unit: 'USD', min: 0, label });
const birthYear = label => ({ type: 'number', unit: 'year', min: MIN_BIRTH_YEAR, max: 2200, integer: true, label });

export const ANSWER_SHAPES = Object.freeze({
  'business.entities': { scope: 'household', type: 'array', minItems: 1, maxItems: 100, label: 'Business entity classifications', items: { type: 'object', fields: {
    name: { type: 'string', label: 'Entity name', maxLength: 200 },
    type: { type: 'choice', label: 'Entity classification', choices: [
      ['s_corp', 'S corp'], ['sole_prop', 'sole proprietorship'], ['llc_single', 'single member LLC'], ['partnership', 'partnership'],
      ['c_corp', 'C corp'], ['personal', 'personal summary'], ['income_history', 'income history'], ['inactive', 'inactive past business'], ['not_mine', 'not mine'],
    ].map(([value, label]) => ({ value, label })) },
    owner: { type: 'choice', optional: true, label: 'Person or business owner', choices: [{ value: 'owner', label: 'you' }, { value: 'spouse', label: 'your spouse' }] },
    sstb: { ...yesNo('Specified service trade or business'), optional: true },
  } } },
  'business.entityInference': { scope: 'household', type: 'map', label: 'Undo an inferred entity classification', values: { type: 'object', fields: { undone: yesNo('Undo this inferred classification?') } } },
  'accounts.businessEntity': { scope: 'account', accountKind: 'business', type: 'string', maxLength: 200, label: 'Business name for {account}' },
  'household.dependentAges': { scope: 'household', type: 'years', min: 0, max: 120, maxItems: 10, label: 'Dependent ages' },
  'household.dependentBirthDates': { scope: 'household', type: 'dates', maxItems: 10, label: 'Dependent birth dates' },
  'household.ownerBirthDate': { scope: 'household', type: 'date', label: 'Your birth date' },
  'household.spouseBirthDate': { scope: 'household', type: 'date', label: 'Your spouse birth date' },
  'household.retireAge': { scope: 'person', type: 'number', min: 18, max: 100, half: true, unit: 'age', label: 'Retirement age for {person}' },
  'obligations.mortgage': { scope: 'household', type: 'object', fields: {
    paidOff: { ...yesNo('Mortgage is paid off'), optional: true, ask: false },
    balance: { ...dollars('Mortgage balance'), optional: true }, rate: { type: 'number', min: 0, max: 1, unit: 'ratio', optional: true, label: 'Annual mortgage rate' },
    monthlyPayment: { ...dollars('Monthly mortgage payment including escrow'), exclusiveMin: 0, optional: true },
    escrowMonthly: { ...dollars('Monthly escrow continuing after payoff'), optional: true }, payoffDate: { type: 'date', optional: true, ask: false, label: 'Mortgage payoff date' },
  } },
  'obligations.childcare': { scope: 'household', type: 'object', fields: {
    schoolAgeMonthly: { ...dollars('Monthly care at school age'), optional: true },
    afterCareEndMonthly: { ...dollars('Monthly care after care ends'), optional: true },
  } },
  'obligations.childcareChangeDate': { scope: 'household', type: 'date', label: 'Childcare change date' },
  'accounts.planType': { scope: 'account', accountKinds: ['retirement','roth','ira','taxable','brokerage'], type: 'choice', label: 'Plan type for {account}',
    choices: ['traditional_ira','roth_ira','sep_ira','401k','roth_401k','solo_401k','403b','457b','hsa','529','taxable'].map(value => ({value,label:value})) },
  'accounts.rothFirstContributionYear': { scope: 'account', accountEligibility: 'roth', type: 'number', min: 1975, currentYear: true, integer: true, unit: 'year', label: 'First Roth contribution year for {account}' },
  'accounts.rothBasis': { scope: 'account', accountEligibility: 'roth', ...dollars('Roth contribution basis for {account}') },
  'accounts.separationDate': { scope: 'account', accountEligibility: 'employer', type: 'date', label: 'Separation date for {account}' },

  'household.filingStatusDefault': { scope: 'household', ...yesNo('Undo the joint filing assumption?') },
  'business.cashBasisDefault': { scope: 'household', ...yesNo('Undo the cash-basis assumption?') },
  'accounts.va529CarryforwardDefault': { scope: 'account', accountKind: '529', type: 'object', fields: { undone: yesNo('Undo the carryforward assumption?') } },
  'pnl.ledgers': { scope: 'household', type: 'map', label: 'Which imported ledgers are spending or businesses?', values: {
    type: 'object', fields: { kind: { type: 'choice', ownerInterpreted: true, label: 'What does this ledger track?', choices: [{ value: 'spending', label: 'Spending ledger' }, { value: 'business', label: 'Business' }] } },
  } },
  'pnl.people': { scope: 'household', type: 'map', label: 'Who each personal summary belongs to', values: { type: 'choice', ownerInterpreted: true,
    label: 'Whose summary is this?', choices: [{ value: 'owner', label: 'you' }, { value: 'spouse', label: 'your spouse' }] } },
  'retirement.planTermsConfirmed': { scope: 'household', ...yesNo('Has your advisor confirmed your retirement plan terms and eligibility?') },
  'retirement.aggregationConfirmed': { scope: 'household', ...yesNo('Has your advisor confirmed no related business shares your plan limits?') },
  'benefits.hsaEligible': { scope: 'household', ...yesNo('Is your health plan HSA eligible for the whole year?') },
  'benefits.hsaCoverage': { scope: 'household', type: 'choice', label: 'Who does your HSA health plan cover?', choices: [{ value: 'self', label: 'Just you' }, { value: 'family', label: 'Family' }] },
  'business.salaryRange': { scope: 'household', type: 'object', fields: { min: { ...dollars('What is the lowest annual salary your advisor considers reasonable?'), exclusiveMin: 0 }, max: { ...dollars('What is the highest annual salary your advisor considers reasonable?'), exclusiveMin: 0 } } },
  'business.cashBasis': { scope: 'household', ...yesNo('Does your business keep its books on a cash basis?') },
  // One source of every age (70 or older, catch-up at 50, RMD age). Only owner and, when filing
  // jointly, spouse get a form field; dependents are recorded from free text in Ask.
  'household.birthYears': { scope: 'household', type: 'object', label: 'The years you, your spouse and your dependents were born', fields: {
    owner: birthYear('What year were you born?'),
    spouse: { ...birthYear('What year was your spouse born?'), optional: true, requires: { fact: 'household.filingStatus', value: 'mfj' } },
    dependents: { type: 'years', optional: true, ask: false, min: MIN_BIRTH_YEAR, max: 2200, maxItems: MAX_DEPENDENTS, label: 'What years were your dependents born?' },
  } },
  'accounts.va529': { scope: 'account', accountKind: '529', type: 'object', fields: {
    virginiaPlan: yesNo(VIRGINIA_PLAN_QUESTION),
    carryforward: { ...dollars('How much unused Virginia deduction carries forward to this year for {account}?'), when: { virginiaPlan: true } },
  } },
  // Undo of an inferred virginiaPlan answer: the account goes back to asking.
  'accounts.va529Inference': { scope: 'account', accountKind: '529', type: 'object', fields: {
    undone: yesNo('Did you undo the Virginia plan answer inferred from the institution?'),
  } },
  'business.onlyEmployee': { scope: 'household', ...yesNo('Do you own the whole business with no employees, including your spouse?') },
  'retirement.priorYearFicaWages': { scope: 'person', ...dollars('How much did {person} receive in Social Security wages from the plan sponsor last year?') },
  'retirement.planOffersRoth': { scope: 'household', ...yesNo('Does your retirement plan offer Roth deferrals?') },
  'retirement.otherPlanDeferrals': { scope: 'person', type: 'object', fields: { deferral: dollars('How much did {person} defer to other workplace plans this year, excluding catch-up?'), catchUp: dollars('How much did {person} contribute as catch-up to other workplace plans this year?') } },
  'household.expectedDate': { scope: 'household', type: 'date', label: 'When is the baby expected?' },
  'tax.vaItemizedEstimate': { scope: 'household', ...dollars('What is your Virginia itemized deduction estimate for this year?') },
  'household.filingStatus': { scope: 'household', type: 'choice', label: 'What is your filing status?', choices: [{ value: 'mfj', label: 'Married filing jointly' }, { value: 'mfs', label: 'Married filing separately' }, { value: 'single', label: 'Single' }, { value: 'hoh', label: 'Head of household' }, { value: 'qss', label: 'Qualifying surviving spouse' }] },
});

export function answerShape(key) {
  if (!Object.hasOwn(ANSWER_SHAPES, key)) throw new TypeError(`No answer shape for ${key}`);
  return ANSWER_SHAPES[key];
}

export function acceptsAnswerAccount(shape, account, facts) {
  const plan = facts['accounts.planType']?.[account.id];
  if (shape.accountEligibility === 'employer') return EMPLOYER_PLAN_TYPES.includes(plan);
  if (shape.accountEligibility === 'roth') return account.kind === 'roth' || ['roth_ira','roth_401k'].includes(plan);
  if (shape.accountKinds) return shape.accountKinds.includes(account.kind);
  return shape.accountKind === '529' ? isCollegeAccount(account) : account.kind === shape.accountKind;
}

// A form field is asked unless its shape part says otherwise: ask: false (recorded from free text
// only) or requires: {fact, value} (a spouse field only when filing jointly).
const asked = (def, facts) => def.ask !== false && (!def.requires || facts[def.requires.fact] === def.requires.value);

// The question a rec asks: one field per unanswered or answered part, each carrying its saved value.
// A Virginia plan field with no saved answer takes the answer inferred from the account's
// institution (`inferred` holds the evidence and the account, for Undo). `answered` is true when
// every active field holds a value, so the rec shows Answered instead of the questions.
export function questionFor(keys, { accounts = [], facts = {}, names = {}, people, mortgage } = {}) {
  const fields = [];
  const unique = [...new Set(keys)].filter(key => !ADVISOR_KEYS.has(key));
  for (const key of unique) {
    const shape = answerShape(key);
    const groups = shape.scope === 'account'
      ? accounts.filter(a => acceptsAnswerAccount(shape, a, facts)).map(a => ({ path: [a.id], account: accountLabel({ ...a, householdNames: names }), record: a }))
      : shape.scope === 'person'
        ? (people || (facts['household.filingStatus'] === 'mfj' ? ['owner', 'spouse'] : ['owner'])).map(p => ({ path: [p], person: p === 'owner' ? 'you' : 'your spouse' }))
        : [{ path: [] }];
    for (const group of groups) {
      const parts = shape.type === 'object' ? Object.entries(shape.fields).filter(([, def]) => asked(def, facts)) : [['', shape]];
      for (const [part, def] of parts) {
        if (key === 'obligations.mortgage' && mortgage?.inferred[part]) continue;
        const path = [...group.path, ...(part ? [part] : [])];
        let value = path.reduce((v, p) => v && typeof v === 'object' && Object.hasOwn(v, p) ? v[p] : undefined, facts[key]);
        const inference = key === 'accounts.va529' && part === 'virginiaPlan' && value === undefined ? activeInference(group.record, facts) : null;
        if (inference) value = inference.value;
        if (key === 'accounts.va529' && part === 'carryforward' && value === undefined
          && facts['accounts.va529CarryforwardDefault']?.[group.path[0]]?.undone !== true) value = facts['accounts.va529Carryforward']?.[group.path[0]];
        const label = def.label.replaceAll('{account}', group.account || '').replaceAll('{person}', group.person || 'you');
        fields.push({
          ...def, key, path, id: JSON.stringify([key, ...path]), label, ...(group.account ? { group: group.account } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(inference ? { inferred: { accountId: group.record.id, evidence: inference.evidence } } : {}),
          ...(def.when ? { when: { path: [...group.path, Object.keys(def.when)[0]], value: Object.values(def.when)[0] } } : {}),
        });
      }
    }
  }
  const byId = new Map(fields.map(f => [f.id, f]));
  const active = f => !f.when || byId.get(JSON.stringify([f.key, ...f.when.path]))?.value === f.when.value;
  const answered = fields.length > 0 && fields.filter(active).every(f => f.value !== undefined);
  const labels = unique.includes('accounts.va529') ? accounts.filter(isCollegeAccount).map(a => accountLabel({ ...a, householdNames: names })) : [];
  const years = unique.includes('household.birthYears') ? ' Tell us your birth year, and your spouse\'s when you file jointly; every age comes from it.' : '';
  const summary = labels.length
    ? `For ${labels.map(dataText).join(', ')}, tell us whether it is Virginia's own 529 program. For each Virginia plan, enter the unused deduction carryforward.${years}`
    : years ? years.trim() : unique.includes('obligations.mortgage') ? 'Tell Fathom only the missing mortgage terms. The other terms are inferred from loan data; correct them in Ask.' : 'Save these answers to update your plan automatically.';
  const first = fields[0];
  const title = first ? (first.group ? `${first.group}: ${first.label}` : first.label) : 'Answer the questions for your plan';
  return { keys: unique, ...(people ? { people } : {}), title, summary, answered, fields };
}

export const confirmTask = key => (answerShape(key), CONFIRM_TASKS[key]);

export function confirmTasks(keys) {
  keys.forEach(answerShape);
  return [];
}

// First plan year of a sole proprietor's solo 401(k) (IRC 401(b)(2) as amended by SECURE 2.0
// s.317): only for a sole proprietor with no plan on file. 'eligible' when the owner holds the whole
// business and it has no employees (the spouse included), 'no' when not, 'unknown' until answered;
// null for anyone else.
export function firstYearStatus(ctx) {
  const solo = ctx.info && ctx.info.solo;
  if (!solo || solo.kind !== 'sole' || ctx.facts['retirement.solo401k'] === true) return null;
  const answer = ctx.facts['business.onlyEmployee'];
  return answer === true ? 'eligible' : answer === false ? 'no' : 'unknown';
}

// Which deadline a solo 401(k) deferral follows: 'payroll' (an S corp owner, or no sponsor known),
// 'firstYear' (Apr 15 next year: an eligible sole proprietor's first plan year, and the pending
// answer that decides it) or 'dec31' (an established sole proprietor plan, an ineligible sole
// proprietor, a partnership).
export function deferralDeadline(ctx) {
  const kind = ctx.info && ctx.info.solo ? ctx.info.solo.kind : null;
  if (kind === 'sole') return firstYearStatus(ctx) === 'eligible' || firstYearStatus(ctx) === 'unknown' ? 'firstYear' : 'dec31';
  if (kind === 'partnership') return 'dec31';
  return 'payroll';
}

export function deadlineWindow(ctx, deadline, payrollLabel) {
  if (deadline === 'firstYear') return { close: `${ctx.year + 1}-04-15`, label: 'Apr 15', hard: true };
  if (deadline === 'dec31') return { close: `${ctx.year}-12-31`, label: 'Dec 31', hard: true };
  return { close: lastPayroll(ctx), label: payrollLabel, hard: true };
}


// Default owners that follow a person in the household data; without one, the trigger's static
// owner. soloPlanOwner: the person whose solo plan this is (retirement recs). modelPersonOwner: the
// person whose business the war-game model covers (hit.person); a confirm form has no model.
export const soloPlanOwner = fallback => ctx => (ctx.info && ctx.info.solo ? personOwner(ctx.info.solo.person) : fallback);
export const modelPersonOwner = fallback => (ctx, hit) => (hit && hit.person ? personOwner(hit.person) : fallback);

// Shared pieces for trigger modules: gate builders, year-generic windows, grounded figure lists,
// confirm-form text and task padding. Template text here follows the prose rule: no digits outside
// tokens and no number words; dates are written as month and day.

import { isIsoDate } from '../../scenario/build.mjs';
import { esc } from '../../shared/tokens.mjs';
import { personOwner } from '../../shared/rec-links.mjs';
import { accountLabel } from '../../shared/account-label.mjs';

// Data-derived text (entity and account names) as stored rec HTML: escaped, braces included, so it
// can never carry markup or a scenario token.
export const dataText = v => esc(v).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

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

const GENERIC_TASKS = ['Review the figures behind this on the plan', 'Mark it done once it is handled', 'Ask a follow-up question if anything looks off'];

export function padTasks(list) {
  const tasks = [...new Set(list.filter(Boolean))].slice(0, 6);
  for (const t of GENERIC_TASKS) if (tasks.length < 3 && !tasks.includes(t)) tasks.push(t);
  return tasks.map(t => ({ t }));
}

export const CONFIRM_TASKS = Object.freeze({
  'retirement.planTermsConfirmed': 'Confirm your retirement plan terms with your advisor',
  'retirement.aggregationConfirmed': 'Confirm no related business shares your plan limits',
  'benefits.hsaEligible': 'Confirm your health plan is HSA eligible for the whole year',
  'benefits.hsaCoverage': 'Tell us whether the HSA plan covers just you or your family',
  'business.salaryRange': 'Ask your advisor for a reasonable salary range and enter it',
  'business.cashBasis': 'Confirm the business keeps its books on a cash basis',
  'household.ownerAge': 'Tell us your age',
  'household.spouseAge': "Tell us your spouse's age",
  'accounts.va529': 'Tell us which college savings accounts are Virginia plans, whether the owner is seventy or older, and any carryforward',
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
const age = label => ({ type: 'number', unit: 'years', min: 0, max: 120, integer: true, label });

export const ANSWER_SHAPES = Object.freeze({
  'retirement.planTermsConfirmed': { scope: 'household', ...yesNo('Has your advisor confirmed your retirement plan terms and eligibility?') },
  'retirement.aggregationConfirmed': { scope: 'household', ...yesNo('Has your advisor confirmed no related business shares your plan limits?') },
  'benefits.hsaEligible': { scope: 'household', ...yesNo('Is your health plan HSA eligible for the whole year?') },
  'benefits.hsaCoverage': { scope: 'household', type: 'choice', label: 'Who does your HSA health plan cover?', choices: [{ value: 'self', label: 'Just you' }, { value: 'family', label: 'Family' }] },
  'business.salaryRange': { scope: 'household', type: 'object', fields: { min: { ...dollars('What is the lowest annual salary your advisor considers reasonable?'), exclusiveMin: 0 }, max: { ...dollars('What is the highest annual salary your advisor considers reasonable?'), exclusiveMin: 0 } } },
  'business.cashBasis': { scope: 'household', ...yesNo('Does your business keep its books on a cash basis?') },
  'household.ownerAge': { scope: 'household', ...age('How old are you at the end of the planning tax year?') },
  'household.spouseAge': { scope: 'household', ...age('How old is your spouse at the end of the planning tax year?') },
  'accounts.va529': { scope: 'account', accountKind: '529', type: 'object', fields: {
    virginiaPlan: yesNo('Is {account} a Virginia plan?'),
    ownerAge70Plus: { ...yesNo('Is the owner of {account} age 70 or older?'), when: { virginiaPlan: true } },
    carryforward: { ...dollars('How much unused Virginia deduction carries forward to this year for {account}?'), when: { virginiaPlan: true } },
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

export function questionFor(keys, { accounts = [], facts = {}, names = {} } = {}) {
  const fields = [];
  const unique = [...new Set(keys)];
  for (const key of unique) {
    const shape = answerShape(key);
    const groups = shape.scope === 'account'
      ? accounts.filter(a => a.kind === shape.accountKind).map(a => ({ path: [a.id], account: accountLabel({ ...a, householdNames: names }) }))
      : shape.scope === 'person'
        ? (facts['household.filingStatus'] === 'mfj' ? ['owner', 'spouse'] : ['owner']).map(p => ({ path: [p], person: p === 'owner' ? 'you' : 'your spouse' }))
        : [{ path: [] }];
    for (const group of groups) {
      const parts = shape.type === 'object' ? Object.entries(shape.fields) : [['', shape]];
      for (const [part, def] of parts) {
        const path = [...group.path, ...(part ? [part] : [])];
        const value = path.reduce((v, p) => v && typeof v === 'object' && Object.hasOwn(v, p) ? v[p] : undefined, facts[key]);
        const label = def.label.replaceAll('{account}', group.account || '').replaceAll('{person}', group.person || 'you');
        fields.push({ ...def, key, path, id: JSON.stringify([key, ...path]), label, ...(value !== undefined ? { value } : {}), ...(def.when ? { when: { path: [...group.path, Object.keys(def.when)[0]], value: Object.values(def.when)[0] } } : {}) });
      }
    }
  }
  const labels = unique.includes('accounts.va529') ? accounts.filter(a => a.kind === '529').map(a => accountLabel({ ...a, householdNames: names })) : [];
  const summary = labels.length ? `For ${labels.map(dataText).join(', ')}, tell us whether it is a Virginia plan. For each Virginia plan, enter the owner age answer and unused deduction carryforward.` : 'Save these answers to update your plan automatically.';
  return { keys: unique, title: fields[0]?.label || 'Answer the questions for your plan', summary, fields };
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

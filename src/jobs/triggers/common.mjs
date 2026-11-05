// Shared pieces for trigger modules: gate builders, year-generic windows, grounded figure lists,
// confirm-form text and task padding. Template text here follows the prose rule: no digits outside
// tokens and no number words; dates are written as month and day.

import { isIsoDate } from '../../scenario/build.mjs';
import { esc } from '../../shared/tokens.mjs';

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

const CONFIRM_TASKS = Object.freeze({
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
});

export const confirmTask = key => CONFIRM_TASKS[key] || 'Answer the open question in your household settings';

export function confirmTasks(keys) {
  return padTasks([...keys.map(confirmTask), 'Run planning again once you have answered']);
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


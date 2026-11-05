// Virginia 529 deduction: deduction room left on Virginia plan accounts before Dec 31 (S8, T5).

import { isTrue, mineOf, padTasks, confirmTasks, yearOf } from './common.mjs';

export const id = 'va529';
export const domain = 'family';
export const trigger = 'calendar';
export const packs = ['virginia-resident', 'kids-dependents'];
export const gate = { all: [isTrue('accounts.has529'), { fact: 'household.state', op: 'eq', value: 'VA' }] };
export const calcs = ['virginiaIncomeTax'];
export const kb = [{ pack: 'virginia-resident', entry: 'virginia529-deduction' }, { pack: 'virginia-resident', entry: 'virginia529-carryforward' }];

export function window(ctx) {
  return { close: `${yearOf(ctx)}-12-31`, label: 'Dec 31', hard: true };
}

export function evaluate(ctx) {
  if (!ctx.year) return null;
  const info = ctx.info.va529 || { accounts: 0, missing: [], age70: [], eligible: 0 };
  if (!info.accounts) return null;
  if (info.missing.length) return { confirm: ['accounts.va529'], grounding: ['va529.contrib.ytd'] };
  if (!info.eligible) return null;
  if (ctx.info.blocked.length) return { blocked: ctx.info.blocked[0] };
  if (ctx.info.vaBlocked) return { blocked: ctx.info.vaBlocked };
  if (!(ctx.fig['va529.deductionLeft'] && ctx.fig['va529.deductionLeft'].v > 0)) return null;
  return { grounding: ['va529.deductionLeft', 'va529.taxSaved', 'va529.contrib.ytd'], age70: info.age70 };
}

export function build(ctx, hit) {
  if (hit.confirm) {
    return {
      title: 'Confirm your college savings accounts so we can size the Virginia deduction',
      effort: 'A few minutes',
      value: [{ cls: 'tax', text: 'Unlocks the Virginia deduction recommendation' }],
      mine: mineOf(ctx, hit.grounding, { actualOnly: true }),
      cross: [],
      tasks: confirmTasks(hit.confirm),
    };
  }
  return {
    title: 'Use the rest of this year Virginia 529 deduction',
    effort: 'A few minutes',
    value: [{ cls: 'tax', text: 'Lowers Virginia tax this year' }, { cls: 'goal', text: 'Builds college savings' }],
    mine: mineOf(ctx, hit.grounding),
    cross: [],
    tasks: padTasks([
      'Decide how much to add before Dec 31',
      'Transfer it into the Virginia plan account',
      'Keep the contribution confirmation for the return',
      ...(hit.age70 || []).map(name => `Ask your advisor how the older-owner exception applies to ${name}`),
    ]),
  };
}

export function template(ctx, hit) {
  if (hit.confirm) {
    return {
      summary: 'Tell us which college savings accounts are Virginia plans you own and we will size the deduction left this year.',
      why: ['Virginia deducts contributions per account up to {l:va529Cap} a year, but only for Virginia plans owned by the household.'],
      qa: [],
    };
  }
  return {
    summary: 'You can still deduct {f:va529.deductionLeft} of Virginia 529 contributions this year, worth about {f:va529.taxSaved} in Virginia tax.',
    why: [
      'Virginia allows a deduction of up to {l:va529Cap} per account each year; you have contributed {f:va529.contrib.ytd} so far.',
      'Contributions above the limit carry forward to later years, so nothing is lost by putting in more.',
    ],
    qa: [{ q: 'Does the money have to stay in the plan?', a: ['Withdrawals for qualified education costs stay tax free. Other withdrawals can recapture the deduction.'] }],
  };
}

// Charitable bunching: give two years of gifts in one year to clear the standard deduction.

import { isTrue, mineOf, padTasks, yearOf, positive } from './common.mjs';

export const id = 'charitable-bunching';
export const domain = 'giving';
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['giving', 'tax']);
export const owner = 'both';
export const trigger = 'goal';
export const packs = ['charitable-giving'];
export const gate = isTrue('giving.charitable');
export const calcs = ['federalIncomeTax'];
export const kb = [{ pack: 'charitable-giving', entry: 'bunching' }, { pack: 'charitable-giving', entry: 'donor-advised-funds' }];

export function window(ctx) {
  return { close: `${yearOf(ctx)}-12-31`, label: 'Dec 31', hard: false };
}

export function evaluate(ctx) {
  if (!ctx.year) return null;
  if (!positive(ctx, 'giving.trailing')) return null;
  return { grounding: ['giving.trailing', 'giving.twoYear', 'giving.ytd'] };
}

export function build(ctx, hit) {
  return {
    title: 'Consider bunching next year gifts into this year',
    effort: 'Under an hour',
    value: [{ cls: 'tax', text: 'Can turn gifts into an itemized deduction' }, { cls: 'goal', text: 'Same giving, better timing' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['A donor-advised fund lets you take the deduction now and grant the money over time.'],
    tasks: padTasks([
      'Add up the gifts you plan for next year',
      'Ask your accountant whether bunching clears the standard deduction',
      'Open or fund a donor-advised fund before Dec 31',
      'Keep the acknowledgment letters',
    ]),
  };
}

const STD_KEY = { mfj: 'stdDeductionMfj', qss: 'stdDeductionMfj', hoh: 'stdDeductionHoh' };

export function template(ctx) {
  const std = STD_KEY[ctx.facts['household.filingStatus']] || 'stdDeductionSingle';
  return {
    summary: 'You gave {f:giving.trailing} over the last year. Giving next year gifts now as well, about {f:giving.twoYear} in total, may beat the standard deduction.',
    why: [
      `Gifts only lower tax when your itemized deductions pass your standard deduction of {l:${std}}.`,
      'Bunching packs a pair of years of gifts into a single tax year, then takes the standard deduction the year after.',
    ],
    qa: [{ q: 'Do I have to give the money away this year?', a: ['Not to the charity. A donor-advised fund takes the gift now and lets you choose the charities later.'] }],
  };
}

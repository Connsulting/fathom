// Dependent care FSA: an outside employer and a child in care, before open enrollment closes.

import { isTrue, mineOf, padTasks, yearOf, factDate } from './common.mjs';
import { TRIGGER_INPUTS } from '../../shared/rec-inputs.mjs';

export const id = 'dependent-care-fsa';
export const domain = 'family';
// Inputs the action reads (src/shared/rec-inputs.mjs): outside employer wages this year.
export const inputs = TRIGGER_INPUTS['dependent-care-fsa'];
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['tax', 'cash']);
export const owner = 'both';
export const trigger = 'calendar';
export const packs = ['kids-dependents', 'w2-benefits'];
export const gate = {
  all: [
    { any: [{ fact: 'household.dependents', op: 'gt', value: 0 }, isTrue('household.expectingChild')] },
    isTrue('income.w2'),
  ],
};
export const calcs = ['dependentCareLimit'];
export const kb = [{ pack: 'w2-benefits', entry: 'dependent-care-fsa' }, { pack: 'kids-dependents', entry: 'care-credit-fsa' }];

export function window(ctx) {
  const ends = factDate(ctx, 'benefits.openEnrollmentEnds');
  if (ends) return { close: ends, label: 'Open enrollment ends', hard: false };
  return { close: `${yearOf(ctx)}-12-31`, label: 'Open enrollment', hard: false };
}

export function evaluate() {
  return { grounding: ['inc.ytd.w2'] };
}

export function build(ctx, hit) {
  return {
    title: 'Enroll in a dependent care FSA for next year',
    effort: 'A few minutes',
    value: [{ cls: 'tax', text: 'Pays for child care with pre-tax wages' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['The child and dependent care credit and the FSA cannot cover the same dollars.'],
    tasks: padTasks([
      'Estimate next year child care costs',
      'Elect the dependent care FSA during open enrollment',
      'Keep provider receipts for reimbursement',
    ]),
  };
}

export function template() {
  return {
    summary: 'An outside employer plan lets you set aside up to {l:dcfsaCap} a year of pre-tax wages for child care.',
    why: ['The election is made during open enrollment and generally cannot change mid-year without a qualifying event.'],
    qa: [{ q: 'Does a newborn count?', a: ['Yes, once care costs start. A birth is a qualifying event that lets you change the election.'] }],
  };
}

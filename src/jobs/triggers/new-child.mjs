// New child: an expected child, with the expected date as the window when the household gave one.

import { isTrue, mineOf, padTasks, factDate } from './common.mjs';
import { dayLabel } from '../planner/data.mjs';

export const id = 'new-child';
export const domain = 'family';
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['cash', 'health']);
export const owner = 'both';
export const trigger = 'life';
export const packs = ['kids-dependents'];
export const gate = isTrue('household.expectingChild');
export const calcs = [];
export const kb = [{ pack: 'kids-dependents', entry: 'expected-child' }, { pack: 'kids-dependents', entry: 'child-tax-credit' }];

export function window(ctx) {
  const due = factDate(ctx, 'household.expectedDate');
  return due ? { close: due, label: dayLabel(due), hard: false } : null;
}

export function evaluate(ctx) {
  return { grounding: ['cash.personal', 'cash.monthlyOut'], ...(!factDate(ctx, 'household.expectedDate') ? { questions: ['household.expectedDate'] } : {}) };
}

export function build(ctx, hit) {
  return {
    title: 'Get ready for the new baby',
    effort: 'A few short sessions',
    value: [{ cls: 'risk', text: 'Avoids missed credits and coverage gaps' }, { cls: 'cash', text: 'Plans for leave and new costs' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['A birth lets you change workplace benefit elections, including a dependent care FSA.'],
    tasks: padTasks([
      'Apply for a Social Security number at the hospital',
      'Add the baby to health coverage within the enrollment window',
      'Update beneficiaries and your will',
    ]),
  };
}

export function template() {
  return {
    summary: 'A new child changes your credits, coverage and cash needs; a few steps around the birth keep them on track.',
    why: [
      'The child tax credit of {l:ctcPerChild} per child starts in the year the child is born, once the child has a Social Security number.',
      'Health coverage has to be updated within a short window after the birth.',
    ],
    qa: [{ q: 'Do we get the credit if the baby arrives late in the year?', a: ['Yes. A child born at any point in the year counts for the whole year.'] }],
  };
}

// Year-end retirement: employee deferral room left before the last payroll (R5, R10).

import { isTrue, lastPayroll, mineOf, padTasks, confirmTasks, salaryProjKey, salaryKey, positive } from './common.mjs';

export const id = 'year-end-retirement';
export const domain = 'retirement';
export const trigger = 'calendar';
export const packs = ['advanced-retirement', 's-corp-owner', 'self-employed-partnership'];
export const gate = { any: [isTrue('retirement.solo401k'), isTrue('income.sCorp'), isTrue('income.selfEmployed')] };
export const calcs = ['solo401kRoom', 'sepRoom'];
export const needsYear = true;
export const kb = [
  { pack: 'advanced-retirement', entry: 'contribution-deadlines' },
  { pack: 'advanced-retirement', entry: 'solo-401k-versus-sep' },
  { pack: 's-corp-owner', entry: 'retirement-compensation' },
];

export function window(ctx) {
  return { close: lastPayroll(ctx), label: 'Last payroll', hard: true };
}

export function evaluate(ctx) {
  if (ctx.info.blocked.length) return { blocked: ctx.info.blocked[0] };
  if (ctx.info.confirm.retirement) return { confirm: ctx.info.confirm.retirement, grounding: [salaryKey(ctx)].filter(Boolean) };
  // The solo 401(k) room this rec rests on could not be computed: missing data, not a closed
  // condition, even when SEP room exists (S12, G2).
  if ((ctx.info.calcFailed || []).includes('solo401kRoom')) return { blocked: 'calc_failed' };
  // R10: only employee deferrals have a year-end (last payroll) deadline; SEP room alone does not fire.
  if (!positive(ctx, 'room.solo401k.employee')) return null;
  return { grounding: ['room.solo401k.employee', 'room.solo401k.employer', 'room.solo401k', 'room.sep', salaryProjKey(ctx)].filter(Boolean) };
}

export function build(ctx, hit) {
  if (hit.confirm) {
    return {
      title: 'Confirm your retirement plan details so we can size your year-end room',
      effort: 'A short conversation',
      value: [{ cls: 'retire', text: 'Unlocks a sized retirement recommendation' }],
      mine: mineOf(ctx, hit.grounding, { actualOnly: true }),
      cross: [],
      tasks: confirmTasks(hit.confirm),
    };
  }
  return {
    title: 'Fill your retirement room before the last payroll',
    effort: 'Under an hour',
    value: [{ cls: 'retire', text: 'Moves income into tax-deferred savings' }, { cls: 'tax', text: 'Lowers this year tax' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['Employer contributions can be funded up to the return due date, including extensions, so only the employee deferral is tied to the last payroll.'],
    tasks: padTasks([
      'Confirm the deferral amount with your payroll provider',
      'Elect the deferral before the last payroll runs',
      'Plan the employer contribution with your accountant',
      'Check that the deposit lands in the plan account',
    ]),
  };
}

export function template(ctx, hit) {
  if (hit.confirm) {
    return {
      summary: 'We need a few answers about your retirement plan before we can size the room left this year.',
      why: ['Plan terms, related businesses and your age all change the limits, so we only show a number once they are confirmed.'],
      qa: [],
    };
  }
  const summary = 'You can still defer {f:room.solo401k.employee} into your solo 401(k) through payroll before the last payroll of the year.';
  const why = [];
  if (ctx.fig['room.solo401k.employer']) why.push('On top of that, the business can add up to {f:room.solo401k.employer} as an employer contribution.');
  why.push('Employee deferrals have to come out of a paycheck, so the last payroll of the year is the real deadline.');
  return {
    summary,
    why,
    qa: [{ q: 'Is the employer part due by the same date?', a: ['No. The employer contribution can be deposited up to the business return due date, including extensions.'] }],
  };
}

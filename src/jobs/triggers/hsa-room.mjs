// HSA room: contribution room left for the year, due by the federal filing date (R6, S4).

import { isTrue, mineOf, padTasks, confirmTasks } from './common.mjs';

export const id = 'hsa-room';
export const domain = 'retirement';
export const trigger = 'calendar';
export const packs = ['w2-benefits', 'advanced-retirement'];
export const gate = isTrue('benefits.hsa');
export const calcs = ['hsaLimit'];
export const kb = [{ pack: 'w2-benefits', entry: 'hsa-limits' }, { pack: 'w2-benefits', entry: 'hsa-eligibility' }];

export function window(ctx) {
  return ctx.year ? { close: `${ctx.year + 1}-04-15`, label: 'Apr 15', hard: true } : null;
}

export function evaluate(ctx) {
  if (!ctx.year) return null;
  if (ctx.info.confirm.hsa) return { confirm: ctx.info.confirm.hsa, grounding: ['hsa.contrib.ytd'] };
  if (!(ctx.fig['room.hsa'] && ctx.fig['room.hsa'].v > 0)) return null;
  return { grounding: ['room.hsa', 'hsa.contrib.ytd'] };
}

export function build(ctx, hit) {
  if (hit.confirm) {
    return {
      title: 'Confirm your HSA eligibility so we can size the room left this year',
      effort: 'A short conversation',
      value: [{ cls: 'tax', text: 'Unlocks a sized HSA recommendation' }],
      mine: mineOf(ctx, hit.grounding, { actualOnly: true }),
      cross: [],
      tasks: confirmTasks(hit.confirm),
    };
  }
  return {
    title: 'Top up your HSA for the year',
    effort: 'A few minutes',
    value: [{ cls: 'tax', text: 'Deductible now and tax-free for medical costs' }, { cls: 'retire', text: 'Can grow as a long-term account' }],
    mine: mineOf(ctx, hit.grounding),
    cross: [],
    tasks: padTasks([
      'Confirm your health plan stayed HSA eligible all year',
      'Transfer the amount into the HSA',
      'Mark the deposit as a contribution for this tax year',
    ]),
  };
}

export function template(ctx, hit) {
  if (hit.confirm) {
    return {
      summary: 'Tell us about your health plan coverage and we will size how much you can still put into the HSA.',
      why: ['HSA limits depend on eligible coverage for each month and on whether it covers just you or your family.'],
      qa: [],
    };
  }
  return {
    summary: 'You can still add {f:room.hsa} to your HSA for this tax year, up to the filing deadline.',
    why: [
      ctx.fig['hsa.contrib.ytd'] ? 'You have put in {f:hsa.contrib.ytd} so far this year.' : 'We do not see HSA contributions this year yet.',
      'Contributions made before the filing deadline can count for this year, so there is no rush before December.',
    ],
    qa: [{ q: 'Do payroll contributions count against the limit?', a: ['Yes. Employer and payroll contributions share the same annual limit as the ones you make yourself.'] }],
  };
}

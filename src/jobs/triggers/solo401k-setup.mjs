// Solo 401(k) setup: a business owner with no plan account on file, before the last payroll.

import { isTrue, absentOrFalse, lastPayroll, mineOf, padTasks } from './common.mjs';

export const id = 'solo401k-setup';
export const domain = 'retirement';
export const trigger = 'calendar';
export const packs = ['advanced-retirement', 's-corp-owner', 'self-employed-partnership'];
export const gate = { all: [{ any: [isTrue('income.sCorp'), isTrue('income.selfEmployed')] }, absentOrFalse('retirement.solo401k')] };
export const calcs = ['solo401kRoom'];
export const kb = [{ pack: 'advanced-retirement', entry: 'solo-401k-versus-sep' }, { pack: 'advanced-retirement', entry: 'aggregation-and-employees' }];

export function window(ctx) {
  return ctx.year ? { close: lastPayroll(ctx), label: 'Before last payroll', hard: true } : null;
}

export function evaluate(ctx) {
  if (!ctx.year) return null;
  return { grounding: ['room.solo401k', 'room.solo401k.employee'] };
}

export function build(ctx, hit) {
  return {
    title: 'Set up a solo 401(k) before the last payroll',
    effort: 'An afternoon',
    value: [{ cls: 'retire', text: 'Opens the largest pre-tax savings option for a business owner' }, { cls: 'timing', text: 'Has to exist before the deferral election' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['Once the plan exists, the year-end retirement recommendation sizes how much to put in.'],
    tasks: padTasks([
      'Pick a provider that supports solo 401(k) plans',
      'Adopt the plan document in the business name',
      'Sign a deferral election before the last payroll',
      'Tell us when the plan account is open',
    ]),
  };
}

export function template(ctx) {
  const sized = ctx.fig['room.solo401k'];
  return {
    summary: sized
      ? 'We do not see a solo 401(k) on file. Setting a plan up before the last payroll opens {f:room.solo401k} of room this year.'
      : 'We do not see a solo 401(k) on file. Setting a plan up before the last payroll lets you save through payroll this year.',
    why: [
      'A deferral has to be elected and withheld from pay, so the plan must exist before the final paycheck of the year.',
      'If you already have a plan, tell us and this goes away.',
    ],
    qa: [{ q: 'Why not a SEP IRA instead?', a: ['A SEP only takes employer contributions. A solo 401(k) adds employee deferrals on top, which usually means more room at the same income.'] }],
  };
}

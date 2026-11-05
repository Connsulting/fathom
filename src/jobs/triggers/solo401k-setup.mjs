// Solo 401(k) setup: a business owner with no plan account on file. The deadline follows the
// sponsor: an S corp owner defers through payroll, so the plan must exist before the last payroll; a
// sole proprietor who owns the whole business and has no employees may adopt a first plan after
// year end and defer this year's income until Apr 15 (IRC 401(b)(2) as amended by SECURE 2.0
// s.317); any other sole proprietor or partnership elects by Dec 31 (Treas. Reg.
// 1.401(k)-1(a)(6)(iii)). Until the only-employee answer is in, this is a confirm form whose window
// stays at Apr 15, so it never closes in December while the answer is pending.

import { isTrue, absentOrFalse, mineOf, padTasks, confirmTasks, firstYearStatus, deferralDeadline, deadlineWindow } from './common.mjs';

export const id = 'solo401k-setup';
export const domain = 'retirement';
export const trigger = 'calendar';
export const packs = ['advanced-retirement', 's-corp-owner', 'self-employed-partnership'];
export const gate = { all: [{ any: [isTrue('income.sCorp'), isTrue('income.selfEmployed')] }, absentOrFalse('retirement.solo401k')] };
export const calcs = ['solo401kRoom'];
export const needsYear = true;
export const kb = [
  { pack: 'advanced-retirement', entry: 'solo-401k-versus-sep' },
  { pack: 'advanced-retirement', entry: 'aggregation-and-employees' },
  { pack: 'advanced-retirement', entry: 'contribution-deadlines' },
];

export function window(ctx) {
  return deadlineWindow(ctx, deferralDeadline(ctx), 'Before last payroll');
}

export function evaluate(ctx) {
  if (firstYearStatus(ctx) === 'unknown') return { confirm: ['business.onlyEmployee'], grounding: [] };
  return { grounding: ['room.solo401k', 'room.solo401k.pretax', 'room.solo401k.employee'], deadline: deferralDeadline(ctx) };
}

const CROSS = 'Once the plan exists, the year-end retirement recommendation sizes how much to put in.';
const VALUE_RETIRE = { cls: 'retire', text: 'Opens the largest pre-tax savings option for a business owner' };

export function build(ctx, hit) {
  if (hit.confirm) {
    return {
      title: 'Tell us about your business so we can set your solo 401(k) deadline',
      effort: 'A few minutes',
      value: [{ cls: 'timing', text: 'Sets the right deadline for this year deferral' }],
      mine: mineOf(ctx, hit.grounding, { actualOnly: true }),
      cross: [CROSS],
      tasks: confirmTasks(hit.confirm),
    };
  }
  if (hit.deadline === 'firstYear') {
    return {
      title: "Set up a solo 401(k) and make this year's deferral by Apr 15",
      effort: 'An afternoon',
      value: [VALUE_RETIRE, { cls: 'timing', text: 'A first plan can still take this year deferral until the return is due' }],
      mine: mineOf(ctx, hit.grounding),
      cross: [CROSS],
      tasks: padTasks([
        'Adopt the plan in the business name',
        "Elect and deposit the deferral from this year's self-employment income before you file",
        'Plan the employer contribution with your accountant',
        'Tell us when the plan account is open',
      ]),
    };
  }
  if (hit.deadline === 'dec31') {
    return {
      title: 'Set up a solo 401(k) and sign the deferral election by Dec 31',
      effort: 'An afternoon',
      value: [VALUE_RETIRE, { cls: 'timing', text: 'Has to exist before the deferral election' }],
      mine: mineOf(ctx, hit.grounding),
      cross: [CROSS],
      tasks: padTasks([
        'Pick a provider that supports solo 401(k) plans',
        'Adopt the plan document in the business name',
        'Sign the deferral election by Dec 31',
        'Tell us when the plan account is open',
      ]),
    };
  }
  return {
    title: 'Set up a solo 401(k) before the last payroll',
    effort: 'An afternoon',
    value: [VALUE_RETIRE, { cls: 'timing', text: 'Has to exist before the deferral election' }],
    mine: mineOf(ctx, hit.grounding),
    cross: [CROSS],
    tasks: padTasks([
      'Pick a provider that supports solo 401(k) plans',
      'Adopt the plan document in the business name',
      'Sign a deferral election before the last payroll',
      'Tell us when the plan account is open',
    ]),
  };
}

const ALREADY = 'If you already have a plan, tell us and this goes away.';
const QA = [{ q: 'Why not a SEP IRA instead?', a: ['A SEP only takes employer contributions. A solo 401(k) adds employee deferrals on top, which usually means more room at the same income.'] }];

export function template(ctx, hit) {
  if (hit.confirm) {
    return {
      summary: "We do not see a solo 401(k) on file. Tell us whether you own the whole business and it has no employees, and we will set the deadline for this year's deferral.",
      why: [
        "A sole owner with no employees can adopt a first plan after year end and still defer this year's income until the return is due. Otherwise the deferral election is due by Dec 31.",
        ALREADY,
      ],
      qa: QA,
    };
  }
  const sized = ctx.fig['room.solo401k'];
  // Pre-tax wording names only the pre-tax figure; the total can include Roth-only catch-up room.
  const pretax = ctx.fig['room.solo401k.pretax'] ? ['Up to {f:room.solo401k.pretax} of that room can go in pre-tax.'] : [];
  if (hit.deadline === 'firstYear') {
    return {
      summary: sized
        ? 'We do not see a solo 401(k) on file. Adopting one by Apr 15 opens {f:room.solo401k} of room for this year.'
        : "We do not see a solo 401(k) on file. As the only owner and employee, you can adopt one by Apr 15 and still defer from this year's self-employment income.",
      why: [
        "As the sole owner with no employees, a plan adopted after year end can still take this year's deferral until the return due date, without extensions.",
        ...(sized ? pretax : []),
        ALREADY,
      ],
      qa: QA,
    };
  }
  if (hit.deadline === 'dec31') {
    return {
      summary: sized
        ? 'We do not see a solo 401(k) on file. Setting a plan up and signing the deferral election by Dec 31 opens {f:room.solo401k} of room this year.'
        : "We do not see a solo 401(k) on file. Setting a plan up and signing the deferral election by Dec 31 lets you defer from this year's self-employment income.",
      why: [
        'Self-employment income counts as paid on Dec 31, so the deferral election has to be signed by then.',
        ...(sized ? pretax : []),
        ALREADY,
      ],
      qa: QA,
    };
  }
  return {
    summary: sized
      ? 'We do not see a solo 401(k) on file. Setting a plan up before the last payroll opens {f:room.solo401k} of room this year.'
      : 'We do not see a solo 401(k) on file. Setting a plan up before the last payroll lets you save through payroll this year.',
    why: [
      'A deferral has to be elected and withheld from pay, so the plan must exist before the final paycheck of the year.',
      ...(sized ? pretax : []),
      ALREADY,
    ],
    qa: QA,
  };
}

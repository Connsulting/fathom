// Year-end retirement: solo 401(k) deferral and catch-up room left before the deferral deadline
// (R5, R10). The deadline follows the sponsor: the last payroll for an S corp owner, Dec 31 for an
// established sole proprietor or partnership plan (Treas. Reg. 1.401(k)-1(a)(6)(iii)), Apr 15 for an
// eligible sole proprietor's first plan year (IRC 401(b)(2) as amended by SECURE 2.0 s.317). The
// rec fires on regular, catch-up or Roth-only catch-up room (IRC 414(v)(2), 414(v)(7)(A)); Roth
// dollars never carry a tax-cut claim (IRC 402A(a)).

import {
  isTrue, mineOf, padTasks, confirmTasks, salaryProjKey, salaryKey, positive,
  firstYearStatus, deferralDeadline, deadlineWindow, soloPlanOwner,
} from './common.mjs';
import { blockedFor } from '../../shared/rec-inputs.mjs';

export const id = 'year-end-retirement';
export const domain = 'retirement';
// Inputs the action reads (src/shared/rec-inputs.mjs): the household tax run sizes the room; catch-up room follows birth years.
export const inputs = Object.freeze(['income', 'retirement', 'filing', 'ages']);
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['retirement', 'tax']);
export const owner = 'you';
export const ownerFor = soloPlanOwner(owner);
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
  return deadlineWindow(ctx, deferralDeadline(ctx), 'Last payroll');
}

export function evaluate(ctx) {
  const held = blockedFor(ctx, { inputs });
  if (held) return { blocked: held };
  const confirmed = [salaryKey(ctx)].filter(Boolean);
  if (ctx.info.confirm.retirement) return { confirm: ctx.info.confirm.retirement, grounding: confirmed };
  // The solo 401(k) room this rec rests on could not be computed: missing data, not a closed
  // condition, even when SEP room exists (S12, G2).
  if ((ctx.info.calcFailed || []).includes('solo401kRoom')) return { blocked: 'calc_failed' };
  // R10: only deferrals and catch-ups have a year-end deadline; SEP or employer room alone does not fire.
  const parts = {
    regular: positive(ctx, 'room.solo401k.employee'),
    catchUp: positive(ctx, 'room.solo401k.catchUp'),
    roth: positive(ctx, 'room.solo401k.rothCatchUp'),
  };
  if (!parts.regular && !parts.catchUp && !parts.roth) return null;
  // R2-6: a sole proprietor with no plan and no only-employee answer gets a confirm form and no
  // sized deferral, so nothing is sized for an April window the owner may not have.
  if (firstYearStatus(ctx) === 'unknown') return { confirm: ['business.onlyEmployee'], grounding: confirmed };
  return {
    grounding: [
      'room.solo401k.employee', 'room.solo401k.catchUp', 'room.solo401k.rothCatchUp', 'room.solo401k.pretax',
      'room.solo401k.employer', 'room.solo401k', 'room.sep', salaryProjKey(ctx),
    ].filter(Boolean),
    parts,
    deadline: deferralDeadline(ctx),
    catchUpPending: ctx.info.retireCatchUp || null,
  };
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
  const value = [{ cls: 'retire', text: 'Moves income into retirement savings' }];
  if (positive(ctx, 'room.solo401k.pretax')) value.push({ cls: 'tax', text: 'Can lower this year tax if you choose pre-tax' });
  if (hit.deadline === 'payroll') {
    return {
      title: 'Fill your retirement room before the last payroll',
      effort: 'Under an hour',
      value,
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
  const firstYear = hit.deadline === 'firstYear';
  return {
    title: firstYear ? "Fill this year's retirement room by Apr 15" : 'Fill your retirement room by Dec 31',
    effort: 'Under an hour',
    value,
    mine: mineOf(ctx, hit.grounding),
    cross: ['The employer contribution can be made up to the return due date, including extensions; only the deferral has an earlier deadline.'],
    tasks: padTasks(firstYear
      ? [
        'Adopt a solo 401(k) in the business name',
        "Elect and deposit the deferral from this year's self-employment income before you file",
        'Plan the employer contribution with your accountant',
        'Tell us when the plan account is open',
      ]
      : [
        'Sign the deferral election by Dec 31',
        'Confirm the deposit date with your plan provider',
        'Plan the employer contribution with your accountant',
        'Check that the deposit lands in the plan account',
      ]),
  };
}

const WHEN = { payroll: 'before the last payroll', dec31: 'by Dec 31', firstYear: 'by Apr 15' };
const DEADLINE_WHY = {
  payroll: 'Employee deferrals have to come out of a paycheck, so the last payroll of the year is the real deadline.',
  dec31: 'Self-employment income counts as paid on Dec 31, so the deferral election has to be signed by then. The contribution is figured from net earnings after year end; confirm the deposit date with your plan provider.',
  firstYear: "As the sole owner with no employees, a plan adopted after year end can still take this year's deferral until the return due date, without extensions.",
};
const PENDING_WHY = {
  'retirement.priorYearFicaWages': 'Catch-up room is left out until we know whether it must be Roth.',
  'retirement.planOffersRoth': 'Catch-up room stays at zero until you confirm your plan offers Roth deferrals.',
};

function regularSummary(deadline) {
  if (deadline === 'payroll') return 'You can still defer {f:room.solo401k.employee} into your solo 401(k) through payroll before the last payroll of the year.';
  if (deadline === 'firstYear') return "Adopt a solo 401(k) and defer {f:room.solo401k.employee} from this year's self-employment income by Apr 15.";
  return "You can still defer {f:room.solo401k.employee} from this year's self-employment income; sign the deferral election by Dec 31.";
}

export function template(ctx, hit) {
  if (hit.confirm) {
    const why = ['Plan terms, related businesses and your age all change the limits, so we only show a number once they are confirmed.'];
    if (hit.confirm.includes('business.onlyEmployee')) why.unshift("Whether you own the whole business and it has no employees decides if this year's deferral can wait until Apr 15.");
    return {
      summary: 'We need a few answers about your retirement plan before we can size the room left this year.',
      why,
      qa: [],
    };
  }
  const { parts, deadline } = hit;
  const when = WHEN[deadline];
  let summary;
  const why = [];
  if (parts.regular) {
    summary = regularSummary(deadline);
    if (parts.catchUp) why.push('Your age adds up to {f:room.solo401k.catchUp} of catch-up room.');
    if (parts.roth) why.push("Up to {f:room.solo401k.rothCatchUp} more can go in as a Roth catch-up; Roth dollars do not lower this year's tax.");
  } else if (parts.catchUp) {
    summary = `Your regular deferral room is used up, but you can still add {f:room.solo401k.catchUp} of catch-up to your solo 401(k) ${when}.`;
  } else {
    summary = `Your regular deferral room is used up, but you can still add {f:room.solo401k.rothCatchUp} as a Roth catch-up to your solo 401(k) ${when}.`;
    why.push("Roth catch-up dollars do not lower this year's tax.");
  }
  if (PENDING_WHY[hit.catchUpPending]) why.push(PENDING_WHY[hit.catchUpPending]);
  if (positive(ctx, 'room.solo401k.employer')) why.push('On top of that, the business can add up to {f:room.solo401k.employer} as an employer contribution.');
  why.push(DEADLINE_WHY[deadline]);
  return {
    summary,
    why: why.slice(0, 4),
    qa: [{ q: 'Is the employer part due by the same date?', a: ['No. The employer contribution can be deposited up to the business return due date, including extensions.'] }],
  };
}

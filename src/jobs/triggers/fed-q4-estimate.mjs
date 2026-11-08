// Fourth-quarter federal estimate: the safe-harbor amount still to pay before Jan 15. The target
// from last year's tax is fixed; the target from this year's projection moves with income (IRC
// 6654(d)(1)(B), (C)), so only the prior-year target is described as fixed. Every variant says a
// January payment does not undo a penalty that already built up on an earlier installment (IRC
// 6654(b)(2), (b)(3)).

import { BUSINESS, has, mineOf, padTasks, positive } from './common.mjs';
import { blockedFor, TRIGGER_INPUTS } from '../../shared/rec-inputs.mjs';

export const id = 'fed-q4-estimate';
export const domain = 'tax';
// Inputs the action reads (src/shared/rec-inputs.mjs): the household tax run, the payments logged against it and the child tax credit.
export const inputs = TRIGGER_INPUTS['fed-q4-estimate'];
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['tax']);
export const owner = 'you';
export const trigger = 'calendar';
export const packs = ['s-corp-owner', 'self-employed-partnership'];
export const gate = BUSINESS;
export const calcs = ['federalIncomeTax', 'selfEmploymentTax', 'qbiDeduction', 'estimatedPaymentSafeHarbor'];
export const needsYear = true;
export const kb = [{ pack: 's-corp-owner', entry: 'payroll-and-estimated-tax' }, { pack: 'self-employed-partnership', entry: 'estimated-tax' }];

export function window(ctx) {
  return { close: `${ctx.year + 1}-01-15`, label: 'Jan 15', hard: true };
}

export function evaluate(ctx) {
  const held = blockedFor(ctx, { inputs });
  if (held) return { blocked: held };
  if (!positive(ctx, 'sh.fed.remaining')) return null;
  return {
    grounding: [
      'sh.fed.remaining', 'sh.fed.required', 'sh.fed.priorTarget', 'sh.fed.priorRemaining', 'sh.fed.currentTarget',
      'tax.fed.paid', 'tax.fed.withheld', 'tax.fed.proj',
    ],
    prior: !!ctx.info.priorYear, priorHigh: !!ctx.info.priorHigh,
    basis: basisOf(ctx),
  };
}

// 'prior' when last year's target is the lower one, 'current' when this year's projection is, and
// 'none' without last year's return.
function basisOf(ctx) {
  if (!ctx.info.priorYear || !ctx.fig['sh.fed.priorRemaining']) return 'none';
  return ctx.info.shBasis === 'prior' ? 'prior' : 'current';
}

export function build(ctx, hit) {
  return {
    title: 'Pay the fourth-quarter federal estimate',
    effort: 'Under an hour',
    value: [
      { cls: 'risk', text: 'Avoids an underpayment penalty' },
      { cls: 'tax', text: hit.basis === 'prior' ? "Reaches last year's safe harbor" : "Meets this year's projected target" },
    ],
    mine: mineOf(ctx, hit.grounding),
    cross: ctx.facts['household.state'] === 'VA' ? ['The Virginia estimate is due on the same day.'] : [],
    tasks: padTasks([
      'Check the amount against your accountant worksheet',
      'Pay through IRS Direct Pay or EFTPS',
      'Save the payment confirmation',
      'Add the payment to your tax payment log',
    ]),
  };
}

const JANUARY_QA = {
  q: 'Does a January payment fix earlier quarters?',
  a: ['No. Each quarterly installment is measured on its own due date. A January payment is credited to the earliest unpaid installment and stops further penalty from then on, but a penalty that already built up on an April, June or September shortfall stays. Your accountant can check whether the annualized income method lowers it.'],
};
const LESS_QA = { q: 'Can I pay less than this?', a: ['You can, but any shortfall against the target may carry an underpayment penalty for the quarter.'] };

export function template(ctx, hit) {
  const paid = has(ctx, 'tax.fed.paid') ? ' and you have paid {f:tax.fed.paid} in estimated payments so far' : '';
  const priorKey = hit.priorHigh ? 'fedSafeHarborPriorHigh' : 'fedSafeHarborPrior';
  if (hit.basis === 'prior') {
    return {
      summary: `Pay {f:sh.fed.priorRemaining} by Jan 15 to bring this year's payments to {p:${priorKey}} of last year's tax.`,
      why: [
        `Your federal target from last year's tax is {f:sh.fed.priorTarget}${paid}.`,
        'That target comes from last year\'s return, so it does not move if this year\'s income ends higher.',
      ],
      qa: [JANUARY_QA, LESS_QA],
    };
  }
  if (hit.basis === 'current') {
    return {
      summary: "Pay {f:sh.fed.remaining} by Jan 15 to reach {p:fedSafeHarborCurrent} of this year's projected tax.",
      why: [
        `Your federal target from this year's projection is {f:sh.fed.required}${paid}.`,
        `That target moves with your income, because the test uses the tax on the return you file. Paying {f:sh.fed.priorRemaining} instead reaches {p:${priorKey}} of last year's tax, which does not move.`,
      ],
      qa: [JANUARY_QA, LESS_QA],
    };
  }
  return {
    summary: "Pay {f:sh.fed.remaining} by Jan 15 to reach {p:fedSafeHarborCurrent} of this year's projected tax.",
    why: [
      `Without last year's return the target is {p:fedSafeHarborCurrent} of this year's projected tax of {f:tax.fed.proj}${paid}.`,
      'This is an estimate. If income ends higher, the target rises.',
    ],
    qa: [JANUARY_QA, LESS_QA],
  };
}

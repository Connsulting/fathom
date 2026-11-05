// Fourth-quarter federal estimate: the safe-harbor amount still to pay before Jan 15.

import { BUSINESS, has, mineOf, padTasks } from './common.mjs';

export const id = 'fed-q4-estimate';
export const domain = 'tax';
export const trigger = 'calendar';
export const packs = ['s-corp-owner', 'self-employed-partnership'];
export const gate = BUSINESS;
export const calcs = ['federalIncomeTax', 'selfEmploymentTax', 'qbiDeduction', 'estimatedPaymentSafeHarbor'];
export const kb = [{ pack: 's-corp-owner', entry: 'payroll-and-estimated-tax' }, { pack: 'self-employed-partnership', entry: 'estimated-tax' }];

export function window(ctx) {
  return ctx.year ? { close: `${ctx.year + 1}-01-15`, label: 'Jan 15', hard: true } : null;
}

export function evaluate(ctx) {
  if (!ctx.year) return null;
  if (ctx.info.blocked.length) return { blocked: ctx.info.blocked[0] };
  if (!(ctx.fig['sh.fed.remaining'] && ctx.fig['sh.fed.remaining'].v > 0)) return null;
  return {
    grounding: ['sh.fed.remaining', 'sh.fed.required', 'tax.fed.paid', 'tax.fed.withheld', 'tax.fed.proj'],
    prior: !!ctx.info.priorYear, priorHigh: !!ctx.info.priorHigh,
  };
}

export function build(ctx, hit) {
  return {
    title: 'Pay the fourth-quarter federal estimate',
    effort: 'Under an hour',
    value: [{ cls: 'risk', text: 'Avoids an underpayment penalty' }, { cls: 'tax', text: 'Keeps you inside the federal safe harbor' }],
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

export function template(ctx, hit) {
  const paid = has(ctx, 'tax.fed.paid') ? ' and you have paid {f:tax.fed.paid} so far' : '';
  const priorKey = hit.priorHigh ? 'fedSafeHarborPriorHigh' : 'fedSafeHarborPrior';
  return {
    summary: 'Pay {f:sh.fed.remaining} by Jan 15 to reach the federal safe harbor for the year.',
    why: [
      `Your federal safe-harbor target is {f:sh.fed.required}${paid}.`,
      hit.prior
        ? `The target is the smaller of {p:fedSafeHarborCurrent} of this year's projected tax and {p:${priorKey}} of last year's tax, so paying it protects you even if income runs higher than projected.`
        : "Without last year's return the target is {p:fedSafeHarborCurrent} of this year's projected tax of {f:tax.fed.proj}.",
    ],
    qa: [
      { q: 'What if my income changes before January?', a: ['The safe harbor protects you from the penalty even if the year ends higher than projected. We update the projection whenever new data arrives.'] },
      { q: 'Can I pay less than this?', a: ['You can, but any shortfall against the target may carry an underpayment penalty for the quarter.'] },
    ],
  };
}

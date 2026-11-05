// Fourth-quarter Virginia estimate: the Virginia target still to pay before Jan 15.

import { BUSINESS, has, mineOf, padTasks, positive } from './common.mjs';

export const id = 'va-q4-estimate';
export const domain = 'tax';
export const trigger = 'calendar';
export const packs = ['virginia-resident'];
export const gate = { all: [{ fact: 'household.state', op: 'eq', value: 'VA' }, BUSINESS] };
export const calcs = ['virginiaIncomeTax'];
export const needsYear = true;
export const kb = [{ pack: 'virginia-resident', entry: 'estimated-tax' }];

export function window(ctx) {
  return { close: `${ctx.year + 1}-01-15`, label: 'Jan 15', hard: true };
}

export function evaluate(ctx) {
  if (ctx.info.blocked.length) return { blocked: ctx.info.blocked[0] };
  if (ctx.info.vaBlocked) return { blocked: ctx.info.vaBlocked };
  if (!positive(ctx, 'sh.va.remaining')) return null;
  return { grounding: ['sh.va.remaining', 'sh.va.required', 'tax.va.paid', 'tax.va.withheld', 'tax.va.proj'] };
}

export function build(ctx, hit) {
  return {
    title: 'Pay the fourth-quarter Virginia estimate',
    effort: 'Under an hour',
    value: [{ cls: 'risk', text: 'Avoids a Virginia underpayment addition' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['The federal estimate is due on the same day.'],
    tasks: padTasks([
      'Check the amount against your accountant worksheet',
      'Pay through Virginia Tax online services',
      'Save the payment confirmation',
      'Add the payment to your tax payment log',
    ]),
  };
}

export function template(ctx) {
  const paid = has(ctx, 'tax.va.paid') ? ' and you have paid {f:tax.va.paid} so far' : '';
  return {
    summary: 'Pay {f:sh.va.remaining} to Virginia by Jan 15 to cover the year.',
    why: [
      `Your Virginia target is {f:sh.va.required}${paid}.`,
      "Virginia expects estimates once the balance due passes {l:vaEstimateThreshold}; the target is {p:vaSafeHarborCurrent} of this year's projected tax or last year's tax, whichever is smaller.",
    ],
    qa: [
      { q: 'How was the Virginia tax projected?', a: ['From your projected income less the Virginia deduction and any Virginia 529 plan deduction, using the Virginia rate schedule. Personal exemptions are left out, which errs on the side of paying enough.'] },
    ],
  };
}

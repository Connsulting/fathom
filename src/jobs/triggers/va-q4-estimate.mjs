// Fourth-quarter Virginia estimate: the Virginia target still to pay before Jan 15.

import { BUSINESS, has, mineOf, padTasks, positive } from './common.mjs';
import { blockedFor, TRIGGER_INPUTS } from '../../shared/rec-inputs.mjs';

export const id = 'va-q4-estimate';
export const domain = 'tax';
// Inputs the action reads (src/shared/rec-inputs.mjs): Virginia tax starts from the household tax run's federal AGI, less the Virginia payments.
export const inputs = TRIGGER_INPUTS['va-q4-estimate'];
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['tax']);
export const owner = 'you';
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
  const held = blockedFor(ctx, { inputs });
  if (held) return { blocked: held };
  if (ctx.info.vaBlocked) return { blocked: ctx.info.vaBlocked };
  if (!positive(ctx, 'sh.va.remaining')) return null;
  return { grounding: ['sh.va.remaining', 'sh.va.required', 'tax.va.paid', 'tax.va.withheld', 'tax.va.proj'] };
}

export function build(ctx, hit) {
  const payment = { jurisdiction: 'VA', taxYear: ctx.year, quarter: 4, amount: ctx.fig['sh.va.remaining']?.v };
  return {
    title: 'Pay the fourth-quarter Virginia estimate',
    effort: 'Under an hour',
    value: [{ cls: 'risk', text: 'Avoids a Virginia underpayment addition' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['The federal estimate is due on the same day.'],
    tasks: padTasks([
      'Check the amount against your accountant worksheet',
      { t: 'Pay through Virginia Tax online services', kind: 'payment', payment },
      'Save the payment confirmation',
      { t: 'Add the payment to your tax payment log', kind: 'payment', payment },
    ]),
  };
}

export function template(ctx) {
  const paid = has(ctx, 'tax.va.paid') ? ' and you have paid {f:tax.va.paid} in estimated payments so far' : '';
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

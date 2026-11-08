// Invoice deferral: moving December invoices into January (S13, R16).

import { isTrue, mineOf, padTasks, confirmTasks, keyMatching, modelPersonOwner } from './common.mjs';
import { blockedFor, TRIGGER_INPUTS } from '../../shared/rec-inputs.mjs';

export const id = 'invoice-deferral';
export const domain = 'business';
// Inputs the action reads (src/shared/rec-inputs.mjs): the deferral war game reruns household and Virginia tax.
export const inputs = TRIGGER_INPUTS['invoice-deferral'];
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['tax']);
export const owner = 'you';
export const ownerFor = modelPersonOwner(owner);
export const trigger = 'calendar';
export const packs = ['s-corp-owner', 'self-employed-partnership'];
export const gate = { any: [isTrue('income.sCorp'), isTrue('income.selfEmployed')] };
export const calcs = ['federalIncomeTax', 'virginiaIncomeTax'];
export const needsYear = true;
export const kb = [{ pack: 's-corp-owner', entry: 'distributions-and-basis' }, { pack: 'self-employed-partnership', entry: 'sole-proprietor-income' }];

export function window(ctx) {
  return { close: `${ctx.year}-12-01`, label: 'Dec 1', hard: false };
}

export function evaluate(ctx) {
  const held = blockedFor(ctx, { inputs });
  if (held) return { blocked: held };
  // The war game needs Virginia tax too; a Virginia gap is missing data, not a closed condition (S12).
  if (ctx.info.vaBlocked) return { blocked: ctx.info.vaBlocked };
  if (ctx.model.deferral) {
    return { person: ctx.model.deferral.person, grounding: ['wg.deferral.d100.tax2026', 'wg.deferral.d100.tax2027', 'wg.deferral.d100.decCash', 'wg.deferral.d100.need', 'cash.business'] };
  }
  if (ctx.info.confirm.deferral) return { confirm: ctx.info.confirm.deferral, grounding: [keyMatching(ctx, /^pnl\.[^.]+\.income$/)].filter(Boolean) };
  return null;
}

export function build(ctx, hit) {
  if (hit.confirm) {
    return {
      title: 'Confirm your accounting method so we can model invoice timing',
      effort: 'A short conversation',
      value: [{ cls: 'timing', text: 'Unlocks the invoice timing comparison' }],
      mine: mineOf(ctx, hit.grounding, { actualOnly: true }),
      cross: [],
      tasks: confirmTasks(hit.confirm),
    };
  }
  return {
    title: 'Decide whether to bill December work in January',
    effort: 'Under an hour',
    value: [{ cls: 'timing', text: 'Shifts tax into next year' }, { cls: 'cash', text: 'Leaves less cash for December' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['Less income this year also changes the fourth-quarter estimates.'],
    tasks: padTasks([
      'Compare the options in the war game',
      'Check December payroll is covered under your choice',
      'Tell clients which invoices go out in January',
    ]),
    scenario: 'deferral',
  };
}

export function template(ctx, hit) {
  if (hit.confirm) {
    return {
      summary: 'Tell us whether the business keeps its books on a cash basis and we will model the timing of December invoices.',
      why: ['Moving invoices only moves income between years for a cash-basis business.'],
      qa: [],
    };
  }
  return {
    summary: 'Billing a month of work in January instead of December changes this year tax by {f:wg.deferral.d100.tax2026} and leaves {f:wg.deferral.d100.decCash} of business cash for December.',
    why: [
      'Deferral moves income to next year rather than removing it; next year tax changes by {f:wg.deferral.d100.tax2027}.',
      'December payroll needs about {f:wg.deferral.d100.need}, so check the cash still covers it.',
    ],
    qa: [{ q: 'Does this lower my total tax?', a: ['Only when next year lands in a lower bracket. Most of the benefit is timing: the tax is due a year later.'] }],
  };
}

// S corp salary: the salary war game over the owner-approved range (S3, R6).

import { isTrue, lastPayroll, mineOf, padTasks, confirmTasks, salaryProjKey, salaryKey, modelPersonOwner } from './common.mjs';

export const id = 'scorp-salary';
export const domain = 'business';
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['tax', 'retirement']);
export const owner = 'you';
export const ownerFor = modelPersonOwner(owner);
export const trigger = 'income';
export const packs = ['s-corp-owner'];
export const gate = isTrue('income.sCorp');
export const calcs = ['payrollTax', 'solo401kRoom', 'federalIncomeTax', 'qbiDeduction', 'selfEmploymentTax', 'virginiaIncomeTax'];
export const needsYear = true;
export const kb = [{ pack: 's-corp-owner', entry: 'reasonable-compensation' }, { pack: 's-corp-owner', entry: 'retirement-compensation' }];

export function window(ctx) {
  return { close: lastPayroll(ctx), label: 'Last payroll', hard: false };
}

export function evaluate(ctx) {
  if (ctx.info.blocked.length) return { blocked: ctx.info.blocked[0] };
  // The war game needs Virginia tax too; a Virginia gap is missing data, not a closed condition (S12).
  if (ctx.info.vaBlocked) return { blocked: ctx.info.vaBlocked };
  if (ctx.model.salary) return { person: ctx.model.salary.person, grounding: [salaryProjKey(ctx), 'scorp.profitProj', 'room.solo401k.employee', 'room.solo401k.employer'].filter(Boolean) };
  if (ctx.info.confirm.salary) return { confirm: ctx.info.confirm.salary, grounding: [salaryKey(ctx)].filter(Boolean) };
  return null;
}

export function build(ctx, hit) {
  if (hit.confirm) {
    return {
      title: 'Confirm your salary range so we can compare salaries for this year',
      effort: 'A short conversation',
      value: [{ cls: 'tax', text: 'Unlocks the salary comparison' }],
      mine: mineOf(ctx, hit.grounding, { actualOnly: true }),
      cross: [],
      tasks: confirmTasks(hit.confirm),
    };
  }
  return {
    title: 'Settle your salary for the rest of the year',
    effort: 'Under an hour',
    value: [{ cls: 'tax', text: 'Trades payroll tax against retirement room' }, { cls: 'retire', text: 'Sets how much the business can contribute' }],
    mine: mineOf(ctx, hit.grounding),
    cross: ['Your salary sets the solo 401(k) employer contribution, so decide it before sizing year-end retirement.'],
    tasks: padTasks([
      'Compare the salary points in the war game',
      'Check the choice against the range your advisor approved',
      'Tell your payroll provider the amount for the last payroll',
    ]),
    scenario: 'salary',
  };
}

export function template(ctx, hit) {
  if (hit.confirm) {
    return {
      summary: 'Tell us the salary range your advisor considers reasonable and we will compare points inside it.',
      why: ['We only model salaries an advisor has called reasonable for the work, so the comparison never suggests an indefensible number.'],
      qa: [],
    };
  }
  const found = salaryProjKey(ctx);
  const key = found && ctx.fig[found].v > 0 ? found : null;
  return {
    summary: key
      ? `You are on track to pay yourself {f:${key}} this year. The war game shows what a different salary does to tax and retirement room.`
      : 'The war game shows what a different salary does to tax and retirement room.',
    why: [
      'A higher salary costs more payroll tax but raises the employer contribution your solo 401(k) can take.',
      'Profit before salary is projected at {f:scorp.profitProj}, so every salary point is checked against what the business can pay.',
    ],
    qa: [{ q: 'What makes a salary reasonable?', a: ['Pay that matches what the business would pay someone else for the same work. Your advisor sets the range; we only compare points inside it.'] }],
  };
}

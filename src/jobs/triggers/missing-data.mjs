// Missing data: stale or missing sources, unclassified businesses, blocked figures and missing
// tax inputs (R1, R14, R19, T9.5). Evaluated last so it sees every other trigger's block.

import { addDays } from '../planner/data.mjs';
import { padTasks, dataText, confirmTask } from './common.mjs';

export const id = 'missing-data';
export const domain = 'data';
export const trigger = 'calendar';
export const packs = [];
export const gate = { all: [] };
export const calcs = [];
export const kb = [];

const BUSINESS_FACTS = ['income.sCorp', 'income.selfEmployed', 'income.partnership'];
const TAX_CODES = new Set([
  'pnl', 'tax_payments', 'prior_year_missing', 'filing_status_assumed', 'partnership_incomplete', 'va_itemized_missing', 'mfs_unsupported', 'calc_failed',
  'ctc_refundable_unsupported', 'retirement_contribution_unattributed', 'retirement_contribution_over_limit', 'retirement_other_deferrals_missing',
  'va529_answers_missing',
]);

// Fixed reason text per code: [what is on hold and why, the task that clears it]. No digits and no
// data-derived text, so the same sentence is safe as rec prose and as a plain-text reason.
const REASONS = Object.freeze({
  mfs_unsupported: ['Tax figures for married filing separately are not supported yet, so tax projections are on hold.', 'Check your filing status, and ask your accountant for this year projection while filing separately'],
  calc_failed: ['A calculator could not use one of your answers, so some figures are on hold.', 'Check your household answers, such as ages, for typos'],
  va_itemized_missing: ['You itemize federally, so Virginia needs your Virginia itemized estimate too.', 'Enter your Virginia itemized deduction estimate'],
  ctc_refundable_unsupported: ['Your child tax credit is larger than your income tax, and the refundable part is not modeled yet, so tax projections are on hold.', 'Ask your accountant for this year projection, including the refundable child tax credit'],
  retirement_contribution_unattributed: ['A retirement contribution does not say which of your businesses sponsors the plan, so tax projections are on hold.', 'Tell us which business sponsors each retirement contribution'],
  retirement_contribution_over_limit: ['A self-employed retirement contribution is above what the plan rules allow for your earnings, so tax projections are on hold.', 'Check your retirement contribution amounts with your plan provider or accountant'],
  retirement_other_deferrals_missing: ['We need your deferrals to other workplace plans this year before your self-employed retirement deduction can be figured.', confirmTask('retirement.otherPlanDeferrals')],
  va529_answers_missing: ["We need each college savings account's Virginia answers, including any carryforward, before projecting Virginia tax.", confirmTask('accounts.va529')],
  ira_room_missing: ['IRA contribution room could not be figured for everyone in the household, so the backdoor Roth recommendation is on hold.', 'Check the household ages and income on file'],
  'retirement.otherPlanDeferrals': ['We need your deferrals to other workplace plans this year before sizing retirement room.', confirmTask('retirement.otherPlanDeferrals')],
  'retirement.priorYearFicaWages': ["We need last year's Social Security wages from your business before sizing catch-up room.", confirmTask('retirement.priorYearFicaWages')],
  'retirement.planOffersRoth': ['We need to know whether your plan offers Roth deferrals before sizing catch-up room.', confirmTask('retirement.planOffersRoth')],
  wargame_contribution_over_limit: ['Moving income to January would leave a self-employed retirement contribution above what the plan rules allow for this year, so this comparison is not a current choice.', 'Check your retirement contribution amounts with your plan provider or accountant'],
  inputs_changed: ['Its inputs changed, so it is kept for reference and is not a current choice.', 'Review the latest data on your plan'],
});
const RETAINED = 'No longer computed from your current data, so it is shown for reference only.';

// `name` formats a data-derived name: dataText for stored rec HTML, plain for a plain-text reason.
function reasonItem(ctx, reason, name = dataText) {
  if (reason.startsWith('entity_unclassified:')) {
    const slug = reason.slice('entity_unclassified:'.length);
    const e = (ctx.entities || []).find(x => x.slug === slug);
    const who = e ? name(e.name) : 'a business in your profit and loss';
    return { code: reason, tax: true, text: `We do not know how ${who} is taxed.`, task: `Tell us how ${who} is taxed` };
  }
  if (reason === 'partnership_incomplete') {
    const names = ((ctx.info && ctx.info.partnershipsMissing) || []).map(name);
    const text = names.length
      ? `We do not have complete partnership figures for ${names.join(', ')}.`
      : 'A partnership statement or partnership estimate is missing an amount we need.';
    return { code: reason, tax: true, text, task: 'Add the ordinary income, guaranteed payments and self-employment earnings from each K-1, or a partnership estimate' };
  }
  if (REASONS[reason]) return { code: reason, tax: TAX_CODES.has(reason), text: REASONS[reason][0], task: REASONS[reason][1] };
  if (reason.includes('.')) {
    return { code: reason, tax: false, text: 'This is on hold until you answer an open question in your household settings.', task: confirmTask(reason) };
  }
  return { code: reason, tax: true, text: 'Some figures could not be computed from the data on file.', task: 'Check the latest uploads for missing amounts' };
}

// The plain-text reason for a code (a blocked code, a confirm key or 'inputs_changed'), used for
// figures and war games kept for reference while unavailable. Escaped where it becomes HTML.
export function reasonText(ctx, code) {
  if (!code) return RETAINED;
  return reasonItem(ctx, code, v => String(v)).text;
}

export function items(ctx) {
  const out = [];
  const business = BUSINESS_FACTS.some(k => ctx.facts[k] === true);
  for (const s of ctx.freshness || []) {
    if (s.state === 'current') continue;
    if ((s.id === 'pnl' || s.id === 'tax_payments') && !business) continue;
    out.push({
      code: s.id, tax: TAX_CODES.has(s.id),
      text: s.state === 'missing' ? `${s.label}: nothing uploaded yet.` : `${s.label}: out of date.`,
      task: `Upload the latest ${s.label.toLowerCase()}`,
    });
  }
  if (ctx.warnings.includes('prior_year_missing')) {
    out.push({ code: 'prior_year_missing', tax: true, text: "Last year's tax return is missing, so the federal target uses this year's projection.", task: "Upload last year's tax return" });
  }
  if (ctx.warnings.includes('filing_status_assumed')) {
    out.push({ code: 'filing_status_assumed', tax: true, text: 'Your filing status is not set, so we assumed single.', task: 'Tell us your filing status' });
  }
  const reasons = [...(ctx.info.blocked || []), ...(ctx.blockedReasons || []).map(b => b.reason)];
  for (const r of reasons) out.push(reasonItem(ctx, r));
  const seen = new Set();
  return out.filter(i => (seen.has(i.code) ? false : (seen.add(i.code), true)));
}

// The earliest hard window among the estimates the data blocks, else two weeks out.
export function window(ctx) {
  const list = items(ctx);
  if (list.some(i => i.tax) && ctx.year) {
    const close = `${ctx.year + 1}-01-15`;
    if (close >= ctx.clock) return { close, label: 'Jan 15', hard: false };
  }
  return { close: addDays(ctx.clock, 14), label: 'Soon', hard: false };
}

export function evaluate(ctx) {
  const list = items(ctx);
  if (!list.length) return null;
  return { grounding: [], items: list.map(i => ({ code: i.code, text: i.text, task: i.task })) };
}

export function build(ctx, hit) {
  return {
    title: 'Bring your data up to date',
    effort: 'A few minutes',
    value: [{ cls: 'risk', text: 'Keeps every figure on your plan current' }],
    mine: [],
    cross: [],
    tasks: padTasks([...hit.items.map(i => i.task), 'Run planning again once the files are in']),
  };
}

export function template(ctx, hit) {
  return {
    summary: 'Some of your data is missing or out of date, so parts of your plan are on hold.',
    why: hit.items.slice(0, 4).map(i => i.text),
    qa: [{ q: 'What happens to recommendations in the meantime?', a: ['They keep their last figures and wait for the data. Nothing is retired because a file is late.'] }],
  };
}

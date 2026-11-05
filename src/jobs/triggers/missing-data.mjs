// Missing data: stale or missing sources, unclassified businesses, blocked figures and missing
// tax inputs (R1, R14, R19, T9.5). Evaluated last so it sees every other trigger's block.

import { addDays } from '../planner/data.mjs';
import { padTasks, dataText } from './common.mjs';

export const id = 'missing-data';
export const domain = 'data';
export const trigger = 'calendar';
export const packs = [];
export const gate = { all: [] };
export const calcs = [];
export const kb = [];

const BUSINESS_FACTS = ['income.sCorp', 'income.selfEmployed', 'income.partnership'];
const TAX_CODES = new Set(['pnl', 'tax_payments', 'prior_year_missing', 'filing_status_assumed', 'partnership_incomplete', 'va_itemized_missing', 'mfs_unsupported', 'calc_failed']);

function reasonItem(ctx, reason) {
  if (reason.startsWith('entity_unclassified:')) {
    const slug = reason.slice('entity_unclassified:'.length);
    const e = (ctx.entities || []).find(x => x.slug === slug);
    const name = e ? dataText(e.name) : 'a business in your profit and loss';
    return { code: reason, tax: true, text: `We do not know how ${name} is taxed.`, task: `Tell us how ${name} is taxed` };
  }
  if (reason === 'partnership_incomplete') {
    const names = (ctx.info.partnershipsMissing || []).map(dataText);
    const text = names.length
      ? `We do not have a complete K-1 or partnership estimate for ${names.join(', ')}.`
      : 'A partnership K-1 or partnership estimate is missing an amount we need.';
    return { code: reason, tax: true, text, task: 'Add the ordinary income, guaranteed payments and self-employment earnings from each K-1, or a partnership estimate' };
  }
  if (reason === 'mfs_unsupported') {
    return { code: reason, tax: true, text: 'Tax figures for married filing separately are not supported yet, so tax projections are on hold.', task: 'Check your filing status, and ask your accountant for this year projection while filing separately' };
  }
  if (reason === 'calc_failed') {
    return { code: reason, tax: false, text: 'A calculator could not use one of your answers, so some figures are on hold.', task: 'Check your household answers, such as ages, for typos' };
  }
  if (reason === 'va_itemized_missing') {
    return { code: reason, tax: true, text: 'You itemize federally, so Virginia needs your Virginia itemized estimate too.', task: 'Enter your Virginia itemized deduction estimate' };
  }
  return { code: reason, tax: true, text: 'Some figures could not be computed from the data on file.', task: 'Check the latest uploads for missing amounts' };
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

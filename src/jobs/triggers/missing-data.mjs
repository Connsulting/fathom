// Missing data: stale or missing sources, unclassified businesses, blocked figures and missing
// tax inputs (R1, R14, R19, T9.5). Evaluated last so it sees every other trigger's block.

import { ADVISOR_KEYS } from '../../facts/derive.mjs';
import { looksLikeSpending, spendingStatement } from '../../pnl/ledgers.mjs';
import { addDays } from '../planner/data.mjs';
import { confirmItemFor } from '../../shared/rec-steps.mjs';
import { staleAccountIds } from '../../../web/core/account-freshness.js';
import { dataText, confirmTask, ANSWER_SHAPES, questionFor } from './common.mjs';

export const id = 'missing-data';
export const domain = 'data';
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze([]);
export const owner = 'you';
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
  // Ingest contract (plan Revision 6).
  'w2_recipient_unknown', 'payroll_recipient_conflict', 'household_employer_unmatched', 'employer_relation_pending', 'w2_box12_unreadable',
  'w2_wages_missing', 'w2_medicare_wages_missing', 'w2_plan_compensation_unknown', 'deferral_split_unknown', 'paystub_ytd_missing', 'paystub_deferrals_unknown', 'k1_unmatched', 'k1_scorp_unmatched',
  'w2_correction_pending', 'w2_correction_conflicting', 'w2_duplicate_unresolved', 'tax_payment_kind_unknown', 'withholding_state_unknown',
  'withholding_recipient_unknown', 'withholding_conflict_pending', 'tax_year_unconfirmed', 'estimated_payer_unknown',
]);

// Payroll reasons that name the employers they concern (from ctx.info.payrollBlocks).
const CONFIRM_WHICH_W2 = 'Answer which W-2 counts in Confirm';
const PAYROLL_NAMED = Object.freeze({
  w2_recipient_unknown: [who => `We do not know whose pay ${who} reports, so tax projections are on hold.`, 'Answer who is paid by each employer in Confirm'],
  payroll_recipient_conflict: [who => `A payroll document from ${who} is marked as both yours and your spouse's, so tax projections are on hold.`, 'Check who each payroll document belongs to in Confirm'],
  household_employer_unmatched: [who => `${who} was marked as your own business, but it does not match any business on file, so tax projections are on hold.`, 'Add the business to your household businesses, or answer that it is an outside employer'],
  employer_relation_pending: [who => `We do not know whether ${who} is an outside employer or your own business, so tax projections are on hold.`, 'Answer whether each employer is your own business in Confirm'],
  w2_box12_unreadable: [who => `A box twelve amount on a W-2 from ${who} could not be read, so tax projections are on hold.`, 'Upload a clearer copy of the W-2'],
  w2_wages_missing: [who => `A W-2 from ${who} has no readable wages, so tax projections are on hold.`, 'Upload a clearer copy of the W-2'],
  w2_medicare_wages_missing: [who => `A W-2 from ${who} has no readable Medicare wages in box five, so federal tax is on hold.`, 'Upload a clearer copy of the W-2 that shows box five'],
  deferral_split_unknown: [who => `Your retirement deferrals are above the yearly limit across ${who} and another plan, and we cannot tell which plan holds the catch-up, so tax and retirement figures are on hold.`, confirmTask('retirement.otherPlanDeferrals')],
  paystub_ytd_missing: [who => `The latest paystub from ${who} has no year-to-date gross pay, so tax projections are on hold.`, 'Upload a paystub that shows year-to-date pay, or the W-2'],
  paystub_deferrals_unknown: [who => `Paystubs from ${who} show retirement or HSA deferrals but no year-to-date total, so tax projections are on hold.`, 'Upload the W-2, or enter your deferrals for this year'],
  w2_correction_pending: [who => `Two W-2s from ${who} for the same year disagree, so wages and withholding are on hold.`, CONFIRM_WHICH_W2],
  w2_correction_conflicting: [who => `Your answers keep different W-2s from ${who} for federal and state withholding, so wages and withholding are on hold.`, CONFIRM_WHICH_W2],
  w2_duplicate_unresolved: [who => `Two different W-2s from ${who} for the same year and person are on file, and nothing says which counts, so wages are on hold.`, 'Remove the W-2 that does not count, or upload the corrected one'],
});

// Fixed reason text per code: [what is on hold and why, the task that clears it]. No digits and no
// data-derived text, so the same sentence is safe as rec prose and as a plain-text reason.
const REASONS = Object.freeze({
  mfs_unsupported: ['Tax figures for married filing separately are not supported yet, so tax projections are on hold.', 'Check your filing status, and ask your accountant for this year projection while filing separately'],
  calc_failed: ['A calculator could not use one of your answers, so some figures are on hold.', 'Check your household answers, such as ages, for typos'],
  va_itemized_missing: ['You itemize federally, so Virginia needs your Virginia itemized estimate too.', 'Enter your Virginia itemized deduction estimate'],
  ctc_refundable_unsupported: ['Your child tax credit is larger than your income tax, and the refundable part is not modeled yet, so tax projections are on hold.', 'Ask your accountant for this year projection, including the refundable child tax credit'],
  retirement_contribution_unattributed: ['A retirement contribution does not say which of your businesses sponsors the plan, so tax projections are on hold.', 'Tell us which business sponsors each retirement contribution'],
  retirement_contribution_over_limit: ['A retirement contribution is above what the plan rules allow for your earnings or wages, so tax projections are on hold.', 'Check your retirement contribution amounts with your plan provider or accountant'],
  retirement_other_deferrals_missing: ['We need your deferrals to other workplace plans this year before your self-employed retirement deduction can be figured.', confirmTask('retirement.otherPlanDeferrals')],
  va529_answers_missing: ["We need each college savings account's Virginia answers, including any carryforward, and your birth year before projecting Virginia tax.", confirmTask('accounts.va529')],
  'household.birthYears': ['We need your birth year, and your spouse\'s when you file jointly, before sizing age based limits.', confirmTask('household.birthYears')],
  ira_room_missing: ['IRA contribution room could not be figured for everyone in the household, so the backdoor Roth recommendation is on hold.', 'Check the household ages and income on file'],
  'retirement.otherPlanDeferrals': ['We need your deferrals to other workplace plans this year before sizing retirement room.', confirmTask('retirement.otherPlanDeferrals')],
  'retirement.priorYearFicaWages': ["We need last year's Social Security wages from your business before sizing catch-up room.", confirmTask('retirement.priorYearFicaWages')],
  'retirement.planOffersRoth': ['We need to know whether your plan offers Roth deferrals before sizing catch-up room.', confirmTask('retirement.planOffersRoth')],
  wargame_contribution_over_limit: ['At one of the incomes this comparison models, this year or next, a retirement contribution would be above what the plan rules allow, so this comparison is not a current choice.', 'Check your retirement contribution amounts with your plan provider or accountant'],
  wargame_salary_contribution_over_limit: ['At one of the salaries in the approved range, a retirement contribution would be above what the plan rules allow for that salary, so this comparison is not a current choice.', 'Check your retirement contribution amounts with your plan provider or accountant'],
  inputs_changed: ['Its inputs changed, so it is kept for reference and is not a current choice.', 'Review the latest data on your plan'],
  w2_plan_compensation_unknown: ['Retirement deferrals on a W-2 from your own business could not be read, so plan compensation is unknown and the figures that depend on it are on hold.', 'Upload a W-2 copy that shows box twelve'],
  k1_unmatched: ['Partnership statements do not name their partnership, and the statements on file do not match your partnerships one to one, so tax projections are on hold.', 'Upload one partnership statement for each partnership, or check your household businesses'],
  k1_scorp_unmatched: ['An S corporation shareholder statement is on file, but no S corporation with a profit and loss is, so tax projections are on hold.', 'Upload the S corporation profit and loss, or add it to your household businesses'],
  tax_payment_kind_unknown: ['A tax payment row does not say whether it is withholding or an estimated payment, so payments are on hold.', 'Check the tax payment log for an unlabeled row'],
  withholding_state_unknown: ['A W-2 or paystub shows state withholding without naming the state, so Virginia withholding is on hold.', 'Upload a clearer copy that shows the state'],
  withholding_recipient_unknown: ['Some withholding could be counted twice until we know whose pay it was, so withholding is on hold.', 'Answer who is paid by each employer in Confirm'],
  withholding_conflict_pending: ['Two documents report different withholding for the same payer, so withholding is on hold.', CONFIRM_WHICH_W2],
  tax_year_unconfirmed: ['We do not know which tax year your logged estimated payments belong to, so payments are on hold.', 'Answer the tax year question for your payment log in Confirm'],
  estimated_payer_unknown: ['Your payment log has payments from more than one person, and only one return is filed, so payments are on hold.', 'Check whose estimated payments count toward this return'],
});
const RETAINED = 'No longer computed from your current data, so it is shown for reference only.';

// Where an item is cleared: what kind of work it is (an answer, an upload or a check) and the link
// that takes the owner there. 'upload' is the Files page; 'ask' is Ask with this recommendation
// attached, where a question is answered in plain words.
const UPLOAD_NOUN = Object.freeze({
  paystub_ytd_missing: 'a paystub', paystub_deferrals_unknown: 'a W-2', w2_box12_unreadable: 'a W-2', w2_wages_missing: 'a W-2', w2_medicare_wages_missing: 'a W-2',
  w2_plan_compensation_unknown: 'a W-2', w2_duplicate_unresolved: 'a W-2', withholding_state_unknown: 'a clearer copy', k1_unmatched: 'partnership statements',
  k1_scorp_unmatched: 'a profit and loss', prior_year_missing: "last year's return", partnership_incomplete: 'partnership statements',
});
export function classify(task, code, answerKey) {
  if (/^Upload\b/.test(task)) return { kind: 'upload', link: 'upload', noun: UPLOAD_NOUN[code] || 'a file' };
  if (answerKey || /\bin Confirm$|^Answer\b/.test(task)) return { kind: 'question', link: 'ask' };
  if (/^(Tell us|Enter|Confirm)\b/.test(task)) return { kind: 'question', link: 'ask' };
  return { kind: 'check', link: 'ask' };
}
const withKind = item => ({ ...item, ...classify(item.task, item.code, item.answerKey) });

// `name` formats a data-derived name: dataText for stored rec HTML, plain for a plain-text reason.
function reasonItem(ctx, reason, name = dataText) {
  return withKind(rawReasonItem(ctx, reason, name));
}

function rawReasonItem(ctx, reason, name) {
  if (reason.startsWith('entity_unclassified:')) {
    const slug = reason.slice('entity_unclassified:'.length);
    const e = (ctx.entities || []).find(x => x.slug === slug);
    if (e && !ctx.declinedLedgerGuess && looksLikeSpending(e, ctx.facts)) return { code: reason, tax: true, text: name(spendingStatement(e)), task: 'Confirm the spending ledger classification in Confirm' };
    const who = e ? name(e.displayName || e.name) : 'a business in your profit and loss';
    return { code: reason, tax: true, text: `We do not know how ${who} is taxed.`, task: `Tell us how ${who} is taxed` };
  }
  if (reason === 'partnership_incomplete') {
    const names = ((ctx.info && ctx.info.partnershipsMissing) || []).map(name);
    const text = names.length
      ? `We do not have complete partnership figures for ${names.join(', ')}.`
      : 'A partnership statement or partnership estimate is missing an amount we need.';
    return { code: reason, tax: true, text, task: 'Add the ordinary income, guaranteed payments and self-employment earnings from each K-1, or a partnership estimate' };
  }
  if (PAYROLL_NAMED[reason]) {
    const names = [...new Set(((ctx.info && ctx.info.payrollBlocks) || []).filter(b => b.code === reason && String(b.employer ?? '').trim()).map(b => name(b.employer)))];
    const who = names.length ? names.join(', ') : 'an employer';
    return { code: reason, tax: true, text: PAYROLL_NAMED[reason][0](who), task: PAYROLL_NAMED[reason][1] };
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
  const stale = staleAccountIds(ctx.data?.accounts ?? []);
  for (const s of ctx.freshness || []) {
    if (s.state === 'current') continue;
    if ((s.id === 'pnl' || s.id === 'tax_payments') && !business) continue;
    out.push({
      code: s.id, tax: TAX_CODES.has(s.id),
      ...(['balances', 'transactions'].includes(s.id) ? { accountIds: stale } : {}),
      text: s.state === 'missing' ? `${s.label}: nothing uploaded yet.` : `${s.label}: out of date.`,
      task: `Upload the latest ${s.label.toLowerCase()}`, kind: 'upload', link: 'upload', noun: `the latest ${s.label.toLowerCase()}`,
    });
  }
  if (ctx.warnings.includes('prior_year_missing')) {
    out.push({ code: 'prior_year_missing', tax: true, text: "Last year's tax return is missing, so the federal target uses this year's projection.", task: "Upload last year's tax return", ...classify("Upload last year's tax return", 'prior_year_missing') });
  }
  if (ctx.warnings.includes('filing_status_assumed')) {
    out.push({ code: 'filing_status_assumed', tax: true, text: 'Your filing status is not set, so we assumed single.', task: 'Tell us your filing status', kind: 'question', link: 'ask' });
  }
  const reasons = [...(ctx.info.blocked || []), ...(ctx.info.heldReasons || []), ...(ctx.blockedReasons || []).map(b => b.reason)];
  for (const r of reasons) if (!ADVISOR_KEYS.has(r)) out.push(reasonItem(ctx, r));
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
  const factFor = { va529_answers_missing: 'accounts.va529', retirement_other_deferrals_missing: 'retirement.otherPlanDeferrals', deferral_split_unknown: 'retirement.otherPlanDeferrals', va_itemized_missing: 'tax.vaItemizedEstimate', filing_status_assumed: 'household.filingStatus' };
  const list = items(ctx).map(i => {
    const answerKey = factFor[i.code] || (Object.hasOwn(ANSWER_SHAPES, i.code) ? i.code : null);
    const confirmId = /\bin Confirm$/.test(i.task) ? confirmItemFor(i.code, ctx.data?.confirm)?.id : null;
    return { ...i, answerKey, ...(confirmId ? { confirmId } : {}), ...(answerKey ? { kind: 'question', link: 'ask' } : {}) };
  }).filter(i => (!i.answerKey || !ctx.questionKeys?.has(i.answerKey)) && (!i.answerKey || !questionFor([i.answerKey], { accounts: ctx.data?.accounts || [], facts: ctx.facts }).answered));
  if (!list.length) return null;
  const questions = [...new Set(list.map(i => i.answerKey).filter(Boolean))];
  const answers = questions.length ? list.every(i => i.answerKey) ? { confirm: questions } : { questions } : {};
  return { grounding: [], items: list, ...answers };
}

// The count of a kind of item as words for a title: one reads "a", more read the number.
const count = (n, one, many) => (n === 1 ? `a ${one}` : `${n} ${many}`);

// What the owner has to do to clear the list, for the title and summary: "Answer 2 tax questions
// and upload a paystub". Questions come first, then uploads, then checks.
export function listTitle(list) {
  const of = kind => list.filter(i => i.kind === kind);
  const asks = of('question');
  const ups = of('upload');
  const checks = of('check');
  const parts = [];
  if (asks.length) {
    const tax = asks.every(i => i.tax);
    parts.push(`answer ${count(asks.length, tax ? 'tax question' : 'question', tax ? 'tax questions' : 'questions')}`);
  }
  if (ups.length) {
    const nouns = [...new Set(ups.map(i => i.noun))];
    parts.push(ups.length === 1 || nouns.length === 1 ? `upload ${nouns[0]}` : `upload ${ups.length} files`);
  }
  if (checks.length) parts.push(`check ${count(checks.length, 'item', 'items')}`);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'update your data';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Every item as a step the product verifies: an answer step names the fact the form above saves,
// every other step the item code, which clears when the planner no longer finds the item. Each
// carries where it is done: an upload, the exact Confirm question, or Ask with this rec attached.
export function stepOf(i) {
  if (i.answerKey) return { t: i.task, kind: 'answer', fact: i.answerKey };
  if (i.kind === 'upload') return { t: i.task, kind: 'upload', code: i.code, noun: i.noun, link: 'upload' };
  if (/\bin Confirm$/.test(i.task)) return { t: i.task, kind: 'confirm', code: i.code, link: i.confirmId ? 'confirm' : 'ask', ...(i.confirmId ? { confirmId: i.confirmId } : {}) };
  if (i.code.startsWith('entity_unclassified:')) return { t: i.task, kind: 'classify', code: i.code, link: 'ask' };
  return { t: i.task, kind: i.kind === 'question' ? 'answer' : 'review', code: i.code, link: 'ask' };
}

export function build(ctx, hit) {
  return {
    title: listTitle(hit.items),
    effort: 'A few minutes',
    value: [{ cls: 'risk', text: 'Keeps every figure on your plan current' }],
    mine: [],
    cross: [],
    tasks: hit.items.map(stepOf),
  };
}

export function template(ctx, hit) {
  return {
    summary: 'Update the missing data so the parts of your plan that are on hold can update.',
    why: hit.items.slice(0, 4).map(i => i.text),
    qa: [{ q: 'What happens to recommendations in the meantime?', a: ['They keep their last figures and wait for the data. Nothing is retired because a file is late.'] }],
  };
}

// What a trigger is waiting on, for the Plan card and dialog: the plain reason, the task that clears
// it and the link to where it is done. Built from the same reason text the missing-data rec lists.
export function blockerOf(ctx, code) {
  const item = reasonItem(ctx, code, v => String(v));
  return { code, text: item.text, task: item.task, link: item.link };
}

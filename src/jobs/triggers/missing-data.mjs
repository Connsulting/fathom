import { TAX_GAP_RULES, taxGap, rankGaps } from '../../shared/tax-gaps.mjs';
// Missing data: stale or missing sources, unclassified businesses, blocked figures and missing
// tax inputs (R1, R14, R19, T9.5). Evaluated last so it sees every other trigger's block.

import { normalizeName } from '../../ingest/confirm.mjs';
import { ledgerDisplayName, summaryPerson, looksLikeSpending } from '../../pnl/ledgers.mjs';
import { ADVISOR_KEYS } from '../../facts/derive.mjs';
import { addDays } from '../planner/data.mjs';
import { confirmItemFor } from '../../shared/rec-steps.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
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

const CONFIRM_WHICH_W2 = 'Upload the corrected W-2';

// Fixed reason text per code: [what is on hold and why, the task that clears it]. No digits and no
// data-derived text, so the same sentence is safe as rec prose and as a plain-text reason.
const REASONS = Object.freeze({
  mfs_unsupported: ['Tax figures for married filing separately are not supported yet, so this filing status cannot be estimated.', 'Check your filing status, and ask your accountant for this year projection while filing separately'],
  calc_failed: ['A calculator could not use one of your answers, so those inputs need checking.', 'Check your household answers, such as ages, for typos'],
  'household.birthYears': ['We need your birth year, and your spouse\'s when you file jointly, before sizing age based limits.', confirmTask('household.birthYears')],
  ira_room_missing: ['IRA contribution room could not be figured for everyone in the household, so its contribution room is uncertain.', 'Check the household ages and income on file'],
  'retirement.otherPlanDeferrals': ['We need your deferrals to other workplace plans this year before sizing retirement room.', confirmTask('retirement.otherPlanDeferrals')],
  'retirement.priorYearFicaWages': ["We need last year's Social Security wages from your business before sizing catch-up room.", confirmTask('retirement.priorYearFicaWages')],
  'retirement.planOffersRoth': ['We need to know whether your plan offers Roth deferrals before sizing catch-up room.', confirmTask('retirement.planOffersRoth')],
  wargame_contribution_over_limit: ['At one of the incomes this comparison models, this year or next, a retirement contribution would be above what the plan rules allow, so this comparison is not a current choice.', 'Check your retirement contribution amounts with your plan provider or accountant'],
  wargame_salary_contribution_over_limit: ['At one of the salaries in the approved range, a retirement contribution would be above what the plan rules allow for that salary, so this comparison is not a current choice.', 'Check your retirement contribution amounts with your plan provider or accountant'],
  inputs_changed: ['Its inputs changed, so it is kept for reference and is not a current choice.', 'Review the latest data on your plan'],
  tax_payment_kind_unknown: ['A tax payment row does not say whether it is withholding or an estimated payment, so those payments are excluded.', 'Check the tax payment log for an unlabeled row'],
  withholding_state_unknown: ['A W-2 or paystub shows state withholding without naming the state, so those state withholding rows are excluded.', 'Upload a clearer copy that shows the state'],
  withholding_recipient_unknown: ['Some withholding could be counted twice until we know whose pay it was, so those withholding rows are excluded.', 'Answer who is paid by each employer in Confirm'],
  withholding_conflict_pending: ['Two documents report different withholding for the same payer, so those withholding rows are excluded.', CONFIRM_WHICH_W2],
  tax_year_unconfirmed: ['We do not know which tax year your logged estimated payments belong to, so those payments are excluded.', 'Answer the tax year question for your payment log in Confirm'],
  estimated_payer_unknown: ['Your payment log has payments from more than one person, and only one return is filed, so those payments are excluded.', 'Check whose estimated payments count toward this return'],
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
const withKind = item => ({ ...item, ...classify(item.task, item.code, item.answerKey), fix: item.fix || (MISSING_TASK_CODES.includes(item.code.split(':')[0]) || Object.hasOwn(ANSWER_SHAPES, item.code) ? fixForCode(item.code) : undefined) });

// `name` formats a data-derived name: dataText for stored rec HTML, plain for a plain-text reason.
function reasonItem(ctx, reason, name = dataText) {
  return withKind(rawReasonItem(ctx, reason, name));
}

function rawReasonItem(ctx, reason, name) {
  const gap = ctx.info?.gaps?.find(g => g.code === reason);
  if (gap && !reason.startsWith('entity_unclassified:')) return gapItem(gap, name);
  if (TAX_GAP_RULES[reason]) {
    const who = ctx.info?.payrollBlocks?.filter(b => b.code === reason).map(b => b.employer).filter(Boolean).join(', ') || undefined;
    return gapItem(taxGap(reason, { employer: who }), name);
  }
  if (reason.startsWith('entity_unclassified:')) {
    const slug = reason.slice('entity_unclassified:'.length);
    const e = (ctx.entities || []).find(x => x.slug === slug);
    const unnamed = (ctx.entities || []).filter(x => x.needsName);
    if (unnamed.length) {
      const who = unnamed.map(x => name(x.displayName)).join(', ');
      return { code: 'accounts.businessEntity', tax: true, text: `What is the business name for ${who}?`, task: `Tell Fathom the business name for ${who}` };
    }
    const unclassified = (ctx.entities || []).filter(x => !x.classified);
    const names = unclassified.length ? unclassified.map(x => name(x.displayName || x.name))
      : [...new Set((ctx.data?.pnl || []).map(ledgerDisplayName))].map(name);
    const who = names.length ? names.join(', ') : e ? name(e.displayName || e.name) : 'a business in your profit and loss';
    const task = unclassified.some(x => summaryPerson(x, ctx.facts) || looksLikeSpending(x, ctx.facts))
      ? `Tell Fathom how to classify ${who}: personal spending summary, S corp, sole proprietorship, partnership, or not mine?`
      : `How is ${who} taxed? Tell Fathom: S corp, sole proprietorship, partnership, personal spending, or not mine.`;
    const exposures = (ctx.info.gaps || []).filter(g => g.code.startsWith('entity_unclassified:')).map(g => g.impact).filter(Number.isFinite);
    const plainNames = unclassified.map(e => e.displayName || e.name).join(', ') || 'the unclassified businesses';
    return { code: reason, tax: true, text: task, task, optional: true, rough: true, impact: exposures.length ? exposures.reduce((sum, n) => sum + n, 0) : null, fix: {
      screen: 'ask', key: 'business.entities', label: 'Classify the businesses',
      prompt: `Record how these businesses are taxed: ${plainNames}. Ask me for the missing classifications, preserving existing entries and account links.`,
    } };
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
    return { code: reason, tax: false, text: 'An answer here would improve the precision of your plan.', task: confirmTask(reason) };
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
  const out = rankGaps(ctx.info?.gaps || []).filter(g => !g.code.startsWith('entity_unclassified:')).map(g => gapItem(g));
  const business = BUSINESS_FACTS.some(k => ctx.facts[k] === true);
  const institutions = new Map();
  for (const account of ctx.refreshNeeds?.accounts ?? []) {
    const key = normalizeName(account.inst) || account.id;
    if (!institutions.has(key)) institutions.set(key, []);
    institutions.get(key).push(account);
  }
  for (const [institution, accounts] of institutions) {
    const names = accounts.map(a => accountLabel(a)).join(', ');
    const name = accounts[0].inst || names;
    out.push({ code: `balances:${institution}`, accountIds: accounts.map(a => a.id), tax: false,
      text: `${dataText(name)}: the plan uses out of date account data for ${dataText(names)}.`,
      task: `Upload the latest statement for ${dataText(name)}, covering ${dataText(names)}`, kind: 'upload', link: 'upload', noun: 'an account statement',
      fix: fixForCode('balances'),
    });
  }
  for (const s of ctx.freshness || []) {
    if (s.state === 'current' || ['balances', 'transactions'].includes(s.id)) continue;
    if (ctx.refreshNeeds && s.state !== 'missing' && ![...ctx.refreshNeeds.sourceIds].some(id => ctx.data.files.some(f => f.source_id === id && (s.id === 'pnl' ? f.source_kind === 'pnl_workbook' : f.source_kind === s.id)))) continue;
    if ((s.id === 'pnl' || s.id === 'tax_payments') && !business) continue;
    out.push({
      code: s.id, tax: TAX_CODES.has(s.id),
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
  const reasons = [...(ctx.info.blocked || []), ...(ctx.info.gaps || []).filter(g => g.code.startsWith('entity_unclassified:')).map(g => g.code), ...(ctx.info.heldReasons || []), ...(ctx.blockedReasons || []).map(b => b.reason),
    ...(ctx.entities || []).filter(e => e.payrollEmployer && !e.classified).map(e => `entity_unclassified:${e.slug}`)];
  let entityQuestion = false;
  for (const r of reasons) if (!ADVISOR_KEYS.has(r)) {
    if (r.startsWith('entity_unclassified:')) {
      if (entityQuestion) continue;
      entityQuestion = true;
    }
    out.push(reasonItem(ctx, r));
  }
  if (!entityQuestion && ctx.facts['income.sCorp'] === true && ctx.data?.pnl?.length && !ctx.entities?.some(e => e.type === 's_corp')) {
    out.push(reasonItem(ctx, 'entity_unclassified:scorp'));
  }
  if (ctx.mortgage?.present && ctx.mortgage.missing.length) out.push({ code: 'obligations.mortgage', tax: false,
    text: `Mortgage: tell Fathom only the missing ${ctx.mortgage.missing.join(', ')}.`, task: 'Tell Fathom the missing mortgage terms', kind: 'question', link: 'ask' });
  for (const entity of ctx.entities || []) if (entity.type === 'partnership' && entity.status === 'final_year' && entity.finalYear === ctx.data.year) {
    const text = `Expect a final K-1 for ${dataText(entity.name)} for its final tax year.`;
    out.push({ code: `final_k1:${entity.slug}`, tax: true, text, task: text, kind: 'check', link: 'ask' });
  }
  const summaries = (Array.isArray(ctx.facts['business.entities']) ? ctx.facts['business.entities'] : []).filter(e => e?.type === 'personal').map(e => {
    const line = (ctx.data?.pnlHistory || ctx.data?.pnl || []).find(l => normalizeName(l.entity) === normalizeName(e.name));
    return { ...e, displayName: line ? ledgerDisplayName(line) : e.name };
  }).filter(e => !summaryPerson(e, ctx.facts));
  if (summaries.length) {
    const question = `Who do these personal spending and income summaries belong to: ${summaries.map(e => dataText(e.displayName)).join(', ')}? Tell Fathom which is yours and which is your spouse's.`;
    out.push({ code: 'pnl_people_unknown', tax: false, text: question, task: question, kind: 'question', link: 'ask' });
  }
  const seen = new Set();
  return rankGaps(out.filter(i => (seen.has(i.code) ? false : (seen.add(i.code), true))).map(i => ({ ...i, fix: i.fix || fixForCode(i.code) })));
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
    const answerKey = i.optional ? null : factFor[i.code] || (Object.hasOwn(ANSWER_SHAPES, i.code) ? i.code : null);
    const employers = (ctx.info.payrollBlocks ?? []).filter(b => b.code === i.code).map(b => normalizeName(b.employer)).filter(Boolean);
    const files = (ctx.data?.documents ?? []).filter(doc => employers.includes(normalizeName(doc.fields?.employerName))).map(doc => doc.fileId).filter(Boolean);
    const candidates = (ctx.data?.confirm ?? []).filter(item => !employers.length || employers.includes(normalizeName(item.context?.employer)) || files.includes(item.fileId));
    const confirmId = /\bin Confirm$/.test(i.task) ? confirmItemFor(i.code, candidates)?.id : null;
    return { ...i, answerKey, ...(confirmId ? { confirmId } : {}), ...(answerKey ? { kind: 'question', link: 'ask' } : {}) };
  }).filter(i => (i.fix || !i.answerKey || !ctx.questionKeys?.has(i.answerKey)) && (!i.answerKey || !questionFor([i.answerKey], { accounts: ctx.data?.accounts || [], facts: ctx.facts }).answered));
  if (!list.length) return null;
  const questions = [...new Set(list.map(i => i.answerKey).filter(Boolean))];
  const answers = questions.length ? list.every(i => i.answerKey) ? { confirm: questions } : { questions } : {};
  return { grounding: [], items: list, ...answers };
}

// Titles name the work; the Steps view renders progress counts from task data.
const phraseFor = (n, one, many) => (n === 1 ? `a ${one}` : many);

// What clears the list. Questions come first, then uploads, then checks.
export function listTitle(list) {
  const of = kind => list.filter(i => i.kind === kind);
  const asks = of('question');
  const ups = of('upload');
  const checks = of('check');
  const parts = [];
  if (asks.length) {
    const tax = asks.every(i => i.tax);
    parts.push(`answer ${phraseFor(asks.length, tax ? 'tax question' : 'question', tax ? 'tax questions' : 'questions')}`);
  }
  if (ups.length) {
    const nouns = [...new Set(ups.map(i => i.noun))];
    parts.push(ups.length === 1 || nouns.length === 1 ? `upload ${nouns[0]}` : 'upload the latest files');
  }
  if (checks.length) parts.push(`check ${phraseFor(checks.length, 'item', 'items')}`);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'update your data';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Every item as a step the product verifies: an answer step names the fact the form above saves,
// every other step the item code, which clears when the planner no longer finds the item. Each
// carries where it is done: an upload, the exact Confirm question, or Ask with this rec attached.
export function stepOf(i) {
  if (i.fix && i.optional) return { t: i.task, kind: i.code.startsWith('entity_unclassified:') ? 'classify' : i.fix.screen === 'upload' ? 'upload' : 'answer', code: i.code, link: i.fix.screen, fix: i.fix, optional: true };
  if (i.answerKey) return { t: i.task, kind: 'answer', fact: i.answerKey };
  if (i.kind === 'upload') return { t: i.task, kind: 'upload', code: i.code, noun: i.noun, link: 'upload', ...(i.fix ? { fix: i.fix } : {}), ...(i.accountIds ? { accountIds: i.accountIds } : {}) };
  if (/\bin Confirm$/.test(i.task)) return { t: i.task, kind: 'confirm', code: i.code, link: i.confirmId ? 'confirm' : 'ask', ...(i.confirmId ? { confirmId: i.confirmId } : {}) };
  if (i.code.startsWith('entity_unclassified:')) return { t: i.task, kind: 'classify', code: i.code, link: 'ask' };
  return { t: i.task, kind: i.kind === 'question' ? 'answer' : 'review', code: i.code, link: 'ask' };
}

export function build(ctx, hit) {
  return {
    title: hit.items.some(i => i.optional) ? 'Improve the precision of your estimates' : listTitle(hit.items),
    effort: 'A few minutes',
    value: [{ cls: 'risk', text: 'Keeps every figure on your plan current' }],
    mine: [],
    cross: [],
    tasks: hit.items.map(stepOf),
  };
}

export function template(ctx, hit) {
  return {
    summary: 'Your estimates use the information on file. These optional improvements would make them more precise, with the largest income gaps first.',
    why: hit.items.slice(0, 4).map(i => i.text),
    qa: [{ q: 'What happens to recommendations in the meantime?', a: ['Tax estimates continue using stated assumptions and the income on file. Each gap names the change that would improve precision.'] }],
  };
}

// What a trigger is waiting on, for the Plan card and dialog: the plain reason, the task that clears
// it and the link to where it is done. Built from the same reason text the missing-data rec lists.
export function blockerOf(ctx, code) {
  const item = reasonItem(ctx, code, v => String(v));
  return { code, text: item.text, task: item.task, link: item.link, ...(item.fix ? { fix: item.fix } : {}) };
}

function gapItem(gap, name = dataText) {
  return { code: gap.code, tax: true, text: name(gap.message), task: `${gap.action.label}${gap.employer && gap.employer !== 'this business' ? ` for ${name(gap.employer)}` : ''}`,
    kind: gap.action.screen === 'upload' ? 'upload' : 'question', link: gap.action.screen, fix: gap.action, optional: true, rough: gap.rough, impact: gap.impact };
}

const SOURCE_FIXES = Object.freeze({ final_k1: 'taxforms', bank: 'bank', balances: 'bank', transactions: 'aggregator', pnl: 'pnl', tax_payments: 'estimates', prior_year_missing: 'taxforms',
  tax_payment_kind_unknown: 'estimates', tax_year_unconfirmed: 'estimates', estimated_payer_unknown: 'estimates', withholding_state_unknown: 'taxforms',
  withholding_recipient_unknown: 'taxforms', withholding_conflict_pending: 'taxforms', calc_failed: 'taxforms',
  wargame_contribution_over_limit: 'taxforms', wargame_salary_contribution_over_limit: 'taxforms', inputs_changed: 'taxforms' });
export const MISSING_TASK_CODES = Object.freeze([...new Set([...Object.keys(REASONS), ...Object.keys(TAX_GAP_RULES),
  ...Object.keys(SOURCE_FIXES), 'entity_unclassified', 'filing_status_assumed', 'pnl_people_unknown'])]);
export function fixForCode(code) {
  const base = code.split(':')[0];
  if (TAX_GAP_RULES[base]) return { ...TAX_GAP_RULES[base].fix };
  const key = base === 'pnl_people_unknown' ? 'pnl.people' : base === 'mfs_unsupported' ? 'household.filingStatus' : base === 'ira_room_missing' ? 'household.birthYears' : code;
  if (Object.hasOwn(ANSWER_SHAPES, key)) return { screen: 'ask', key, label: 'Enter the missing answer', prompt: `Help me record ${key}. Ask me for the missing information.` };
  const kind = SOURCE_FIXES[base];
  if (kind) return { screen: 'upload', kind, label: 'Upload the updated record' };
  throw new TypeError(`No missing-data fix for ${code}`);
}

// Suggested goal targets: a deterministic calculator over stored rows the caller has already read.
// Pure: no store, no clock of its own. Every number it returns is a provenance figure in the pace
// figure shape ({v, src: 'calc:targets', kind, label, notes, locator}); labels carry no digits and
// notes are plain sentences naming the window, each parameter and the accounts left out.
//
// Kinds (goalKind): 'cushion' (months of spending held in personal cash), 'independence'
// (investments that cover yearly spending at a withdrawal rate) and 'tax' (this year's unused
// contribution room from the planner's stored room figures). Anything else is a question.

import { createHash } from 'node:crypto';
import { resolveCategories } from '../categories/resolve.mjs';
import { finite, round } from './pace.mjs';
import { figure, rowsSource, mergeSources } from './figure.mjs';
import { HORIZON_IDS, horizonLabel } from '../shared/goals.mjs';
import { accountLabel } from '../shared/account-label.mjs';

export const TARGET_PARAMETERS = Object.freeze({
  cushionMonths: 6, withdrawalRate: 0.04, withdrawalRateMin: 0.02, withdrawalRateMax: 0.06, realReturn: 0.04,
  maxProjectionMonths: 600, transferDays: 5, maxWindowMonths: 12, minWindowMonths: 3, closedAfterMonths: 6,
});

export const SPENDING_KINDS = Object.freeze(['checking', 'savings', 'cash', 'card']);
export const CASH_KINDS = Object.freeze(['checking', 'savings', 'cash']);
export const INVESTMENT_KINDS = Object.freeze(['taxable', 'brokerage', 'retirement', 'roth', 'ira']);
export const ASK = 'What amount would make this real?';
export const ROOM_PARTS = Object.freeze([
  Object.freeze({ part: 'retirement', key: 'room.solo401k.pretax', label: 'Unused solo 401(k) pretax room this year', words: 'pretax retirement' }),
  Object.freeze({ part: 'sep', key: 'room.sep', label: 'Unused SEP room this year', words: 'SEP' }),
  Object.freeze({ part: 'hsa', key: 'room.hsa', label: 'Unused HSA room this year', words: 'HSA' }),
  Object.freeze({ part: 'dependentCare', key: 'room.dependentCare', label: 'Unused dependent care room this year', words: 'dependent care' }),
]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

const word = n => NUMBER_WORDS[n] ?? String(n);
const pct = r => `${round(r * 100)}%`;
const usd = v => `$${round(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const listText = items => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

// ---------------------------------------------------------------- dates

const monthIndex = ym => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthOf = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const monthName = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const isoOf = date => date.toISOString().slice(0, 10);
// The last day of the month n months after the clock's month.
export const monthEndAfter = (clock, n) => isoOf(new Date(Date.UTC(Number(clock.slice(0, 4)), Number(clock.slice(5, 7)) + n, 0)));

const HORIZON_YEARS = { now: 0, '1-3y': 3, '3-10y': 10 };
export const horizonOf = h => HORIZON_IDS.includes(h) ? h : 'now';
export const horizonLabelOf = h => horizonLabel(horizonOf(h));
// Dec 31 of the clock year plus the horizon's years.
export const horizonEnd = (horizon, clock) => `${Number(clock.slice(0, 4)) + HORIZON_YEARS[horizonOf(horizon)]}-12-31`;

export function windowText(window) {
  const from = monthName(window.from);
  const to = monthName(window.to);
  const span = window.from.slice(0, 4) === window.to.slice(0, 4) ? `${from.slice(0, 3)} to ${to}` : `${from} to ${to}`;
  return `${span}, ${word(window.months)} full month${window.months === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- kinds

const TOKEN = /\{[a-z]+:[^{}]*\}/g;
const KIND_WORDS = [
  ['independence', /work (becomes |is )?optional|work less|stop working|financial(ly)? independen|\bfire\b|retire early|early retirement|investments? (cover|pay for)|live off (our|my) (investments|portfolio|savings)|on (our|my) terms/i],
  ['tax', /\btax(es)?\b/i],
  ['cushion', /cash cushion|cushion|emergency fund|emergency|rainy day|runway|safety net|months of (spending|expenses)/i],
];

// -> {kind: 'cushion'|'independence'|'tax'|null, reason: null|'unsupported_goal'|'ambiguous_goal'}
export function goalKind(goal) {
  const text = `${String(goal?.title ?? '').replace(TOKEN, ' ')} ${String(goal?.note ?? '').replace(TOKEN, ' ')}`;
  const hits = KIND_WORDS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (hits.length === 1) return { kind: hits[0], reason: null };
  return { kind: null, reason: hits.length ? 'ambiguous_goal' : 'unsupported_goal' };
}

// ---------------------------------------------------------------- figures

// An account name fit for a note: scenario tokens are not plain text, so such a name becomes its kind.
export const plainAccountName = a => typeof a?.name === 'string' && a.name.trim() && !/\{[a-z]+:/i.test(a.name)
  ? a.name.trim() : `a ${a?.kind || 'household'} account`;

// ---------------------------------------------------------------- spending

// The complete-month run of one account: the month after its first transaction to the month before
// its last, split at months without a transaction, the latest run kept. -> {from, to} indexes or null.
// Window selection lives here, separate from which transactions count as spending.
export function resolveSpendingWindow({ accounts, monthsOf, clock, parameters = TARGET_PARAMETERS }) {
  const closedAfter = parameters.closedAfterMonths ?? TARGET_PARAMETERS.closedAfterMonths;
  const silent = [];
  const incomplete = [];
  const runs = [];
  for (const a of accounts) {
    const months = monthsOf.get(a.id);
    if (!months || !months.size) { silent.push(a); continue; }
    const run = accountRun(months);
    if (!run) { incomplete.push(a); continue; }
    let lastTx = -Infinity;
    for (const m of months) if (m > lastTx) lastTx = m;
    runs.push({ account: a, run, lastTx, months });
  }
  const out = {
    window: null, months: 0, counted: [], silent, incomplete, closed: [], limitedBy: [],
    ranges: new Map(), missing: [],
  };
  if (!runs.length) { out.missing.push('no_spending_history'); return out; }
  const newest = Math.max(...runs.map(r => r.run.to));
  const closedRuns = [];
  const openRuns = [];
  for (const r of runs) (r.lastTx <= newest - closedAfter ? closedRuns : openRuns).push(r);
  out.closed = closedRuns.map(r => r.account);
  if (!openRuns.length) { out.missing.push('no_spending_history'); return out; }
  const to = Math.min(...openRuns.map(r => r.run.to), monthIndex(clock.slice(0, 7)) - 1);
  // A gap means months exist before the latest run. That run still sets the start.
  // An account with no earlier months opened then, and does not push the start later.
  const openedThen = r => [...r.months].some(m => m < r.run.from - 1);
  const gapFroms = openRuns.filter(openedThen).map(r => r.run.from);
  const wholeFroms = openRuns.filter(r => !openedThen(r)).map(r => r.run.from);
  let from = to - parameters.maxWindowMonths + 1;
  if (gapFroms.length) from = Math.max(from, ...gapFroms);
  if (wholeFroms.length) from = Math.max(from, Math.min(...wholeFroms));
  const span = to - from + 1;
  if (span < parameters.minWindowMonths) { out.missing.push('no_spending_history'); return out; }
  out.window = { from: monthOf(from), to: monthOf(to), months: span };
  out.months = span;
  const overlaps = r => r.run.to >= from && r.run.from <= to;
  const activeClosed = closedRuns.filter(overlaps);
  out.counted = [...openRuns.map(r => r.account), ...activeClosed.map(r => r.account)];
  out.limitedBy = openRuns.filter(r => r.run.to === to).map(r => r.account);
  for (const r of [...openRuns, ...activeClosed]) {
    out.ranges.set(r.account.id, { from: Math.max(r.run.from, from), to: Math.min(r.run.to, to) });
  }
  return out;
}

function accountRun(months) {
  const sorted = [...months].sort((a, b) => a - b);
  const first = sorted[0] + 1;
  const last = sorted.at(-1) - 1;
  if (last < first) return null;
  let to = last;
  while (to >= first && !months.has(to)) to--;
  if (to < first) return null;
  let from = to;
  while (from - 1 >= first && months.has(from - 1)) from--;
  return { from, to };
}

// accounts [{id, kind, name}], transactions [{id, account_id, date, amount}] dated on or before the
// clock. -> {window, months, monthlySpend, annualSpend, monthlySavings, spendIds, incomeIds,
//   counted: [account], silent: [account], missing: [codes]}
// A business account: kind business, or flagged by the store side (owner or stated entity).
export const isBusinessAccount = a => !!a && (a.business === true || a.kind === 'business');

export function spendingInputs({ accounts, transactions, corrections = [], merchantRules = [], sourceRules = [], guesses = [], clock, parameters = TARGET_PARAMETERS }) {
  const P = parameters;
  const byId = new Map(accounts.map(a => [a.id, a]));
  const isSpending = a => SPENDING_KINDS.includes(a.kind) && !isBusinessAccount(a);
  const spending = accounts.filter(isSpending);
  const rows = transactions.filter(t => byId.has(t.account_id) && finite(t.amount) && typeof t.date === 'string' && t.date <= clock);
  const monthsOf = new Map();
  for (const t of rows) {
    if (!isSpending(byId.get(t.account_id))) continue;
    const set = monthsOf.get(t.account_id) || new Set();
    set.add(monthIndex(t.date.slice(0, 7)));
    monthsOf.set(t.account_id, set);
  }
  const resolved = resolveSpendingWindow({ accounts: spending, monthsOf, clock, parameters: P });
  const out = {
    window: resolved.window, months: resolved.months, counted: resolved.counted, silent: resolved.silent,
    incomplete: resolved.incomplete, closed: resolved.closed, limitedBy: resolved.limitedBy,
    spendIds: [], incomeIds: [], windowTransactionIds: [], missing: [...resolved.missing],
  };
  if (!resolved.window) return out;

  const inWindow = t => {
    const range = resolved.ranges.get(t.account_id);
    if (!range) return false;
    const m = monthIndex(t.date.slice(0, 7));
    return m >= range.from && m <= range.to;
  };
  const ordered = rows.toSorted((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const onSpending = ordered.filter(t => isSpending(byId.get(t.account_id)) && inWindow(t));
  out.windowTransactionIds = onSpending.map(t => t.id);
  const categories = resolveCategories({ accounts, transactions: ordered, corrections, merchantRules, sourceRules, guesses,
    transferSourceIds: onSpending.map(t => t.id), transferDays: P.transferDays });
  const spend = onSpending.filter(t => t.amount < 0 && categories.get(t.id).bucket === 'household');
  const income = onSpending.filter(t => t.amount > 0 && categories.get(t.id).bucket === 'income');
  for (const [layer, prefix] of [['guess', 'guessed'], ['uncategorized', 'uncategorized']]) {
    const uncertainSpend = spend.filter(t => categories.get(t.id).layer === layer);
    const uncertainIncome = income.filter(t => categories.get(t.id).layer === layer);
    out[prefix + 'Spend'] = round(-uncertainSpend.reduce((sum,t) => sum+t.amount,0));
    out[prefix + 'Income'] = round(uncertainIncome.reduce((sum,t) => sum+t.amount,0));
    out[prefix + 'Count'] = uncertainSpend.length + uncertainIncome.length;
  }
  const spendTotal = -spend.reduce((s, t) => s + t.amount, 0);
  const incomeTotal = income.reduce((s, t) => s + t.amount, 0);
  out.spendIds = spend.map(t => t.id);
  out.incomeIds = income.map(t => t.id);
  out.spendTotal = round(spendTotal);
  out.incomeTotal = round(incomeTotal);
  out.monthlySpend = round(spendTotal / out.months);
  out.annualSpend = round(spendTotal / out.months * 12);
  out.monthlySavings = round((incomeTotal - spendTotal) / out.months);
  return out;
}

// The spending figures, keyed by name (monthlySpend, annualSpend, monthlySavings).
export function spendingFigures(sp, { clock, parameters = TARGET_PARAMETERS }) {
  const endName = monthName(sp.window.to);
  const limitNote = sp.limitedBy?.length
    ? `The window ends in ${endName} because ${listText(sp.limitedBy.map(accountLabel))} ${sp.limitedBy.length === 1 ? 'has' : 'have'} no later complete month.`
    : `The window ends in ${endName}, the latest complete month on file.`;
  const windowNote = `Spending window: ${windowText(sp.window)}. ${limitNote}`;
  const countedNote = `Spending accounts counted: ${listText(sp.counted.map(accountLabel))}.`;
  const leftOut = [];
  if (sp.silent.length) leftOut.push(`No transactions on file for ${listText(sp.silent.map(accountLabel))}`);
  if (sp.incomplete?.length) leftOut.push(`No complete month on file for ${listText(sp.incomplete.map(accountLabel))}`);
  const leftCount = sp.silent.length + (sp.incomplete?.length || 0);
  const silentNote = leftOut.length
    ? `${leftOut.join('. ')}. ${leftCount === 1 ? 'Its' : 'Their'} spending is not counted.` : null;
  const P = {
    transferDays: parameters.transferDays, maxWindowMonths: parameters.maxWindowMonths,
    minWindowMonths: parameters.minWindowMonths, closedAfterMonths: parameters.closedAfterMonths,
  };
  const inputs = { months: sp.months, spendTotal: sp.spendTotal, incomeTotal: sp.incomeTotal,
    guessedSpend: sp.guessedSpend, uncategorizedSpend: sp.uncategorizedSpend, guessedIncome: sp.guessedIncome,
    uncategorizedIncome: sp.uncategorizedIncome, guessedCount: sp.guessedCount, uncategorizedCount: sp.uncategorizedCount };
  const base = { clock, inputs, parameters: P, window: sp.window };
  const spendSources = [rowsSource('transactions', sp.spendIds)];
  const transferNote = `Only household spending counts; business, transfers, taxes, saving and excluded categories are left out. Unclassified transfers match opposite amounts within ${word(parameters.transferDays)} days.`;
  const uncertaintyNote = `Spending includes ${usd(sp.guessedSpend ?? 0)} from guesses and ${usd(sp.uncategorizedSpend ?? 0)} from Uncategorized rows. Income includes ${usd(sp.guessedIncome ?? 0)} from guesses and ${usd(sp.uncategorizedIncome ?? 0)} from Uncategorized rows.`;
  return {
    monthlySpend: figure(sp.monthlySpend, { ...base, label: 'Monthly spending, recent average', calc: 'monthlySpend', sources: spendSources,
      formula: 'household bucket outflows on spending accounts in the window divided by the months in the window',
      notes: [windowNote, countedNote, uncertaintyNote, transferNote, silentNote] }),
    annualSpend: figure(sp.annualSpend, { ...base, label: 'Yearly spending, recent average', calc: 'annualSpend', sources: spendSources,
      formula: 'monthly spending times twelve', notes: [windowNote, uncertaintyNote, 'Yearly spending is monthly spending times twelve.', countedNote, silentNote] }),
    monthlySavings: figure(sp.monthlySavings, { ...base, label: 'Monthly savings, recent average', calc: 'monthlySavings',
      sources: [rowsSource('transactions', [...sp.incomeIds, ...sp.spendIds])],
      formula: 'income bucket inflows minus household bucket outflows on spending accounts in the window divided by the months',
      notes: [windowNote, uncertaintyNote, 'Savings is money coming into spending accounts minus spending, per month.',
        'Transfers in from other household accounts that are not business accounts are not income; business transfers in are.', countedNote] }),
  };
}

// holdings [{id, kind, name, value: actual figure | null}] -> {v, ids, sources, left: [account]} or null.
export function holdingsTotal(holdings) {
  const held = holdings.filter(h => h.value && finite(h.value.v));
  const left = holdings.filter(h => !(h.value && finite(h.value.v)));
  if (!held.length) return { total: null, held, left };
  return { total: round(held.reduce((s, h) => s + h.value.v, 0)), held, left,
    sources: mergeSources(held.flatMap(h => h.value.locator?.sources || [])),
    dataThrough: held.map(h => h.value.dataThrough).filter(Boolean).sort()[0] ?? null };
}

function currentFigure(h, { clock, label, kindWords, excluded }) {
  const notes = [`Latest stored value of ${listText(h.held.map(plainAccountName))}.`];
  if (h.left.length) notes.push(`Left out, no stored value: ${listText(h.left.map(plainAccountName))}.`);
  notes.push(excluded);
  return figure(h.total, { clock, label, kind: 'a', calc: 'current', sources: h.sources,
    inputs: { accounts: h.held.map(x => ({ id: x.id, v: x.value.v, dataThrough: x.value.dataThrough ?? null })) },
    formula: `sum of the latest stored values of the tracked ${kindWords} accounts`, notes });
}

// ---------------------------------------------------------------- kind plans

const DATE_NOTES = {
  projected: 'Date: projected from your recent monthly savings.',
  covered: horizon => `Date: the end of the ${horizon} horizon you picked; the target is already covered.`,
  noSavings: horizon => `Date: the end of the ${horizon} horizon you picked; recent savings are not positive, so no date is projected.`,
  tooLong: horizon => `Date: the end of the ${horizon} horizon you picked; at the recent savings rate the target is not reached within fifty years.`,
};

function dated({ need, savings, clock, horizon, monthsFor, P }) {
  const end = horizonEnd(horizon, clock);
  const label = horizonLabelOf(horizon);
  if (need <= 0) return { targetDate: end, dateSource: 'horizon', covered: true, note: DATE_NOTES.covered(label), why: 'covered' };
  if (!(savings > 0)) return { targetDate: end, dateSource: 'horizon', covered: false, note: DATE_NOTES.noSavings(label), why: 'noSavings' };
  const n = monthsFor();
  if (!finite(n) || n > P.maxProjectionMonths) return { targetDate: end, dateSource: 'horizon', covered: false, note: DATE_NOTES.tooLong(label), why: 'tooLong' };
  const date = monthEndAfter(clock, Math.max(1, Math.ceil(n - 1e-9)));
  if (date < clock) return { targetDate: end, dateSource: 'horizon', covered: false, note: DATE_NOTES.noSavings(label), why: 'noSavings' };
  return { targetDate: date, dateSource: 'projected', covered: false, note: DATE_NOTES.projected, why: 'projected', months: Math.ceil(n - 1e-9) };
}

// -> {target, current, targetDate, dateSource, covered, why, figures: {target, current}}
export function cushionPlan({ spending, cash, horizon, clock, goalId, parameters = TARGET_PARAMETERS }) {
  const P = parameters;
  const months = P.cushionMonths;
  const target = Math.ceil(round(months * spending.monthlySpend) / 100) * 100;
  const date = dated({ need: target - cash.total, savings: spending.monthlySavings, clock, horizon, P,
    monthsFor: () => (target - cash.total) / spending.monthlySavings });
  const windowNote = `Spending window: ${windowText(spending.window)}.`;
  const targetFig = figure(target, { clock, label: 'Suggested cash cushion', kind: 'e', calc: 'cushionTarget', window: spending.window,
    inputs: { monthlySpend: spending.monthlySpend, monthlySavings: spending.monthlySavings, current: cash.total, horizon: horizonOf(horizon) },
    parameters: { cushionMonths: months, maxProjectionMonths: P.maxProjectionMonths },
    sources: [rowsSource('transactions', spending.spendIds), rowsSource('goals', [goalId])],
    formula: 'cushion months times monthly spending, rounded up to the next hundred',
    notes: [windowNote, `Cushion months: ${word(months)}, the default.`, 'Rounded up to the next hundred dollars.', date.note] });
  const current = currentFigure(cash, { clock, label: 'Personal cash now', kindWords: 'checking, savings and cash',
    excluded: 'Only personal checking, savings and cash accounts count; business accounts and cards are left out.' });
  const whys = {
    covered: `Your personal cash already covers ${word(months)} months of your recent spending.`,
    projected: `${cap(word(months))} months of your recent spending held in personal cash, reached at your recent savings pace.`,
    noSavings: `${cap(word(months))} months of your recent spending held in personal cash; recent savings do not project a date, so it uses the end of the horizon you picked.`,
    tooLong: `${cap(word(months))} months of your recent spending held in personal cash; at your recent savings pace it takes too long to project, so it uses the end of the horizon you picked.`,
  };
  return { target, current: cash.total, ...date, why: whys[date.why], figures: { target: targetFig, current } };
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// The months to grow V to T with C saved a month at monthly rate r: the future-value-of-annuity solution.
export function monthsToReach({ target, invested, monthly, monthlyRate }) {
  if (!(monthly > 0)) return Infinity;
  if (monthlyRate === 0) return (target - invested) / monthly;
  return Math.log((target * monthlyRate + monthly) / (invested * monthlyRate + monthly)) / Math.log(1 + monthlyRate);
}

export function independencePlan({ spending, invested, horizon, clock, goalId, withdrawalRate, parameters = TARGET_PARAMETERS }) {
  const P = parameters;
  const rate = withdrawalRate;
  const target = Math.ceil(round(spending.annualSpend / rate) / 1000) * 1000;
  const monthlyRate = P.realReturn / 12;
  const date = dated({ need: target - invested.total, savings: spending.monthlySavings, clock, horizon, P,
    monthsFor: () => monthsToReach({ target, invested: invested.total, monthly: spending.monthlySavings, monthlyRate }) });
  const windowNote = `Spending window: ${windowText(spending.window)}.`;
  const targetFig = figure(target, { clock, label: 'Suggested amount invested', kind: 'm', calc: 'independenceTarget', window: spending.window,
    inputs: { annualSpend: spending.annualSpend, monthlySavings: spending.monthlySavings, current: invested.total, horizon: horizonOf(horizon),
      months: date.months ?? null },
    parameters: { withdrawalRate: rate, realReturn: P.realReturn, maxProjectionMonths: P.maxProjectionMonths },
    sources: [rowsSource('transactions', spending.spendIds), rowsSource('goals', [goalId])],
    formula: 'yearly spending divided by the withdrawal rate, rounded up to the next thousand; date months n = ln((T r + C) / (V r + C)) / ln(1 + r)',
    notes: [windowNote, `Withdrawal rate: ${pct(rate)} a year${rate === P.withdrawalRate ? ', the default' : ', your choice'}.`,
      `Real return: ${pct(P.realReturn)} a year, compounded monthly.`, 'Rounded up to the next thousand dollars.', date.note] });
  const current = currentFigure(invested, { clock, label: 'Invested now', kindWords: 'investment',
    excluded: 'Investment accounts are taxable, brokerage, retirement, Roth and IRA accounts; HSA, education and business accounts are left out.' });
  const base = 'Enough invested to cover your yearly spending at the chosen withdrawal rate, so work can become optional';
  const whys = {
    covered: 'Your investments already cover your yearly spending at the chosen withdrawal rate.',
    projected: `${base}, reached at your recent savings pace and an assumed real return.`,
    noSavings: `${base}; recent savings do not project a date, so it uses the end of the horizon you picked.`,
    tooLong: `${base}; at your recent savings pace it takes more than fifty years, so it uses the end of the horizon you picked.`,
  };
  return { target, current: invested.total, ...date, why: whys[date.why], figures: { target: targetFig, current } };
}

// rooms [{part, key, label, words, v, computedOn, taxYear}] (already filtered to this year).
export function taxPlan({ rooms, clock, goalId }) {
  const year = clock.slice(0, 4);
  const total = round(rooms.reduce((s, r) => s + r.v, 0));
  const parts = listText(rooms.map(r => r.words));
  const notComputed = ROOM_PARTS.filter(p => p.part !== 'sep' && !rooms.some(r => r.part === p.part || (p.part === 'retirement' && r.part === 'sep')));
  const roomFigures = Object.fromEntries(rooms.map(r => [r.part, figure(r.v, { clock, label: r.label, kind: 'm', calc: 'room',
    inputs: { key: r.key, v: r.v, computedOn: r.computedOn, taxYear: r.taxYear }, parameters: { taxYear: r.taxYear },
    sources: [rowsSource('figures', [r.key])], formula: `the stored planner figure ${r.key}`,
    notes: [`From the planner figure ${r.key}, computed on ${r.computedOn} for tax year ${r.taxYear}.`,
      'Only room for the current tax year counts; withheld figures are left out.'] })]));
  const target = figure(total, { clock, label: 'Suggested contributions this year', kind: 'm', calc: 'taxTarget',
    inputs: { rooms: rooms.map(r => ({ key: r.key, v: r.v })), taxYear: Number(year) }, parameters: { taxYear: Number(year) },
    sources: [rowsSource('figures', rooms.map(r => r.key)), rowsSource('goals', [goalId])],
    formula: 'sum of this year\'s unused room figures',
    notes: [`Tax year ${year}: unused ${parts} room from the planner.`, `Date: Dec 31, ${year}, the end of the tax year.`,
      notComputed.length ? `No current figure, so not counted: ${listText(notComputed.map(p => `${p.words} room`))}.` : null,
      'Nothing is tracked: contributions are not measured yet.'] });
  return { target: total, targetDate: `${year}-12-31`, dateSource: 'deadline', covered: false,
    why: `This year's unused ${parts} room lowers taxable income when you use it before the year ends.`,
    figures: { target, rooms: roomFigures } };
}

// ---------------------------------------------------------------- questions and fingerprints

const REASONS = {
  unsupported_goal: 'Fathom can suggest a target for a cash cushion, work becoming optional or paying less tax; this goal reads as none of those.',
  ambiguous_goal: 'This goal reads as more than one kind of goal, so no single target fits.',
  no_spending_history: `There are not yet ${word(TARGET_PARAMETERS.minWindowMonths)} full months of spending on file.`,
  no_cash_balance: 'No checking, savings or cash account has a stored balance.',
  no_investment_balance: 'No investment account has a stored value.',
  no_tax_room: 'No unused tax room for this year has been computed yet.',
};
export const questionWhy = missing => missing.map(m => REASONS[m] || 'Something this goal needs is not on file.').join(' ');

const canonical = v => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]))
    : typeof v === 'number' ? round(v) : v;
// sha256 hex of the canonical JSON of the record's semantic inputs.
export const suggestionFingerprint = parts => createHash('sha256').update(JSON.stringify(canonical(parts))).digest('hex');

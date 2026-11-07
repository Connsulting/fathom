// Suggested goal targets: a deterministic calculator over stored rows the caller has already read.
// Pure: no store, no clock of its own. Every number it returns is a provenance figure in the pace
// figure shape ({v, src: 'calc:targets', kind, label, notes, locator}); labels carry no digits and
// notes are plain sentences naming the window, each parameter and the accounts left out.
//
// Kinds (goalKind): 'cushion' (months of spending held in personal cash), 'independence'
// (investments that cover yearly spending at a withdrawal rate) and 'tax' (this year's unused
// contribution room from the planner's stored room figures). Anything else is a question.

import { createHash } from 'node:crypto';

export const TARGET_PARAMETERS = Object.freeze({
  cushionMonths: 6, withdrawalRate: 0.04, withdrawalRateMin: 0.02, withdrawalRateMax: 0.06, realReturn: 0.04,
  maxProjectionMonths: 600, transferDays: 5, maxWindowMonths: 12, minWindowMonths: 3,
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

const SRC = 'calc:targets';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const DAY = 86400000;

const finite = v => typeof v === 'number' && Number.isFinite(v);
const round = v => Math.round((v + Number.EPSILON) * 100) / 100;
const cents = v => Math.round(v * 100);
const day = iso => Date.parse(iso + 'T00:00:00Z') / DAY;
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
const dateText = iso => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

const HORIZON_YEARS = { now: 0, '1-3y': 3, '3-10y': 10 };
const HORIZON_LABELS = { now: 'This year', '1-3y': 'Next few years', '3-10y': 'Long range' };
export const horizonOf = h => Object.hasOwn(HORIZON_YEARS, h) ? h : 'now';
export const horizonLabelOf = h => HORIZON_LABELS[horizonOf(h)];
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

const rowsSource = (table, ids) => ({ rows: { table, ids: ids.slice(0, 50), count: ids.length } });
function mergeSources(list) {
  const by = new Map();
  for (const s of list) {
    if (!s?.rows || !Array.isArray(s.rows.ids)) continue;
    by.set(s.rows.table, [...(by.get(s.rows.table) || []), ...s.rows.ids]);
  }
  return [...by].map(([table, ids]) => rowsSource(table, [...new Set(ids)]));
}

function figure(v, { label, kind = 'e', calc, clock, inputs = {}, parameters = {}, window = null, sources, formula, notes }) {
  const value = round(v);
  return { v: value, src: SRC, kind, label, notes: notes.filter(n => typeof n === 'string' && n.trim()).slice(0, 5),
    locator: { calc, inputs: structuredClone(inputs), parameters: { ...parameters }, window: window && { ...window },
      sources: structuredClone(sources), steps: [{ label, formula, value }], computedOn: clock } };
}

// An account name fit for a note: scenario tokens are not plain text, so such a name becomes its kind.
export const plainAccountName = a => typeof a?.name === 'string' && a.name.trim() && !/\{[a-z]+:/i.test(a.name)
  ? a.name.trim() : `a ${a?.kind || 'household'} account`;

// ---------------------------------------------------------------- spending

// Pairs each source row with at most one candidate row: another account, the opposite amount to
// the cent, within transferDays. Nearest date wins, then the lowest id. -> Set of matched source ids.
function matchTransfers(sources, candidates, days) {
  const used = new Set();
  const matched = new Set();
  for (const s of sources) {
    let best = null;
    for (const c of candidates) {
      if (used.has(c.id) || c.account_id === s.account_id || cents(c.amount) !== -cents(s.amount)) continue;
      const gap = Math.abs(day(c.date) - day(s.date));
      if (gap > days) continue;
      if (!best || gap < best.gap || (gap === best.gap && c.id < best.c.id)) best = { c, gap };
    }
    if (best) { used.add(best.c.id); matched.add(s.id); }
  }
  return matched;
}

// The complete-month run of one account: the month after its first transaction to the month before
// its last, split at months without a transaction, the latest run kept. -> {from, to} indexes or null.
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
export function spendingInputs({ accounts, transactions, clock, parameters = TARGET_PARAMETERS }) {
  const P = parameters;
  const byId = new Map(accounts.map(a => [a.id, a]));
  const spending = accounts.filter(a => SPENDING_KINDS.includes(a.kind));
  const rows = transactions.filter(t => byId.has(t.account_id) && finite(t.amount) && typeof t.date === 'string' && t.date <= clock);
  const monthsOf = new Map();
  for (const t of rows) {
    if (!SPENDING_KINDS.includes(byId.get(t.account_id).kind)) continue;
    const set = monthsOf.get(t.account_id) || new Set();
    set.add(monthIndex(t.date.slice(0, 7)));
    monthsOf.set(t.account_id, set);
  }
  const counted = spending.filter(a => monthsOf.has(a.id));
  const silent = spending.filter(a => !monthsOf.has(a.id));
  const out = { window: null, months: 0, counted, silent, spendIds: [], incomeIds: [], missing: [] };
  const runs = counted.map(a => accountRun(monthsOf.get(a.id)));
  if (!counted.length || runs.some(r => !r)) { out.missing.push('no_spending_history'); return out; }
  const to = Math.min(...runs.map(r => r.to), monthIndex(clock.slice(0, 7)) - 1);
  const from = Math.max(...runs.map(r => r.from), to - P.maxWindowMonths + 1);
  const months = to - from + 1;
  if (months < P.minWindowMonths) { out.missing.push('no_spending_history'); return out; }
  out.window = { from: monthOf(from), to: monthOf(to), months };
  out.months = months;

  const inWindow = t => { const m = monthIndex(t.date.slice(0, 7)); return m >= from && m <= to; };
  const ordered = rows.toSorted((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const onSpending = ordered.filter(t => SPENDING_KINDS.includes(byId.get(t.account_id).kind) && inWindow(t));
  const outflows = onSpending.filter(t => t.amount < 0);
  const inflows = onSpending.filter(t => t.amount > 0);
  // Spending leaves out an outflow matched to an inflow on any other household account.
  const notSpend = matchTransfers(outflows, ordered.filter(t => t.amount > 0), P.transferDays);
  // Income leaves out an inflow matched to an outflow on another account that is not a business account.
  const notIncome = matchTransfers(inflows, ordered.filter(t => t.amount < 0 && byId.get(t.account_id).kind !== 'business'), P.transferDays);
  const spend = outflows.filter(t => !notSpend.has(t.id));
  const income = inflows.filter(t => !notIncome.has(t.id));
  const spendTotal = -spend.reduce((s, t) => s + t.amount, 0);
  const incomeTotal = income.reduce((s, t) => s + t.amount, 0);
  out.spendIds = spend.map(t => t.id);
  out.incomeIds = income.map(t => t.id);
  out.spendTotal = round(spendTotal);
  out.incomeTotal = round(incomeTotal);
  out.monthlySpend = round(spendTotal / months);
  out.annualSpend = round(spendTotal / months * 12);
  out.monthlySavings = round((incomeTotal - spendTotal) / months);
  return out;
}

// The spending figures, keyed by name (monthlySpend, annualSpend, monthlySavings).
export function spendingFigures(sp, { clock, parameters = TARGET_PARAMETERS }) {
  const windowNote = `Spending window: ${windowText(sp.window)}.`;
  const countedNote = `Spending accounts counted: ${listText(sp.counted.map(plainAccountName))}.`;
  const silentNote = sp.silent.length
    ? `No transactions on file for ${listText(sp.silent.map(plainAccountName))}; ${sp.silent.length === 1 ? 'its' : 'their'} spending is not counted.` : null;
  const P = { transferDays: parameters.transferDays, maxWindowMonths: parameters.maxWindowMonths, minWindowMonths: parameters.minWindowMonths };
  const inputs = { months: sp.months, spendTotal: sp.spendTotal, incomeTotal: sp.incomeTotal };
  const base = { clock, inputs, parameters: P, window: sp.window };
  const spendSources = [rowsSource('transactions', sp.spendIds)];
  const transferNote = `Transfers between household accounts of the same amount within ${word(parameters.transferDays)} days are left out.`;
  return {
    monthlySpend: figure(sp.monthlySpend, { ...base, label: 'Monthly spending, recent average', calc: 'monthlySpend', sources: spendSources,
      formula: 'outflows on spending accounts in the window, less matched transfers, divided by the months in the window',
      notes: [windowNote, countedNote, transferNote, silentNote, 'Spending accounts are checking, savings, cash and card accounts; business accounts are left out.'] }),
    annualSpend: figure(sp.annualSpend, { ...base, label: 'Yearly spending, recent average', calc: 'annualSpend', sources: spendSources,
      formula: 'monthly spending times twelve', notes: [windowNote, 'Yearly spending is monthly spending times twelve.', countedNote, silentNote] }),
    monthlySavings: figure(sp.monthlySavings, { ...base, label: 'Monthly savings, recent average', calc: 'monthlySavings',
      sources: [rowsSource('transactions', [...sp.incomeIds, ...sp.spendIds])],
      formula: 'inflows on spending accounts in the window, less matched transfers from non-business accounts, minus spending, divided by the months',
      notes: [windowNote, 'Savings is money coming into spending accounts minus spending, per month.',
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

export { word as numberWord, dateText };

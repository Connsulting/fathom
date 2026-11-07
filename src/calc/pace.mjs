import { freshnessOf } from '../ingest/freshness.mjs';
import { roundForUnit, UNITS } from './figure.mjs';

export { round } from './figure.mjs';

const DAY = 86400000;
const MONTH_DAYS = 365.2425 / 12;
export const PACE_PARAMETERS = Object.freeze({ toleranceDays: 7, minimumToleranceUsd: 1, daysPerMonth: MONTH_DAYS });
export const finite = v => typeof v === 'number' && Number.isFinite(v);
const day = date => Date.parse(date + 'T00:00:00Z') / DAY;
export const isoDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(day(date)) && new Date(day(date) * DAY).toISOString().slice(0, 10) === date;

export function paceFigure(v, label, { unit, dataThrough, clock, calc, inputs, sources = [], parameters = PACE_PARAMETERS, kind = 'e', formula = calc } = {}) {
  if (!UNITS.includes(unit)) throw new TypeError(`Unknown pace figure unit ${unit}`);
  if (!finite(v)) return null;
  const value = roundForUnit(v, unit);
  return { v: value, src: 'calc:pace', kind, label,
    locator: { calc, unit, dataThrough, inputs: structuredClone(inputs), parameters: { ...parameters }, sources: structuredClone(sources),
      steps: [{ label, formula, value }], computedOn: clock } };
}

export function dataState(actual, clock) {
  if (!actual || !finite(actual.v)) return 'missing_actual';
  if (actual.kind !== 'a') return 'projected_actual';
  if (!isoDate(actual.dataThrough) || actual.dataThrough > clock || !actual.dependencies?.length) return 'undated_actual';
  const states = actual.dependencies.map(d => isoDate(d.asOf) && d.asOf <= clock
    ? freshnessOf({ kind: d.kind, asOf: d.asOf }, clock).state : 'unknown');
  if (states.includes('stale')) return 'stale_data';
  return states.every(s => s === 'fresh') ? null : 'unknown_freshness';
}

function pathOf(goal) {
  const start = goal.pace;
  if (!start || !finite(start.startValue) || !isoDate(start.startDate)) return { reason: 'missing_plan_start' };
  if (!isoDate(goal.targetDate) || goal.targetDate <= start.startDate) return { reason: 'invalid_plan_dates' };
  // A plan that starts at or above its target is a flat reached path: the plan holds the target.
  if (finite(goal.target) && start.startValue >= goal.target) return { slope: 0, reached: true, at: () => goal.target };
  const slope = (goal.target - start.startValue) / (day(goal.targetDate) - day(start.startDate));
  if (!finite(slope) || slope <= 0) return { reason: 'non_increasing_path' };
  return { slope, at: date => start.startValue + slope * Math.max(0, Math.min(day(date), day(goal.targetDate)) - day(start.startDate)) };
}

function timeLabel(days) {
  const n = Math.abs(days);
  const [unit, size] = n >= 60 ? ['month', MONTH_DAYS] : n >= 7 ? ['week', 7] : ['day', 1];
  const count = Math.max(1, Math.round(n / size));
  return `${count} ${unit}${count === 1 ? '' : 's'} ${days < 0 ? 'behind' : 'ahead'}`;
}

const actualSources = a => a ? (a.locator?.sources || [{ src: a.src, ...a.locator }]) : [];
export function goalPace({ goal, actual = null, clock }) {
  if (!isoDate(clock)) throw new TypeError('Pace requires an ISO clock date');
  const sources = [...(goal.planSources || [{ rows: { table: 'goals', ids: [goal.id], count: 1 } }]),
    ...(goal.pace?.sources || []), ...actualSources(actual)];
  const inputs = { goal: { id: goal.id, target: goal.target ?? null, targetDate: goal.targetDate ?? null, pace: goal.pace ?? null }, clock,
    actual: actual ? { v: actual.v, dataThrough: actual.dataThrough, dependencies: actual.dependencies } : null };
  const dataThrough = actual?.dataThrough ?? null;
  const f = (v, label, kind = 'e', unit = 'usd') => paceFigure(v, label, { unit, dataThrough, clock, calc: 'goalPace', inputs, sources, kind });
  const out = { id: goal.id, title: goal.title, targetDate: goal.targetDate ?? null, status: 'unknown', reason: null,
    dataThrough: actual?.dataThrough ?? null, stale: false, target: f(goal.target, 'Goal target', 't'),
    actual: actual ? f(actual.v, 'Latest tracked value', actual.kind) : null,
    expected: null, gap: null, gapDays: null, tolerance: null, timeGap: null };
  if (!finite(goal.target) || !isoDate(goal.targetDate)) return { ...out, status: 'no target', reason: 'no_target' };
  const path = pathOf(goal);
  if (path.reason) return { ...out, reason: path.reason };
  if (path.reached) {
    out.expected = paceFigure(goal.target, 'Expected today', { unit: 'usd', dataThrough, clock, calc: 'goalPace', inputs, sources, kind: 'p',
      formula: 'target already reached at plan start' });
    out.tolerance = f(PACE_PARAMETERS.minimumToleranceUsd, 'On pace tolerance');
    if (actual && finite(actual.v)) out.gap = f(actual.v - goal.target, 'Tracked value minus plan');
    out.reason = dataState(actual, clock);
    out.stale = out.reason === 'stale_data';
    if (!out.reason) {
      out.status = actual.v >= goal.target ? 'ahead' : 'behind';
      out.timeGap = actual.v >= goal.target ? 'Reached' : null;
    }
    return out;
  }
  const expected = path.at(clock);
  const tolerance = Math.max(PACE_PARAMETERS.minimumToleranceUsd, path.slope * PACE_PARAMETERS.toleranceDays);
  out.expected = f(expected, 'Expected today', 'p');
  out.tolerance = f(tolerance, 'On pace tolerance');
  if (actual && finite(actual.v)) {
    const gap = actual.v - expected;
    out.gap = f(gap, 'Tracked value minus plan');
    out.gapDays = f(gap / path.slope, 'Time ahead or behind in days', 'e', 'days');
    out.timeGap = Math.abs(gap) <= tolerance ? 'On pace' : timeLabel(gap / path.slope);
  }
  out.reason = dataState(actual, clock);
  out.stale = out.reason === 'stale_data';
  if (out.reason) out.timeGap = null;
  if (!out.reason) out.status = Math.abs(actual.v - expected) <= tolerance ? 'on pace' : actual.v > expected ? 'ahead' : 'behind';
  return out;
}

const goalRow = goal => goal.planSources || [{ rows: { table: 'goals', ids: [goal.id], count: 1 } }];
const actualInputs = actual => actual ? { v: actual.v, dataThrough: actual.dataThrough, dependencies: actual.dependencies } : null;
// The same figure under another label (goalPace names every actual 'Latest tracked value').
function relabel(fig, label) {
  if (!fig) return fig;
  return { ...fig, label, locator: { ...fig.locator, steps: fig.locator.steps.map(s => ({ ...s, label })) } };
}

// A range is measured on the balance path to its low end; it needs both ends to have a target.
export const rangeGoal = goal => ({ ...goal, target: finite(goal.targetLow) && finite(goal.targetHigh) ? goal.targetLow : null });

export function rangePace({ goal, actual = null, clock }) {
  const base = goalPace({ goal: rangeGoal(goal), actual, clock });
  const sources = [...goalRow(goal), ...(goal.pace?.sources || []), ...actualSources(actual)];
  const inputs = { goal: { id: goal.id, targetLow: goal.targetLow ?? null, targetHigh: goal.targetHigh ?? null }, clock, actual: actual?.v ?? null };
  const both = finite(goal.targetLow) && finite(goal.targetHigh);
  const f = (v, label) => both ? paceFigure(v, label, { unit: 'usd', dataThrough: actual?.dataThrough ?? null, clock, calc: 'rangePace', inputs, sources, kind: 't' }) : null;
  const v = actual?.v;
  const position = !both || !finite(v) ? null : v < goal.targetLow ? 'below' : v > goal.targetHigh ? 'above' : 'in';
  return { ...base, range: { low: f(goal.targetLow, 'Range low end'), high: f(goal.targetHigh, 'Range high end'), position } };
}

// A floor holds at or above its amount and is breached below it. The state comes from the last
// reading even when it is stale; the status is known only when the reading is current.
export function floorPace({ goal, actual = null, clock }) {
  if (!isoDate(clock)) throw new TypeError('Pace requires an ISO clock date');
  const sources = [...goalRow(goal), ...actualSources(actual)];
  const inputs = { goal: { id: goal.id, floor: goal.floor ?? null }, clock, actual: actualInputs(actual) };
  const dataThrough = actual?.dataThrough ?? null;
  const f = (v, label, kind = 'e') => paceFigure(v, label, { unit: 'usd', dataThrough, clock, calc: 'floorPace', inputs, sources, kind });
  const out = { id: goal.id, title: goal.title, targetDate: null, status: 'unknown', reason: null, dataThrough, stale: false,
    target: f(goal.floor, 'Floor', 't'), actual: actual ? f(actual.v, 'Latest tracked value', actual.kind) : null,
    expected: null, gap: null, gapDays: null, tolerance: null, timeGap: null, floor: { state: null } };
  if (!finite(goal.floor)) return { ...out, status: 'no target', reason: 'no_target' };
  const holding = actual && finite(actual.v) ? actual.v >= goal.floor : null;
  if (holding !== null) {
    out.floor.state = holding ? 'holding' : 'breached';
    out.gap = f(actual.v - goal.floor, 'Tracked value minus floor');
  }
  out.reason = dataState(actual, clock);
  out.stale = out.reason === 'stale_data';
  if (!out.reason) {
    out.status = holding ? 'on pace' : 'behind';
    out.timeGap = holding ? 'Holding' : 'Below floor';
  }
  return out;
}

// Contribution pace: a straight line from 0 on Jan 1 of the tax year to the amount at the deadline.
// `actual` is the progress figure the store reader built (transactions or the entered amount),
// `people` its per-person actuals [{person, actual}], `reason` the reader's code when it found no
// progress source (partial_contribution_coverage); otherwise a missing actual is missing_contributions.
const CONTRIBUTORS = ['owner', 'spouse'];
export function contributionPace({ goal, actual = null, basis = null, people = [], reason = null, clock }) {
  const valid = finite(goal.target) && Number.isInteger(goal.taxYear) && isoDate(goal.targetDate);
  const planned = { ...goal, pace: valid ? { startDate: `${goal.taxYear}-01-01`, startValue: 0, sources: [] } : null };
  const base = goalPace({ goal: planned, actual, clock });
  base.actual = relabel(base.actual, 'Contributed so far');
  const contribution = { basis, taxYear: Number.isInteger(goal.taxYear) ? goal.taxYear : null, deadline: isoDate(goal.targetDate) ? goal.targetDate : null,
    remaining: null, people: [] };
  if (!valid) {
    return { ...base, status: 'no target', reason: 'no_target', expected: null, gap: null, gapDays: null, tolerance: null, timeGap: null, stale: false, contribution };
  }
  if (!actual) {
    base.reason = reason || 'missing_contributions';
  } else if (!base.reason) {
    if (actual.v >= goal.target) { base.status = 'ahead'; base.timeGap = 'Reached'; }
    else if (clock > goal.targetDate) { base.status = 'behind'; base.timeGap = 'Deadline passed'; }
  }
  const inputs = { goal: { id: goal.id, target: goal.target, taxYear: goal.taxYear, targetDate: goal.targetDate, split: goal.split ?? null },
    clock, basis, actual: actualInputs(actual) };
  // Every contribution figure dates from the entry's data date, the date its envelope reports.
  const f = (v, label, kind, of = actual) => paceFigure(v, label, { unit: 'usd', dataThrough: actual?.dataThrough ?? null, clock, calc: 'contributionPace',
    inputs, sources: [...goalRow(goal), ...actualSources(of)], kind });
  if (actual && finite(actual.v)) contribution.remaining = f(Math.max(0, goal.target - actual.v), 'Left to contribute', 'e');
  const split = (Array.isArray(goal.split) ? goal.split : []).filter(s => CONTRIBUTORS.includes(s?.person));
  const given = (Array.isArray(people) ? people : []).filter(p => CONTRIBUTORS.includes(p?.person));
  const order = list => CONTRIBUTORS.filter(p => list.includes(p));
  const splitPersons = order(split.map(s => s.person));
  const persons = [...splitPersons, ...order(given.map(p => p.person).filter(p => !splitPersons.includes(p)))];
  contribution.people = persons.map(person => {
    const share = split.find(s => s.person === person);
    const own = given.find(p => p.person === person)?.actual ?? null;
    return { person, target: share ? f(share.amount, 'Share of the contribution', 't', null) : null,
      actual: own ? f(own.v, 'Contributed so far', own.kind, own) : null };
  });
  return { ...base, contribution };
}

// Contributions into a goal's destination accounts: credits dated in the tax year and on or before
// the clock, less (a) internal moves, a credit matched one to one (date then id order) with an equal
// and opposite debit in another destination account within five days, and (b) investment income by
// imported category or description. Anything else credited to a destination account counts, which
// is how outside transfers arrive. Rows are {id, account_id, date, amount, description, category}.
const INVESTMENT_INCOME = /\b(interest|dividends?|div(idend)? reinv\w*|capital gains?|cap gain)\b/i;
export const MOVE_DAYS = 5;
export function qualifyingContributions(rows, accountIds, { taxYear, clock } = {}) {
  if (!Number.isInteger(taxYear) || !isoDate(clock)) return [];
  const dest = new Set(accountIds || []);
  const cents = v => Math.round(Math.abs(v) * 100);
  const byDateId = (a, b) => a.date.localeCompare(b.date) || (a.id > b.id) - (a.id < b.id);
  const ordered = (rows || []).filter(r => r && dest.has(r.account_id) && finite(r.amount) && isoDate(r.date) && r.date <= clock).toSorted(byDateId);
  const moved = new Set();
  for (const debit of ordered.filter(r => r.amount < 0)) {
    const credit = ordered.find(r => r.amount > 0 && !moved.has(r) && r.account_id !== debit.account_id
      && cents(r.amount) === cents(debit.amount) && Math.abs(day(r.date) - day(debit.date)) <= MOVE_DAYS);
    if (credit) moved.add(credit);
  }
  const start = `${taxYear}-01-01`;
  const end = `${taxYear}-12-31`;
  return ordered.filter(r => r.amount > 0 && r.date >= start && r.date <= end && !moved.has(r)
    && !INVESTMENT_INCOME.test(r.category || '') && !INVESTMENT_INCOME.test(r.description || ''));
}

export function paceRollup(goals, clock) {
  const included = goals.filter(g => g.status !== 'no target');
  const n = { behind: 0, ahead: 0, onPace: 0, unknown: 0 };
  for (const g of included) n[g.status === 'on pace' ? 'onPace' : g.status] += 1;
  const dataThrough = included.map(g => g.dataThrough).filter(isoDate).sort()[0] ?? null;
  const sources = included.map(g => ({ rows: { table: 'goals', ids: [g.id], count: 1 } }));
  const f = (v, label) => paceFigure(v, label, { unit: 'count', dataThrough, clock, calc: 'paceRollup', inputs: { goals: goals.map(g => ({ id: g.id, status: g.status, dataThrough: g.dataThrough })) }, sources });
  let headline;
  if (!included.length) headline = 'No goals with targets';
  else if (n.behind) headline = `${n.behind} goal${n.behind === 1 ? '' : 's'} behind`;
  else if (n.unknown) {
    const unknown = included.filter(g => g.status === 'unknown');
    const end = unknown.every(g => isoDate(g.dataThrough)) ? unknown.map(g => g.dataThrough).sort()[0] : null;
    const label = end && new Date(end + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    headline = label ? `Pace unknown: data through ${label}` : 'Pace unknown: data missing';
  } else if (n.onPace) headline = `${n.onPace} of ${included.length} goals on pace`;
  else headline = `${n.ahead} goal${n.ahead === 1 ? '' : 's'} ahead`;
  return { headline, dataThrough, counts: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, f(v, `Goals ${k}`)])), total: f(included.length, 'Goals with targets') };
}

export function monthlyPace({ goal, observations, clock }) {
  const valid = (observations || []).filter(a => finite(a.v) && a.kind === 'a' && isoDate(a.dataThrough) && a.dataThrough <= clock)
    .toSorted((a, b) => a.dataThrough.localeCompare(b.dataThrough));
  const last = valid.at(-1);
  const dataEnd = last?.dataThrough ?? null;
  const path = pathOf(goal);
  if (!finite(goal.target) || !isoDate(goal.targetDate) || path.reason || !last) {
    return { series: null, reason: path.reason || (!last ? 'missing_actual_history' : 'no_target'), dataEnd };
  }
  const year = Number(clock.slice(0, 4));
  const series = Array.from({ length: 12 }, (_, i) => {
    const end = new Date(Date.UTC(year, i + 1, 0)).toISOString().slice(0, 10);
    const month = end.slice(0, 7);
    const projected = month > dataEnd.slice(0, 7);
    const observed = valid.filter(a => a.dataThrough.slice(0, 7) === month).at(-1);
    const date = projected ? end : observed?.dataThrough ?? end;
    const plan = path.at(date);
    const amount = projected ? plan + last.v - path.at(dataEnd) : observed?.v;
    const sources = [...(goal.planSources || [{ rows: { table: 'goals', ids: [goal.id], count: 1 } }]),
      ...(goal.pace?.sources || []), ...actualSources(projected ? last : observed)];
    const inputs = { goal, month, date, dataEnd, observed: projected ? last.v : observed?.v ?? null };
    const dataThrough = projected ? dataEnd : observed?.dataThrough ?? null;
    const f = (v, label, kind) => paceFigure(v, label, { unit: 'usd', dataThrough, clock, calc: 'monthlyPace', inputs, sources, kind });
    return { month, date, dataThrough, projected,
      actual: f(amount, projected ? 'Projected tracked value' : 'Monthly tracked value', projected ? 'p' : 'a'),
      plan: f(plan, 'Monthly plan', 'p'), gap: f(finite(amount) ? amount - plan : null, 'Monthly value minus plan', projected ? 'p' : 'e'),
      reason: !projected && !observed ? 'missing_month_actual' : null };
  });
  return { series, dataEnd, reason: null };
}

export function paceMeter({ used, limit, clock }) {
  if (!used || !limit || !finite(used.v) || !finite(limit.v) || limit.v <= 0) return { meter: null, reason: 'missing_meter_inputs', dataThrough: null };
  const dates = [used.dataThrough, limit.dataThrough];
  const dataThrough = dates.every(isoDate) ? dates.toSorted()[0] : null;
  const sources = [...actualSources(used), ...actualSources(limit)];
  const inputs = { used: used.v, limit: limit.v, dataThrough };
  const f = (v, label, kind, unit = 'usd') => paceFigure(v, label, { unit, dataThrough, clock, calc: 'paceMeter', inputs, sources, kind });
  return { meter: { used: f(used.v, 'Used or reserved', used.kind), limit: f(limit.v, 'Limit or plan', limit.kind),
    ratio: f(used.v / limit.v, 'Share used or reserved', 'e', 'ratio') }, dataThrough,
    reason: dataState(used, clock), stale: dataState(used, clock) === 'stale_data' };
}

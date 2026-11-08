import { staleAccountIds } from '../../core/account-freshness.js';

/* Home view model: goals first, pace per goal, the next action per goal, one data-health line.
   Pure functions over the scenario (pace, goals, recs, suggestions, ingest, accounts); no DOM and no api, so
   node can import it. Every number it returns is a count or a ratio of stored figures. */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const arr = (a) => (Array.isArray(a) ? a : []);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const figV = (f) => (f && finite(f.v) ? f.v : null);
const count = (f) => figV(f) ?? 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 'Aug 7' from an ISO date, in UTC; null when the date does not parse.
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/* ---------- owners and goal links ---------- */

// Every rec carries owner (one of OWNERS in /shared/rec-links.mjs), housekeeping (boolean) and
// serves (the open goals it is linked to, [{ id, title, origin }]); see loadLinkedRecs.

export function ownerMatches(rec, filter) {
  const o = rec?.owner;
  if (filter === 'me') return o === 'you' || o === 'both';
  if (filter === 'spouse') return o === 'spouse' || o === 'both';
  return true;
}

export function servedGoalIds(rec) {
  return arr(rec?.serves).map((g) => String(g.id));
}

// Counted like the server's live.housekeeping: housekeeping and not hidden, done or dismissed.
const CLOSED = ['hidden', 'done', 'dismissed'];
export function isHousekeepingItem(rec) {
  return rec?.housekeeping === true && !CLOSED.includes(rec.status);
}

export function isOpen(rec) {
  return rec?.status === 'proposed' || rec?.status === 'doing';
}

const recDays = (r) => {
  const d = Number(r?.window?.days);
  return r?.window?.days != null && Number.isFinite(d) ? d : Infinity;
};
const cmpStr = (a, b) => { const x = String(a ?? ''), y = String(b ?? ''); return x < y ? -1 : x > y ? 1 : 0; };
const byWindow = (a, b) => (recDays(a) - recDays(b)) || cmpStr(a.title, b.title) || cmpStr(a.id, b.id);

/* ---------- priority order ---------- */

// Goal priority (goal model v2). Matches PRIORITIES in src/shared/goals.mjs, checked by a test; kept
// here so this file has no imports. Unset or unknown sorts last.
export const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });
export function priorityRankOf(p) {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? PRIORITY_RANK[p] : Object.keys(PRIORITY_RANK).length;
}

// A stable sort on a copy: equal keys keep their order.
function stableBy(list, key) {
  return arr(list).map((x, i) => [x, key(x), i]).sort((a, b) => (a[1] - b[1]) || (a[2] - b[2])).map((e) => e[0]);
}
const isDone = (g) => g?.status === 'done';
const isOpenGoal = (g) => g && !g.archived && !isDone(g);

// Goals screen order: not done before done, then priority, keeping the given order within each.
export function orderGoals(goals) {
  const n = Object.keys(PRIORITY_RANK).length + 1;
  return stableBy(goals, (g) => (isDone(g) ? n : 0) + priorityRankOf(g?.priority));
}

// A rec's served goals by the matching goal's priority; a goal not in the list sorts with unset.
export function orderServes(serves, goals) {
  const byId = new Map(arr(goals).filter(Boolean).map((g) => [String(g.id), g]));
  return stableBy(serves, (s) => priorityRankOf(byId.get(String(s?.id))?.priority));
}

// Plan rows: deadline days first (a rec with no window counts as 0, as the Plan list always has),
// then the best priority among the open goals the rec serves, then the given order.
const planDays = (r) => { const d = Number(r?.window?.days ?? 0); return Number.isFinite(d) ? d : 0; };
export function planOrder(recs, goals) {
  const open = new Map(arr(goals).filter(isOpenGoal).map((g) => [String(g.id), g]));
  const best = (r) => Math.min(Object.keys(PRIORITY_RANK).length, ...arr(r?.serves).map((s) => {
    const g = open.get(String(s?.id));
    return g ? priorityRankOf(g.priority) : Object.keys(PRIORITY_RANK).length;
  }));
  return arr(recs).map((r, i) => [r, planDays(r), best(r), i])
    .sort((a, b) => (a[1] - b[1]) || (a[2] - b[2]) || (a[3] - b[3])).map((e) => e[0]);
}

/* ---------- pace chips, bars and reasons ---------- */

export function goalChip(p) {
  // Goal model v2 kinds: a floor breach shows even on stale data; a range says where the value sits.
  if (p?.kind === 'floor' && p.floor?.state === 'breached') return { tone: 'warn', label: 'Below floor' };
  if (p?.kind === 'floor' && p.status === 'on pace') return { tone: 'ok', label: 'Holding' };
  if (p?.kind === 'range' && (p.status === 'ahead' || p.status === 'on pace')) {
    if (p.range?.position === 'in') return { tone: 'ok', label: 'In range' };
    if (p.range?.position === 'above') return { tone: 'ok', label: 'Above range' };
  }
  if (!p || p.status === 'no target') return { tone: 'mute', label: 'No target' };
  // Only the status says On pace; a time gap label never stands in for it.
  const gap = p.timeGap && p.timeGap !== 'On pace' ? p.timeGap : null;
  if (p.status === 'ahead') return { tone: 'ok', label: gap || 'Ahead' };
  if (p.status === 'on pace') return { tone: 'ok', label: 'On pace' };
  if (p.status === 'behind') return { tone: 'warn', label: gap || 'Behind' };
  if (p.reason === 'stale_data') return { tone: 'bad', label: 'Data stale' };
  return { tone: 'mute', label: 'Pace unknown' };
}

// The chip a Home goal card carries: progress only. Stale or unknown pace has no chip there; the one
// data line at the top says how current the data is.
export function cardChip(p) {
  const c = goalChip(p);
  return c.label === 'Data stale' || c.label === 'Pace unknown' ? null : c;
}

const included = (pace) => arr(pace?.goals).filter((g) => g && g.status !== 'no target');

export function healthChip(pace) {
  const c = pace?.rollup?.counts || {};
  const behind = count(c.behind);
  if (behind > 0) return { tone: 'warn', label: `${plural(behind, 'goal')} behind` };
  if (count(c.unknown) > 0) {
    return included(pace).some((g) => g.stale) ? { tone: 'bad', label: 'Data stale' } : { tone: 'mute', label: 'Pace unknown' };
  }
  if (count(pace?.rollup?.total) === 0) return { tone: 'mute', label: 'No targets yet' };
  return { tone: 'ok', label: 'On pace' };
}

export function paceReason(pace) {
  const c = pace?.rollup?.counts || {};
  const behind = count(c.behind), unknown = count(c.unknown), total = count(pace?.rollup?.total);
  let s;
  if (behind > 0) {
    const worst = arr(pace?.goals).filter((g) => g && g.status === 'behind')
      .sort((a, b) => (figV(a.gapDays) ?? 0) - (figV(b.gapDays) ?? 0))[0];
    const gap = worst?.timeGap ? worst.timeGap.toLowerCase() : 'behind';
    const title = worst?.title || 'One goal';
    if (behind === 1 && worst?.kind === 'floor') s = `${title} is below its floor.`;
    else if (behind === 1 && worst?.timeGap === 'Deadline passed') s = `${title} missed its deadline.`;
    else s = behind === 1 ? `${title} is ${gap} plan.` : `${behind} goals are behind plan; ${title} is furthest, ${gap}.`;
  } else if (unknown > 0) {
    const d = shortDate(pace?.rollup?.dataThrough);
    const n = plural(unknown, 'goal');
    // The cadence wording is only true when every unknown goal is unknown because its data is stale.
    const unk = included(pace).filter((g) => g.status === 'unknown');
    const stale = unk.length > 0 && unk.every((g) => g.reason === 'stale_data');
    if (stale) {
      s = d
        ? `Data through ${d} is past its update cadence, so pace is unknown for ${n}; later months are projected.`
        : `Data is missing, so pace is unknown for ${n}.`;
    } else {
      s = d
        ? `Data runs through ${d}, but pace is unknown for ${n} because the data or plan is incomplete; later months are projected.`
        : `Pace is unknown for ${n} because the data or plan is incomplete.`;
    }
  } else if (total > 0) {
    s = `All ${plural(total, 'goal')} with targets ${total === 1 ? 'is' : 'are'} within plan.`;
  } else {
    s = 'No goals have a target yet.';
  }
  const m = arr(pace?.goals).filter((g) => g && g.status === 'no target').length;
  if (m > 0) s += ` ${plural(m, 'goal')} without a target ${m === 1 ? 'is' : 'are'} not counted.`;
  return s;
}

export function paceBar(p) {
  const t = figV(p?.target), a = figV(p?.actual), e = figV(p?.expected);
  if (t == null || a == null || e == null || t <= 0) return null;
  return { fill: clamp01(a / t), tick: clamp01(e / t), muted: !['ahead', 'on pace', 'behind'].includes(p.status) };
}

// Goal reasons: plain text and the fix beside it. A fix is { screen: 'goal', field, label } (a goal
// edit form field, data-gf), { screen: 'goal-new', label }, { screen: 'upload', kind, label } or null.
const goalField = (field, label) => ({ screen: 'goal', field, label });
const goalUpload = (kind, label) => ({ screen: 'upload', kind, label });
const TRACK = goalField('track', 'Choose what tracks it');
export const GOAL_REASONS = Object.freeze({
  stale_data: { text: 'The data behind it is past its update cadence.', fix: goalUpload('aggregator', 'Import recent data') },
  unknown_freshness: { text: 'How current the data is cannot be told yet.', fix: goalField('track', 'Track a dated account') },
  undated_actual: { text: 'The tracked value has no date.', fix: goalField('track', 'Track a dated account') },
  projected_actual: { text: 'The tracked value is a projection, not a reading.', fix: goalField('track', 'Track an actual balance') },
  missing_actual: { text: 'Nothing tracks this goal yet.', fix: TRACK },
  missing_plan_start: { text: 'The plan has no starting point to measure from.', fix: TRACK },
  invalid_plan_dates: { text: 'The target date is not after the plan start.', fix: goalField('targetDate', 'Fix the target date') },
  non_increasing_path: { text: 'The target is not above where the plan started.', fix: goalField('target', 'Raise the target') },
  no_target: { text: 'This goal has no target amount and date.', fix: goalField('target', 'Set a target') },
  missing_actual_history: { text: 'No monthly readings exist yet.', fix: goalUpload('bank', 'Upload past statements') },
  missing_household_savings_plan: { text: 'No household savings plan by month is stored yet.', fix: { screen: 'goal-new', label: 'Add a savings goal' } },
  missing_meter_inputs: { text: 'The figures this needs are not stored yet.', fix: goalUpload('paystub', 'Upload a paystub') },
  missing_month_actual: { text: 'No reading for this month.', fix: goalUpload('bank', 'Upload that statement') },
  missing_contributions: { text: 'No contributions are recorded or entered yet.', fix: goalField('enteredTotal', 'Enter what was contributed') },
  partial_contribution_coverage: { text: 'Only some contributions can be matched to the destination accounts.', fix: goalField('enteredTotal', 'Enter what was contributed') },
  kind_not_charted: { text: 'This kind of goal has no monthly chart.', fix: null },
  no_spending_history: { text: 'Not enough spending history is stored yet.', fix: goalUpload('aggregator', 'Import more spending') }
});
export const REASON_TEXT = Object.freeze(Object.fromEntries(Object.entries(GOAL_REASONS).map(([code, r]) => [code, r.text])));

export function reasonText(code) {
  return Object.prototype.hasOwnProperty.call(GOAL_REASONS, code) ? GOAL_REASONS[code].text : 'Not enough data yet';
}

// The data-gf fields the goal edit form renders per kind (design.js goalFormHtml), and the kind's own
// field for one it lacks.
const FORM_FIELDS = {
  balance: ['target', 'targetDate', 'track'],
  range: ['targetLow', 'targetHigh', 'targetDate', 'track'],
  floor: ['floor', 'track'],
  contribution: ['target', 'taxYear', 'targetDate', 'dest', 'shareOwner', 'shareSpouse', 'enteredTotal', 'enteredAsOf']
};
const FIELD_FOR_KIND = { range: { target: 'targetLow' }, floor: { target: 'floor' }, contribution: { track: 'dest' } };

// The fix for a reason on a goal: a goal field fix names the goal and the kind's field; an owner goal
// without that field, or a goal Fathom made, gets an Ask about the goal (`goal.title` in plain text).
// A goal field fix with no goal is null. Upload, goal-new and null fixes do not depend on the goal.
export function goalReasonFix(code, goal) {
  const fix = GOAL_REASONS[code]?.fix;
  if (!fix) return null;
  if (fix.screen !== 'goal') return { ...fix };
  if (!goal) return null;
  const kind = goal.kind || 'balance', fields = FORM_FIELDS[kind] || [];
  const field = fields.includes(fix.field) ? fix.field : fields.includes(FIELD_FOR_KIND[kind]?.[fix.field]) ? FIELD_FOR_KIND[kind][fix.field] : null;
  if (goal.origin === 'owner' && field && goal.id != null) return { screen: 'goal', field, label: fix.label, id: goal.id };
  return { screen: 'ask', label: fix.label, prompt: `Change my goal "${goal.title ?? ''}": ${fix.label.toLowerCase()}.` };
}

// One button for a fix: goal and goal-new carry data-goal-fix; Ask and upload carry the same
// data-tax-gap-fix button gapControl renders (web/core/gap-control.js), kept here so this file needs
// no import for it.
export function goalReasonControl(fix, esc, cls = 'h-link') {
  if (!fix || typeof fix.label !== 'string') return '';
  const attr = fix.screen === 'goal' || fix.screen === 'goal-new' ? 'data-goal-fix'
    : fix.screen === 'ask' || fix.screen === 'upload' ? 'data-tax-gap-fix' : null;
  return attr ? `<button type="button" class="${cls}" ${attr}="${esc(JSON.stringify(fix))}">${esc(fix.label)}</button>` : '';
}

/* ---------- kind lines ---------- */

const POSITION_LABEL = { below: 'Below range', in: 'In range', above: 'Above range' };
const STATE_LABEL = { holding: 'Holding', breached: 'Below floor' };
const BASIS_LABEL = { transactions: 'From recorded contributions', entered: 'As you entered' };

// The kind detail for a range, floor or contribution pace entry at index i: figure fields hold scenario
// figure keys under `pace.goals.<i>.` (null when the entry has no such figure), labels are plain text,
// asOf is the data-through date when the data is stale. Null for a balance goal or no pace entry.
export function kindLine(p, i) {
  if (!p || !['range', 'floor', 'contribution'].includes(p.kind)) return null;
  const base = `pace.goals.${i}.`;
  const key = (f, path) => (figV(f) != null ? base + path : null);
  const asOf = p.stale && p.dataThrough ? p.dataThrough : null;
  if (p.kind === 'range') {
    return { kind: 'range', low: key(p.range?.low, 'range.low'), high: key(p.range?.high, 'range.high'),
      positionLabel: POSITION_LABEL[p.range?.position] || null, asOf };
  }
  if (p.kind === 'floor') {
    return { kind: 'floor', floor: key(p.target, 'target'), stateLabel: STATE_LABEL[p.floor?.state] || null, asOf };
  }
  const c = p.contribution || {};
  return {
    kind: 'contribution', actual: key(p.actual, 'actual'), target: key(p.target, 'target'),
    remaining: key(c.remaining, 'contribution.remaining'), basisLabel: BASIS_LABEL[c.basis] || null,
    taxYear: c.taxYear ?? null, deadline: c.deadline || p.targetDate || null, asOf,
    people: arr(c.people).map((x, j) => ({ person: x?.person ?? null,
      actual: key(x?.actual, `contribution.people.${j}.actual`), target: key(x?.target, `contribution.people.${j}.target`) }))
  };
}

/* ---------- the home model ---------- */

// Whole days from an ISO clock date to Dec 31 of its year, in UTC; Infinity when the clock does not
// parse, so nothing is cut off by a year end nobody knows.
function daysToYearEnd(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return Infinity;
  return Math.round((Date.UTC(+m[1], 11, 31) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 864e5);
}

// Goal actions only: a rec that serves no goal stays in the housekeeping row.
const isGoalAction = (r) => r?.housekeeping !== true;

export function homeModel({ goals, pace, recs, filter, suggestions, clock } = {}) {
  const f = ['both', 'me', 'spouse'].includes(filter) ? filter : 'both';
  const open = arr(recs).filter(isOpen);
  const counts = {
    both: open.filter((r) => ownerMatches(r, 'both')).length,
    me: open.filter((r) => ownerMatches(r, 'me')).length,
    spouse: open.filter((r) => ownerMatches(r, 'spouse')).length
  };
  const queue = open.filter((r) => ownerMatches(r, f)).sort(byWindow);
  const live = arr(goals).filter((g) => g && !g.archived && g.status !== 'done');
  const paceGoals = arr(pace?.goals);
  const records = arr(suggestions).filter((r) => r && r.goalId != null);
  const ordered = [];
  paceGoals.forEach((p) => { const g = live.find((x) => x.id === p?.id); if (g && !ordered.includes(g)) ordered.push(g); });
  live.forEach((g) => { if (!ordered.includes(g)) ordered.push(g); });
  const cards = stableBy(ordered, (g) => priorityRankOf(g.priority)).map((g) => {
    const paceIndex = paceGoals.findIndex((p) => p?.id === g.id);
    const p = paceIndex >= 0 ? paceGoals[paceIndex] : null;
    const actions = queue.filter((r) => servedGoalIds(r).includes(String(g.id)));
    const suggestion = records.find((r) => String(r.goalId) === String(g.id)) || null;
    return {
      id: g.id, goal: g, pace: p, paceIndex, chip: cardChip(p), bar: paceBar(p), next: actions[0] || null, actions, suggestion,
      kind: g.kind || 'balance', owner: g.owner ?? null, priority: g.priority ?? null, line: p ? kindLine(p, paceIndex) : null
    };
  });
  const yearEnd = daysToYearEnd(clock ?? pace?.clock);
  const due = queue.filter((r) => isGoalAction(r) && recDays(r) <= yearEnd);
  const nextThing = due[0] || queue.find(isGoalAction) || null;
  const at = due.indexOf(nextThing);
  return {
    filter: f, counts, cards, queue, due, nextThing,
    afterThat: at >= 0 ? due.slice(at + 1, at + 4) : [],
    housekeeping: arr(recs).filter((r) => isHousekeepingItem(r) && ownerMatches(r, f)).sort(byWindow),
    pending: cards.filter((c) => c.suggestion?.state === 'suggested').map((c) => c.suggestion)
  };
}

// The Home headline. A goal with a target gives the verdict: covered, or how many goal actions due
// before Dec 31 need the filtered owner. It never explains the data; the data line does that. With
// no target, it counts the goals that have a suggested target, else the goals that still need one.
// Fathom adopts suggestions itself, so there is no bulk accept.
const WHOM = { both: 'you', me: 'you', spouse: 'your spouse' };
export function homeHeadline({ cards, pending, due, filter } = {}) {
  const list = arr(cards);
  const n = Array.isArray(pending) ? pending.length : Math.max(0, Number(pending) || 0);
  if (list.some((c) => c?.pace && c.pace.status !== 'no target')) {
    const needs = Array.isArray(due) ? due.length : Math.max(0, Number(due) || 0);
    const whom = WHOM[filter] || WHOM.both;
    if (needs > 0) return { title: `${plural(needs, 'thing')} ${needs === 1 ? 'needs' : 'need'} ${whom} before Dec 31`, verdict: 'needs', needs };
    const who = whom === 'you' ? 'You are' : 'Your spouse is';
    return { title: `${who} covered through Dec 31`, verdict: 'covered', needs: 0 };
  }
  if (n > 0) return { title: `Suggested targets for ${plural(n, 'goal')}` };
  const need = list.filter((c) => !c?.pace || c.pace.status === 'no target').length;
  return { title: `${plural(need, 'goal')} ${need === 1 ? 'needs' : 'need'} a target` };
}

/* ---------- suggested targets ---------- */

// 'Jun 30, 2027' from an ISO date, in UTC; null when the date does not parse.
export function longDate(iso) {
  const s = shortDate(iso);
  return s ? `${s}, ${String(iso).slice(0, 4)}` : null;
}

// A suggestion's spending window: 'Feb to Jul 2026' within one year, else 'Nov 2025 to Jul 2026'.
export function windowSpan(w) {
  const a = /^(\d{4})-(\d{2})/.exec(String(w?.from || '')), b = /^(\d{4})-(\d{2})/.exec(String(w?.to || ''));
  if (!a || !b) return '';
  const mon = (x) => MON[Number(x[2]) - 1] || x[2];
  return a[1] === b[1] ? `${mon(a)} to ${mon(b)} ${b[1]}` : `${mon(a)} ${a[1]} to ${mon(b)} ${b[1]}`;
}

export function healthLine({ pace, ingest, accounts, metaDataThrough } = {}) {
  const dataThrough = typeof pace?.rollup?.dataThrough === 'string' && shortDate(pace.rollup.dataThrough) ? pace.rollup.dataThrough : null;
  const dataLabel = dataThrough ? `Data through ${shortDate(dataThrough)}` : metaDataThrough ? `Data through ${metaDataThrough}` : 'No data yet';
  const staleAccounts = staleAccountIds(arr(accounts)).length;
  const staleGoals = included(pace).filter((g) => g.stale).length;
  const pending = Math.max(0, Number(ingest?.pending) || 0);
  const rows = [{ text: dataLabel, tone: 'ok' }];
  if (staleAccounts > 0) rows.push({ text: `${plural(staleAccounts, 'account')} stale`, tone: 'bad' });
  else if (staleGoals > 0) rows.push({ text: `pace data stale for ${plural(staleGoals, 'goal')}`, tone: 'bad' });
  if (pending > 0) rows.push({ text: `${plural(pending, 'question')} to confirm`, tone: 'ask' });
  // Owner-only items: what Fathom cannot do itself. Stale pace alone is not one; the data date covers it.
  // Unresolved files are the Imports service line's (services.attention), not counted here.
  const owner = [];
  if (pending > 0) owner.push({ key: 'confirm', text: `${plural(pending, 'question')} to confirm`, go: 'confirm' });
  if (staleAccounts > 0) owner.push({ key: 'accounts', text: `${plural(staleAccounts, 'account')} stale`, go: 'money' });
  return {
    dataThrough, dataLabel, staleAccounts, staleGoals, pending, stale: staleAccounts + staleGoals > 0, parts: rows.map((r) => r.text), rows,
    line: dataLabel, owner, needs: owner.length, needsLabel: owner.length ? `Fathom needs ${plural(owner.length, 'thing')}` : null, needsGo: owner[0]?.go ?? null
  };
}

// The pace board's This year meters that have a figure to show, in board order. None means no panel.
export const METER_KEYS = Object.freeze(['retirement', 'tax', 'income']);
export function paceMeters(meters) {
  return METER_KEYS.filter((k) => finite(meters?.[k]?.meter?.ratio?.v));
}

export function boardCharts(pace) {
  const hs = pace?.series?.householdSavings;
  if (Array.isArray(hs?.series)) {
    return [{ id: 'householdSavings', title: 'Household savings', series: hs.series, dataEnd: hs.dataEnd ?? null, figBase: 'pace.series.householdSavings.series' }];
  }
  const goals = pace?.series?.goals || {};
  return arr(pace?.goals).filter((p) => p && Array.isArray(goals[p.id]?.series)).map((p) => ({
    id: p.id, title: p.title, series: goals[p.id].series, dataEnd: goals[p.id].dataEnd ?? null, figBase: `pace.series.goals.${p.id}.series`
  }));
}

/* Contribution progress ("entered") in the goal form: the stored shape (per person or one total) is kept
   regardless of whether a split exists, so an unrelated save never drops it. */
const numStr = (v) => (finite(v) ? String(v) : '');
const blankStr = (v) => String(v ?? '').trim() === '';

export function enteredDraft(entered) {
  const e = entered && typeof entered === 'object' ? entered : null;
  const of = (person) => numStr(arr(e?.people).find((x) => x && x.person === person)?.amount);
  return { enteredTotal: e ? numStr(e.total) : '', enteredOwner: of('owner'), enteredSpouse: of('spouse'), enteredAsOf: e && e.asOf ? e.asOf : '' };
}

export function enteredFields(draft, split, asOfDefault) {
  const d = draft || {};
  const asOf = blankStr(d.enteredAsOf) ? asOfDefault : String(d.enteredAsOf).trim();
  const amount = (k) => { const n = Number(String(d[k]).trim()); return Number.isFinite(n) && n >= 0 ? n : null; };
  const BAD = { err: 'What was contributed must be zero or more.' };
  const shares = arr(split);
  const people = [];
  for (const [person, key] of [['owner', 'enteredOwner'], ['spouse', 'enteredSpouse']]) {
    if (blankStr(d[key])) continue;
    if (shares.length && !shares.some((x) => x && x.person === person)) return { err: 'Contributed amounts are only for people with a share.' };
    const v = amount(key);
    if (v == null) return BAD;
    people.push({ person, amount: v });
  }
  // Both shapes filled means the person changed one of them; saving either would drop the other.
  if (people.length && !blankStr(d.enteredTotal)) return { err: 'Give either a total or an amount per person, not both.' };
  if (people.length) return { entered: { asOf, people } };
  if (!blankStr(d.enteredTotal)) {
    const v = amount('enteredTotal');
    if (v == null) return BAD;
    return { entered: { asOf, total: v } };
  }
  return { entered: null };
}

export function enteredInputs(draft, split) {
  const d = draft || {};
  const hasSplit = arr(split).length > 0;
  const personal = !blankStr(d.enteredOwner) || !blankStr(d.enteredSpouse);
  return { people: hasSplit || personal, total: !hasSplit || !blankStr(d.enteredTotal) };
}

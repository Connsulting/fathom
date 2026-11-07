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

/* ---------- pace chips, bars and reasons ---------- */

export function goalChip(p) {
  if (!p || p.status === 'no target') return { tone: 'mute', label: 'No target' };
  // Only the status says On pace; a time gap label never stands in for it.
  const gap = p.timeGap && p.timeGap !== 'On pace' ? p.timeGap : null;
  if (p.status === 'ahead') return { tone: 'ok', label: gap || 'Ahead' };
  if (p.status === 'on pace') return { tone: 'ok', label: 'On pace' };
  if (p.status === 'behind') return { tone: 'warn', label: gap || 'Behind' };
  if (p.reason === 'stale_data') return { tone: 'bad', label: 'Data stale' };
  return { tone: 'mute', label: 'Pace unknown' };
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
    s = behind === 1 ? `${title} is ${gap} plan.` : `${behind} goals are behind plan; ${title} is furthest, ${gap}.`;
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

export const REASON_TEXT = Object.freeze({
  stale_data: 'The data behind it is past its update cadence.',
  unknown_freshness: 'How current the data is cannot be told yet.',
  undated_actual: 'The tracked value has no date.',
  projected_actual: 'The tracked value is a projection, not a reading.',
  missing_actual: 'Nothing tracks this goal yet.',
  missing_plan_start: 'The plan has no starting point to measure from.',
  invalid_plan_dates: 'The target date is not after the plan start.',
  non_increasing_path: 'The target is not above where the plan started.',
  no_target: 'This goal has no target amount and date.',
  missing_actual_history: 'No monthly readings exist yet.',
  missing_household_savings_plan: 'No household savings plan by month is stored yet.',
  missing_meter_inputs: 'The figures this needs are not stored yet.',
  missing_month_actual: 'No reading for this month.'
});

export function reasonText(code) {
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, code) ? REASON_TEXT[code] : 'Not enough data yet';
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
  const cards = ordered.map((g) => {
    const paceIndex = paceGoals.findIndex((p) => p?.id === g.id);
    const p = paceIndex >= 0 ? paceGoals[paceIndex] : null;
    const actions = queue.filter((r) => servedGoalIds(r).includes(String(g.id)));
    const suggestion = records.find((r) => String(r.goalId) === String(g.id)) || null;
    return { id: g.id, goal: g, pace: p, paceIndex, chip: goalChip(p), bar: paceBar(p), next: actions[0] || null, actions, suggestion };
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

// The Home headline. A goal with a target keeps the pace headline; with none, it counts the goals
// that have a suggested target, else the goals that still need one. bulk: Accept all is offered.
export function homeHeadline({ cards, pace, pending } = {}) {
  const list = arr(cards);
  const n = Array.isArray(pending) ? pending.length : Math.max(0, Number(pending) || 0);
  const bulk = n >= 2;
  if (list.some((c) => c?.pace && c.pace.status !== 'no target')) {
    return { title: pace?.rollup?.headline || 'Pace for your goals', bulk };
  }
  if (n > 0) return { title: `Suggested targets for ${plural(n, 'goal')}`, bulk };
  const need = list.filter((c) => !c?.pace || c.pace.status === 'no target').length;
  return { title: `${plural(need, 'goal')} ${need === 1 ? 'needs' : 'need'} a target`, bulk };
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
  const staleAccounts = arr(accounts).filter((a) => a?.fresh === 'stale').length;
  const staleGoals = included(pace).filter((g) => g.stale).length;
  const pending = Math.max(0, Number(ingest?.pending) || 0);
  const failed = arr(ingest?.files).filter((x) => x?.status === 'failed').length;
  const rows = [{ text: dataLabel, tone: 'ok' }];
  if (staleAccounts > 0) rows.push({ text: `${plural(staleAccounts, 'account')} stale`, tone: 'bad' });
  else if (staleGoals > 0) rows.push({ text: `pace data stale for ${plural(staleGoals, 'goal')}`, tone: 'bad' });
  if (pending > 0) rows.push({ text: `${plural(pending, 'question')} to confirm`, tone: 'ask' });
  if (failed > 0) rows.push({ text: `${plural(failed, 'file')} failed`, tone: 'bad' });
  return { dataThrough, dataLabel, staleAccounts, staleGoals, pending, failed, stale: staleAccounts + staleGoals > 0, parts: rows.map((r) => r.text), rows };
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

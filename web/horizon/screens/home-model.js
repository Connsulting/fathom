/* Home view model: goals first, pace per goal, the next action per goal, one data-health line.
   Pure functions over the scenario (pace, goals, recs, ingest, accounts); no DOM and no api, so
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

export const OWNERS = ['you', 'spouse', 'both', 'advisor', 'automatic'];

export function ownerOf(rec) {
  return OWNERS.includes(rec?.owner) ? rec.owner : 'both';
}

export function ownerMatches(rec, filter) {
  const o = ownerOf(rec);
  if (filter === 'me') return o === 'you' || o === 'both';
  if (filter === 'spouse') return o === 'spouse' || o === 'both';
  return true;
}

export function servedGoalIds(rec) {
  const out = [];
  arr(rec?.serves).forEach((s) => {
    const id = s && typeof s === 'object' ? s.id : s;
    if (id != null && id !== '' && !out.includes(String(id))) out.push(String(id));
  });
  return out;
}

export function isHousekeeping(rec) {
  return typeof rec?.housekeeping === 'boolean' ? rec.housekeeping : servedGoalIds(rec).length === 0;
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
  if (p.status === 'ahead') return { tone: 'ok', label: p.timeGap || 'Ahead' };
  if (p.status === 'on pace') return { tone: 'ok', label: 'On pace' };
  if (p.status === 'behind') return { tone: 'warn', label: p.timeGap || 'Behind' };
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
    s = d
      ? `Data through ${d} is past its update cadence, so pace is unknown for ${plural(unknown, 'goal')}; later months are projected.`
      : `Data is missing, so pace is unknown for ${plural(unknown, 'goal')}.`;
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

export function homeModel({ goals, pace, recs, filter } = {}) {
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
  const ordered = [];
  paceGoals.forEach((p) => { const g = live.find((x) => x.id === p?.id); if (g && !ordered.includes(g)) ordered.push(g); });
  live.forEach((g) => { if (!ordered.includes(g)) ordered.push(g); });
  const cards = ordered.map((g) => {
    const paceIndex = paceGoals.findIndex((p) => p?.id === g.id);
    const p = paceIndex >= 0 ? paceGoals[paceIndex] : null;
    const actions = queue.filter((r) => servedGoalIds(r).includes(String(g.id)));
    const quiet = !p || p.status === 'no target' || ((p.status === 'on pace' || p.status === 'ahead') && actions.length === 0);
    return { id: g.id, goal: g, pace: p, paceIndex, chip: goalChip(p), bar: paceBar(p), next: actions[0] || null, actions, collapsed: quiet };
  });
  return {
    filter: f, counts, cards,
    expanded: cards.filter((c) => !c.collapsed),
    collapsed: cards.filter((c) => c.collapsed),
    housekeeping: queue.filter(isHousekeeping),
    queue,
    nextThing: queue[0] || null,
    afterThat: queue.slice(1, 4)
  };
}

export function healthLine({ pace, ingest, accounts, metaDataThrough } = {}) {
  const dataThrough = typeof pace?.rollup?.dataThrough === 'string' && shortDate(pace.rollup.dataThrough) ? pace.rollup.dataThrough : null;
  const dataLabel = dataThrough ? `Data through ${shortDate(dataThrough)}` : metaDataThrough ? `Data through ${metaDataThrough}` : 'No data yet';
  const staleAccounts = arr(accounts).filter((a) => a?.fresh === 'stale').length;
  const staleGoals = included(pace).filter((g) => g.stale).length;
  const pending = Math.max(0, Number(ingest?.pending) || 0);
  const failed = arr(ingest?.files).filter((x) => x?.status === 'failed').length;
  const parts = [dataLabel];
  if (staleAccounts > 0) parts.push(`${plural(staleAccounts, 'account')} stale`);
  else if (staleGoals > 0) parts.push(`pace data stale for ${plural(staleGoals, 'goal')}`);
  if (pending > 0) parts.push(`${plural(pending, 'question')} to confirm`);
  if (failed > 0) parts.push(`${plural(failed, 'file')} failed`);
  return { dataThrough, dataLabel, staleAccounts, staleGoals, pending, failed, stale: staleAccounts + staleGoals > 0, parts };
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

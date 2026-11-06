// Goals, shared by the server (store, scenario builder, planner, tools) and the browser (served at
// /shared/goals.mjs). Pure: no store, no DOM.
//
// A goal def: {id, title, note, horizon, target, targetDate, track, kind?}. Owner goals (origin
// 'owner') hold plain owner text; seed goals (the demo) hold scenario text with tokens and use
// prose/status/progress as the design reference did.
// track is null, {accounts: [accountId, ...]} or {figure: key} (a KNOWN_FIGURES key).
// Topic matching is deterministic: a goal's topics come from its kind, its words and what it
// tracks; a rec's topics from its domain, value classes and id. A rec serves a goal when they
// share a topic.

export const HORIZONS = Object.freeze([
  Object.freeze({ id: 'now', label: 'This year' }),
  Object.freeze({ id: '1-3y', label: 'Next few years' }),
  Object.freeze({ id: '3-10y', label: 'Long range' }),
]);
export const HORIZON_IDS = HORIZONS.map(h => h.id);
export const horizonLabel = id => (HORIZONS.find(h => h.id === id) || HORIZONS[0]).label;

// The tradeoff curve axes a store without curve content uses (a real store), in the design's
// order. Positions run 0 (left end) to 1 (right end); 0.5 is no lean.
export const CURVE_AXES = Object.freeze([
  Object.freeze({ id: 'tax_cash', left: 'Pay less tax this year', right: 'Keep cash flexible' }),
  Object.freeze({ id: 'ret_life', left: 'Max retirement room', right: 'Lifestyle now' }),
  Object.freeze({ id: 'effort', left: 'Optimize everything', right: 'Do not make me think' }),
  Object.freeze({ id: 'human', left: 'Lean on the AI', right: 'Lean on the human' }),
]);
export const CURVE_DEFAULT = 0.5;

// Figures a goal can track besides accounts, when the store holds them.
export const KNOWN_FIGURES = Object.freeze([
  Object.freeze({ key: 'cash.total', label: 'All cash', topic: 'cash' }),
  Object.freeze({ key: 'cash.personal', label: 'Personal cash', topic: 'cash' }),
  Object.freeze({ key: 'cash.business', label: 'Business cash', topic: 'cash' }),
  Object.freeze({ key: 'true_reserve', label: 'Cash reserve', topic: 'cash' }),
  Object.freeze({ key: 'portfolio', label: 'Investment portfolio', topic: 'retirement' }),
  Object.freeze({ key: 'plan529', label: '529 balance', topic: 'education' }),
]);

export const LIMITS = Object.freeze({ title: 120, note: 500, accounts: 20, target: 1e10 });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = v => typeof v === 'string' && ISO_DATE.test(v)
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// Control characters other than tab and newline.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// Validates goal input against the store's accounts and figures. fields: the body; partial: an
// edit (absent keys keep their value). -> {ok: true, value} | {ok: false, error}
export function validateGoal(fields, { accounts = [], figures = {}, partial = false } = {}) {
  const f = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : null;
  if (!f) return { ok: false, error: 'send a goal object' };
  const out = {};
  const has = k => Object.hasOwn(f, k) && f[k] !== undefined;
  const text = (k, max, required) => {
    if (!has(k)) { if (required && !partial) return `${k} is required`; return null; }
    const v = f[k] == null ? '' : f[k];
    if (typeof v !== 'string') return `${k} must be text`;
    const clean = v.trim();
    if (required && !clean) return `${k} is required`;
    if (clean.length > max) return `${k} is over ${max} characters`;
    if (CONTROL.test(clean) || (k === 'title' && /[\r\n]/.test(clean))) return `${k} has characters that are not allowed`;
    out[k] = clean;
    return null;
  };
  const err = text('title', LIMITS.title, true) || text('note', LIMITS.note, false);
  if (err) return { ok: false, error: err };
  if (has('horizon')) {
    if (!HORIZON_IDS.includes(f.horizon)) return { ok: false, error: `horizon must be one of ${HORIZON_IDS.join(', ')}` };
    out.horizon = f.horizon;
  } else if (!partial) out.horizon = 'now';
  if (has('target')) {
    const t = f.target;
    if (t === null || t === '') out.target = null;
    else if (typeof t !== 'number' || !Number.isFinite(t)) return { ok: false, error: 'target must be a number' };
    else if (t < 0) return { ok: false, error: 'target must not be negative' };
    else if (t > LIMITS.target) return { ok: false, error: 'target is too large' };
    else out.target = Math.round(t * 100) / 100;
  } else if (!partial) out.target = null;
  if (has('targetDate')) {
    const d = f.targetDate;
    if (d === null || d === '') out.targetDate = null;
    else if (!isIsoDate(d)) return { ok: false, error: 'targetDate must be a date (YYYY-MM-DD)' };
    else out.targetDate = d;
  } else if (!partial) out.targetDate = null;
  if (has('track')) {
    const t = f.track;
    if (t === null) out.track = null;
    else if (t && typeof t === 'object' && !Array.isArray(t) && Array.isArray(t.accounts) && Object.keys(t).length === 1) {
      const ids = [...new Set(t.accounts)];
      if (!ids.length) out.track = null;
      else if (ids.length > LIMITS.accounts) return { ok: false, error: `track at most ${LIMITS.accounts} accounts` };
      else if (!ids.every(id => typeof id === 'string' && accounts.some(a => a.id === id))) return { ok: false, error: 'track names an unknown account' };
      else out.track = { accounts: ids };
    } else if (t && typeof t === 'object' && !Array.isArray(t) && typeof t.figure === 'string' && Object.keys(t).length === 1) {
      if (!KNOWN_FIGURES.some(k => k.key === t.figure) || !Object.hasOwn(figures, t.figure)) return { ok: false, error: 'track names an unknown figure' };
      out.track = { figure: t.figure };
    } else return { ok: false, error: 'track must be null, {accounts: [ids]} or {figure: key}' };
  } else if (!partial) out.track = null;
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- topics

const GOAL_WORDS = [
  ['retirement', /\b(retire|retirement|401\s?\(?k\)?|ira|roth|pension|nest egg|financial independence|zero income)\b/i],
  ['education', /\b(529|college|education|tuition|school)\b/i],
  ['cash', /\b(cash|reserve|runway|emergency|cushion|savings)\b/i],
  ['tax', /\b(tax|taxes)\b/i],
  ['giving', /\b(giving|give|charity|charitable|donate|donation)\b/i],
  ['health', /\b(health|hsa|medical)\b/i],
  ['home', /\b(mortgage|house|home)\b/i],
];
const ACCOUNT_TOPIC = { retirement: 'retirement', roth: 'retirement', '529': 'education', checking: 'cash', cash: 'cash', business: 'cash', hsa: 'health' };
export const TOPIC_LABEL = { retirement: 'Retirement', education: 'Education', cash: 'Cash', tax: 'Tax', giving: 'Giving', health: 'Health', home: 'Home' };

// Text without scenario tokens (their keys are not words the owner wrote).
const words = s => String(s ?? '').replace(/\{[a-z]+:[^{}]*\}/g, ' ');

export function goalTopics(goal, accounts = []) {
  const out = new Set();
  if (!goal) return out;
  if (typeof goal.kind === 'string' && TOPIC_LABEL[goal.kind]) out.add(goal.kind);
  const text = words(goal.title) + ' ' + words(goal.note);
  for (const [topic, re] of GOAL_WORDS) if (re.test(text)) out.add(topic);
  const tr = goal.track;
  if (tr && Array.isArray(tr.accounts)) {
    for (const id of tr.accounts) {
      const a = accounts.find(x => x.id === id);
      if (a && ACCOUNT_TOPIC[a.kind]) out.add(ACCOUNT_TOPIC[a.kind]);
    }
  }
  // A known figure the goal tracks, or (a seed goal) the figure its progress bar reads.
  for (const key of [tr && tr.figure, goal.progress && goal.progress.cur]) {
    const k = typeof key === 'string' ? KNOWN_FIGURES.find(x => x.key === key) : null;
    if (k) out.add(k.topic);
  }
  return out;
}

const REC_DOMAIN = { retirement: 'retirement', retire: 'retirement', tax: 'tax', cash: 'cash', giving: 'giving' };
const REC_VALUE = { retire: 'retirement', tax: 'tax', cash: 'cash' };
const REC_ID = [
  ['retirement', /401k|roth|sep|ira|retire|backdoor/i],
  ['education', /529|college/i],
  ['health', /hsa/i],
  ['giving', /charit|daf|giving/i],
  ['home', /mortgage/i],
];

export function recTopics(rec) {
  const out = new Set();
  if (!rec) return out;
  if (REC_DOMAIN[rec.domain]) out.add(REC_DOMAIN[rec.domain]);
  for (const v of Array.isArray(rec.value) ? rec.value : []) if (v && REC_VALUE[v.cls]) out.add(REC_VALUE[v.cls]);
  for (const [topic, re] of REC_ID) if (re.test(String(rec.id || ''))) out.add(topic);
  return out;
}

// Goals that count for linking and ranking: not archived, not a finished seed goal.
export const openGoal = g => !!g && !g.archived && g.status !== 'done';

// Topic order for linking: a specific topic (retirement, education, ...) beats tax, which almost
// every rec carries; a goal about tax links to tax recs only when nothing more specific matches.
// -> [{id, title, origin}] in goal order, at most three.
export function servesGoals(rec, goals, accounts = []) {
  const rt = recTopics(rec);
  if (!rt.size) return [];
  const hits = [];
  for (const g of goals || []) {
    if (!openGoal(g)) continue;
    const gt = goalTopics(g, accounts);
    const shared = [...gt].filter(t => rt.has(t));
    if (!shared.length) continue;
    hits.push({ g, specific: shared.some(t => t !== 'tax') });
  }
  const best = hits.some(h => h.specific) ? hits.filter(h => h.specific) : hits;
  return best.slice(0, 3).map(({ g }) => ({ id: g.id, title: g.title, origin: g.origin || 'seed' }));
}

// The curve position for an axis: the stored one, else the content default, else 0.5.
export function curvePosition(positions, axis) {
  const p = positions && Object.hasOwn(positions, axis.id) ? positions[axis.id] : undefined;
  if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) return p;
  return typeof axis.value === 'number' ? axis.value : CURVE_DEFAULT;
}

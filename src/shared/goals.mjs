// Goals, shared by the server (store, scenario builder, planner, tools) and the browser (served at
// /shared/goals.mjs). Pure: no store, no DOM.
//
// A goal def: {id, title, note, horizon, kind, owner, priority, ...kind fields, pace}. `kind` is
// the goal model kind (balance, range, floor or contribution; KIND_FIELDS lists each kind's
// fields), not a topic; a def without one is a balance goal. `owner` is whose goal (owner, spouse,
// joint or a dependent key such as kid), distinct from `origin: 'owner'` (a goal the owner typed).
// Status is never in the def: it is derived from the row (archived_at, done_at). Owner goals
// (origin 'owner') hold plain owner text; seed goals (the demo) hold scenario text with tokens and
// use prose/status/progress as the design reference did, the seed status being display text.
// track is null, {accounts: [accountId, ...]} or {figure: key} (a KNOWN_FIGURES key).
// Topic matching is deterministic: a goal's topics come from its words, what it tracks, its
// contribution accounts and a legacy `topic` (an old def kind that named a topic); a rec's topics
// are the goal topics it names (rec.goalKinds, a topic list, not model kinds). A rec serves a goal
// when they share a topic. Links resolve at read time, so a new, done or archived goal relinks at
// once.

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

export const LIMITS = Object.freeze({ title: 120, note: 500, accounts: 20, target: 1e10, people: 2, taxYearMin: 2000, taxYearMax: 2100 });

// ---------------------------------------------------------------- goal model

// Goal model kinds (goal.kind). Not the rec topics in rec.goalKinds.
export const GOAL_KINDS = Object.freeze(['balance', 'range', 'floor', 'contribution']);
export const KIND_LABEL = Object.freeze({ balance: 'Reach a balance', range: 'Stay in a range', floor: 'Keep a floor', contribution: 'Make a contribution' });
// The def fields each kind keeps; a field listed for another kind is dropped on a kind change and
// refused in a body. A contribution's target is the amount and its targetDate the deadline.
export const KIND_FIELDS = Object.freeze({
  balance: Object.freeze(['target', 'targetDate', 'track']),
  range: Object.freeze(['targetLow', 'targetHigh', 'targetDate', 'track']),
  floor: Object.freeze(['floor', 'track']),
  contribution: Object.freeze(['target', 'taxYear', 'targetDate', 'accounts', 'split', 'entered']),
});
export const ALL_KIND_FIELDS = Object.freeze([...new Set(Object.values(KIND_FIELDS).flat())]);
export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const PRIORITY_LABEL = Object.freeze({ high: 'High', medium: 'Medium', low: 'Low' });
export const priorityRank = p => (PRIORITIES.includes(p) ? PRIORITIES.indexOf(p) : PRIORITIES.length);
export const GOAL_STATUSES = Object.freeze(['open', 'done', 'archived']);
// People who can contribute (split, entered): the ids accounts.owner and the spec use.
export const PERSONS = Object.freeze(['owner', 'spouse']);
export const isDependentKey = v => typeof v === 'string' && /^kid\d{0,2}$/.test(v);
// Whose goal: the owner, the spouse, both (joint) or a dependent. Not origin 'owner'.
export const isGoalOwner = v => v === 'owner' || v === 'spouse' || v === 'joint' || isDependentKey(v);
export const kindOf = def => (def && GOAL_KINDS.includes(def.kind) ? def.kind : 'balance');
export const goalStatusOf = row => (row?.archived_at ? 'archived' : row?.done_at ? 'done' : 'open');

const nameOf = (names, key) => (names && typeof names[key] === 'string' && names[key].trim() ? names[key] : '');

// Label for a person or goal owner id from scenario names ({me, spouse, kid, ...}); neutral fallbacks.
export function personLabel(id, names = {}) {
  if (id === 'owner') return nameOf(names, 'me') || 'You';
  if (id === 'spouse') return nameOf(names, 'spouse') || 'Your spouse';
  if (id === 'joint') return 'Joint';
  if (isDependentKey(id)) return nameOf(names, id) || 'Your child';
  return '';
}

// Whose-goal options for the editor: owner, spouse, joint, then each kid key present in names
// (sorted), else one 'kid'. -> [{id, label}]
export function goalOwnerOptions(names = {}) {
  const kids = Object.keys(names || {}).filter(k => isDependentKey(k) && nameOf(names, k)).sort();
  return ['owner', 'spouse', 'joint', ...(kids.length ? kids : ['kid'])].map(id => ({ id, label: personLabel(id, names) }));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = v => typeof v === 'string' && ISO_DATE.test(v)
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// Control characters other than tab and newline.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// Validates goal input against the store's accounts and figures. fields: the body; partial: an
// edit (absent keys keep their value); previous: the stored def of the goal being edited, so the
// kind rules see the goal as it will be saved. -> {ok: true, value} | {ok: false, error}
// A full body defaults kind to balance, status to open, owner and priority to null, and every
// field of its kind to null. A partial value holds only the keys sent.
export function validateGoal(fields, { accounts = [], figures = {}, partial = false, previous = null } = {}) {
  const f = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : null;
  if (!f) return { ok: false, error: 'send a goal object' };
  const out = {};
  const has = k => Object.hasOwn(f, k) && f[k] !== undefined;
  const fail = error => ({ ok: false, error });
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
  // An amount: a finite number, not negative, within the limit, kept to cents. -> {error} | {value}
  const money = (k, v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${k} must be a number` };
    if (v < 0) return { error: `${k} must not be negative` };
    if (v > LIMITS.target) return { error: `${k} is too large` };
    return { value: Math.round(v * 100) / 100 };
  };
  const err = text('title', LIMITS.title, true) || text('note', LIMITS.note, false);
  if (err) return fail(err);
  if (has('horizon')) {
    if (!HORIZON_IDS.includes(f.horizon)) return fail(`horizon must be one of ${HORIZON_IDS.join(', ')}`);
    out.horizon = f.horizon;
  } else if (!partial) out.horizon = 'now';

  if (has('kind')) {
    if (!GOAL_KINDS.includes(f.kind)) return fail(`kind must be one of ${GOAL_KINDS.join(', ')}`);
    out.kind = f.kind;
  } else if (!partial) out.kind = 'balance';
  if (has('owner')) {
    if (f.owner === null || f.owner === '') out.owner = null;
    else if (!isGoalOwner(f.owner)) return fail('owner must be owner, spouse, joint or a dependent key such as kid');
    else out.owner = f.owner;
  } else if (!partial) out.owner = null;
  if (has('priority')) {
    if (f.priority === null || f.priority === '') out.priority = null;
    else if (!PRIORITIES.includes(f.priority)) return fail(`priority must be one of ${PRIORITIES.join(', ')}`);
    else out.priority = f.priority;
  } else if (!partial) out.priority = null;
  if (has('status')) {
    if (!GOAL_STATUSES.includes(f.status)) return fail(`status must be one of ${GOAL_STATUSES.join(', ')}`);
    out.status = f.status;
  } else if (!partial) out.status = 'open';

  // The kind the goal will have, and no body field of another kind.
  const kind = out.kind || kindOf(partial ? previous : null);
  for (const k of ALL_KIND_FIELDS) {
    if (has(k) && !KIND_FIELDS[kind].includes(k)) return fail(`${k} does not apply to a ${kind} goal`);
  }

  for (const k of ['target', 'targetLow', 'targetHigh', 'floor']) {
    if (!has(k)) continue;
    if (f[k] === null || f[k] === '') { out[k] = null; continue; }
    const m = money(k, f[k]);
    if (m.error) return fail(m.error);
    out[k] = m.value;
  }
  if (has('targetDate')) {
    const d = f.targetDate;
    if (d === null || d === '') out.targetDate = null;
    else if (!isIsoDate(d)) return fail('targetDate must be a date (YYYY-MM-DD)');
    else out.targetDate = d;
  }
  if (has('track')) {
    const t = f.track;
    if (t === null) out.track = null;
    else if (t && typeof t === 'object' && !Array.isArray(t) && Array.isArray(t.accounts) && Object.keys(t).length === 1) {
      const ids = [...new Set(t.accounts)];
      if (!ids.length) out.track = null;
      else if (ids.length > LIMITS.accounts) return fail(`track at most ${LIMITS.accounts} accounts`);
      else if (!ids.every(id => typeof id === 'string' && accounts.some(a => a.id === id))) return fail('track names an unknown account');
      else out.track = { accounts: ids };
    } else if (t && typeof t === 'object' && !Array.isArray(t) && typeof t.figure === 'string' && Object.keys(t).length === 1) {
      if (!KNOWN_FIGURES.some(k => k.key === t.figure) || !Object.hasOwn(figures, t.figure)) return fail('track names an unknown figure');
      out.track = { figure: t.figure };
    } else return fail('track must be null, {accounts: [ids]} or {figure: key}');
  }
  if (has('taxYear')) {
    const y = f.taxYear;
    if (y === null) out.taxYear = null;
    else if (!Number.isInteger(y) || y < LIMITS.taxYearMin || y > LIMITS.taxYearMax) return fail(`taxYear must be a whole year from ${LIMITS.taxYearMin} to ${LIMITS.taxYearMax}`);
    else out.taxYear = y;
  }
  if (has('accounts')) {
    const a = f.accounts;
    if (a === null || (Array.isArray(a) && !a.length)) out.accounts = null;
    else if (!Array.isArray(a)) return fail('accounts must be a list of account ids');
    else {
      const ids = [...new Set(a)];
      if (ids.length > LIMITS.accounts) return fail(`accounts at most ${LIMITS.accounts} accounts`);
      if (!ids.every(id => typeof id === 'string' && accounts.some(x => x.id === id))) return fail('accounts names an unknown account');
      out.accounts = ids;
    }
  }
  // [{person, amount}] with each person once. -> {error} | {value}
  const people = (k, list, { positive }) => {
    if (!Array.isArray(list) || !list.length || list.length > LIMITS.people) return { error: `${k} must list one or two people` };
    const seen = new Set();
    const value = [];
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2
        || !Object.hasOwn(item, 'person') || !Object.hasOwn(item, 'amount')) return { error: `${k} entries must be {person, amount}` };
      if (!PERSONS.includes(item.person)) return { error: `${k} person must be ${PERSONS.join(' or ')}` };
      if (seen.has(item.person)) return { error: `${k} names a person twice` };
      seen.add(item.person);
      const m = money(`${k} amount`, item.amount);
      if (m.error) return m;
      if (positive && !(m.value > 0)) return { error: `${k} amount must be above zero` };
      value.push({ person: item.person, amount: m.value });
    }
    return { value };
  };
  if (has('split')) {
    const sp = f.split;
    if (sp === null || (Array.isArray(sp) && !sp.length)) out.split = null;
    else {
      const r = people('split', sp, { positive: true });
      if (r.error) return fail(r.error);
      out.split = r.value;
    }
  }
  if (has('entered')) {
    const e = f.entered;
    if (e === null) out.entered = null;
    else if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(k => !['asOf', 'total', 'people'].includes(k))) {
      return fail('entered must be {asOf, total} or {asOf, people}');
    } else if (!isIsoDate(e.asOf)) return fail('entered asOf must be a date (YYYY-MM-DD)');
    else if (Object.hasOwn(e, 'total') === Object.hasOwn(e, 'people')) return fail('entered needs exactly one of total or people');
    else if (Object.hasOwn(e, 'total')) {
      const m = money('entered total', e.total);
      if (m.error) return fail(m.error);
      out.entered = { asOf: e.asOf, total: m.value };
    } else {
      const r = people('entered', e.people, { positive: false });
      if (r.error) return fail(r.error);
      out.entered = { asOf: e.asOf, people: r.value };
    }
  }

  // Kind rules on the goal as it will be saved: the stored fields of the new kind, then the body.
  const kept = {};
  if (partial && previous && typeof previous === 'object') {
    for (const [k, v] of Object.entries(previous)) if (!ALL_KIND_FIELDS.includes(k) || KIND_FIELDS[kind].includes(k)) kept[k] = v;
  }
  const merged = { ...kept, ...out };
  const set = k => merged[k] !== undefined && merged[k] !== null;
  const finite = k => typeof merged[k] === 'number' && Number.isFinite(merged[k]);
  if (kind === 'range') {
    if (!finite('targetLow') || !finite('targetHigh')) return fail('a range needs a low end and a high end');
    if (merged.targetLow > merged.targetHigh) return fail('the low end must not be above the high end');
  } else if (kind === 'floor') {
    if (!finite('floor')) return fail('a floor needs an amount');
    if (!set('track')) return fail('a floor needs something to track');
  } else if (kind === 'contribution') {
    if (!finite('target') || !(merged.target > 0)) return fail('a contribution needs an amount');
    if (!Number.isInteger(merged.taxYear)) return fail('a contribution needs a tax year');
    if (!isIsoDate(merged.targetDate)) return fail('a contribution needs a deadline');
    if (merged.targetDate <= `${merged.taxYear}-01-01`) return fail('the deadline must be after January 1 of the tax year');
    const split = Array.isArray(merged.split) && merged.split.length ? merged.split : null;
    if (split) {
      const cents = split.reduce((sum, p) => sum + Math.round(p.amount * 100), 0);
      if (cents !== Math.round(merged.target * 100)) return fail('the split must add up to the amount');
      const named = merged.entered && Array.isArray(merged.entered.people) ? merged.entered.people : [];
      if (named.some(p => !split.some(x => x.person === p.person))) return fail('entered names a person who is not in the split');
    }
  }
  if (!partial) for (const k of KIND_FIELDS[kind]) if (!Object.hasOwn(out, k)) out[k] = null;
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
  // A legacy topic (read-time `topic`, or a raw def whose kind names a topic). The model kinds are
  // not topics, so they add nothing.
  for (const t of [goal.topic, goal.kind]) if (typeof t === 'string' && Object.hasOwn(TOPIC_LABEL, t)) out.add(t);
  const text = words(goal.title) + ' ' + words(goal.note);
  for (const [topic, re] of GOAL_WORDS) if (re.test(text)) out.add(topic);
  const tr = goal.track;
  if (tr && Array.isArray(tr.accounts)) {
    for (const id of tr.accounts) {
      const a = accounts.find(x => x.id === id);
      if (a && ACCOUNT_TOPIC[a.kind]) out.add(ACCOUNT_TOPIC[a.kind]);
    }
  }
  // A contribution goal's destination accounts.
  if (Array.isArray(goal.accounts)) {
    for (const id of goal.accounts) {
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

// A rec's topics are exactly the known goal kinds it names (rec.goalKinds: set by the trigger for
// planner recs, by the scenario for demo recs, read from recs.goal_kinds for stored recs).
export function recTopics(rec) {
  const out = new Set();
  if (!rec || !Array.isArray(rec.goalKinds)) return out;
  for (const k of rec.goalKinds) if (typeof k === 'string' && Object.hasOwn(TOPIC_LABEL, k)) out.add(k);
  return out;
}

// Goals that count for linking and ranking: not archived and not done (a done owner goal or a
// finished seed goal).
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

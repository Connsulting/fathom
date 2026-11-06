// Fathom core runtime: window.Fathom, hash router, in-memory store, harness bar, figure popover.
// Implements mock-v2/CONTRACT.md. Designs only touch window.Fathom.api.
//
// Reading notes (where the contract was ambiguous, the simplest reading was taken):
//  - api.verdict() returns raw strings with tokens (only {count} is replaced). Render via api.t().
//  - api.rec(id) also returns recs whose live status is 'hidden'; api.recs() and api.needsYou() never do.
//  - api.go(name, params): params is an object ({id}, {step}, {name}) or a bare value for the route's
//    primary param (rec->id, onboarding->step, wargame->name, packs->id).
//  - api.scenarioPick(name, idx): idx is a point/option index or its id string.
//  - api.ask(questionId): index (or id, or exact q) into rec.qa when the active conversation is a rec,
//    otherwise an id into ask.suggested. Active conversation = rec on the rec route, else 'ask'.
//  - Messages are { id, role, html, refs, ts, notice? }. 'fathom' html is a series of <p>.
//  - t() leaves literal markup in scenario strings alone and escapes only what a token resolves to.

const S = window.FATHOM_SCENARIO || null;
const SOURCE = window.FATHOM_SCENARIO_SOURCE === 'private' ? 'private' : 'synthetic';

const DEMOS = [
  { id: 'fresh', label: '1 New member' },
  { id: 'first', label: '2 First brief' },
  { id: 'november', label: '3 November' },
  { id: 'checkin', label: '4 Check-in' },
  { id: 'clear', label: '5 All clear' },
];
const DEMO_IDS = new Set(DEMOS.map(d => d.id));
const DEFAULT_DEMO = 'november';
const PREFERRED_ORDER = ['ledger', 'console', 'horizon', 'thread'];
const ROUTES = new Set(['onboarding', 'brief', 'plan', 'rec', 'ask', 'wargame', 'goals', 'accounts',
  'advisor', 'yearend', 'connect', 'engine', 'email', 'packs']);
const PARAM_KEY = { rec: 'id', onboarding: 'step', wargame: 'name', packs: 'id' };
const LAST_STEP = 5;

// ---------------------------------------------------------------- small helpers

const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const arr = v => (Array.isArray(v) ? v : []);
const lsGet = k => { try { return window.localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
const trimZeros = s => (s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const commas = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function money(n, o) {
  o = o || {};
  n = Number(n);
  if (!isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  let body;
  if (o.k) {
    if (a >= 999500) body = '$' + trimZeros((a / 1e6).toFixed(2)) + 'M';
    else if (a >= 1e3) body = '$' + trimZeros((a / 1e3).toFixed(a >= 1e4 ? 0 : 1)) + 'K';
    else body = '$' + Math.round(a);
  } else {
    body = '$' + commas(Math.round(a));
  }
  const zero = /^\$0(\.0+)?[KM]?$/.test(body);
  const sign = n < 0 && !zero ? '-' : (o.sign && n > 0 ? '+' : '');
  return sign + body;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function clockDate() {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((S && S.meta && S.meta.clock) || '');
  return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : '';
}
function clockTime(n) {
  const mins = 9 * 60 + n;
  const h24 = Math.floor(mins / 60) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return h + ':' + String(mins % 60).padStart(2, '0') + (h24 < 12 ? ' AM' : ' PM');
}

// ---------------------------------------------------------------- scenario lookups

const recList = () => arr(S && S.recs);
const rawRec = id => recList().find(r => r.id === id) || null;
const packList = () => arr(S && S.packs);
const rawPack = id => packList().find(p => p.id === id) || null;

const KIND_WORDS = {
  a: 'Actual, from a mirrored account',
  p: 'Projected from the plan',
  e: 'Estimate',
  m: 'Model output',
};

function figOf(key) {
  const f = S && S.fig && key != null ? S.fig[key] : null;
  if (f && typeof f === 'object') return f;
  return { v: 0, src: null, kind: 'e', label: String(key == null ? '' : key), missing: true };
}
function srcOf(id) {
  const s = S && S.src && id != null ? S.src[id] : null;
  return { id: id == null ? null : id, label: (s && s.label) || 'Unknown source', asOf: (s && s.asOf) || '' };
}

// ---------------------------------------------------------------- tokens

const TOKEN = /\{(fk|f|l|p|n):([^{}\s:]+)\}/g;
const warned = new Set();
function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  try { console.warn('[fathom] ' + msg); } catch (e) { /* no console */ }
}

function resolveTokens(input, asHtml) {
  if (input == null) return '';
  const str = typeof input === 'string' ? input : String(input);
  if (str.indexOf('{') < 0) return str;
  return str.replace(TOKEN, (m, type, key) => {
    try {
      if (type === 'f' || type === 'fk') {
        const f = S && S.fig ? S.fig[key] : null;
        if (!f || typeof f.v !== 'number') { warnOnce('missing figure ' + key); return '[?' + key + ']'; }
        const text = money(f.v, { k: type === 'fk' });
        if (!asHtml) return text;
        const kind = f.kind in KIND_WORDS ? f.kind : 'e';
        return '<span class="fx-fig" data-fig="' + esc(key) + '" data-kind="' + kind + '" tabindex="0">' + text + '</span>';
      }
      if (type === 'l') {
        const v = S && S.law ? S.law[key] : undefined;
        if (typeof v !== 'number') { warnOnce('missing law ' + key); return '[?' + key + ']'; }
        const text = money(v);
        return asHtml ? '<span class="fx-law">' + text + '</span>' : text;
      }
      if (type === 'p') {
        const v = S && S.pct ? S.pct[key] : undefined;
        if (typeof v !== 'number') { warnOnce('missing pct ' + key); return '[?' + key + ']'; }
        return trimZeros(v.toFixed(2)) + '%';
      }
      const v = S && S.names ? S.names[key] : undefined; // 'n'
      if (v == null) { warnOnce('missing name ' + key); return '[?' + key + ']'; }
      return asHtml ? esc(v) : String(v);
    } catch (e) {
      return m;
    }
  });
}
const t = s => resolveTokens(s, true);
const txt = s => resolveTokens(s, false);

// ---------------------------------------------------------------- store

const state = {};
let version = 0;
let cache = { ver: -1, recs: null };

function defaultPick(name) {
  const w = S && S.wargame && S.wargame[name];
  if (!w) return 0;
  const list = arr(name === 'salary' ? w.points : w.options);
  const i = list.findIndex(x => x && (x.current || x.recommended));
  return i >= 0 ? i : 0;
}

function pushMsg(key, role, html, extra) {
  const list = state.convs[key] || (state.convs[key] = []);
  state.seq += 1;
  const msg = Object.assign({ id: 'm' + state.seq, role, html, refs: [], ts: clockDate() + ', ' + clockTime(state.clockN) }, extra || {});
  state.clockN += 1;
  list.push(msg);
  return msg;
}

function resetStore(demo, opts) {
  opts = opts || {};
  Object.keys(state).forEach(k => delete state[k]);
  Object.assign(state, {
    demo,
    engine: opts.engine === undefined ? true : !!opts.engine,
    onboardStep: 0,
    actions: {},      // recId -> status override
    wake: {},         // recId -> snooze label
    taskDone: {},     // recId -> { taskIndex: boolean }
    convs: {},        // conversation key -> messages
    packActive: {},   // packId -> boolean override of the scenario status
    exploring: {},    // packId -> true once a what-if was opened
    whatIfAsked: {},
    whatIfDone: {},
    unhid: {},        // packId -> recIds this pack turned from hidden to proposed
    picks: { salary: defaultPick('salary'), deferral: defaultPick('deferral') },
    seq: 0,
    clockN: 0,
  });
  state.convs.ask = [];
  recList().forEach(r => {
    state.convs[r.id] = [{ id: 'seed-' + r.id, role: 'fathom', html: '<p>' + t(r.summary) + '</p>', refs: [], ts: clockDate() + ', 8:00 AM' }];
  });
  if (demo === 'clear') {
    // November with every needs-you rec done, unless the rec says otherwise for this state.
    recList().forEach(r => {
      if (r.statusByDemo && r.statusByDemo.clear) return;
      const base = (r.statusByDemo && r.statusByDemo.november) || r.status;
      if (needsRule(base, r)) {
        state.actions[r.id] = 'done';
        state.taskDone[r.id] = {};
        arr(r.tasks).forEach((_, i) => { state.taskDone[r.id][i] = true; });
      }
    });
  }
  version += 1;
}

function needsRule(status, r) {
  const days = r && r.window && typeof r.window.days === 'number' ? r.window.days : 9999;
  return status === 'proposed' || (status === 'doing' && days <= 30);
}

function liveStatus(r) {
  const a = state.actions[r.id];
  if (a) return a;
  if (r.statusByDemo && r.statusByDemo[state.demo]) return r.statusByDemo[state.demo];
  return r.status;
}

function mergedRecs() {
  if (cache.ver === version && cache.recs) return cache.recs;
  const done = state.taskDone || {};
  const list = recList().map(r => {
    const td = done[r.id] || {};
    return Object.assign({}, r, {
      status: liveStatus(r),
      wake: state.wake[r.id] != null ? state.wake[r.id] : r.wake,
      tasks: arr(r.tasks).map((tk, i) => Object.assign({}, tk, { done: td[i] != null ? td[i] : !!tk.done })),
    });
  });
  cache = { ver: version, recs: list };
  return list;
}

// ---------------------------------------------------------------- subscriptions and design registry

const coreSubs = [];
let designSubs = [];
const designs = new Map();
let current = null;     // { id, def }
let booted = false;
let cur = null;         // current route { name, params }
let suppressHash = null;
let root = null;

function notify() {
  version += 1;
  coreSubs.slice().forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  designSubs.slice().forEach(fn => { try { fn(state, cur); } catch (e) { console.error(e); } });
  if (current && current.def && typeof current.def.render === 'function') {
    try { current.def.render(cur); } catch (e) { console.error(e); }
  }
}

// ---------------------------------------------------------------- routes

function defaultRoute() {
  if (state.demo === 'fresh') return { name: 'onboarding', params: { step: state.onboardStep || 0 } };
  if (state.demo === 'checkin') return { name: 'advisor', params: {} };
  return { name: 'brief', params: {} };
}
const clampStep = n => Math.max(0, Math.min(LAST_STEP, Number.isFinite(n) ? Math.floor(n) : 0));

function normalizeRoute(r) {
  if (!r || !ROUTES.has(r.name)) return defaultRoute();
  const p = r.params || {};
  if (state.demo === 'fresh') {
    const step = r.name === 'onboarding' && p.step != null && p.step !== '' ? clampStep(Number(p.step)) : state.onboardStep;
    return { name: 'onboarding', params: { step } };
  }
  if (r.name === 'onboarding') return defaultRoute();
  if (r.name === 'rec') return p.id && rawRec(String(p.id)) ? { name: 'rec', params: { id: String(p.id) } } : { name: 'plan', params: {} };
  if (r.name === 'packs') return p.id && rawPack(String(p.id)) ? { name: 'packs', params: { id: String(p.id) } } : { name: 'packs', params: {} };
  if (r.name === 'wargame') {
    const n = p.name != null ? String(p.name) : '';
    return { name: 'wargame', params: n === 'salary' || n === 'deferral' ? { name: n } : {} };
  }
  return { name: r.name, params: {} };
}

function parseHash(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return null;
  const name = parts[0];
  const key = PARAM_KEY[name];
  let val = parts[1];
  if (val != null) { try { val = decodeURIComponent(val); } catch (e) { /* keep raw */ } }
  return { name, params: key && val != null ? { [key]: val } : {} };
}

function routeHash(r) {
  if (!r) return '';
  const key = PARAM_KEY[r.name];
  const v = key && r.params ? r.params[key] : null;
  return '#/' + r.name + (v != null && v !== '' ? '/' + encodeURIComponent(v) : '');
}

function urlWith(hash) {
  return window.location.pathname + window.location.search + hash;
}

function applyRoute(r, opts) {
  opts = opts || {};
  const next = normalizeRoute(r);
  const h = routeHash(next);
  const changed = h !== routeHash(cur);
  cur = next;
  if (next.name === 'onboarding') state.onboardStep = next.params.step;
  if (window.location.hash !== h) {
    if (opts.replace) {
      try { window.history.replaceState(null, '', urlWith(h)); } catch (e) { /* ignore */ }
    } else {
      suppressHash = h;
      window.location.hash = h;
    }
  }
  if (opts.silent) return;
  if (changed || opts.force) {
    closePopover();
    if (changed) { try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } }
    notify();
  }
}

function go(name, params) {
  let p = params;
  if (p != null && typeof p !== 'object') p = { [PARAM_KEY[name] || 'id']: p };
  applyRoute({ name, params: p || {} });
}

function onHashChange() {
  if (suppressHash && window.location.hash === suppressHash) { suppressHash = null; return; }
  suppressHash = null;
  const parsed = parseHash(window.location.hash);
  const before = routeHash(cur);
  applyRoute(parsed, { replace: true, silent: true });
  if (routeHash(cur) !== before) {
    closePopover();
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    notify();
  }
}

// ---------------------------------------------------------------- derived data

function needsYou() {
  return mergedRecs()
    .filter(r => r.status !== 'hidden' && needsRule(r.status, r))
    .sort((a, b) => {
      const da = a.window && typeof a.window.days === 'number' ? a.window.days : 9999;
      const db = b.window && typeof b.window.days === 'number' ? b.window.days : 9999;
      return da - db;
    });
}

function verdict() {
  const n = needsYou().length;
  const v = (S && S.verdict) || {};
  if (!n) {
    const c = v.clear || {};
    return { level: 'clear', count: 0, headline: c.headline || '', sub: c.sub || '' };
  }
  const a = v.attention || {};
  const sub = x => String(x == null ? '' : x).replace(/\{count\}/g, String(n));
  return { level: 'attention', count: n, headline: sub(a.headline), sub: sub(a.sub) };
}

// ---------------------------------------------------------------- actions

const ACTION_STATUS = { start: 'doing', complete: 'done', dismiss: 'dismissed', snooze: 'snoozed', reopen: 'proposed' };

function act(recId, action, arg) {
  const r = rawRec(recId);
  if (!r || liveStatus(r) === 'hidden') return;
  if (action === 'task') {
    const i = Number(arg);
    if (!Number.isInteger(i) || i < 0 || i >= arr(r.tasks).length) return;
    const m = mergedRecs().find(x => x.id === recId);
    const td = state.taskDone[recId] || (state.taskDone[recId] = {});
    td[i] = !m.tasks[i].done;
    notify();
    return;
  }
  const status = ACTION_STATUS[action];
  if (!status) return;
  state.actions[recId] = status;
  if (action === 'snooze') state.wake[recId] = arg != null && arg !== '' ? String(arg) : 'Next month';
  else delete state.wake[recId];
  notify();
}

// ---------------------------------------------------------------- conversations

const ENGINE_OFF_HTML = '<p>Engine is off, so answers are paused. Switch it back on to get an answer.</p>';

function activeKey() {
  return cur && cur.name === 'rec' && cur.params && cur.params.id ? cur.params.id : 'ask';
}

function paragraphs(list) {
  return arr(list).map(p => '<p>' + t(p) + '</p>').join('');
}

function findQuestion(key, qid) {
  const r = rawRec(key);
  if (r) {
    const qa = arr(r.qa);
    const byIdx = /^\d+$/.test(String(qid)) ? qa[Number(qid)] : null;
    const hit = byIdx || qa.find(x => x && (x.id === qid || x.q === qid));
    return hit ? { q: hit.q, a: hit.a, refs: [r.id] } : null;
  }
  const sug = arr(S && S.ask && S.ask.suggested);
  const hit = sug.find(x => x && x.id === qid) || (/^\d+$/.test(String(qid)) ? sug[Number(qid)] : null);
  return hit ? { q: hit.q, a: hit.a, refs: arr(hit.refs) } : null;
}

function fallbackAnswer() {
  const f = S && ((S.ask && S.ask.fallback) || S.askFallback);
  return arr(f).length ? f : ['I do not have a canned answer for that in this mock.'];
}

function ask(questionId, convKey) {
  const key = convKey || activeKey();
  const q = findQuestion(key, questionId);
  if (!q) return null;
  pushMsg(key, 'me', t(q.q));
  const msg = state.engine
    ? pushMsg(key, 'fathom', paragraphs(q.a), { refs: q.refs })
    : pushMsg(key, 'fathom', ENGINE_OFF_HTML, { notice: true });
  notify();
  return msg;
}

function askFree(text, convKey) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return null;
  const key = convKey || activeKey();
  pushMsg(key, 'me', esc(clean));
  let msg;
  if (!state.engine) {
    msg = pushMsg(key, 'fathom', ENGINE_OFF_HTML, { notice: true });
  } else {
    const r = rawRec(key);
    const pool = r ? arr(r.qa) : arr(S && S.ask && S.ask.suggested);
    const lc = clean.toLowerCase();
    const exact = pool.find(x => x && txt(x.q).trim().toLowerCase() === lc);
    msg = pushMsg(key, 'fathom', paragraphs(exact ? exact.a : fallbackAnswer()), { refs: exact ? (r ? [r.id] : arr(exact.refs)) : [] });
  }
  notify();
  return msg;
}

function conversation(key) {
  return state.convs[key == null || key === '' ? 'ask' : key] || [];
}

// ---------------------------------------------------------------- packs

function packActive(p) {
  return state.packActive[p.id] != null ? state.packActive[p.id] : p.status === 'active';
}

function livePack(p) {
  let status;
  if (packActive(p)) status = 'active';
  else if (state.exploring[p.id]) status = 'exploring';
  else status = p.status === 'active' ? 'available' : p.status;
  return Object.assign({}, p, { status, baseStatus: p.status });
}

function packs() { return packList().map(livePack); }
function pack(id) { const p = rawPack(id); return p ? livePack(p) : null; }

function whatIf(id) {
  const p = rawPack(id);
  if (!p || !p.whatIf) return;
  const key = 'pack:' + id;
  state.exploring[id] = true;
  if (!state.whatIfAsked[id]) {
    pushMsg(key, 'me', t(p.whatIf.prompt));
    state.whatIfAsked[id] = true;
  }
  if (!state.whatIfDone[id]) {
    if (!state.engine) {
      const list = state.convs[key];
      const last = list[list.length - 1];
      if (!(last && last.notice)) pushMsg(key, 'fathom', ENGINE_OFF_HTML, { notice: true });
    } else {
      pushMsg(key, 'fathom', paragraphs(p.whatIf.a), { refs: arr(p.whatIf.unlocks).map(u => u && u.recId).filter(Boolean) });
      state.whatIfDone[id] = true;
    }
  }
  notify();
}

function packToggle(id) {
  const p = rawPack(id);
  if (!p) return null;
  const turnOn = !packActive(p);
  state.packActive[id] = turnOn;
  if (turnOn) {
    const lifted = [];
    arr(p.recIds).forEach(rid => {
      const r = rawRec(rid);
      if (r && liveStatus(r) === 'hidden') { state.actions[rid] = 'proposed'; lifted.push(rid); }
    });
    state.unhid[id] = lifted;
  } else {
    arr(state.unhid[id]).forEach(rid => {
      const stillPowered = packList().some(o => o.id !== id && packActive(o) && arr(o.recIds).indexOf(rid) >= 0);
      if (state.actions[rid] === 'proposed' && !stillPowered) delete state.actions[rid];
    });
    state.unhid[id] = [];
  }
  notify();
  return livePack(p).status;
}

// ---------------------------------------------------------------- misc api

function scenarioPick(name, idx) {
  if (name !== 'salary' && name !== 'deferral') return;
  const w = S && S.wargame && S.wargame[name];
  if (!w) return;
  const list = arr(name === 'salary' ? w.points : w.options);
  let i = typeof idx === 'string' && !/^\d+$/.test(idx) ? list.findIndex(x => x && x.id === idx) : Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return;
  state.picks[name] = i;
  notify();
}

function onboard(step) {
  const n = Number(step);
  if (!Number.isFinite(n)) return;
  if (n > LAST_STEP) { setDemo('first'); return; }
  const s = clampStep(n);
  state.onboardStep = s;
  go('onboarding', { step: s });
}

function on(fn) {
  if (typeof fn !== 'function') return () => {};
  designSubs.push(fn);
  return () => { designSubs = designSubs.filter(f => f !== fn); };
}

function setEngine(v) {
  state.engine = !!v;
  notify();
}

function setDemo(id) {
  if (!DEMO_IDS.has(id)) return;
  resetStore(id, { engine: state.engine });
  lsSet('fx.demo', id);
  syncUrl();
  applyRoute(defaultRoute(), { silent: true });
  closePopover();
  try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  notify();
}

function resetAll() {
  resetStore(state.demo);
  applyRoute(defaultRoute(), { silent: true });
  closePopover();
  try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  notify();
}

const api = {
  s: S,
  state,
  get route() { return cur; },
  go,
  on,
  t,
  txt,
  fig: figOf,
  src: srcOf,
  money,
  recs: () => mergedRecs().filter(r => r.status !== 'hidden'),
  rec: id => mergedRecs().find(r => r.id === id) || null,
  needsYou,
  verdict,
  act,
  ask,
  askFree,
  conversation,
  scenarioPick,
  onboard,
  engineOn: () => !!state.engine,
  setEngine,
  demo: () => state.demo,
  packs,
  pack,
  whatIf,
  packToggle,
  figPopover: el => openPopover(el),
};

// ---------------------------------------------------------------- figure popover

let pop = null;   // { el, anchor }

function closePopover() {
  if (pop) { pop.el.remove(); pop = null; }
}

function openPopover(anchor) {
  if (!anchor || !anchor.getBoundingClientRect) return;
  const same = pop && pop.anchor === anchor;
  closePopover();
  if (same) return;
  const key = anchor.getAttribute('data-fig');
  const f = figOf(key);
  const src = srcOf(f.src);
  const kind = KIND_WORDS[f.kind] || KIND_WORDS.e;
  const el = document.createElement('div');
  el.className = 'fx-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Figure source');
  el.innerHTML =
    '<div class="fx-pop-label">' + esc(f.label || key) + '</div>' +
    '<div class="fx-pop-val">' + esc(money(f.v)) + '</div>' +
    '<div class="fx-pop-row"><span class="fx-pop-k">Source</span><span class="fx-pop-v">' + esc(src.label) + '</span></div>' +
    (src.asOf ? '<div class="fx-pop-row"><span class="fx-pop-k">As of</span><span class="fx-pop-v">' + esc(src.asOf) + '</span></div>' : '') +
    '<div class="fx-pop-row"><span class="fx-pop-k">Kind</span><span class="fx-pop-v">' + esc(kind) + '</span></div>';
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
  let top = r.bottom + 8;
  if (top + h > vh - 8 && r.top - h - 8 >= 8) top = r.top - h - 8;
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(Math.max(8, top)) + 'px';
  pop = { el, anchor };
}

document.addEventListener('click', e => {
  if (!pop) return;
  if (pop.el.contains(e.target) || pop.anchor.contains(e.target)) return;
  closePopover();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closePopover();
    const hb = document.querySelector('.fx-harness.fx-open');
    if (hb) setHarnessOpen(false);
  }
});

// ---------------------------------------------------------------- harness bar

const H = {};

function buildHarness() {
  const bar = document.querySelector('.fx-harness') || document.body.insertBefore(document.createElement('div'), document.body.firstChild);
  bar.classList.add('fx-harness');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Review harness');
  bar.innerHTML =
    '<div class="fx-h-row">' +
      '<span class="fx-h-tag">review</span>' +
      '<label class="fx-h-group fx-h-design-group"><span class="fx-h-lab">Design</span><select class="fx-h-design" aria-label="Design"></select></label>' +
      '<div class="fx-h-rest">' +
        '<div class="fx-h-group fx-h-state"><span class="fx-h-lab">State</span><div class="fx-h-seg" role="group" aria-label="Demo state">' +
          DEMOS.map(d => '<button type="button" data-demo="' + d.id + '" aria-pressed="false">' + esc(d.label) + '</button>').join('') +
        '</div></div>' +
        '<button type="button" class="fx-h-btn fx-h-eng" aria-pressed="true"></button>' +
        '<div class="fx-h-src"></div>' +
        '<button type="button" class="fx-h-btn fx-h-reset">Reset</button>' +
      '</div>' +
      '<button type="button" class="fx-h-more" aria-expanded="false" aria-label="More review controls">...</button>' +
    '</div>';
  H.bar = bar;
  H.select = bar.querySelector('.fx-h-design');
  H.eng = bar.querySelector('.fx-h-eng');
  H.src = bar.querySelector('.fx-h-src');
  H.more = bar.querySelector('.fx-h-more');
  H.segs = Array.from(bar.querySelectorAll('[data-demo]'));

  H.select.addEventListener('change', () => mountDesign(H.select.value));
  H.segs.forEach(b => b.addEventListener('click', () => setDemo(b.getAttribute('data-demo'))));
  H.eng.addEventListener('click', () => setEngine(!state.engine));
  bar.querySelector('.fx-h-reset').addEventListener('click', resetAll);
  H.more.addEventListener('click', () => setHarnessOpen(!bar.classList.contains('fx-open')));
  document.addEventListener('click', e => {
    if (bar.classList.contains('fx-open') && !bar.contains(e.target)) setHarnessOpen(false);
  });

  const meta = (S && S.meta) || {};
  H.src.textContent = (SOURCE === 'private' ? 'private data' : 'synthetic data') +
    ' | ' + (meta.clockLabel || meta.clock || 'n/a') +
    ' | data through ' + (meta.dataThrough || 'n/a');
  H.src.title = H.src.textContent;
  coreSubs.push(updateHarness);
  refreshDesignList();
  updateHarness();
}

function setHarnessOpen(open) {
  if (!H.bar) return;
  H.bar.classList.toggle('fx-open', open);
  H.more.setAttribute('aria-expanded', String(open));
}

function orderedDesigns() {
  const ids = Array.from(designs.keys());
  ids.sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a); const ib = PREFERRED_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return ids.map(id => designs.get(id));
}

function refreshDesignList() {
  if (!H.select) return;
  const list = orderedDesigns();
  if (!list.length) {
    H.select.innerHTML = '<option value="">no designs loaded</option>';
    H.select.disabled = true;
    return;
  }
  H.select.disabled = false;
  H.select.innerHTML = list.map(d => '<option value="' + esc(d.id) + '">' + esc(d.name || d.id) + '</option>').join('');
  if (current && designs.has(current.id)) H.select.value = current.id;
}

function updateHarness() {
  if (!H.bar) return;
  H.segs.forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-demo') === state.demo)));
  H.eng.setAttribute('aria-pressed', String(!!state.engine));
  H.eng.textContent = 'Engine: ' + (state.engine ? 'on' : 'off');
  if (current && designs.has(current.id) && H.select.value !== current.id) H.select.value = current.id;
  if (pop && !pop.anchor.isConnected) closePopover();
}

// ---------------------------------------------------------------- design lifecycle

function syncUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (current && designs.has(current.id)) q.set('d', current.id);
    q.set('demo', state.demo);
    window.history.replaceState(null, '', window.location.pathname + '?' + q.toString() + window.location.hash);
  } catch (e) { /* ignore */ }
}

function unmountCurrent() {
  if (current && current.def && typeof current.def.unmount === 'function') {
    try { current.def.unmount(); } catch (e) { console.error(e); }
  }
  designSubs = [];
  closePopover();
  current = null;
}

function mountDesign(id) {
  const def = designs.get(id) || FALLBACK;
  unmountCurrent();
  root.innerHTML = '';
  root.className = 'd-' + def.id;
  current = { id: def.id, def };
  try {
    def.mount(root, api);
  } catch (e) {
    console.error(e);
    root.innerHTML = '<pre style="padding:24px;color:#d99;white-space:pre-wrap">Design "' + esc(def.id) + '" failed to mount: ' + esc(e && e.message) + '</pre>';
  }
  if (typeof def.render === 'function') {
    try { def.render(cur); } catch (e) { console.error(e); }
  }
  if (designs.has(def.id)) {
    lsSet('fx.design', def.id);
    syncUrl();
  }
  refreshDesignList();
  updateHarness();
}

function pickInitialDesign() {
  const fromUrl = new URLSearchParams(window.location.search).get('d');
  if (fromUrl && designs.has(fromUrl)) return fromUrl;
  const fromLs = lsGet('fx.design');
  if (fromLs && designs.has(fromLs)) return fromLs;
  if (designs.has('horizon')) return 'horizon';
  const list = orderedDesigns();
  return list.length ? list[0].id : null;
}

function registerDesign(def) {
  if (!def || !def.id || typeof def.mount !== 'function') {
    console.error('[fathom] registerDesign needs { id, mount }');
    return;
  }
  designs.set(def.id, def);
  if (!booted) return;
  refreshDesignList();
  // A design that arrives after boot replaces the plain fallback, or takes over when it was asked for.
  if (!current || current.def === FALLBACK || new URLSearchParams(window.location.search).get('d') === def.id && current.id !== def.id) {
    mountDesign(def.id);
  }
}

// ---------------------------------------------------------------- fallback design (core testing without designs)

const FALLBACK = {
  id: 'fallback',
  name: 'Plain fallback',
  blurb: 'Core test view: routes as links and the current route data as text.',
  mount(el) {
    this.el = el;
    this.off = api.on(() => this.render());
    el.addEventListener('click', this.onClick = e => this.click(e));
    el.addEventListener('submit', this.onSubmit = e => {
      const form = e.target.closest('form[data-ask]');
      if (!form) return;
      e.preventDefault();
      const input = form.querySelector('input');
      api.askFree(input.value);
    });
    this.render();
  },
  unmount() {
    if (this.off) this.off();
    if (this.el) {
      this.el.removeEventListener('click', this.onClick);
      this.el.removeEventListener('submit', this.onSubmit);
    }
  },
  click(e) {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    const a = (n) => b.getAttribute('data-' + n);
    const op = a('do');
    if (op === 'act') api.act(a('rec'), a('action'), a('arg'));
    else if (op === 'ask') api.ask(a('q'), a('key') || undefined);
    else if (op === 'whatif') api.whatIf(a('pack'));
    else if (op === 'toggle') api.packToggle(a('pack'));
    else if (op === 'pick') api.scenarioPick(a('name'), Number(a('idx')));
    else if (op === 'step') api.onboard(Number(a('step')));
  },
  data(r) {
    const brief = x => ({ id: x.id, title: x.title, status: x.status, window: x.window && x.window.label, days: x.window && x.window.days });
    const s = api.s;
    switch (r.name) {
      case 'onboarding': return { step: r.params.step, onboarding: s.onboarding };
      case 'brief': return { verdict: api.verdict(), needsYou: api.needsYou().map(brief), deadlines: s.deadlines, events: s.events, domains: s.domains };
      case 'plan': return { recs: api.recs().map(brief) };
      case 'rec': return { rec: api.rec(r.params.id), conversation: api.conversation(r.params.id) };
      case 'ask': return { suggested: s.ask && s.ask.suggested, conversation: api.conversation() };
      case 'wargame': return { picks: api.state.picks, wargame: r.params.name ? { [r.params.name]: s.wargame[r.params.name] } : s.wargame };
      case 'goals': return { goals: s.goals, curve: s.curve };
      case 'packs': return r.params.id
        ? { pack: api.pack(r.params.id), conversation: api.conversation('pack:' + r.params.id) }
        : { packs: api.packs().map(p => ({ id: p.id, name: p.name, status: p.status, why: p.why })) };
      default: return s[r.name];
    }
  },
  render() {
    const r = api.route;
    const nav = Array.from(ROUTES).filter(n => n !== 'rec').map(n => {
      const href = n === 'onboarding' ? '#/onboarding/0' : '#/' + n;
      return '<a href="' + href + '"' + (n === r.name ? ' style="color:#fff"' : '') + '>' + n + '</a>';
    }).join(' &nbsp; ');
    let tools = '';
    const btn = (label, attrs) => '<button type="button" ' + attrs + ' style="margin:2px">' + esc(label) + '</button>';
    const recRow = x => '<div>' + '<a href="#/rec/' + esc(x.id) + '">' + esc(x.id) + '</a> [' + esc(x.status) + '] ' +
      ['start', 'snooze', 'dismiss', 'complete', 'reopen'].map(ac => btn(ac, 'data-do="act" data-rec="' + esc(x.id) + '" data-action="' + ac + '"')).join('') + '</div>';
    if (r.name === 'brief') tools = api.needsYou().map(recRow).join('') || '<div>(no needs-you items)</div>';
    if (r.name === 'plan') tools = api.recs().map(recRow).join('');
    if (r.name === 'rec') {
      const x = api.rec(r.params.id);
      tools = recRow(x) + arr(x.tasks).map((tk, i) => btn('toggle task ' + i + (tk.done ? ' (done)' : ''), 'data-do="act" data-rec="' + esc(x.id) + '" data-action="task" data-arg="' + i + '"')).join('') +
        '<div>' + arr(x.qa).map((q, i) => btn('Q' + i, 'data-do="ask" data-q="' + i + '"')).join('') + '</div>' +
        '<form data-ask><input placeholder="free text"> <button>send</button></form>';
    }
    if (r.name === 'ask') {
      tools = arr(api.s.ask && api.s.ask.suggested).map(q => btn(q.id, 'data-do="ask" data-q="' + esc(q.id) + '"')).join('') +
        '<form data-ask><input placeholder="free text"> <button>send</button></form>';
    }
    if (r.name === 'packs') {
      tools = api.packs().map(p => '<div><a href="#/packs/' + esc(p.id) + '">' + esc(p.id) + '</a> [' + esc(p.status) + '] ' +
        btn('what if', 'data-do="whatif" data-pack="' + esc(p.id) + '"') + btn('toggle', 'data-do="toggle" data-pack="' + esc(p.id) + '"') + '</div>').join('');
    }
    if (r.name === 'wargame') {
      const w = api.s.wargame || {};
      tools = arr(w.salary && w.salary.points).map((p, i) => btn('salary ' + i, 'data-do="pick" data-name="salary" data-idx="' + i + '"')).join('') +
        arr(w.deferral && w.deferral.options).map((p, i) => btn('deferral ' + i, 'data-do="pick" data-name="deferral" data-idx="' + i + '"')).join('');
    }
    if (r.name === 'onboarding') {
      const st = r.params.step;
      tools = btn('back', 'data-do="step" data-step="' + Math.max(0, st - 1) + '"') + btn(st >= LAST_STEP ? 'finish' : 'next', 'data-do="step" data-step="' + (st + 1) + '"');
    }
    const v = api.verdict();
    this.el.innerHTML =
      '<div style="max-width:900px;margin:0 auto;padding:24px 16px 64px;font:14px/1.5 system-ui,sans-serif;color:#cfd3da;background:#0b0c0e">' +
      '<p style="margin:0 0 4px;color:#7b8190;font:12px ui-monospace,monospace">Plain fallback: no design registered. Core test view.</p>' +
      '<p style="margin:0 0 12px">' + nav + '</p>' +
      '<p style="margin:0 0 12px;color:#fff">' + esc(v.level) + ' (' + v.count + '): ' + t(v.headline) + '</p>' +
      '<div>' + tools + '</div>' +
      '<pre style="white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace;margin-top:16px">' + esc(dumpText({ route: r, data: this.data(r) })) + '</pre>' +
      '</div>';
  },
};

function dumpText(v, ind) {
  ind = ind || '';
  const prim = x => x == null || typeof x !== 'object';
  const fmt = x => (x == null ? '(none)' : typeof x === 'string' ? txt(x) : String(x));
  if (prim(v)) return ind + fmt(v) + '\n';
  if (Array.isArray(v)) {
    return v.map((x, i) => (prim(x) ? ind + '[' + i + '] ' + fmt(x) + '\n' : ind + '[' + i + ']\n' + dumpText(x, ind + '  '))).join('');
  }
  return Object.keys(v).map(k => (prim(v[k]) ? ind + k + ': ' + fmt(v[k]) + '\n' : ind + k + ':\n' + dumpText(v[k], ind + '  '))).join('');
}

// ---------------------------------------------------------------- boot

function boot() {
  root = document.getElementById('app');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  }
  if (!S) {
    buildHarness();
    root.innerHTML = '<pre style="padding:24px;color:#d99;white-space:pre-wrap">No scenario loaded. Expected private/scenario.js or scenario/example.js to set window.FATHOM_SCENARIO.</pre>';
    return;
  }
  const q = new URLSearchParams(window.location.search);
  const fromUrl = q.get('demo');
  const fromLs = lsGet('fx.demo');
  const demo = DEMO_IDS.has(fromUrl) ? fromUrl : (DEMO_IDS.has(fromLs) ? fromLs : DEFAULT_DEMO);
  resetStore(demo);
  applyRoute(parseHash(window.location.hash), { replace: true, silent: true });
  buildHarness();
  const id = pickInitialDesign();
  booted = true;
  mountDesign(id || 'fallback');
  lsSet('fx.demo', demo);
  syncUrl();
  window.addEventListener('hashchange', onHashChange);
  // Provenance popovers for any .fx-fig, unless a design handles the click and calls preventDefault.
  root.addEventListener('click', e => {
    if (e.defaultPrevented) return;
    const sw = e.target.closest && e.target.closest('[data-fx-engine]');
    if (sw && root.contains(sw)) { e.preventDefault(); setEngine(!state.engine); return; }
    const el = e.target.closest && e.target.closest('.fx-fig');
    if (el && root.contains(el)) openPopover(el);
  });
  root.addEventListener('keydown', e => {
    if (e.defaultPrevented || (e.key !== 'Enter' && e.key !== ' ')) return;
    const el = e.target.closest && e.target.closest('.fx-fig');
    if (el && root.contains(el)) { e.preventDefault(); openPopover(el); }
  });
}

window.Fathom = { registerDesign, api, DEMOS };

function start() { Promise.resolve().then(boot); }
if (document.readyState === 'complete') start();
else document.addEventListener('DOMContentLoaded', start);

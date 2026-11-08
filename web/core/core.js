import { signInTarget } from '../auth/return-path.js';

// Fathom client core: window.Fathom, hash router, API-backed store, figure popover.
// Port of mock-v2/core/core.js. Keeps every `api` member of mock-v2/CONTRACT.md (Core API) with the
// same semantics, plus api.src and api.figPopover. Designs only touch window.Fathom.api.
//
// Differences from the mock:
//  - No review harness, no demo switcher, no design switcher, nothing in localStorage.
//  - Boot reads GET /api/auth/session first. A real store with no signed-in identity goes to
//    /signin before any household request; a demo store is open (identity null). The scenario
//    then comes from GET /api/scenario. The server has already merged live state (rec status,
//    tasks, wake) and adds `scenario.live`; api.state is derived from it.
//  - Any later 401 drops the scenario from memory and the page, then goes to /signin (leaving
//    one notice code in sessionStorage for that page to explain why).
//  - Actions POST to the API, replace the scenario with the one in the response, then notify. They
//    return a Promise (designs may ignore it). Requests run one at a time, in order. A failed
//    request keeps the old state and shows a dismissible error line (role=alert).
//  - api.go(name, params, opts) accepts opts.replace to replace the current history entry, and
//    opts.silent to change the URL only: no notify, no scroll to the top (a screen's own state in the hash).
//  - The figure popover shows cents when the value has a nonzero cents part.
//
// Reading notes kept from the mock:
//  - api.verdict() returns raw strings with tokens (only {count} is replaced). Render via api.t().
//  - api.rec(id) also returns recs whose live status is 'hidden'; api.recs() and api.needsYou() never do.
//  - api.go(name, params): params is an object ({id}, {step}, {name}) or a bare value for the route's
//    primary param (rec->id, onboarding->step, wargame->name, packs->id).
//  - api.scenarioPick(name, idx): idx is a point/option index or its id string.
//  - api.decide(decisionId, idx?): decide the open war-game decision on the picked point (idx, else the
//    stored pick); api.revisit(decisionId) reopens a decision decided that way.
//  - api.ask(questionId, key?): index (or id) into rec.qa when the conversation was asked from a rec,
//    otherwise an id into ask.suggested (or a starter id on #/ask). Default conversation = the rec's
//    attached thread on the rec route (none yet: a new thread asked from that rec), the pack's What
//    if thread on a pack route, the open thread on #/ask/<id>; on #/ask with no thread open it starts
//    a new thread (api.newThread).
//  - Messages are { id, role, html, refs, ts, notice, provenance }. 'fathom' html is a series of <p>.
//    provenance is the stored object (tools, figures, literals, packEntries, packIds, grounding)
//    or null for messages that have none.
//  - api.askFree(text, key) takes an Ask thread key 'ask:<id>' or 'pack:<id>' (the pack's What if
//    thread). Recs have no conversation of their own: a question asked from a rec is an Ask thread
//    carrying recId. There is no bare 'ask' conversation; api.conversation() with no key is [].
//  - Ask threads: route 'ask' takes an optional id (#/ask/<id>; an id not in live.threads normalizes
//    to #/ask). api.threads() lists every thread (archived and trashed too, newest lastAt first) as
//    { id, key, title, titleSource, createdAt, lastAt, archivedAt, trashedAt, turns, recId,
//    recDetachedAt }; title null means "New conversation"; recId names the rec the thread was asked
//    from (null for none; the rec may no longer exist) and recDetachedAt is set once Start over
//    detached it from that rec's dialog. api.askStarters() lists { id, q } plain-text starters.
//    api.newThread({ text, recId? } | { questionId, recId? }) creates a thread, asks, and opens
//    #/ask/<id> when the owner is on #/ask (replacing it); with recId the thread is asked from that
//    rec and questionId indexes rec.qa. It resolves { thread, message } or null.
//    api.recThread(recId) is the rec's attached thread: the newest lastAt thread with that recId,
//    not trashed and not detached, or null. api.startOver(recId) detaches every thread of the rec
//    (they stay in Ask) and resolves the response or null. api.threadAct(id, 'archive'|'trash'|'restore'|
//    'delete') and api.renameThread(id, title) resolve the updated thread (or null; delete resolves
//    null too, and a deleted open thread falls back to #/ask).
//  - api.askStream({ text } | { questionId }, key, onEvent) and api.newThreadStream({ text, recId? } |
//    { questionId, recId? }, onEvent) are api.askFree / api.ask and api.newThread over the server's
//    event stream: onEvent(name, data) sees 'start' {key},
//    'progress' {label}, 'text' {text} (raw model text: escape it and never style its numbers as
//    verified), 'reset' and 'recovering'. They resolve exactly like askFree and newThread. When the
//    stream breaks before its final event, the answer is fetched instead: the scenario is reloaded
//    until the conversation has the new turn (the server stores it once, after grounding). A new
//    thread counts only once it has a turn (a rec thread's row exists before its answer is stored).
//  - References: api.askStream and api.newThreadStream read q.context, api.newThread reads
//    q.context, and api.ask(questionId, key, { context }) and api.askFree(text, key, { context })
//    take it as an option. context is a list of { kind, id } strings (at most 8) the owner pointed
//    at; it is sent only when it has at least one entry.
//  - api.registerFigures(map) keeps Ask block figures ({ 'blk:<messageId>:<blockId>:<n>': { value, unit,
//    label, kind, asOf, source, gaps, provenance } }) for api.fig and the popover (assumptions as Assumes rows), which writes a unit-tagged value by
//    its unit (a ratio as a percent, a date as a date) and a null one as Unavailable with its gap messages.
//  - api.setFigAction(fn | null): while set, the figure popover shows Add to chat; a click calls
//    fn(key, label) with the figure key and its plain label, then closes the popover.
//  - api.accountDetail(id) GETs the account dialog's data and resolves it, or null. api.accountTransactions(id,
//    { q, from, to, limit, cursor }) resolves one page { items, next, total } (newest first) or null; each item's
//    fig and its source are registered, so api.fig(item.fig) and the figure popover work for it. Neither touches
//    the scenario or the error line.
//  - api.pnl({ entity, from, to }) GETs /api/pnl and resolves { entities, pnl, figures, sources } or null.
//    api.pnlRows({ entity, from, to, section, category, month }) GETs /api/pnl/rows and resolves
//    { items, total, sum, figures, sources, note } or null: sum is a figure over every matching row and
//    each item carries amount (raw signed), value (counted) and fig (at value). api.spending({ from, to, include, exclude }) GETs
//    /api/spending and resolves { spending, figures, sources } or null; include and exclude are arrays
//    (or comma separated strings). api.spendingRows({ from, to, include, exclude, bucket, category, month })
//    GETs /api/spending/rows (same shape as pnlRows). All four register the response's figures and sources like
//    api.accountTransactions and never touch the scenario or the error line. A figure's optional
//    detail list ({ k, v } plain text) is shown as rows in the figure popover.
//  - api.accountMask(id, mask | { undo }), api.accountOwner(id, { owner } | { undo }), api.accountKind(id, { kind } |
//    { undo }) and api.accountMerge(id, withId) resolve { data } (the reply, scenario applied) or
//    { error, status } without the error line. api.accountMergeCandidates(id) resolves { items } or null.
//  - api.packEntry(packId, entryId) GETs one pack entry and resolves { id, title, body, cites } or
//    null; it never touches the scenario or the error line.
//  - api.reviseAnswer(id, optionId) and api.reopenAnswer(id) resolve { item }, or { final: message }
//    when the server refuses with 409 (no error line), or null on any other failure.

import { money, resolveTokens, esc, KIND_WORDS } from '/shared/tokens.mjs';
import { needsYou as needsYouOf, packStatus } from '/shared/rules.mjs';
import { isOwner } from '/shared/rec-links.mjs';
import { ROUTES, LAST_STEP, movedRoute, onboardStepOf } from '/shared/route-moves.mjs';

const PARAM_KEY = { confirm: 'id', rec: 'id', onboarding: 'step', wargame: 'name', packs: 'id', ask: 'id', account: 'id', pnl: 'state', pnlrows: 'id' };
// Routes whose param is a URLSearchParams string: kept as written in the hash ('=', '&' and the
// string's own percent escapes literal), never decoded as one value.
const QUERY_PARAM = new Set(['pnl', 'pnlrows']);

// ---------------------------------------------------------------- small helpers

const arr = v => (Array.isArray(v) ? v : []);

// Whole dollars as api.money does, or dollars and cents when the value has a nonzero cents part.
const moneyCents = n => (Math.round(Math.abs(Number(n)) * 100) % 100 ? money(n, { cents: true }) : money(n));

const warned = new Set();
const tokenOpts = {
  onMissing(msg) {
    if (warned.has(msg)) return;
    warned.add(msg);
    try { console.warn('[fathom] ' + msg); } catch (e) { /* no console */ }
  },
};

// ---------------------------------------------------------------- scenario and derived state

let S = null;           // scenario object from the API (replaced after every action)
let IDENT = null;       // { id, email, role, login, name } from GET /api/auth/session, or null (demo)
let leaving = false;    // set once a 401 sent the page to /signin
let version = 0;        // bumped on every change; caches key off it
let routeStep = null;   // onboarding step of the current route (route state, not stored)
const pendingPicks = {}; // war-game picks sent but not yet answered (shown immediately)

const live = () => (S && S.live) || {};
const recList = () => arr(S && S.recs);
const rawRec = id => recList().find(r => r.id === id) || null;
const packList = () => arr(S && S.packs);
const rawPack = id => packList().find(p => p.id === id) || null;
const threadList = () => arr(live().threads);
const rawThread = id => threadList().find(t => t && t.id === id) || null;
const isReal = () => live().mode === 'real';
const minStep = () => onboardStepOf(0, { real: isReal() });
const demoId = () => (live().demo === 'fresh' ? 'fresh' : 'november');

// Figures and sources a screen fetched on its own (an account's transactions), kept beside the
// scenario's so the provenance popover reads them the same way. Keys are namespaced by the server
// (txn.<id>, txn-src:<id>) and never collide with a scenario key.
const extraFig = new Map();
const extraSrc = new Map();

function figOf(key) {
  const f = S && S.fig && key != null ? S.fig[key] : null;
  if (f && typeof f === 'object') return f;
  const x = key != null ? extraFig.get(String(key)) : null;
  if (x) return x;
  return { v: 0, src: null, kind: 'e', label: String(key == null ? '' : key), missing: true };
}
function srcOf(id) {
  const s = (S && S.src && id != null ? S.src[id] : null) || (id != null ? extraSrc.get(String(id)) : null);
  return { id: id == null ? null : id, label: (s && s.label) || 'Unknown source', asOf: (s && s.asOf) || '' };
}

const t = s => resolveTokens(S, s, true, tokenOpts);
const txt = s => resolveTokens(S, s, false, tokenOpts);

let stateCache = { ver: -1, val: null };
function stateView() {
  if (stateCache.ver === version && stateCache.val) return stateCache.val;
  const L = live();
  const val = {
    demo: demoId(),
    engine: !!L.engine,
    onboardStep: onboardStepOf(routeStep != null ? routeStep : L.onboardStep, { real: isReal() }),
    picks: Object.assign({}, L.picks || {}, pendingPicks),
    convs: L.conversations || {},
  };
  stateCache = { ver: version, val };
  return val;
}

let convCache = { ver: -1, map: new Map() };
function mapMsg(m) {
  return {
    id: m.id,
    role: m.role,
    html: t(m.text),
    refs: arr(m.refs),
    ts: m.ts == null ? '' : String(m.ts), // the server already labels it ('Nov 5, 9:04 AM')
    notice: !!m.notice,
    provenance: m.provenance && typeof m.provenance === 'object' && !Array.isArray(m.provenance) ? m.provenance : null,
  };
}
function conversation(key) {
  if (key == null || key === '') return [];
  const k = String(key);
  if (convCache.ver !== version) convCache = { ver: version, map: new Map() };
  if (convCache.map.has(k)) return convCache.map.get(k);
  const list = arr((live().conversations || {})[k]).map(mapMsg);
  convCache.map.set(k, list);
  return list;
}

function needsYou() {
  return needsYouOf(recList());
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

// Pack live status from the base status plus live.packs overrides, exactly as the mock computed it.
function livePack(p) {
  const o = (live().packs || {})[p.id] || {};
  const base = p.baseStatus || p.status;
  return Object.assign({}, p, { status: packStatus(base, o), baseStatus: base });
}
function packs() { return packList().map(livePack); }
function pack(id) { const p = rawPack(id); return p ? livePack(p) : null; }

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
  designSubs.slice().forEach(fn => { try { fn(stateView(), cur); } catch (e) { console.error(e); } });
  if (current && current.def && typeof current.def.render === 'function') {
    try { current.def.render(cur); } catch (e) { console.error(e); }
  }
}

function on(fn) {
  if (typeof fn !== 'function') return () => {};
  designSubs.push(fn);
  return () => { designSubs = designSubs.filter(f => f !== fn); };
}

// ---------------------------------------------------------------- routes

function defaultRoute() {
  if (demoId() === 'fresh') return { name: 'onboarding', params: { step: stateView().onboardStep || minStep() } };
  return { name: 'home', params: {} };
}
// The cut Goals and Curve steps (1 and 2) land on Tell us (3).
const clampStep = n => onboardStepOf(n, { real: isReal() });

function normalizeRoute(r) {
  if (!r || !ROUTES.has(r.name)) return defaultRoute();
  // An old route (#/brief, #/accounts) lands on its new home.
  const moved = movedRoute(r);
  if (moved) return normalizeRoute(moved);
  const p = r.params || {};
  if (demoId() === 'fresh') {
    const step = r.name === 'onboarding' && p.step != null && p.step !== '' ? clampStep(Number(p.step)) : stateView().onboardStep;
    return { name: 'onboarding', params: { step } };
  }
  // A real store past first run reaches onboarding as Setup, landing on Tell us.
  if (r.name === 'onboarding') return isReal() ? { name: 'onboarding', params: { step: p.step != null && p.step !== '' ? clampStep(Number(p.step)) : minStep() } } : defaultRoute();
  if (r.name === 'rec') return p.id && rawRec(String(p.id)) ? { name: 'rec', params: { id: String(p.id) } } : { name: 'plan', params: {} };
  // The account dialog is a route like the rec dialog; an account that is gone lands on Money.
  if (r.name === 'account') return p.id && arr(S && S.accounts).some(a => a.id === String(p.id)) ? { name: 'account', params: { id: String(p.id) } } : { name: 'money', params: {} };
  if (r.name === 'confirm') return p.id && /^[1-9]\d*$/.test(String(p.id)) ? { name: 'confirm', params: { id: String(p.id) } } : { name: 'confirm', params: {} };
  if (r.name === 'ask') return p.id && rawThread(String(p.id)) ? { name: 'ask', params: { id: String(p.id) } } : { name: 'ask', params: {} };
  if (r.name === 'packs') return p.id && rawPack(String(p.id)) ? { name: 'packs', params: { id: String(p.id) } } : { name: 'packs', params: {} };
  // The P&L keeps its sort and filter as one state string; its rows dialog needs a spec.
  if (r.name === 'pnl') return p.state ? { name: 'pnl', params: { state: String(p.state) } } : { name: 'pnl', params: {} };
  if (r.name === 'pnlrows') return p.id ? { name: 'pnlrows', params: { id: String(p.id) } } : { name: 'pnl', params: {} };
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
  if (val != null && !QUERY_PARAM.has(name)) { try { val = decodeURIComponent(val); } catch (e) { /* keep raw */ } }
  return { name, params: key && val != null ? { [key]: val } : {} };
}

function routeHash(r) {
  if (!r) return '';
  const key = PARAM_KEY[r.name];
  const v = key && r.params ? r.params[key] : null;
  if (v == null || v === '') return '#/' + r.name;
  const enc = QUERY_PARAM.has(r.name) ? encodeURIComponent(v).replace(/%(25|26|2B|3D)/g, (m) => decodeURIComponent(m)) : encodeURIComponent(v);
  return '#/' + r.name + '/' + enc;
}

function urlWith(hash) {
  return window.location.pathname + window.location.search + hash;
}

function applyRoute(r, opts) {
  if (leaving) return false;
  opts = opts || {};
  const next = normalizeRoute(r);
  const h = routeHash(next);
  const changed = h !== routeHash(cur);
  cur = next;
  if (changed && opts.titleRepair !== false && next.name === 'ask' && next.params.id) refreshThreadTitle(next.params.id);
  routeStep = next.name === 'onboarding' ? next.params.step : null;
  stateCache.ver = -1;
  if (window.location.hash !== h) {
    if (opts.replace) {
      try { window.history.replaceState(null, '', urlWith(h)); } catch (e) { /* ignore */ }
    } else {
      suppressHash = h;
      window.location.hash = h;
    }
  }
  if (opts.silent) return changed;
  if (changed || opts.force) {
    closePopover();
    if (changed) { try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } }
    notify();
  }
  return changed;
}

function go(name, params, opts) {
  let p = params;
  if (p != null && typeof p !== 'object') p = { [PARAM_KEY[name] || 'id']: p };
  applyRoute({ name, params: p || {} }, { replace: !!(opts && opts.replace), silent: !!(opts && opts.silent), titleRepair: opts?.titleRepair });
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

// ---------------------------------------------------------------- API requests

let queue = Promise.resolve();
let errEl = null;
let lastError = '';

function hideError() {
  if (errEl) { errEl.remove(); errEl = null; }
}

function showError(message) {
  if (leaving) return;
  hideError();
  const el = document.createElement('div');
  el.className = 'fx-err';
  el.setAttribute('role', 'alert');
  const span = document.createElement('span');
  span.className = 'fx-err-t';
  span.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fx-err-x';
  btn.textContent = 'Dismiss';
  btn.addEventListener('click', hideError);
  el.appendChild(span);
  el.appendChild(btn);
  document.body.appendChild(el);
  errEl = el;
}

// The session is gone (a protected request answered 401, or boot found no identity): drop the
// household from memory and the page, then go to sign in. Runs once. `notice` is the code the
// sign-in page explains (null for a plain signed-out boot).
const NOTICE_KEY = 'fathom.auth.notice';
function signedOut(notice) {
  if (leaving) return;
  leaving = true;
  hideError();
  closePopover();
  unmountCurrent();
  S = null;
  version += 1;
  if (root) { root.className = ''; root.innerHTML = ''; }
  if (notice) { try { window.sessionStorage.setItem(NOTICE_KEY, notice); } catch (e) { /* the page still works */ } }
  try { window.location.replace(signInTarget(window.location.pathname, window.location.hash)); } catch (e) { /* ignore */ }
}

// A FormData body goes out as multipart with no content-type header (the browser sets the boundary).
async function postJson(path, body) {
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: form ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: form ? body : JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
  } catch (e) {
    throw new Error('The server could not be reached.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) signedOut('expired');
  if (!res.ok) {
    const err = new Error((data && typeof data.error === 'string' && data.error) || 'The server answered ' + res.status + '.');
    err.status = res.status;
    if (data && typeof data.code === 'string') err.code = data.code;
    throw err;
  }
  if (!data || !data.scenario || typeof data.scenario !== 'object') throw new Error('The server sent an unexpected reply.');
  return data;
}

// ---------------------------------------------------------------- streamed asks

const RECOVER_EVERY_MS = 1500;
const RECOVER_FOR_MS = 240000;

// One Server-Sent Events block -> { name, data } or null.
function parseEvent(block) {
  let name = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  try { return { name, data: JSON.parse(data.join('\n')) }; } catch (e) { return null; }
}

const broken = (key) => { const err = new Error('The answer stream broke.'); err.broken = true; err.key = key; return err; };

// POST asking for an event stream. Resolves the final body; rejects with err.status for a server
// error and err.broken (with err.key once the server named the conversation) when the stream
// ends or fails before a final or error event.
async function postStream(path, body, onEvent) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
  } catch (e) {
    throw broken(null);
  }
  if (res.status === 401) signedOut('expired');
  if (!/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && typeof data.error === 'string' && data.error) || 'The server answered ' + res.status + '.');
      err.status = res.status;
      throw err;
    }
    if (!data || !data.scenario || typeof data.scenario !== 'object') throw new Error('The server sent an unexpected reply.');
    return data;
  }
  let key = null;
  let buf = '';
  const dec = new TextDecoder();
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const ev = parseEvent(buf.slice(0, at));
        buf = buf.slice(at + 2);
        if (!ev) continue;
        if (ev.name === 'final') {
          if (ev.data && ev.data.scenario && typeof ev.data.scenario === 'object') return ev.data;
          throw broken(key);
        }
        if (ev.name === 'error') {
          const err = new Error((ev.data && typeof ev.data.error === 'string' && ev.data.error) || 'The server could not answer.');
          err.status = (ev.data && ev.data.status) || 500;
          throw err;
        }
        if (ev.name === 'start' && ev.data && typeof ev.data.key === 'string') key = ev.data.key;
        try { onEvent(ev.name, ev.data || {}); } catch (e) { /* a view error never breaks the stream */ }
      }
    }
  } catch (e) {
    if (e && (e.status || e.broken)) throw e;
  }
  throw broken(key);
}

const meTurns = (scenario, key) => arr(scenario && scenario.live && scenario.live.conversations && scenario.live.conversations[key])
  .filter(m => m && m.role === 'me').length;
// A thread's conversation key ('ask:<id>').
const threadKey = (th) => th.key || 'ask:' + th.id;
const threadIds = (scenario) => new Set(arr(scenario && scenario.live && scenario.live.threads).map(t => t && t.id));

// Reload the scenario until the asked conversation has the new turn: `key` with more owner
// messages than `before`, or (a new thread whose key never arrived) a thread not in `ids` that has
// a stored turn (a thread asked from a rec is inserted before its answer).
// Resolves { scenario, key } or null after RECOVER_FOR_MS.
async function recoverTurn({ key, before, ids }) {
  const until = Date.now() + RECOVER_FOR_MS;
  while (!leaving && Date.now() < until) {
    await new Promise(r => setTimeout(r, RECOVER_EVERY_MS));
    let next;
    try { next = await loadScenario(); } catch (e) { continue; }
    if (key && meTurns(next, key) > before) return { scenario: next, key };
    if (!key) {
      const fresh = arr(next.live && next.live.threads).find(t => t && t.id && !ids.has(t.id) && Number(t.turns) > 0);
      if (fresh) return { scenario: next, key: threadKey(fresh) };
    }
  }
  return null;
}

// Like send, over an event stream; a broken stream falls back to recoverTurn.
function sendStream(path, body, onEvent, onOk, key) {
  const run = () => {
    const before = key ? meTurns(S, key) : 0;
    const ids = threadIds(S);
    return postStream(path, body, onEvent).catch(err => {
      if (!err || !err.broken) throw err;
      try { onEvent('recovering', {}); } catch (e) { /* ignore */ }
      return recoverTurn({ key: err.key || key, before, ids }).then(got => {
        if (!got) throw new Error('The answer did not arrive in time. Reload the page to check for it.');
        return { scenario: got.scenario, recoveredKey: got.key };
      });
    }).then(
      data => {
        applyScenario(data.scenario);
        hideError();
        let out = data;
        try { out = onOk(data); } catch (e) { out = null; }
        notify();
        return out;
      },
      err => {
        showError('Could not get an answer. ' + (err && err.message ? err.message : ''));
        return null;
      }
    );
  };
  const p = queue.then(run);
  queue = p;
  return p;
}

// The newest Fathom message in `key`, mapped (a recovered answer has no message in the body).
function lastReply(key) {
  const list = conversation(key);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role !== 'me') return list[i];
  return null;
}

// { text } | { questionId } as the question part of a request body, or null when it is empty. A
// rec question id that is all digits is an index into rec.qa; starter ids stay strings.
const hasQid = o => o.questionId != null && o.questionId !== '';
const qidOf = v => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
function questionBody(q, numeric) {
  const o = q && typeof q === 'object' ? q : {};
  let body = null;
  if (hasQid(o)) body = { questionId: numeric ? qidOf(o.questionId) : String(o.questionId) };
  else {
    const text = String(o.text == null ? '' : o.text).trim();
    if (text) body = { text };
  }
  const context = body ? contextOf(o.context) : null;
  if (context) body.context = context;
  return body;
}

// The references a question carries (items the owner pointed at): { kind, id } string pairs, at
// most 8, or null for none. The design shapes them; only kind and id go on the wire.
function contextOf(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const r of raw) {
    if (out.length >= 8) break;
    if (r && typeof r === 'object' && typeof r.kind === 'string' && r.kind && typeof r.id === 'string' && r.id) out.push({ kind: r.kind, id: r.id });
  }
  return out.length ? out : null;
}

// The new-thread body: the question plus recId when the thread is asked from a rec.
function threadBody(q) {
  const o = q && typeof q === 'object' ? q : {};
  const recId = typeof o.recId === 'string' && o.recId ? o.recId : null;
  const body = questionBody(o, !!recId);
  if (!body) return null;
  if (recId) body.recId = recId;
  return body;
}

// The rec of the rec route, or null.
const routeRecId = () => (cur && cur.name === 'rec' && cur.params && cur.params.id ? String(cur.params.id) : null);

function askStream(q, convKey, onEvent) {
  const body = questionBody(q, true);
  if (!body) return done();
  const key = convKey || activeKey();
  if (!key) return newThreadStream({ ...body, recId: routeRecId() }, onEvent);
  if (key.startsWith('pack:') && !rawPack(key.slice(5))) return done();
  const cb = typeof onEvent === 'function' ? onEvent : () => {};
  return sendStream('/api/ask', { key, ...body }, cb, d => (d.message ? mapMsg(d.message) : d.recoveredKey ? lastReply(key) : null), key);
}

function newThreadStream(q, onEvent) {
  const body = threadBody(q);
  if (!body) return done();
  const cb = typeof onEvent === 'function' ? onEvent : () => {};
  return sendStream('/api/threads', body, cb, d => {
    let th = d.thread && typeof d.thread === 'object' ? d.thread : null;
    if (!th && d.recoveredKey) th = rawThread(d.recoveredKey.replace(/^ask:/, ''));
    if (th && th.id && cur && cur.name === 'ask' && !(cur.params && cur.params.id)) go('ask', { id: th.id }, { replace: true, titleRepair: false });
    const key = th ? threadKey(th) : null;
    return { thread: th, message: d.message ? mapMsg(d.message) : key ? lastReply(key) : null };
  });
}

// Swap in a new scenario and keep the route valid for it (for example onboarding finishing).
function applyScenario(next) {
  if (leaving) return;
  S = next;
  version += 1;
  if (cur) {
    const before = routeHash(cur);
    applyRoute(cur, { replace: true, silent: true });
    if (routeHash(cur) !== before) {
      closePopover();
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    }
  }
}

// POST in order; on success replace the scenario and notify; on failure keep the old state.
// Resolves with onOk(data) or null; never rejects.
function send(path, body, onOk, onDone, failText) {
  const run = () => postJson(path, body).then(
    data => {
      if (onDone) onDone();
      applyScenario(data.scenario);
      hideError();
      lastError = '';
      let out = data;
      try { out = onOk ? onOk(data) : data; } catch (e) { out = null; }
      notify();
      return out;
    },
    err => {
      if (onDone) { onDone(); notify(); }
      lastError = (err && err.message) ? err.message : 'The server could not complete that.';
      showError((failText || 'Could not save that change. ') + lastError);
      return null;
    }
  );
  const p = queue.then(run);
  queue = p;
  return p;
}

// Like send, for changes the server may refuse as final: resolves { item } on success and
// { final: message } on a 409 without the error line. Other failures show the error line and
// resolve null.
function sendFinal(path, body) {
  const run = () => postJson(path, body).then(
    data => {
      applyScenario(data.scenario);
      hideError();
      notify();
      return { item: data.item || null };
    },
    err => {
      if (err && err.status === 409) return { final: err.message };
      showError('Could not save that change. ' + (err && err.message ? err.message : ''));
      return null;
    }
  );
  const p = queue.then(run);
  queue = p;
  return p;
}

const done = v => Promise.resolve(v === undefined ? null : v);

// ---------------------------------------------------------------- actions

const ACTIONS = new Set(['start', 'complete', 'dismiss', 'snooze', 'reopen']);

function act(recId, action, arg) {
  const r = rawRec(recId);
  if (!r || r.status === 'hidden') return done();
  if (r.question?.primary && (action === 'complete' || action === 'task')) return done();
  const body = { action };
  if (action === 'task') {
    const i = Number(arg);
    if (!Number.isInteger(i) || i < 0 || i >= arr(r.tasks).length) return done();
    body.arg = i;
  } else if (action === 'owner') {
    // Who acts on the rec; the server records it as an owner override.
    if (!isOwner(arg)) return done();
    body.arg = arg;
  } else {
    if (!ACTIONS.has(action)) return done();
    if (action === 'snooze') body.arg = arg != null && arg !== '' ? String(arg) : 'Next month';
  }
  return send('/api/recs/' + encodeURIComponent(recId) + '/action', body);
}

// The conversation the current route asks into: the rec's attached thread on the rec route (null
// when it has none: the next question starts a thread asked from the rec), the pack's What if
// thread, or the open Ask thread.
function activeKey() {
  const recId = routeRecId();
  if (recId) {
    const th = recThread(recId);
    return th ? threadKey(th) : null;
  }
  if (cur && cur.name === 'packs' && cur.params && cur.params.id) return 'pack:' + cur.params.id;
  if (cur && cur.name === 'ask' && cur.params && cur.params.id) {
    const th = rawThread(cur.params.id);
    if (th) return threadKey(th);
  }
  return null;
}

// opts.context: references for the question (see contextOf), sent only when there are any.
function ask(questionId, convKey, opts) {
  if (questionId == null || questionId === '') return done();
  const context = contextOf(opts && opts.context);
  const key = convKey || activeKey();
  if (!key) return newThread({ questionId: String(questionId), recId: routeRecId(), context });
  return send('/api/ask', { key, questionId: qidOf(questionId), ...(context ? { context } : {}) }, d => (d.message ? mapMsg(d.message) : null));
}

function askFree(text, convKey, opts) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return done();
  const context = contextOf(opts && opts.context);
  const key = convKey || activeKey();
  if (!key) return newThread({ text: clean, recId: routeRecId(), context });
  if (key.startsWith('pack:') && !rawPack(key.slice(5))) return done();
  return send('/api/ask', { key, text: clean, ...(context ? { context } : {}) }, d => (d.message ? mapMsg(d.message) : null));
}

// ---------------------------------------------------------------- Ask threads

const THREAD_ACTS = new Set(['archive', 'trash', 'restore', 'delete']);

function threads() {
  return threadList().slice();
}

function blockStatus(id) {
  return getRead('/api/threads/' + encodeURIComponent(id) + '/blocks');
}

async function refreshThreadTitle(id) {
  const before = rawThread(id);
  const data = await getRead('/api/threads/' + encodeURIComponent(id));
  const current = rawThread(id);
  if (!data?.thread || !before || !current || current.title !== before.title || current.titleSource !== before.titleSource) return;
  if (current.title === data.thread.title && current.titleSource === data.thread.titleSource) return;
  current.title = data.thread.title;
  current.titleSource = data.thread.titleSource;
  notify();
}

function askStarters() {
  return arr(live().askStarters).filter(s => s && s.id != null && typeof s.q === 'string');
}

// Creates a thread and asks its first question. When the owner is still on #/ask, the new thread
// replaces that history entry, so Back leaves the Ask page instead of reopening an empty composer.
function newThread(q) {
  const body = threadBody(q);
  if (!body) return done();
  return send('/api/threads', body, d => {
    const th = d.thread && typeof d.thread === 'object' ? d.thread : null;
    if (th && th.id && cur && cur.name === 'ask' && !(cur.params && cur.params.id)) go('ask', { id: th.id }, { replace: true, titleRepair: false });
    return { thread: th, message: d.message ? mapMsg(d.message) : null };
  });
}

// The thread the rec's dialog shows: newest lastAt among the rec's threads that are neither trashed
// nor detached by Start over (an archived one still counts), or null.
function recThread(recId) {
  if (recId == null || recId === '') return null;
  const id = String(recId);
  let best = null;
  for (const th of threadList()) {
    if (!th || th.recId !== id || th.trashedAt || th.recDetachedAt) continue;
    if (!best || String(th.lastAt || '') > String(best.lastAt || '')) best = th;
  }
  return best;
}

// Start over: detach every thread of the rec from its dialog; the threads stay in Ask.
function startOver(recId) {
  if (!rawRec(String(recId == null ? '' : recId))) return done();
  return send('/api/recs/' + encodeURIComponent(recId) + '/start-over', {});
}

function threadAct(id, action) {
  if (id == null || id === '' || !THREAD_ACTS.has(action) || !rawThread(String(id))) return done();
  return send('/api/threads/' + encodeURIComponent(id) + '/' + action, {}, d => (d.thread && typeof d.thread === 'object' ? d.thread : null));
}

function renameThread(id, title) {
  const clean = String(title == null ? '' : title).trim().replace(/\s+/g, ' ');
  if (id == null || id === '' || !clean || !rawThread(String(id))) return done();
  return send('/api/threads/' + encodeURIComponent(id) + '/rename', { title: clean }, d => (d.thread && typeof d.thread === 'object' ? d.thread : null));
}

function whatIf(id) {
  const p = rawPack(id);
  if (!p || !p.whatIf) return done();
  return send('/api/packs/' + encodeURIComponent(id) + '/whatif', {});
}

function packToggle(id) {
  if (!rawPack(id)) return done();
  return send('/api/packs/' + encodeURIComponent(id) + '/toggle', {}, d => {
    if (typeof d.status === 'string') return d.status;
    const p = pack(id);
    return p ? p.status : null;
  });
}

// Decide on the picked point of an open war-game decision, or reopen a decided one.
function decide(decisionId, idx) {
  const body = idx == null ? {} : { index: idx };
  return send('/api/decisions/' + encodeURIComponent(decisionId) + '/decide', body, null, null, 'Could not save that decision. ');
}

function revisit(decisionId) {
  return send('/api/decisions/' + encodeURIComponent(decisionId) + '/revisit', {}, null, null, 'Could not reopen that decision. ');
}

function scenarioPick(name, idx) {
  if (name !== 'salary' && name !== 'deferral') return done();
  const w = S && S.wargame && S.wargame[name];
  if (!w) return done();
  const list = arr(name === 'salary' ? w.points : w.options);
  const i = typeof idx === 'string' && !/^\d+$/.test(idx) ? list.findIndex(x => x && x.id === idx) : Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return done();
  pendingPicks[name] = i;
  notify();
  return send('/api/wargame/' + name + '/pick', { index: i }, null, () => {
    if (pendingPicks[name] === i) delete pendingPicks[name];
  });
}

function onboard(step) {
  const n = Number(step);
  if (!Number.isFinite(n)) return done();
  if (n > LAST_STEP) return send('/api/onboarding', { step: LAST_STEP + 1 });
  const s = clampStep(n);
  routeStep = s;
  go('onboarding', { step: s });
  return send('/api/onboarding', { step: s });
}

// ---------------------------------------------------------------- goals and the curve

// Resolve with the saved goal (or true for a delete), or null on failure (error line shown).
function accountRename(id, displayName) {
  if (id == null || id === '') return done();
  return send('/api/accounts/' + encodeURIComponent(id) + '/name', { displayName: displayName ?? '' }, d => d.account || null, null, 'Could not rename that account. ');
}

// The signed-in user finished or dismissed the guided tour: clear their server-side flag.
function tourSeen() {
  return send('/api/tour/seen', {}, null, null, 'Could not save that the tour is done. ');
}

function preferenceSave(id, text) {
  return send('/api/preferences' + (id ? '/' + encodeURIComponent(id) : ''), { text });
}

function preferenceDelete(id) {
  return send('/api/preferences/' + encodeURIComponent(id) + '/delete', {});
}

function blockAct(threadId, messageId, blockId, body) {
  return send('/api/threads/' + encodeURIComponent(threadId) + '/messages/' + encodeURIComponent(messageId) + '/blocks/' + encodeURIComponent(blockId) + '/act', body,
    d => d.message || null, null, 'Could not save that choice. ');
}

function actionUndo(id) {
  return send('/api/actions/' + encodeURIComponent(id) + '/undo', {}, null, null, 'Could not undo that change. ');
}

// Confirm or decline (decision) the stored proposal on message `messageId` ('m<id>') in Ask thread
// `threadId`; the fresh scenario carries the thread's new messages. Resolves the reply or null.
function proposalDecide(threadId, messageId, decision) {
  if (threadId == null || threadId === '' || !/^m\d+$/.test(String(messageId)) || (decision !== 'confirm' && decision !== 'decline')) return done();
  return send('/api/threads/' + encodeURIComponent(threadId) + '/proposals/' + encodeURIComponent(messageId), { decision },
    d => (d.message ? mapMsg(d.message) : null), null, 'Could not save that decision. ');
}

function goalCreate(fields) {
  if (!fields || typeof fields !== 'object') return done();
  return send('/api/goals', fields, d => d.goal || null, null, 'Could not save that goal. ');
}

function goalUpdate(id, fields) {
  if (id == null || id === '' || !fields || typeof fields !== 'object') return done();
  return send('/api/goals/' + encodeURIComponent(id), fields, d => d.goal || null, null, 'Could not save that goal. ');
}

// Undo a target Fathom set: { action: 'undo' }. Resolves with the
// reply, or null on failure (error line shown).
function goalSuggestion(id, body) {
  if (id == null || id === '' || !body || typeof body !== 'object') return done();
  return send('/api/goals/' + encodeURIComponent(id) + '/suggestion', body, null, null, 'Could not change that suggestion. ');
}

function goalArchive(id, archived) {
  if (id == null || id === '') return done();
  return send('/api/goals/' + encodeURIComponent(id) + '/archive', { archived: archived !== false }, d => d.goal || null);
}

function goalDelete(id) {
  if (id == null || id === '') return done();
  return send('/api/goals/' + encodeURIComponent(id) + '/delete', {}, () => true);
}

// A tradeoff curve or onboarding priority position, 0 to 1.
function setCurve(id, value) {
  const v = Number(value);
  if (id == null || id === '' || !Number.isFinite(v) || v < 0 || v > 1) return done();
  return send('/api/curve', { id: String(id), value: Math.round(v * 100) / 100 });
}

// Saves the Tell us note through the ingest pipeline. Resolves { understood, file } (what the
// note added: facts, goals, open questions; waiting when the engine is off), or null on failure.
function saveNotes(text) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return done();
  return send('/api/onboarding/notes', { text: clean }, d => (d.understood && typeof d.understood === 'object' ? { understood: d.understood, file: d.file || null } : null), null, 'Could not save your note. ');
}

// What the store holds about the household, for the "what we heard" step: { sections, deadlines,
// pending, empty }. Derived on the server from stored facts and accounts, with provenance.
function heard() {
  const h = live().heard;
  return h && typeof h === 'object' ? h : { sections: [], deadlines: 0, pending: 0, empty: true };
}

function setEngine(v) {
  return send('/api/engine', { on: !!v });
}

// The monthly engine cap in dollars, 0 to 10000, rounded to cents. Checked here first so an
// invalid value shows the error line without a request (the server keeps its own 400 check).
function setCap(usd) {
  const n = typeof usd === 'number' ? usd : (usd == null || usd === '' ? NaN : Number(usd));
  if (!Number.isFinite(n) || n < 0 || n > 10000) {
    showError('Enter a monthly cap between 0 and 10,000 dollars.');
    return done();
  }
  return send('/api/engine/cap', { usd: Math.round(n * 100) / 100 }, d => d);
}

// POST /api/jobs/plan/run (an owner or administrator session, as the route requires). Resolves
// { res, error }: the run response, or the server's plain message. It never shows the error line;
// the Engine screen words the outcome beside the button.
function runPlan() {
  const run = () => postJson('/api/jobs/plan/run', {}).then(
    data => { applyScenario(data.scenario); hideError(); notify(); return { res: data, error: '' }; },
    err => ({ res: null, error: (err && err.message) || 'The server could not complete that.' })
  );
  const p = queue.then(run);
  queue = p;
  return p;
}

function buildYourPlans(fileIds) {
  const ids = arr(fileIds).filter(x => x != null && x !== '').map(String);
  return send('/api/your-plans/build', { fileIds: ids }, d => (d.result && typeof d.result === 'object' ? d.result : null));
}

// GET a JSON read that never touches the scenario or the error line: the parsed body, or null on
// any failure (a 401 still sends the page to sign-in).
async function getRead(path) {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) signedOut('expired');
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

// One account's dialog data, or null.
function accountDetail(id) {
  if (id == null || id === '') return Promise.resolve(null);
  return getRead('/api/accounts/' + encodeURIComponent(id));
}

// One page of an account's transactions: opts { q, from, to, limit, cursor }. Resolves the page, with
// its figures and sources registered for the provenance popover, or null.
async function accountTransactions(id, opts) {
  if (id == null || id === '') return null;
  const qs = new URLSearchParams();
  for (const k of ['q', 'from', 'to', 'limit', 'cursor']) {
    const v = opts && opts[k];
    if (v != null && v !== '') qs.set(k, String(v));
  }
  const page = await getRead('/api/accounts/' + encodeURIComponent(id) + '/transactions' + (qs.size ? '?' + qs : ''));
  if (!page || !Array.isArray(page.items)) return null;
  registerExtra(page);
  return page;
}

// Ask block figures (web/horizon/screens/ask-blocks.js): { key: { value, unit, label, kind, asOf,
// source, gaps, provenance, quote?, detail? } } kept beside the scenario's under their blk: keys, each with
// its own source entry, so api.fig and the popover read them like any other figure.
function registerFigures(map) {
  if (!map || typeof map !== 'object') return;
  for (const [k, e] of Object.entries(map)) {
    if (!e || typeof e !== 'object' || !String(k).startsWith('blk:')) continue;
    const src = 'blk-src:' + k;
    const provenance = e.provenance && typeof e.provenance === 'object' && !Array.isArray(e.provenance) ? e.provenance : {};
    // Assumptions the figure was computed under read as the popover's Assumes rows.
    const notes = arr(provenance.assumptions).map(a => (a && typeof a.stated === 'string' ? a.stated : '')).filter(Boolean);
    extraFig.set(k, { v: e.value ?? null, unit: typeof e.unit === 'string' ? e.unit : 'usd', label: e.label || '', kind: e.kind || 'e', src,
      gaps: arr(e.gaps), provenance, ...(notes.length ? { notes } : {}), ...(e.stale ? { stale: true } : {}),
      // Plain { k, v } lines the popover lists, such as a transaction's raw bank text.
      ...(Array.isArray(e.detail) && e.detail.length ? { detail: e.detail } : {}) });
    extraSrc.set(src, { label: e.source || '', asOf: e.asOf || '' });
  }
}

// Keep a fetched response's figures and sources for api.fig and the provenance popover.
function registerExtra(page) {
  for (const [k, f] of Object.entries(page.figures || {})) if (f && typeof f === 'object') extraFig.set(k, f);
  for (const [k, s] of Object.entries(page.sources || {})) if (s && typeof s === 'object') extraSrc.set(k, s);
}

// A query string from opts: the named keys that are set; arrays are joined with commas.
function readQuery(opts, keys) {
  const qs = new URLSearchParams();
  for (const k of keys) {
    let v = opts && opts[k];
    if (Array.isArray(v)) v = v.filter(x => x != null && x !== '').join(',');
    if (v != null && v !== '') qs.set(k, String(v));
  }
  return qs.size ? '?' + qs : '';
}

// A P&L or spending read with its figures registered, or null. ok(body) says the body has the
// expected shape.
async function figRead(path, opts, keys, ok) {
  const body = await getRead(path + readQuery(opts, keys));
  if (!body || !ok(body)) return null;
  registerExtra(body);
  return body;
}

const pnl = opts => figRead('/api/pnl', opts, ['entity', 'from', 'to'], b => Array.isArray(b.entities));
const pnlRows = opts => figRead('/api/pnl/rows', opts, ['entity', 'from', 'to', 'section', 'category', 'month'], b => Array.isArray(b.items));
const spending = opts => figRead('/api/spending', opts, ['from', 'to', 'include', 'exclude'], b => !!b.spending && typeof b.spending === 'object');
const spendingRows = opts => figRead('/api/spending/rows', opts, ['from', 'to', 'include', 'exclude', 'bucket', 'category', 'month'], b => Array.isArray(b.items));

// An account dialog edit: resolves { data } with the whole reply (its scenario applied) or
// { error: message, status } on a refusal or failure. The dialog shows the error inline, so the
// page's error line stays hidden.
function sendAccountEdit(path, body) {
  const run = () => postJson(path, body).then(
    data => {
      applyScenario(data.scenario);
      hideError();
      notify();
      return { data };
    },
    err => ({ error: (err && err.message) || 'The server could not complete that.', status: (err && err.status) || 0 })
  );
  const p = queue.then(run);
  queue = p;
  return p;
}

const accountPath = (id, tail) => '/api/accounts/' + encodeURIComponent(id) + '/' + tail;
const noAccount = () => done({ error: 'No account was given.', status: 0 });

// The account's last 4 digits (exactly four, checked again on the server), or { undo: before } from
// an earlier reply.
function accountMask(id, mask) {
  if (id == null || id === '') return noAccount();
  if (mask && typeof mask === 'object') return sendAccountEdit(accountPath(id, 'mask'), mask);
  return sendAccountEdit(accountPath(id, 'mask'), { mask: String(mask ?? '') });
}

// Owner or kind: body is { owner } or { kind }, or { undo: before } from an earlier reply.
function accountOwner(id, body) {
  if (id == null || id === '' || !body || typeof body !== 'object') return noAccount();
  return sendAccountEdit(accountPath(id, 'owner'), body);
}

function accountKind(id, body) {
  if (id == null || id === '' || !body || typeof body !== 'object') return noAccount();
  return sendAccountEdit(accountPath(id, 'kind'), body);
}

// The accounts this one could merge with, each with what a merge would keep and move, or null.
function accountMergeCandidates(id) {
  if (id == null || id === '') return Promise.resolve(null);
  return getRead(accountPath(id, 'merge-candidates'));
}

// Merge another account into this pair; the reply names the survivor and the confirm item whose
// reopen undoes it.
function accountMerge(id, withId) {
  if (id == null || id === '' || withId == null || withId === '') return noAccount();
  return sendAccountEdit(accountPath(id, 'merge'), { withId: String(withId) });
}

async function packEntry(packId, entryId) {
  if (packId == null || entryId == null || packId === '' || entryId === '') return null;
  try {
    const res = await fetch('/api/packs/' + encodeURIComponent(packId) + '/entries/' + encodeURIComponent(entryId), {
      headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store',
    });
    if (res.status === 401) signedOut('expired');
    if (!res.ok) return null;
    const data = await res.json();
    const e = data && data.entry;
    if (!e || typeof e !== 'object' || typeof e.body !== 'string') return null;
    return { id: String(e.id == null ? entryId : e.id), title: String(e.title || ''), body: e.body, cites: arr(e.cites) };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- ingest

const emptyIngest = () => ({ pending: 0, items: [], decided: [], files: [], waiting: [], sources: [], accounts: {}, staleNotes: [], formats: [] });

function ingest() {
  const g = live().ingest;
  if (!g || typeof g !== 'object') return emptyIngest();
  const out = emptyIngest();
  out.pending = Number.isFinite(Number(g.pending)) ? Number(g.pending) : 0;
  ['items', 'decided', 'files', 'waiting', 'sources', 'staleNotes', 'formats'].forEach(k => { out[k] = arr(g[k]); });
  if (g.accounts && typeof g.accounts === 'object') out.accounts = g.accounts;
  return out;
}

// SimpleFIN Bridge: connect with a setup token (the token goes only in this request body), Sync
// now (the simplefin-sync job under the lease) and Disconnect. Each resolves the response or null.
function simplefinConnect(token) {
  return send('/api/simplefin/connect', { token: String(token || '') }, d => d, null, 'Could not connect accounts. ');
}
function simplefinSync() {
  return send('/api/jobs/simplefin-sync/run', {}, d => d, null, 'Could not sync accounts. ');
}
function simplefinDisconnect() {
  return send('/api/simplefin/disconnect', {}, d => d, null, 'Could not disconnect. ');
}

// Resolves { files, pending } with the per-file results, or null on failure (error line shown).
function upload(fileList) {
  const list = Array.from(fileList || []);
  if (!list.length) return done();
  const form = new FormData();
  list.forEach(f => form.append('files', f, f.name));
  return send('/api/files', form, d => ({ files: arr(d.files), pending: Number(d.pending) || 0 }), null, 'Could not add those files. ');
}

// A failed answer POST is retried once only when the server confirms the first attempt did not
// land: a network error or a 502, 503 or 504 (a proxy that lost the connection) re-reads the item,
// and only a still pending item is posted again. An item answered with this option meanwhile
// landed; any other state is reported stale. Never a blind second POST.
const RETRY_STATUS = new Set([502, 503, 504]);
const retryable = err => !!err && (err.status == null || RETRY_STATUS.has(err.status));

async function confirmItemNow(id) {
  try {
    const res = await fetch('/api/confirm/' + encodeURIComponent(id), { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) signedOut('expired');
    if (!res.ok) return null;
    const d = await res.json();
    return d && d.item && typeof d.item === 'object' ? d.item : null;
  } catch (e) {
    return null;
  }
}

// Re-read the scenario after an answer whose reply was lost or refused as stale.
async function refetchScenario() {
  try {
    applyScenario(await loadScenario());
  } catch (e) { /* keep the old state */ }
  notify();
}

// Resolves { item } on success, { stale: true } when the question changed since it was asked (the
// scenario is refetched first) and null on any other failure (error line shown). Never rejects.
function answer(id, optionId) {
  if (id == null || id === '' || optionId == null || optionId === '') return done();
  const path = '/api/confirm/' + encodeURIComponent(id) + '/answer';
  const body = { answer: String(optionId) };
  const stale = async () => { hideError(); await refetchScenario(); return { stale: true }; };
  const fail = err => {
    showError('Could not save that change. ' + (err && err.message ? err.message : ''));
    return null;
  };
  const run = async () => {
    let data;
    try {
      data = await postJson(path, body);
    } catch (err) {
      if (err && err.status === 409 && err.code === 'stale') return stale();
      if (!retryable(err)) return fail(err);
      const now = await confirmItemNow(id);
      if (!now) return fail(err);
      if (now.status === 'answered') {
        if (String(now.answer) !== String(optionId)) return stale();
        hideError();
        await refetchScenario();
        return { item: now };
      }
      try {
        data = await postJson(path, body);
      } catch (again) {
        if (again && again.status === 409 && again.code === 'stale') return stale();
        return fail(again);
      }
    }
    applyScenario(data.scenario);
    hideError();
    notify();
    return { item: data.item || null };
  };
  const p = queue.then(run);
  queue = p;
  return p;
}

// Change an answered question to another option.
function reviseAnswer(id, optionId) {
  if (id == null || id === '' || optionId == null || optionId === '') return done();
  return sendFinal('/api/confirm/' + encodeURIComponent(id) + '/answer', { answer: String(optionId), revise: true });
}

// Put an answered question back to pending.
function reopenAnswer(id) {
  if (id == null || id === '') return done();
  return sendFinal('/api/confirm/' + encodeURIComponent(id) + '/reopen', {});
}

// A batch confirm POST: resolves { items } on success, { stale: true } when the server refused it
// as stale or already answered (the scenario is refetched first), { final: message } on any other
// 409 refusal (an undo that a final answer blocks; no error line) and null on any other failure
// (error line shown). Never rejects.
const STALE_CODES = new Set(['stale', 'answered', 'not_found', 'not_answered']);
function sendMany(path, body) {
  const run = async () => {
    let data;
    try {
      data = await postJson(path, body);
    } catch (err) {
      if (err && err.status === 409 && STALE_CODES.has(err.code)) {
        hideError();
        await refetchScenario();
        return { stale: true };
      }
      if (err && err.status === 409) return { final: err.message };
      showError('Could not save that change. ' + (err && err.message ? err.message : ''));
      return null;
    }
    applyScenario(data.scenario);
    hideError();
    notify();
    return { items: arr(data.items) };
  };
  const p = queue.then(run);
  queue = p;
  return p;
}

// Answer several pending questions at once: list is [{ id, answer }]. One transaction on the server.
function answerMany(list) {
  const answers = arr(list)
    .filter(a => a && a.id != null && a.id !== '' && a.answer != null && a.answer !== '')
    .map(a => ({ id: Number(a.id), answer: String(a.answer) }));
  if (!answers.length) return done();
  return sendMany('/api/confirm/answers', { answers });
}

// Put several answered questions back to pending in one transaction (a group undo).
function reopenMany(ids) {
  const list = arr(ids).filter(id => id != null && id !== '').map(Number);
  if (!list.length) return done();
  return sendMany('/api/confirm/reopen-many', { ids: list });
}

// Mark an expected year-end document not needed this year (reason text), or clear the mark (null).
function yearendMark(year, key, reason) {
  if (!key) return done();
  return send('/api/yearend/marks', { year, key, reason: reason == null ? null : String(reason) }, d => d);
}

// Sources on the Files page. Each resolves { receipt } (null when nothing changed) with the
// scenario applied, or null on failure (error line shown). Undo is api.actionUndo(receipt.id).
function archiveAccount(id, archived = true) {
  if (id == null || id === '') return done();
  return send(accountPath(id, 'archive'), { archived: archived !== false }, d => ({ receipt: d.receipt || null }), null, 'Could not change that account. ');
}

function removeFile(id) {
  if (id == null || id === '') return done();
  return send('/api/files/' + encodeURIComponent(id) + '/remove', {}, d => ({ receipt: d.receipt || null }), null, 'Could not remove that file. ');
}

function retryFile(id) {
  if (id == null || id === '') return done();
  return send('/api/files/' + encodeURIComponent(id) + '/retry', {}, d => d.file || null);
}

// Approve ('approve', evidence 'Looks right') or correct in the owner's own words ('correct') one
// version of a staged import proposal. Resolves the review result ({status: 'imported', counts,
// receipt} or {status: 'queued'}) with the scenario applied, or null on failure (error line shown).
function reviewImport(id, version, decision, evidence) {
  if (id == null || id === '' || !Number.isSafeInteger(version) || version <= 0 || (decision !== 'approve' && decision !== 'correct')
    || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 4000) return done();
  return send('/api/import-proposals/' + encodeURIComponent(id) + '/review', { version, decision, evidence }, d => d, null, 'Could not save that review. ');
}

// Advisor workflow (item 24). Each resolves with a truthy value on success, null on failure.
function sendToAdvisor(recId) {
  if (recId == null || recId === '') return done();
  return send('/api/advisor/reviews', { recId: String(recId) }, () => true);
}

function advisorVerdict(reviewId, verdict, note, date) {
  return send('/api/advisor/reviews/' + encodeURIComponent(reviewId) + '/verdict', { verdict, note, date }, () => true);
}

function advisorCheckin(date, time, lengthMin) {
  return send('/api/advisor/checkin', { date, time, lengthMin }, () => true);
}

function advisorPacket() {
  return send('/api/advisor/packets', {}, d => d.packetId || null, null, 'Could not prepare the packet. ');
}

const api = {
  get s() { return S; },
  get state() { return stateView(); },
  get route() { return cur; },
  go,
  on,
  t,
  txt,
  fig: figOf,
  src: srcOf,
  money,
  recs: () => recList().filter(r => r.status !== 'hidden'),
  rec: id => rawRec(id),
  needsYou,
  verdict,
  act,
  answerRec: (id, answers) => send('/api/recs/' + encodeURIComponent(id) + '/answers', { answers }),
  ask,
  askFree,
  askStream,
  conversation,
  threads,
  blockStatus,
  askStarters,
  newThread,
  newThreadStream,
  recThread,
  startOver,
  threadAct,
  renameThread,
  scenarioPick,
  decide,
  revisit,
  onboard,
  accountRename,
  accountDetail,
  accountTransactions,
  pnl,
  pnlRows,
  spending,
  spendingRows,
  preferenceSave,
  tourSeen,
  preferenceDelete,
  actionUndo, blockAct,
  proposalDecide,
  accountMask,
  accountOwner,
  accountKind,
  accountMergeCandidates,
  accountMerge,
  goalCreate,
  goalUpdate,
  goalSuggestion,
  goalArchive,
  goalDelete,
  setCurve,
  saveNotes,
  heard,
  engineOn: () => !!live().engine,
  setEngine,
  setCap,
  runPlan,
  demo: demoId,
  packs,
  pack,
  whatIf,
  packToggle,
  packEntry,
  buildYourPlans,
  ingest,
  identity: () => (IDENT ? { ...IDENT } : null),
  upload,
  simplefinConnect,
  simplefinSync,
  simplefinDisconnect,
  showError,
  answer,
  reviseAnswer,
  reopenAnswer,
  answerMany,
  reopenMany,
  retryFile,
  reviewImport,
  archiveAccount,
  removeFile,
  yearendMark,
  refresh: refetchScenario,
  sendToAdvisor,
  advisorVerdict,
  advisorCheckin,
  advisorPacket,
  lastError: () => lastError,
  registerFigures,
  figPopover: el => openPopover(el),
  setFigAction: fn => { figAction = typeof fn === 'function' ? fn : null; },
};

// ---------------------------------------------------------------- figure popover

let pop = null;   // { el, anchor }
let figAction = null;   // the design's Add to chat handler, or null

// A figure's value as the popover writes it. A figure without a unit (the scenario's) is money; a
// unit-tagged one (an Ask block figure) is written by its unit, and a null one reads Unavailable.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNIT_WORD = { months: 'month', years: 'year', days: 'day' };
const PER_UNIT = { usd_per_month: ' a month', usd_per_year: ' a year' };
function popValue(f) {
  if (!f.unit) return moneyCents(f.v);
  if (f.v === null || f.v === undefined) return 'Unavailable';
  if (f.unit === 'date') {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(f.v));
    return m ? (m[3] ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : MONTHS[Number(m[2]) - 1] + ' ' + m[1]) : String(f.v);
  }
  const n = Number(f.v);
  if (f.unit in PER_UNIT || f.unit === 'usd') return moneyCents(n) + (PER_UNIT[f.unit] || '');
  const sig = x => String(Number(Number(x).toPrecision(6)));
  if (f.unit === 'ratio') return sig(n * 100) + '%';
  if (f.unit === 'age') return Number.isInteger(n) ? String(n) : Math.trunc(n) + ' and a half';
  if (UNIT_WORD[f.unit]) return sig(n) + ' ' + UNIT_WORD[f.unit] + (n === 1 ? '' : 's');
  return sig(n);
}

function closePopover() {
  if (pop) { pop.el.remove(); pop = null; }
}

// fromKey: opened with Enter or Space on the figure, so focus moves into the popover.
function openPopover(anchor, fromKey) {
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
    '<div class="fx-pop-val">' + esc(popValue(f)) + '</div>' +
    '<div class="fx-pop-row"><span class="fx-pop-k">Source</span><span class="fx-pop-v">' + esc(src.label) + '</span></div>' +
    (src.asOf ? '<div class="fx-pop-row"><span class="fx-pop-k">As of</span><span class="fx-pop-v">' + esc(src.asOf) + '</span></div>' : '') +
    '<div class="fx-pop-row"><span class="fx-pop-k">Kind</span><span class="fx-pop-v">' + esc(kind) + '</span></div>' +
    // An Ask block figure: why it is unavailable or incomplete, and whether its data changed since.
    (Array.isArray(f.gaps) ? f.gaps.filter(g => g && typeof g.message === 'string' && g.message).map(g =>
      '<div class="fx-pop-row"><span class="fx-pop-k">' + (f.v == null ? 'Why' : 'Gap') + '</span><span class="fx-pop-v">' + esc(g.message) + '</span></div>').join('') : '') +
    (f.stale ? '<div class="fx-pop-row"><span class="fx-pop-k">Note</span><span class="fx-pop-v">Changed since this answer</span></div>' : '') +
    // Kept only for reference (R2-9), then readable assumptions (MGN1); both are stored plain text.
    (typeof f.unavailable === 'string' && f.unavailable ? '<div class="fx-pop-row"><span class="fx-pop-k">Not current</span><span class="fx-pop-v">' + esc(f.unavailable) + '</span></div>' : '') +
    (Array.isArray(f.notes) ? f.notes.filter(n => typeof n === 'string').map(n => '<div class="fx-pop-row"><span class="fx-pop-k">Assumes</span><span class="fx-pop-v">' + esc(n) + '</span></div>').join('') : '') +
    // What an aggregate counts (accounts, months, rows), as plain text pairs.
    (Array.isArray(f.detail) ? f.detail.filter(d => d && typeof d === 'object' && d.k != null).map(d =>
      '<div class="fx-pop-row"><span class="fx-pop-k">' + esc(String(d.k)) + '</span><span class="fx-pop-v">' + esc(String(d.v ?? '')) + '</span></div>').join('') : '') +
    // An aggregate lists what it adds up: each account, its balance and the date of that balance.
    (Array.isArray(f.sums) && f.sums.length
      ? '<div class="fx-pop-sums" role="list" aria-label="Accounts added up">' + f.sums.map(a =>
        '<div class="fx-pop-row" role="listitem"><span class="fx-pop-v">' + esc(a.label) + (a.carried ? ' <em>(carried forward)</em>' : '') +
        '</span><span class="fx-pop-n">' + esc(moneyCents(a.v)) + ', ' + esc(a.asOf) + '</span></div>').join('') + '</div>'
      : '') +
    (figAction ? '<button type="button" class="fx-pop-add" data-fig-add>Add to chat</button>' : '');
  const add = el.querySelector('[data-fig-add]');
  if (add) {
    add.addEventListener('click', e => {
      e.preventDefault();
      const fn = figAction;
      closePopover();
      if (fn) fn(key, txt(f.label || key));
    });
  }
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
  let top = r.bottom + 8;
  if (top + h > vh - 8 && r.top - h - 8 >= 8) top = r.top - h - 8;
  el.style.left = Math.round(left) + 'px';
  // Never below the viewport: a popover taller than the room under the figure and above it is
  // pulled up so its Add to chat button stays reachable.
  el.style.top = Math.round(Math.max(8, Math.min(top, vh - h - 8))) + 'px';
  pop = { el, anchor };
  if (fromKey && add) add.focus();
}

document.addEventListener('click', e => {
  if (!pop) return;
  if (pop.el.contains(e.target) || pop.anchor.contains(e.target)) return;
  closePopover();
});
// Escape with a popover open closes only the popover: focus goes back to its figure and the
// design sees the key as handled (it closes nothing else).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !pop) return;
  const anchor = pop.anchor;
  closePopover();
  e.preventDefault();
  if (anchor && anchor.isConnected && typeof anchor.focus === 'function') anchor.focus({ preventScroll: true });
});
// A re-render replaces the anchor; a popover for a figure that is gone closes.
coreSubs.push(() => { if (pop && !pop.anchor.isConnected) closePopover(); });

// ---------------------------------------------------------------- design lifecycle

function bootMessage(title, body, retry) {
  if (!root) return;
  root.className = '';
  root.innerHTML = '<div class="fx-boot" role="alert"><b>' + esc(title) + '</b>' + esc(body) +
    (retry ? ' <button type="button" data-fx-retry>Try again</button>' : '') + '</div>';
  const b = root.querySelector('[data-fx-retry]');
  if (b) b.addEventListener('click', () => { window.location.reload(); });
}

function unmountCurrent() {
  if (current && current.def && typeof current.def.unmount === 'function') {
    try { current.def.unmount(); } catch (e) { console.error(e); }
  }
  designSubs = [];
  closePopover();
  current = null;
}

function mountDesign(def) {
  unmountCurrent();
  root.innerHTML = '';
  root.className = 'd-' + def.id;
  current = { id: def.id, def };
  try {
    def.mount(root, api);
  } catch (e) {
    console.error(e);
    bootMessage('Fathom could not start.', 'The interface failed to load: ' + (e && e.message ? e.message : 'unknown error') + '.');
    return;
  }
  if (typeof def.render === 'function') {
    try { def.render(cur); } catch (e) { console.error(e); }
  }
}

function pickDesign() {
  if (designs.has('horizon')) return designs.get('horizon');
  const first = designs.values().next();
  return first.done ? null : first.value;
}

function registerDesign(def) {
  if (!def || !def.id || typeof def.mount !== 'function') {
    console.error('[fathom] registerDesign needs { id, mount }');
    return;
  }
  designs.set(def.id, def);
  if (booted && !current) mountDesign(def);
}

// ---------------------------------------------------------------- boot

async function loadScenario() {
  const res = await fetch('/api/scenario', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) signedOut('expired');
  if (!res.ok) throw new Error('The server answered ' + res.status + '.');
  const data = await res.json();
  if (!data || typeof data !== 'object' || !data.meta) throw new Error('The server sent an unexpected reply.');
  return data;
}

// The signed-in user in the shape api.identity() has always had ({ login, name }, both the email
// here) plus id, email and role. Null when nobody is signed in or on a demo store.
function identityOf(i) {
  if (!i || typeof i !== 'object') return null;
  const email = typeof i.email === 'string' ? i.email : '';
  const login = typeof i.login === 'string' && i.login ? i.login : email;
  const name = typeof i.name === 'string' && i.name ? i.name : login;
  if (!login) return null;
  return { id: i.id == null ? null : String(i.id), email: email || login, role: i.role === 'admin' ? 'admin' : 'member', login, name };
}

// GET /api/auth/session, before any household request: { demo, identity }.
async function loadSession() {
  let res;
  try {
    res = await fetch('/api/auth/session', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  } catch (e) {
    throw new Error('The server could not be reached.');
  }
  if (res.status === 401) return { demo: false, identity: null };
  if (!res.ok) throw new Error('The server answered ' + res.status + '.');
  let d = null;
  try { d = await res.json(); } catch (e) { d = null; }
  if (!d || typeof d !== 'object') throw new Error('The server sent an unexpected reply.');
  return { demo: d.demo === true, identity: identityOf(d.identity) };
}

async function boot() {
  root = document.getElementById('app');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  }
  try {
    // The session comes first: a real store never asks for the household without a signed-in user.
    const session = await loadSession();
    if (!session.demo && !session.identity) { signedOut(null); return; }
    IDENT = session.identity;
    S = await loadScenario();
  } catch (e) {
    if (leaving) return;
    bootMessage('Fathom could not load your plan.', (e && e.message ? e.message : 'Unknown error.'), true);
    return;
  }
  version += 1;
  applyRoute(parseHash(window.location.hash), { replace: true, silent: true });
  booted = true;
  window.addEventListener('hashchange', onHashChange);
  const def = pickDesign();
  if (def) mountDesign(def);
  else bootMessage('Fathom could not start.', 'No interface is registered.');
  // Engine switches and provenance popovers for any .fx-fig, unless a design handles the click
  // and calls preventDefault. These listen on the document, so they run after the design's own
  // root listeners whichever registered first (a design that loads after boot mounts later).
  document.addEventListener('click', e => {
    if (e.defaultPrevented) return;
    const sw = e.target.closest && e.target.closest('[data-fx-engine]');
    if (sw && root.contains(sw)) { e.preventDefault(); setEngine(!live().engine); return; }
    const el = e.target.closest && e.target.closest('.fx-fig');
    if (el && root.contains(el)) openPopover(el);
  });
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || (e.key !== 'Enter' && e.key !== ' ')) return;
    const el = e.target.closest && e.target.closest('.fx-fig');
    if (el && root.contains(el)) { e.preventDefault(); openPopover(el, true); }
  });
}

window.Fathom = { registerDesign, api };

function start() { Promise.resolve().then(boot); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

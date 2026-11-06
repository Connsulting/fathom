// Fathom client core: window.Fathom, hash router, API-backed store, figure popover.
// Port of mock-v2/core/core.js. Keeps every `api` member of mock-v2/CONTRACT.md (Core API) with the
// same semantics, plus api.src and api.figPopover. Designs only touch window.Fathom.api.
//
// Differences from the mock:
//  - No review harness, no demo switcher, no design switcher, nothing in localStorage.
//  - The scenario comes from GET /api/scenario at boot. The server has already merged live state
//    (rec status, tasks, wake) and adds `scenario.live`; api.state is derived from it.
//  - Actions POST to the API, replace the scenario with the one in the response, then notify. They
//    return a Promise (designs may ignore it). Requests run one at a time, in order. A failed
//    request keeps the old state and shows a dismissible error line (role=alert).
//  - api.go(name, params, opts) accepts opts.replace to replace the current history entry.
//  - The figure popover shows cents when the value has a nonzero cents part.
//
// Reading notes kept from the mock:
//  - api.verdict() returns raw strings with tokens (only {count} is replaced). Render via api.t().
//  - api.rec(id) also returns recs whose live status is 'hidden'; api.recs() and api.needsYou() never do.
//  - api.go(name, params): params is an object ({id}, {step}, {name}) or a bare value for the route's
//    primary param (rec->id, onboarding->step, wargame->name, packs->id).
//  - api.scenarioPick(name, idx): idx is a point/option index or its id string.
//  - api.ask(questionId, key?): index (or id) into rec.qa when the conversation is a rec, otherwise an
//    id into ask.suggested (or a starter id on #/ask). Default conversation = the rec on the rec
//    route, the pack's What if thread on a pack route, the open thread on #/ask/<id>; on #/ask with
//    no thread open it starts a new thread (api.newThread).
//  - Messages are { id, role, html, refs, ts, notice, provenance }. 'fathom' html is a series of <p>.
//    provenance is the stored object (tools, figures, literals, packEntries, packIds, grounding)
//    or null for messages that have none.
//  - api.askFree(text, key) takes an Ask thread key 'ask:<id>', a rec id or 'pack:<id>' (the pack's
//    What if thread). There is no bare 'ask' conversation; api.conversation() with no key is [].
//  - Ask threads: route 'ask' takes an optional id (#/ask/<id>; an id not in live.threads normalizes
//    to #/ask). api.threads() lists every thread (archived and trashed too, newest lastAt first) as
//    { id, key, title, titleSource, createdAt, lastAt, archivedAt, trashedAt, turns }; title null
//    means "New conversation". api.askStarters() lists { id, q } plain-text starters.
//    api.newThread({ text } | { questionId }) creates a thread, asks, and opens #/ask/<id> (replacing
//    #/ask); it resolves { thread, message } or null. api.threadAct(id, 'archive'|'trash'|'restore'|
//    'delete') and api.renameThread(id, title) resolve the updated thread (or null; delete resolves
//    null too, and a deleted open thread falls back to #/ask).
//  - api.askStream(text, key, onEvent) and api.newThreadStream({ text } | { questionId }, onEvent) are
//    askFree and newThread over the server's event stream: onEvent(name, data) sees 'start' {key},
//    'progress' {label}, 'text' {text} (raw model text: escape it and never style its numbers as
//    verified), 'reset' and 'recovering'. They resolve exactly like askFree and newThread. When the
//    stream breaks before its final event, the answer is fetched instead: the scenario is reloaded
//    until the conversation has the new turn (the server stores it once, after grounding).
//  - api.packEntry(packId, entryId) GETs one pack entry and resolves { id, title, body, cites } or
//    null; it never touches the scenario or the error line.
//  - api.reviseAnswer(id, optionId) and api.reopenAnswer(id) resolve { item }, or { final: message }
//    when the server refuses with 409 (no error line), or null on any other failure.

import { money, resolveTokens, esc, KIND_WORDS } from '/shared/tokens.mjs';
import { needsYou as needsYouOf, packStatus } from '/shared/rules.mjs';

const ROUTES = new Set(['onboarding', 'brief', 'plan', 'rec', 'ask', 'wargame', 'goals', 'accounts',
  'advisor', 'yearend', 'connect', 'engine', 'email', 'packs', 'confirm', 'add']);
const PARAM_KEY = { rec: 'id', onboarding: 'step', wargame: 'name', packs: 'id', ask: 'id' };
const LAST_STEP = 5;

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
let IDENT = null;       // { login, name } from GET /api/identity, or null (demo, or the fetch failed)
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
const minStep = () => (isReal() ? 1 : 0);
const demoId = () => (live().demo === 'fresh' ? 'fresh' : 'november');

function figOf(key) {
  const f = S && S.fig && key != null ? S.fig[key] : null;
  if (f && typeof f === 'object') return f;
  return { v: 0, src: null, kind: 'e', label: String(key == null ? '' : key), missing: true };
}
function srcOf(id) {
  const s = S && S.src && id != null ? S.src[id] : null;
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
    onboardStep: Math.max(minStep(), routeStep != null ? routeStep : (Number.isFinite(Number(L.onboardStep)) ? Number(L.onboardStep) : 0)),
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
  return { name: 'brief', params: {} };
}
const clampStep = n => Math.max(minStep(), Math.min(LAST_STEP, Number.isFinite(n) ? Math.floor(n) : 0));

function normalizeRoute(r) {
  if (!r || !ROUTES.has(r.name)) return defaultRoute();
  const p = r.params || {};
  if (demoId() === 'fresh') {
    const step = r.name === 'onboarding' && p.step != null && p.step !== '' ? clampStep(Number(p.step)) : stateView().onboardStep;
    return { name: 'onboarding', params: { step } };
  }
  if (r.name === 'onboarding') return defaultRoute();
  if (r.name === 'rec') return p.id && rawRec(String(p.id)) ? { name: 'rec', params: { id: String(p.id) } } : { name: 'plan', params: {} };
  if (r.name === 'ask') return p.id && rawThread(String(p.id)) ? { name: 'ask', params: { id: String(p.id) } } : { name: 'ask', params: {} };
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
  applyRoute({ name, params: p || {} }, { replace: !!(opts && opts.replace) });
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

function hideError() {
  if (errEl) { errEl.remove(); errEl = null; }
}

function showError(message) {
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

// The identity gate answered 401: reload so the server serves its 401 page.
function reloadUnauthorized() {
  try { window.location.reload(); } catch (e) { /* ignore */ }
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
  if (res.status === 401) reloadUnauthorized();
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
  if (res.status === 401) reloadUnauthorized();
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
const threadIds = (scenario) => new Set(arr(scenario && scenario.live && scenario.live.threads).map(t => t && t.id));

// Reload the scenario until the asked conversation has the new turn: `key` with more owner
// messages than `before`, or (a new thread whose key never arrived) a thread not in `ids`.
// Resolves { scenario, key } or null after RECOVER_FOR_MS.
async function recoverTurn({ key, before, ids }) {
  const until = Date.now() + RECOVER_FOR_MS;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, RECOVER_EVERY_MS));
    let next;
    try { next = await loadScenario(); } catch (e) { continue; }
    if (key && meTurns(next, key) > before) return { scenario: next, key };
    if (!key) {
      const fresh = arr(next.live && next.live.threads).find(t => t && t.id && !ids.has(t.id));
      if (fresh) return { scenario: next, key: fresh.key || 'ask:' + fresh.id };
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

function askStream(text, convKey, onEvent) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return done();
  const key = convKey || activeKey();
  if (!key) return newThreadStream({ text: clean }, onEvent);
  if (key.startsWith('pack:') && !rawPack(key.slice(5))) return done();
  const cb = typeof onEvent === 'function' ? onEvent : () => {};
  return sendStream('/api/ask', { key, text: clean }, cb, d => (d.message ? mapMsg(d.message) : d.recoveredKey ? lastReply(key) : null), key);
}

function newThreadStream(q, onEvent) {
  const o = q && typeof q === 'object' ? q : {};
  let body;
  if (o.questionId != null && o.questionId !== '') body = { questionId: String(o.questionId) };
  else {
    const text = String(o.text == null ? '' : o.text).trim();
    if (!text) return done();
    body = { text };
  }
  const cb = typeof onEvent === 'function' ? onEvent : () => {};
  return sendStream('/api/threads', body, cb, d => {
    let th = d.thread && typeof d.thread === 'object' ? d.thread : null;
    if (!th && d.recoveredKey) th = rawThread(d.recoveredKey.replace(/^ask:/, ''));
    if (th && th.id && cur && cur.name === 'ask' && !(cur.params && cur.params.id)) go('ask', { id: th.id }, { replace: true });
    const key = th ? th.key || 'ask:' + th.id : null;
    return { thread: th, message: d.message ? mapMsg(d.message) : key ? lastReply(key) : null };
  });
}

// Swap in a new scenario and keep the route valid for it (for example onboarding finishing).
function applyScenario(next) {
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
      let out = data;
      try { out = onOk ? onOk(data) : data; } catch (e) { out = null; }
      notify();
      return out;
    },
    err => {
      if (onDone) { onDone(); notify(); }
      showError((failText || 'Could not save that change. ') + (err && err.message ? err.message : ''));
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

const ACTIONS = new Set(['accept', 'start', 'complete', 'dismiss', 'snooze', 'reopen']);

function act(recId, action, arg) {
  const r = rawRec(recId);
  if (!r || r.status === 'hidden') return done();
  const body = { action };
  if (action === 'task') {
    const i = Number(arg);
    if (!Number.isInteger(i) || i < 0 || i >= arr(r.tasks).length) return done();
    body.arg = i;
  } else {
    if (!ACTIONS.has(action)) return done();
    if (action === 'snooze') body.arg = arg != null && arg !== '' ? String(arg) : 'Next month';
  }
  return send('/api/recs/' + encodeURIComponent(recId) + '/action', body);
}

function activeKey() {
  if (cur && cur.name === 'rec' && cur.params && cur.params.id) return cur.params.id;
  if (cur && cur.name === 'packs' && cur.params && cur.params.id) return 'pack:' + cur.params.id;
  if (cur && cur.name === 'ask' && cur.params && cur.params.id) {
    const th = rawThread(cur.params.id);
    if (th) return th.key || 'ask:' + th.id;
  }
  return null;
}

function ask(questionId, convKey) {
  if (questionId == null || questionId === '') return done();
  const key = convKey || activeKey();
  if (!key) return newThread({ questionId: String(questionId) });
  const qid = typeof questionId === 'string' && /^\d+$/.test(questionId) ? Number(questionId) : questionId;
  return send('/api/ask', { key, questionId: qid }, d => (d.message ? mapMsg(d.message) : null));
}

function askFree(text, convKey) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return done();
  const key = convKey || activeKey();
  if (!key) return newThread({ text: clean });
  if (key.startsWith('pack:') && !rawPack(key.slice(5))) return done();
  return send('/api/ask', { key, text: clean }, d => (d.message ? mapMsg(d.message) : null));
}

// ---------------------------------------------------------------- Ask threads

const THREAD_ACTS = new Set(['archive', 'trash', 'restore', 'delete']);

function threads() {
  return threadList().slice();
}

function askStarters() {
  return arr(live().askStarters).filter(s => s && s.id != null && typeof s.q === 'string');
}

// Creates a thread and asks its first question. When the owner is still on #/ask, the new thread
// replaces that history entry, so Back leaves the Ask page instead of reopening an empty composer.
function newThread(q) {
  const o = q && typeof q === 'object' ? q : {};
  let body;
  if (o.questionId != null && o.questionId !== '') body = { questionId: String(o.questionId) };
  else {
    const text = String(o.text == null ? '' : o.text).trim();
    if (!text) return done();
    body = { text };
  }
  return send('/api/threads', body, d => {
    const th = d.thread && typeof d.thread === 'object' ? d.thread : null;
    if (th && th.id && cur && cur.name === 'ask' && !(cur.params && cur.params.id)) go('ask', { id: th.id }, { replace: true });
    return { thread: th, message: d.message ? mapMsg(d.message) : null };
  });
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
function goalCreate(fields) {
  if (!fields || typeof fields !== 'object') return done();
  return send('/api/goals', fields, d => d.goal || null, null, 'Could not save that goal. ');
}

function goalUpdate(id, fields) {
  if (id == null || id === '' || !fields || typeof fields !== 'object') return done();
  return send('/api/goals/' + encodeURIComponent(id), fields, d => d.goal || null, null, 'Could not save that goal. ');
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

function buildYourPlans(fileIds) {
  const ids = arr(fileIds).filter(x => x != null && x !== '').map(String);
  return send('/api/your-plans/build', { fileIds: ids }, d => (d.result && typeof d.result === 'object' ? d.result : null));
}

async function packEntry(packId, entryId) {
  if (packId == null || entryId == null || packId === '' || entryId === '') return null;
  try {
    const res = await fetch('/api/packs/' + encodeURIComponent(packId) + '/entries/' + encodeURIComponent(entryId), {
      headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store',
    });
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

const emptyIngest = () => ({ pending: 0, items: [], files: [], waiting: [], sources: [], accounts: {}, staleNotes: [], formats: [] });

function ingest() {
  const g = live().ingest;
  if (!g || typeof g !== 'object') return emptyIngest();
  const out = emptyIngest();
  out.pending = Number.isFinite(Number(g.pending)) ? Number(g.pending) : 0;
  ['items', 'files', 'waiting', 'sources', 'staleNotes', 'formats'].forEach(k => { out[k] = arr(g[k]); });
  if (g.accounts && typeof g.accounts === 'object') out.accounts = g.accounts;
  return out;
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

function retryFile(id) {
  if (id == null || id === '') return done();
  return send('/api/files/' + encodeURIComponent(id) + '/retry', {}, d => d.file || null);
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
  ask,
  askFree,
  askStream,
  conversation,
  threads,
  askStarters,
  newThread,
  newThreadStream,
  threadAct,
  renameThread,
  scenarioPick,
  onboard,
  goalCreate,
  goalUpdate,
  goalArchive,
  goalDelete,
  setCurve,
  engineOn: () => !!live().engine,
  setEngine,
  setCap,
  demo: demoId,
  packs,
  pack,
  whatIf,
  packToggle,
  packEntry,
  buildYourPlans,
  ingest,
  identity: () => (IDENT ? { login: IDENT.login, name: IDENT.name } : null),
  upload,
  answer,
  reviseAnswer,
  reopenAnswer,
  retryFile,
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
    '<div class="fx-pop-val">' + esc(moneyCents(f.v)) + '</div>' +
    '<div class="fx-pop-row"><span class="fx-pop-k">Source</span><span class="fx-pop-v">' + esc(src.label) + '</span></div>' +
    (src.asOf ? '<div class="fx-pop-row"><span class="fx-pop-k">As of</span><span class="fx-pop-v">' + esc(src.asOf) + '</span></div>' : '') +
    '<div class="fx-pop-row"><span class="fx-pop-k">Kind</span><span class="fx-pop-v">' + esc(kind) + '</span></div>' +
    // Kept only for reference (R2-9), then readable assumptions (MGN1); both are stored plain text.
    (typeof f.unavailable === 'string' && f.unavailable ? '<div class="fx-pop-row"><span class="fx-pop-k">Not current</span><span class="fx-pop-v">' + esc(f.unavailable) + '</span></div>' : '') +
    (Array.isArray(f.notes) ? f.notes.filter(n => typeof n === 'string').map(n => '<div class="fx-pop-row"><span class="fx-pop-k">Assumes</span><span class="fx-pop-v">' + esc(n) + '</span></div>').join('') : '');
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
  el.style.top = Math.round(Math.max(8, top)) + 'px';
  pop = { el, anchor };
}

document.addEventListener('click', e => {
  if (!pop) return;
  if (pop.el.contains(e.target) || pop.anchor.contains(e.target)) return;
  closePopover();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePopover();
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
  if (res.status === 401) reloadUnauthorized();
  if (!res.ok) throw new Error('The server answered ' + res.status + '.');
  const data = await res.json();
  if (!data || typeof data !== 'object' || !data.meta) throw new Error('The server sent an unexpected reply.');
  return data;
}

async function loadIdentity() {
  try {
    const res = await fetch('/api/identity', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const d = await res.json();
    const i = d && d.identity;
    if (!i || typeof i !== 'object') return null;
    const login = typeof i.login === 'string' ? i.login : '';
    const name = typeof i.name === 'string' && i.name ? i.name : login;
    return login || name ? { login, name } : null;
  } catch (e) {
    return null;
  }
}

async function boot() {
  root = document.getElementById('app');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  }
  try {
    const [scenario, ident] = await Promise.all([loadScenario(), loadIdentity()]);
    S = scenario;
    IDENT = ident;
  } catch (e) {
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
    if (el && root.contains(el)) { e.preventDefault(); openPopover(el); }
  });
}

window.Fathom = { registerDesign, api };

function start() { Promise.resolve().then(boot); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

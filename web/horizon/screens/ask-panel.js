/* Horizon Ask panel: Ask beside every page. A launcher (bottom right, Ctrl+I) opens a panel that
   mounts chat.js's own thread pane, so a question in flight, its live work block and its answer
   are the same ones the Ask page shows; this module only hosts them.
   Modes by viewport: docked at 1040px and wider (the page reflows beside it, width clamped so the
   page keeps 720px), a modal right-side sheet from 721 to 1039px, a modal full-height sheet at
   720px and below. Expand opens the same thread on the Ask page; Open in panel there comes back.
   Context: the page chip names what the owner is looking at, with what its screen published this
   draw (pageContext: a month, a range, a filter, an open goal; screens/ask-context.js); the Ask
   about buttons across the app and the figure popover's Add to chat add chips. A question carries
   them as references, kind and id only. A conversation belongs to the page it started on
   (screens/ask-convo.js): on another page the next add or question starts a new one.
   Open state, width, thread, chips, page and each thread's context persist in localStorage
   (fathom.askPanel); every access is guarded and a blocked store falls back to defaults. */

import * as chatScreen from './chat.js';
import * as convo from './ask-convo.js';
import { KINDS, MAX_REFS, routeContext, refKey, chipPayload, chipHtml } from './ask-context.js';

let H = null;

export function bind(kit) { H = kit; }

const STORE = 'fathom.askPanel';
const W_DEF = 400;
const W_MIN = 320;
const W_MAX = 640;
const STEP = 16;
const PAGE_MIN = 720;
const DOCK_Q = '(min-width: 1040px)';
const SHEET_Q = '(max-width: 720px)';
const NEW_TITLE = 'New conversation';
const STALE_NOTE = 'Your next question starts a new conversation about this page.';
const Q_RE = /^[a-z]+=[A-Za-z0-9-]+(;[a-z]+=[A-Za-z0-9-]+)*$/;

const svg = (p) => `<svg class="h-i" viewBox="0 0 16 16" aria-hidden="true">${p}</svg>`;
const I = {
  list: svg('<path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5M2.75 4.5h.5M2.75 8h.5M2.75 11.5h.5"/>'),
  compose: svg('<path d="M13 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V4a1 1 0 011-1h3"/><path d="M11.25 2.25l2.5 2.5L8 10.5H5.5V8z"/>'),
  expand: svg('<path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"/>'),
  dock: svg('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M9.5 3v10"/>')
};

// The conversation (page, threadId, chips, gen, ctx, pageOff, asking: see ask-convo.js), then the
// panel's own state.
const fresh = () => ({
  open: false, width: W_DEF, ...convo.freshConvo(),
  offKey: null,                     // the route pageOff was kept for
  view: 'thread', origin: null,     // 'thread' or 'list'; the page an Expand came from
  focus: false,                     // focus the composer after the next draw
  shown: null,                      // what the body showed last draw, for its scroll position
  drag: null
});
let P = fresh();
// What the screens drawn this draw publish about their view (design.js clears it per draw).
let PV = {};

/* ---------- persistence ---------- */

function cleanChip(c) {
  if (!c || typeof c !== 'object' || !KINDS.includes(c.kind) || typeof c.id !== 'string' || !c.id || c.id.length > 200) return null;
  return { kind: c.kind, id: c.id, label: typeof c.label === 'string' ? c.label : '', q: typeof c.q === 'string' && Q_RE.test(c.q) ? c.q : '' };
}

function cleanChips(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(cleanChip)
    .filter((c) => c && !seen.has(refKey(c)) && seen.add(refKey(c))).slice(0, MAX_REFS);
}

function load() {
  let v = null;
  try { v = JSON.parse(window.localStorage.getItem(STORE) || 'null'); } catch (e) { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return;
  P.open = v.open === true;
  const w = Number(v.width);
  if (Number.isFinite(w)) P.width = Math.round(Math.max(W_MIN, Math.min(W_MAX, w)));
  P.threadId = typeof v.threadId === 'string' && v.threadId ? v.threadId : null;
  P.chips = cleanChips(v.chips);
  P.page = typeof v.page === 'string' && v.page && v.page.length <= 400 ? v.page : null;
  if (v.ctx && typeof v.ctx === 'object' && !Array.isArray(v.ctx)) {
    for (const [id, e] of Object.entries(v.ctx)) {
      if (!e || typeof e !== 'object' || id.length > 200) continue;
      convo.rememberCtx(P, id, { origin: cleanChip(e.origin), chips: cleanChips(e.chips) });
    }
  }
}

function save() {
  try {
    window.localStorage.setItem(STORE, JSON.stringify({ open: P.open, width: P.width, threadId: P.threadId, chips: P.chips, page: P.page, ctx: P.ctx }));
  } catch (e) { /* storage blocked: the panel still works for this visit */ }
}

export function reset() { P = fresh(); PV = {}; load(); }

/* ---------- mode, width, route ---------- */

const mq = (q) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
const mode = () => (mq(DOCK_Q) ? 'dock' : mq(SHEET_Q) ? 'sheet' : 'overlay');
const maxW = () => Math.max(W_MIN, Math.min(W_MAX, window.innerWidth - PAGE_MIN));
const dockW = () => Math.max(W_MIN, Math.min(maxW(), P.width));
const overlayW = () => Math.max(W_MIN, Math.min(P.width, window.innerWidth - 64));
const route = () => H.routeNow();
const onAsk = () => route().name === 'ask';
// The conversation's page: the page under any dialog, the design.js draw() key.
const pageKey = () => convo.pageKeyOf(H.pageRoute());
const threadOf = (id) => (id ? H.arr(H.api.threads ? H.api.threads() : []).find((t) => t && t.id === id) || null : null);

// Shown: open and not on the Ask page (the page is the expanded panel).
export const isOpen = () => !!(H && H.root && P.open && !onAsk());
export const modalOpen = () => isOpen() && mode() !== 'dock';
export const el = () => (H && H.root ? H.root.querySelector('#h-askp') : null);
export function focusInside() {
  const p = el();
  const a = document.activeElement;
  return !!(p && a && p.contains(a));
}

/* ---------- context chips ---------- */

// The current Confirm card, read from its "+" (single card: the item id; group card: group:<kind>).
function confirmCard() {
  const b = H.root && H.root.querySelector('.h-root .h-deck-card.cur > .h-cf-k .h-add');
  return b ? { id: b.dataset.ctxId, label: b.dataset.ctxLabel || '' } : null;
}

// The page chip of a route, with the view the screens published this draw.
function chipFor(r, view) {
  const { api } = H;
  return routeContext(r, {
    accounts: api.s && api.s.accounts, recs: api.recs(), packs: api.packs ? api.packs() : [],
    txt: (s) => api.txt(s), confirm: r.name === 'confirm' ? confirmCard() : null, view
  });
}

const pageChip = () => chipFor(route(), PV);

// Called by design.js at the start of every draw; the page and then the dialog publish again.
export function clearView() { PV = {}; }

// A screen's view details (KIT.pageContext), merged into this draw's view.
export function pageContext(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(PV, v);
}

// A removed page chip stays removed until the route changes.
function syncOff() {
  const r = route();
  const k = `${r.name}/${(r.params && (r.params.id ?? r.params.name)) ?? ''}`;
  if (k !== P.offKey) { P.offKey = k; P.pageOff.clear(); }
}

// The page chip (unless removed or already added), then the added chips; on another page than
// the conversation's, the page chip alone.
function shownChips() {
  syncOff();
  return convo.visibleChips(P, pageKey(), pageChip());
}

// The chip row above a composer (the panel's and the Ask page's), or ''. On another page than an
// open thread's, a note says the next question starts a new conversation.
export function chipsHtml() {
  if (!H || !H.api) return '';
  const list = shownChips();
  const note = P.threadId && convo.isStale(P, pageKey()) ? `<p class="h-ctx-note">${H.esc(STALE_NOTE)}</p>` : '';
  if (!list.length) return note;
  return `<div class="h-ctx-row" role="group" aria-label="Context for the question">${list.map((c) => chipHtml(c, { esc: H.esc, removable: true, page: !!c.page })).join('')}</div>${note}`;
}

// The references a question asked from host carries; a rec dialog question carries none.
export function refs(host) {
  if (!H || !H.api || host === 'dialog') return [];
  return chipPayload(shownChips());
}

// On another page than the conversation's, the add starts a new conversation for this page.
export function addChip(c) {
  const chip = cleanChip(c);
  if (!H || !chip) return;
  syncOff();
  convo.beginAdd(P, pageKey(), chip);
  if (!onAsk()) { P.open = true; P.view = 'thread'; }
  save();
  P.focus = true;
  H.draw();
}

function removeChip(key, isPage) {
  convo.removeChip(P, key, isPage);
  save();
  P.focus = true;
  H.draw();
}

// A new thread asked from the panel becomes the panel's thread, unless the owner has started or
// reopened another conversation since; either way its context is remembered.
export function onThread(thread, host) {
  if (host !== 'panel' || !thread || typeof thread.id !== 'string' || !thread.id) return;
  if (convo.adoptThread(P, thread.id, pageChip())) P.view = 'thread';
  save();
}

// chat.js, before a panel question is sent: true when it just started a new conversation (the
// question then goes as a new thread with this page's context only).
export function askBegin() {
  if (!H || !H.api) return false;
  syncOff();
  const started = convo.beginAsk(P, pageKey(), pageChip());
  save();
  return started;
}

// chat.js newConversation on the Ask page: clear the conversation; chat.js draws.
export function clearConversation() {
  if (!H) return;
  convo.newConversation(P, pageKey());
  P.view = 'thread';
  save();
}

// The Ask page's Open in panel button.
export function collapseBtn() {
  return `<button type="button" class="h-askx-ib h-askp-collapse" data-askp="collapse" aria-label="Open in panel" title="Open in panel">${I.dock}</button>`;
}

/* ---------- open, close, expand ---------- */

function focusComposer() {
  const scope = el() || (H.root && H.root.querySelector('.h-root'));
  const t = scope && scope.querySelector('form.h-askx-compose textarea[name="q"]');
  if (!t) return;
  t.focus({ preventScroll: true });
  const n = t.value.length;
  try { t.setSelectionRange(n, n); } catch (e) { /* not a text field */ }
}

export function open() {
  if (!H) return;
  if (onAsk()) { collapse(); return; }
  P.open = true;
  P.view = 'thread';
  save();
  P.focus = true;
  H.draw();
}

export function close() {
  if (!H) return;
  P.open = false;
  save();
  H.draw();
  const l = H.root && H.root.querySelector('.h-askp-launch');
  if (l) l.focus({ preventScroll: true });
}

export function toggle() {
  if (!H) return;
  if (onAsk()) collapse();
  else if (P.open) close();
  else open();
}

// Expand: the same thread on the Ask page, with the page chip folded into the added chips. The
// panel closes; Open in panel on the Ask page brings it back on the page it expanded from.
function expand() {
  P.open = false;
  const r = H.pageRoute();
  P.origin = { name: r.name, params: { ...(r.params || {}) } };
  const pc = pageChip();
  if (pc && !P.pageOff.has(refKey(pc)) && !P.chips.some((c) => refKey(c) === refKey(pc))) {
    P.chips.unshift({ kind: pc.kind, id: pc.id, label: pc.label, q: pc.q || '' });
    P.chips = P.chips.slice(0, MAX_REFS);
  }
  P.view = 'thread';
  save();
  P.focus = true;
  H.api.go('ask', P.threadId ? { id: P.threadId } : {});
}

// Open in panel, from the Ask page: back to the page the panel expanded from, on this thread.
// Another thread than the panel's comes back with its own context; the conversation belongs to
// the page the panel returns to.
function collapse() {
  const r = route();
  const id = r.name === 'ask' && r.params && r.params.id ? String(r.params.id) : null;
  const next = id && threadOf(id) ? id : null;
  const o = P.origin || { name: 'home', params: {} };
  P.origin = null;
  const key = convo.pageKeyOf(o);
  if (next && next !== P.threadId) convo.restoreCtx(P, next, key, chipFor(o, {}));
  else { P.threadId = next; P.page = key; }
  // A first question still streaming on the Ask page: its thread lands in the panel.
  if (!P.threadId) chatScreen.handPending('panel');
  P.open = true;
  P.view = 'thread';
  save();
  P.focus = true;
  H.api.go(o.name, o.params);
}

function newConversation() {
  convo.newConversation(P, pageKey());
  P.view = 'thread';
  save();
  P.focus = true;
  H.draw();
}

// A thread picked from the panel's list comes back with its own context, on this page.
function pick(id) {
  const next = threadOf(id) ? id : null;
  if (next && next !== P.threadId) convo.restoreCtx(P, next, pageKey(), pageChip());
  else if (next) P.page = pageKey(); // the current thread picked again here: it belongs to this page now
  else P.threadId = null;
  P.view = 'thread';
  save();
  P.focus = true;
  H.draw();
}

function act(name) {
  if (name === 'close') close();
  else if (name === 'new') newConversation();
  else if (name === 'expand') expand();
  else if (name === 'collapse') collapse();
  else if (name === 'list') { P.view = P.view === 'list' ? 'thread' : 'list'; if (P.view === 'thread') P.focus = true; H.draw(); }
}

/* ---------- width ---------- */

function setWidth(w, persist) {
  P.width = Math.round(Math.max(W_MIN, Math.min(maxW(), w)));
  H.root.style.setProperty('--askp-w', `${P.width}px`);
  const g = H.root.querySelector('.h-askp-grip');
  if (g) g.setAttribute('aria-valuenow', String(P.width));
  if (persist) save();
}

/* ---------- rendering ---------- */

function panelHtml(m) {
  const { esc, icon } = H;
  const list = P.view === 'list';
  const th = threadOf(P.threadId);
  const title = list ? 'Conversations' : th && typeof th.title === 'string' && th.title ? th.title : NEW_TITLE;
  const w = dockW();
  const grip = m === 'dock'
    ? `<div class="h-askp-grip" role="separator" aria-orientation="vertical" aria-label="Resize the Ask panel" aria-valuenow="${w}" aria-valuemin="${W_MIN}" aria-valuemax="${maxW()}" tabindex="0"></div>`
    : '';
  const b = (a, label, ic, extra = {}) => `<button type="button" class="h-askp-ib" data-askp="${a}" aria-label="${label}" title="${extra.title || label}"${extra.attrs || ''}>${ic}</button>`;
  const body = list ? chatScreen.listHtml(th ? th.id : '') : chatScreen.paneHtml(th ? th.id : null, 'panel');
  return `<aside id="h-askp" class="h-askp" role="complementary" aria-label="Ask" data-mode="${m}">${grip}`
    + `<div class="h-askp-bar"><h2 class="h-askp-t">${esc(title)}</h2><div class="h-askp-acts">`
    + b('list', 'Conversations', I.list, { attrs: ` aria-pressed="${list}"` })
    + b('new', 'New conversation', I.compose)
    + b('expand', 'Open in Ask', I.expand)
    + b('close', 'Close', icon('x'), { title: 'Close (Ctrl+I)' })
    + `</div></div><div class="h-askp-body"><div class="h-askx h-askp-x">${body}</div></div></aside>`;
}

// A selector for the focused element, found again in the redrawn panel.
function sigOf(t) {
  const a = (n) => t.getAttribute(n);
  const q = (n) => `[${n}="${CSS.escape(a(n) || '')}"]`;
  if (a('data-askp')) return q('data-askp');
  if (a('data-blk-ctl')) return q('data-blk-ctl');
  if (a('data-draft')) return q('data-draft');
  if (a('data-ctx-remove')) return q('data-ctx-remove');
  if (a('data-thread')) return `a.h-askx-row${q('data-thread')}`;
  if (a('data-work')) return `button.h-work-row${q('data-work')}`;
  if (a('data-starter') != null) return q('data-starter');
  if (a('data-thread-act')) return `${q('data-thread-act')}${q('data-tid')}`;
  if (a('data-view')) return q('data-view');
  if (t.classList.contains('h-askp-grip')) return '.h-askp-grip';
  if (t.classList.contains('h-askx-new')) return 'button.h-askx-new';
  if (t.classList.contains('h-askx-send')) return 'button.h-askx-send';
  return null;
}

// Page, dialog and panel layers: the page is inert under a dialog or a modal panel, the dialog
// under a modal panel.
function layers(modal) {
  const page = H.root.querySelector('.h-root');
  const dlg = H.root.querySelector('.h-dlg-host');
  const dlgOpen = !!(dlg && !dlg.hidden);
  if (page) page.inert = dlgOpen || modal;
  if (dlg) dlg.inert = modal;
}

// Puts the latest question at the top of the panel's scroller (or the list at its top).
function toLatest(body) {
  const mine = body.querySelectorAll('.h-askx-msgs .h-msg.me');
  const last = mine[mine.length - 1];
  body.scrollTop = last ? Math.max(0, last.getBoundingClientRect().top - body.getBoundingClientRect().top - 12) : 0;
}

// Called by design.js after every draw (after the page and the dialog).
export function sync() {
  if (!H || !H.root || !H.api) return;
  const root = H.root;
  const host = root.querySelector('.h-askp-host');
  const slot = host && host.querySelector('.h-askp-slot');
  const launch = host && host.querySelector('.h-askp-launch');
  if (!slot || !launch) return;
  const r = route();
  syncOff();
  if (P.threadId && !threadOf(P.threadId)) { P.threadId = null; save(); }
  // Stored state from before conversations had a page: it takes the page it is shown on.
  if (P.page == null && r.name !== 'ask') { convo.adoptPage(P, pageKey()); if (P.page != null) save(); }
  const show = P.open && r.name !== 'ask';
  const m = mode();
  const dock = show && m === 'dock';
  root.classList.toggle('h-askp-on', dock);
  if (dock) root.style.setProperty('--askp-w', `${dockW()}px`);
  else root.style.removeProperty('--askp-w');
  launch.hidden = r.name === 'ask' || (show && !dock);
  launch.setAttribute('aria-expanded', String(show));

  const old = slot.querySelector('#h-askp');
  const a = document.activeElement;
  const had = !!(old && a && old.contains(a));
  const sig = had ? sigOf(a) : null;
  const sel = had && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  const oldBody = old && old.querySelector('.h-askp-body');
  const top = oldBody ? oldBody.scrollTop : 0;

  if (!show) {
    slot.innerHTML = '';
    P.shown = null;
    layers(false);
    if (P.focus) { P.focus = false; focusComposer(); }
    return;
  }
  slot.innerHTML = (m === 'overlay' ? '<div class="h-askp-scrim" data-askp="close"></div>' : '') + panelHtml(m);
  const aside = slot.querySelector('#h-askp');
  if (m === 'overlay') aside.style.setProperty('--askp-w', `${overlayW()}px`);
  layers(m !== 'dock');
  const body = aside.querySelector('.h-askp-body');
  const shown = P.view === 'list' ? 'list' : (P.threadId || '');
  if (shown !== P.shown) { P.shown = shown; toLatest(body); }
  else body.scrollTop = top;
  if (P.focus) { P.focus = false; focusComposer(); return; }
  if (!had) return;
  const t = (sig && aside.querySelector(sig)) || aside.querySelector('form.h-askx-compose textarea[name="q"]');
  if (!t) return;
  t.focus({ preventScroll: true });
  if (sel && t.matches('textarea, input')) try { t.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ }
}

/* ---------- events ---------- */

// First in the design's screen order: "+" buttons, chip removal, the launcher, the panel bar and
// the panel's own thread list (picking a thread or New stays in the panel).
export function onClick(e) {
  if (!H || !H.root) return false;
  const t = e.target;
  if (!t || !t.closest) return false;
  const root = H.root;
  const add = t.closest('[data-ctx-add]');
  if (add && root.contains(add)) {
    e.preventDefault();
    e.stopPropagation();
    const d = add.dataset;
    addChip({ kind: d.ctxAdd, id: d.ctxId, label: d.ctxLabel });
    return true;
  }
  const rm = t.closest('[data-ctx-remove]');
  if (rm && root.contains(rm)) {
    e.preventDefault();
    const chip = rm.closest('.h-ctx');
    removeChip(rm.dataset.ctxRemove, !!(chip && chip.dataset.page === '1'));
    return true;
  }
  const c = t.closest('[data-askp]');
  if (c && root.contains(c)) { e.preventDefault(); act(c.dataset.askp); return true; }
  if (t.closest('button.h-askp-launch')) { e.preventDefault(); toggle(); return true; }
  const aside = t.closest('#h-askp');
  if (!aside || !root.contains(aside)) return false;
  const row = t.closest('a.h-askx-row');
  if (row) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return true;
    e.preventDefault();
    pick(row.dataset.thread);
    return true;
  }
  if (t.closest('button.h-askx-new')) { e.preventDefault(); newConversation(); return true; }
  return false;
}

// The resize grip: ArrowLeft widens, ArrowRight narrows.
export function onKey(e) {
  const t = e.target;
  if (!t || !t.classList || !t.classList.contains('h-askp-grip')) return false;
  const d = { ArrowLeft: STEP, ArrowRight: -STEP }[e.key];
  if (d == null) return false;
  e.preventDefault();
  setWidth(dockW() + d, true);
  return true;
}

// Dragging the grip resizes the docked panel; the width is saved on release.
export function handlePointer(e) {
  if (e.type === 'pointerdown') {
    const g = e.target.closest && e.target.closest('.h-askp-grip');
    if (!g || e.button !== 0) return false;
    e.preventDefault();
    P.drag = { x: e.clientX, w: dockW() };
    try { g.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
    H.root.classList.add('h-askp-drag');
    return true;
  }
  if (!P.drag) return false;
  if (e.type === 'pointermove') { setWidth(P.drag.w + (P.drag.x - e.clientX), false); return true; }
  if (e.type === 'pointerup' || e.type === 'pointercancel') {
    P.drag = null;
    H.root.classList.remove('h-askp-drag');
    save();
    return true;
  }
  return false;
}

/* ---------- lifecycle ---------- */

export function mount() {
  const host = H.root.querySelector('.h-askp-host');
  if (!host) return;
  host.innerHTML = `<button type="button" class="h-askp-launch" aria-label="Ask" aria-controls="h-askp" aria-expanded="false" title="Ask (Ctrl+I)">${H.icon('chat')}</button><div class="h-askp-slot"></div>`;
  if (typeof H.api.setFigAction === 'function') {
    H.api.setFigAction((key, label) => addChip({ kind: 'figure', id: String(key), label: String(label || '') }));
  }
}

export function unmount() {
  if (!H) return;
  if (H.api && typeof H.api.setFigAction === 'function') H.api.setFigAction(null);
  if (H.root) {
    H.root.classList.remove('h-askp-on', 'h-askp-drag');
    H.root.style.removeProperty('--askp-w');
  }
  P.drag = null;
}

/* Horizon guided product tour: a short walk through the main screens, one callout per stop.
   TOUR_STOPS is the only place stops are declared. A stop's anchor is a selector list tried left
   to right: the first rendered match of the earliest part that has one wins. The pure part (the table, tourCount and
   placeCallout) does no DOM work at import, so node:test imports this module directly.
   The runtime opens from Settings, the quick switcher, or once on its own on a public demo. While
   it is open the page, the dialog host and the Ask panel are inert, every key is captured on the
   window before the page sees it, and the tour navigates with replace so it adds no history.
   design.js replaces the page markup on every data change, so the anchor is re-queried on every
   redraw, mutation, scroll and resize; no element is ever held across them. */

export const TOUR_STOPS = Object.freeze([
  { id: 'home-goals', route: 'home', anchor: '.h-gcard:has(.h-pbar), .h-gcard', title: 'Your goals, on pace',
    body: 'Home shows each goal and how far along it is against where the plan says it should be today.' },
  { id: 'home-next', route: 'home', anchor: '.h-gcard .h-gnext', title: 'The next thing to do',
    body: 'Each goal shows its most urgent action, who owns it and how many days are left.' },
  { id: 'home-figure', route: 'home', anchor: '.h-gcard .fx-fig, .h-home .fx-fig', title: 'Every number shows its source',
    body: 'Click any underlined figure to see where it came from: the account, the date and how it was worked out.' },
  { id: 'plan-timeline', route: 'plan', anchor: '.h-tl', title: 'Plan: the year on a timeline',
    body: 'Every recommendation sits at the date its window closes. The line is today.' },
  { id: 'money-trend', route: 'money', anchor: '.h-trend .tr-plot', title: 'Money over time',
    body: 'Net worth, month by month, summed from every account. Pick a part to see what moved.' },
  { id: 'pnl', route: 'pnl', anchor: '.pl-tiles', title: 'Profit and loss',
    body: 'Income, expenses and net for each business, plus what the household spends.' },
  { id: 'accounts', route: 'accounts', anchor: '.h-accs .h-acc', title: 'A read-only mirror',
    body: 'Every account in one place. Fathom can see balances and transactions but can never move money.' },
  { id: 'confirm', route: 'confirm', anchor: '.h-deck-card.cur .h-cf-q', title: 'Quick questions',
    body: 'When an import is unsure, Fathom asks instead of guessing. One answer fixes every matching item.' },
  { id: 'ask', route: 'home', anchor: '.h-askp-launch', title: 'Ask anything',
    body: 'Ask opens in a side panel beside any page. Answers use your own data and show where every figure came from.' },
  { id: 'add-context', route: 'home', anchor: '.h-home .h-add', title: 'Add it to the question',
    body: 'The + on a goal, action or account adds it to Ask, so the answer starts with the right context.' },
  { id: 'packs', route: 'packs', anchor: '.h-pack', title: 'Knowledge packs',
    body: 'Curated rules, like tax deadlines and contribution limits, that ground every answer. A pack turns on when your facts say it applies.' }
].map((s) => Object.freeze(s)));

/* ---------- pure helpers ---------- */

// The count on the shown stop at shownIndex (0 based among shown stops): stops known to be
// missing leave the total, so the last shown stop reads "N of N".
export function tourCount(shownIndex, total, skipped) {
  return { n: shownIndex + 1, of: total - skipped };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

// v clamped so [v, v + size] sits in [lo, hi]; when it cannot, in [0, total] instead.
const into = (v, size, lo, hi, total) => (hi - lo >= size ? clamp(v, lo, hi - size) : clamp(v, 0, Math.max(0, total - size)));

// Where the callout goes for an anchor rect (viewport coordinates). Phone: a full-width sheet at
// the bottom, or under the header when the anchor sits in the lower half. Wider: a popover below,
// above, right or left, the first side where it fits inside the margins (topInset keeps it off the
// sticky header); when none fits, the side with the most room, clamped into the viewport.
export function placeCallout({ anchor, box, view, phone, margin = 12, gap = 12, topInset = 0 }) {
  const a = { top: anchor.top, left: anchor.left, bottom: anchor.top + anchor.height, right: anchor.left + anchor.width };
  const h = box.height;
  if (phone) {
    const lower = anchor.top + anchor.height / 2 > view.height / 2;
    const top = lower ? clamp(topInset, 0, Math.max(0, view.height - h)) : Math.max(0, view.height - h);
    return { mode: 'sheet', side: lower ? 'top' : 'bottom', left: 0, top, width: view.width };
  }
  const w = box.width;
  const minX = margin, maxX = view.width - margin, minY = Math.max(margin, topInset), maxY = view.height - margin;
  const crossX = into(a.left, w, minX, maxX, view.width);
  const crossY = into(a.top, h, minY, maxY, view.height);
  const sides = [
    ['bottom', crossX, a.bottom + gap],
    ['top', crossX, a.top - gap - h],
    ['right', a.right + gap, crossY],
    ['left', a.left - gap - w, crossY]
  ];
  const hit = sides.find(([, l, t]) => l >= minX && t >= minY && l + w <= maxX && t + h <= maxY);
  if (hit) return { mode: 'pop', side: hit[0], left: hit[1], top: hit[2], width: w };
  const room = { bottom: view.height - a.bottom, top: a.top, right: view.width - a.right, left: a.left };
  const [side, l0, t0] = sides.reduce((best, s) => (room[s[0]] > room[best[0]] ? s : best));
  return { mode: 'pop', side, left: into(l0, w, minX, maxX, view.width), top: into(t0, h, minY, maxY, view.height), width: w };
}

/* ---------- runtime ---------- */

let H = null;

export function bind(kit) { H = kit; }

const DONE_KEY = 'fathom.tour.done';
const WAIT_MS = 5000; // how long a stop's anchor may take to render before the stop is skipped
const PAD = 6;        // spotlight padding around the anchor
const GAP = 12;
const LAYERS = ['.h-root', '.h-dlg-host', '.h-askp-host'];

const fresh = () => ({
  host: null, open: false, idx: -1, shown: -1, dir: 1, busy: false, nav: false, seq: 0, poll: null,
  skipped: new Set(), opener: null, start: null, inert: null, mo: null, raf: 0, waitRaf: 0, waitTimer: 0
});
let S = fresh();
let autoTried = false; // once per page load, across remounts

const isPhone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches;
const viewSize = () => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
const q = (sel) => H.root.querySelector(sel);

// The sticky header's bottom edge: callouts and scrolled anchors stay below it.
function topInset() {
  const top = q('.h-root .h-top');
  return top ? Math.max(0, top.getBoundingClientRect().bottom) : 0;
}

// A selector list split on its top-level commas (commas inside parentheses do not separate).
const partsCache = new Map();
function partsOf(sel) {
  if (partsCache.has(sel)) return partsCache.get(sel);
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(sel.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(sel.slice(from).trim());
  partsCache.set(sel, parts);
  return parts;
}

// The first rendered match of the earliest part of a stop's selector list that has one.
function anchorOf(stop) {
  for (const part of partsOf(stop.anchor)) {
    for (const el of H.root.querySelectorAll(part)) {
      if (S.host.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

// True for an element that does not scroll with the page: it or an ancestor is position fixed.
function isFixed(el) {
  if (el.offsetParent === null) return true;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (getComputedStyle(n).position === 'fixed') return true;
  }
  return false;
}

// Moves data-tour-on to the current stop's anchor and returns it.
function mark() {
  const el = S.idx >= 0 && !S.busy ? anchorOf(TOUR_STOPS[S.idx]) : null;
  H.root.querySelectorAll('[data-tour-on]').forEach((x) => { if (x !== el) x.removeAttribute('data-tour-on'); });
  if (el && !el.hasAttribute('data-tour-on')) el.setAttribute('data-tour-on', '');
  return el;
}

// The next stop index in direction dir that is not known to be missing, or -1.
function step(i, dir) {
  for (let j = i + dir; j >= 0 && j < TOUR_STOPS.length; j += dir) if (!S.skipped.has(j)) return j;
  return -1;
}

const sameRoute = (a, b) => a.name === b.name && JSON.stringify(a.params || {}) === JSON.stringify(b.params || {});

/* ---------- inert layers ---------- */

function lockInert() {
  S.inert = LAYERS.map(q).filter(Boolean).map((el) => [el, el.inert]);
  S.inert.forEach(([el]) => { el.inert = true; });
}

// After a draw: the Ask panel's sync has reset the layers to their resting state. Remember that
// state for the end of the tour and keep every layer inert while it is open (as the switcher does).
function holdInert() {
  const page = q('.h-root');
  const dlg = q('.h-dlg-host');
  const modal = !!(H.askModal && H.askModal());
  S.inert = [[page, !!(dlg && !dlg.hidden) || modal], [dlg, modal], [q('.h-askp-host'), false]].filter((x) => x[0]);
  S.inert.forEach(([el]) => { el.inert = true; });
}

function unlockInert() {
  if (S.inert) S.inert.forEach(([el, v]) => { el.inert = v; });
  S.inert = null;
}

/* ---------- callout ---------- */

function calloutHtml(stop) {
  const esc = H.esc;
  const before = TOUR_STOPS.slice(0, S.idx).filter((_, j) => !S.skipped.has(j)).length;
  const { n, of } = tourCount(before, TOUR_STOPS.length, S.skipped.size);
  const last = step(S.idx, 1) < 0;
  const first = step(S.idx, -1) < 0;
  const dots = TOUR_STOPS.map((_, j) => (S.skipped.has(j) ? '' : `<i${j === S.idx ? ' class="on"' : ''}></i>`)).join('');
  const btn = (k, label, cls, extra = '') => `<button type="button" class="h-btn${cls ? ` ${cls}` : ''}" data-tour="${k}"${extra}>${label}</button>`;
  return '<div class="h-tour-spot" aria-hidden="true"></div>'
    + `<div class="h-tour" role="dialog" aria-modal="true" aria-labelledby="h-tour-t" aria-describedby="h-tour-b" data-tour-stop="${esc(stop.id)}">`
    + `<div class="h-tour-k"><span data-tour-count>${n} of ${of}</span><span class="h-tour-dots" aria-hidden="true">${dots}</span></div>`
    + `<h2 id="h-tour-t">${esc(stop.title)}</h2><p id="h-tour-b">${esc(stop.body)}</p>`
    + `<div class="h-tour-acts">${last ? '' : btn('skip', 'Skip', 'ghost')}<span class="h-tour-sp"></span>`
    + `${btn('back', 'Back', '', first ? ' disabled' : '')}${last ? btn('done', 'Done', 'pri') : btn('next', 'Next', 'pri')}</div></div>`;
}

// Sets the callout's mode and width for this viewport and returns its size.
function sizeBox(box, phone, view) {
  box.dataset.mode = phone ? 'sheet' : 'pop';
  box.style.width = phone ? `${view.width}px` : '';
  return { width: box.offsetWidth, height: box.offsetHeight };
}

// The anchor rect grown by the spotlight padding: the callout keeps its gap from the ring, not the anchor.
const inflate = (r) => ({
  top: r.top - PAD, left: r.left - PAD, right: r.right + PAD, bottom: r.bottom + PAD,
  width: r.width + PAD * 2, height: r.height + PAD * 2
});

function placeFor(rect, box, phone, view) {
  const { top, left, width, height } = inflate(rect);
  return placeCallout({ anchor: { top, left, width, height }, box, view, phone, gap: GAP, topInset: topInset() });
}

const covers = (p, h, r) => p.left < r.right && r.left < p.left + p.width && p.top < r.bottom && r.top < p.top + h;

function scrollByY(dy) {
  if (Math.abs(dy) < 1) return;
  window.scrollTo({ top: Math.max(0, window.scrollY + dy), behavior: 'instant' });
  // draw() puts the window back at ui.y on a redraw; keep it where the tour put it.
  if (H.ui) H.ui.y = window.scrollY;
}

// Scrolls (instantly) until the anchor is fully visible below the header and clear of the callout.
// Fixed anchors (the Ask launcher) never move, so they pass or fail the first check as they are.
function reveal(el) {
  const box = S.host.querySelector('.h-tour');
  const phone = isPhone();
  const view = viewSize();
  const size = sizeBox(box, phone, view);
  const ok = () => {
    const r = el.getBoundingClientRect();
    return r.top >= topInset() && r.bottom <= view.height && !covers(placeFor(r, size, phone, view), size.height, inflate(r));
  };
  if (isFixed(el)) return;
  // A phone anchor in the lower half would push the sheet to the top: scroll it up anyway, so the
  // sheet stays at the bottom wherever the page allows.
  const r0 = el.getBoundingClientRect();
  if (ok() && !(phone && r0.top + r0.height / 2 > view.height / 2)) return;
  // Phone: anchor near the top so the sheet sits at the bottom; desktop: just below the header.
  scrollByY(el.getBoundingClientRect().top - topInset() - GAP);
  if (ok() || !phone) return;
  // Still not clear of the sheet: put the anchor at the bottom, under a sheet at the top.
  scrollByY(el.getBoundingClientRect().bottom - (view.height - GAP));
}

// Places the spotlight and the callout for the current anchor.
function position() {
  S.raf = 0;
  if (!S.open || S.busy) return;
  const box = S.host.querySelector('.h-tour');
  const spot = S.host.querySelector('.h-tour-spot');
  if (!box || !spot) return;
  const el = mark();
  const phone = isPhone();
  const view = viewSize();
  const size = sizeBox(box, phone, view);
  if (!el) { spot.hidden = true; return; }
  const r = el.getBoundingClientRect();
  const p = placeFor(r, size, phone, view);
  box.dataset.side = p.side;
  box.style.left = `${p.left}px`;
  box.style.top = `${p.top}px`;
  box.style.width = `${p.width}px`;
  spot.hidden = false;
  spot.style.left = `${r.left - PAD}px`;
  spot.style.top = `${r.top - PAD}px`;
  spot.style.width = `${r.width + PAD * 2}px`;
  spot.style.height = `${r.height + PAD * 2}px`;
  // Follow the anchor's corner radius (px), or go round for 50% and the like; else the CSS default.
  const rad = getComputedStyle(el).borderTopLeftRadius;
  const px = /px$/.test(rad) ? parseFloat(rad) : 0;
  if (px > 0) spot.style.borderRadius = `${px + PAD}px`;
  else if (rad && rad !== '0px') spot.style.borderRadius = `${Math.min(r.width, r.height) / 2 + PAD}px`;
  else spot.style.borderRadius = '';
}

function schedule() {
  if (S.open && !S.raf) S.raf = requestAnimationFrame(position);
}

/* ---------- walking ---------- */

function stopWaiting() {
  if (S.waitRaf) cancelAnimationFrame(S.waitRaf);
  if (S.waitTimer) clearTimeout(S.waitTimer);
  S.waitRaf = 0; S.waitTimer = 0;
}

// Shows stop i, navigating to its route first. dir is the walk direction (1 or -1), used when
// the anchor never renders and the stop is skipped.
function show(i, dir) {
  const stop = TOUR_STOPS[i];
  stopWaiting();
  S.idx = i; S.dir = dir; S.busy = true;
  S.host.dataset.busy = '';
  mark();
  const cur = H.pageRoute();
  if (cur.name !== stop.route || Object.keys(cur.params || {}).length) {
    S.nav = true;
    try { H.api.go(stop.route, {}, { replace: true }); } finally { S.nav = false; }
  }
  if (!S.open) return;
  const seq = ++S.seq;
  const t0 = Date.now();
  // Runs on every frame and on every mutation batch until the anchor renders or time runs out.
  const poll = () => {
    if (S.waitRaf) cancelAnimationFrame(S.waitRaf);
    S.waitRaf = 0;
    if (!S.open || seq !== S.seq || !S.busy) return;
    const el = anchorOf(stop);
    if (el) { stopWaiting(); found(stop, el); return; }
    if (Date.now() - t0 >= WAIT_MS) { stopWaiting(); missing(); return; }
    S.waitRaf = requestAnimationFrame(poll);
  };
  S.poll = poll;
  // The timer still ends the wait when frames are throttled.
  S.waitTimer = setTimeout(() => { if (seq === S.seq && S.busy) poll(); }, WAIT_MS + 50);
  poll();
}

function found(stop, el) {
  S.busy = false;
  S.shown = S.idx;
  S.poll = null;
  delete S.host.dataset.busy;
  S.host.innerHTML = calloutHtml(stop);
  mark();
  reveal(el);
  position();
  S.host.querySelector('[data-tour="next"],[data-tour="done"]')?.focus({ preventScroll: true });
}

// The anchor never rendered: drop the stop from the count and keep walking the same way. Going
// back past the first shown stop returns to it; going forward past the last ends the tour.
function missing() {
  S.skipped.add(S.idx);
  const j = step(S.idx, S.dir);
  if (j >= 0) show(j, S.dir);
  else if (S.dir < 0 && S.shown >= 0) show(S.shown, 1);
  else end();
}

function next() {
  if (S.busy) return;
  const j = step(S.idx, 1);
  if (j < 0) end(); else show(j, 1);
}

function back() {
  if (S.busy) return;
  const j = step(S.idx, -1);
  if (j >= 0) show(j, -1);
}

function cycleFocus(backwards) {
  const f = [...S.host.querySelectorAll('button:not([disabled])')];
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  const k = i < 0 ? (backwards ? f.length - 1 : 0) : (i + (backwards ? -1 : 1) + f.length) % f.length;
  f[k].focus();
}

/* ---------- listeners ---------- */

// Window, capture phase: runs before the page, the switcher and the key registry, and nothing
// reaches them while the tour is open (Confirm's 1 to 9 and Enter never answer under it).
function onKey(e) {
  if (!S.open) return;
  e.stopPropagation();
  if (e.isComposing) return;
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); end(); return; }
  if (k === 'Tab') { e.preventDefault(); cycleFocus(e.shiftKey); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); next(); return; }
  if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); back(); return; }
  if (k === 'Enter') {
    // Enter on Back or Skip is that button's own click; anywhere else it moves on, once: the
    // default click on the focused Next or Done is prevented.
    const b = document.activeElement?.closest?.('[data-tour]');
    if (b && S.host.contains(b) && (b.dataset.tour === 'back' || b.dataset.tour === 'skip')) return;
    e.preventDefault();
    next();
  }
}

function onHostClick(e) {
  e.stopPropagation();
  const b = e.target.closest?.('[data-tour]');
  if (!b || b.disabled) return;
  e.preventDefault();
  const k = b.dataset.tour;
  if (k === 'next') next();
  else if (k === 'back') back();
  else end();
}

function onMutate(list) {
  if (!S.open || list.every((m) => S.host.contains(m.target))) return;
  if (S.busy) { if (S.poll) S.poll(); return; }
  mark();
  schedule();
}

function onResize() {
  if (!S.open || S.busy) return;
  const el = mark();
  if (el) reveal(el);
  schedule();
}

function listen(on) {
  const f = on ? 'addEventListener' : 'removeEventListener';
  window[f]('keydown', onKey, true);
  window[f]('resize', onResize);
  window[f]('scroll', schedule, { passive: true, capture: true });
}

/* ---------- start and end ---------- */

export function start(opener) {
  if (!H || !S.host || S.open || H.routeNow().name === 'onboarding') return;
  S.opener = opener || document.activeElement;
  const r = H.pageRoute();
  S.start = { name: r.name, params: { ...(r.params || {}) } };
  if (H.askModal && H.askModal()) H.askPanelToggle();
  S.open = true;
  S.skipped = new Set();
  S.idx = -1; S.shown = -1;
  lockInert();
  listen(true);
  S.mo = new MutationObserver(onMutate);
  S.mo.observe(H.root, { childList: true, subtree: true, characterData: true });
  show(0, 1);
}

// Stops everything the open tour runs, without marking it done or navigating.
function teardown() {
  if (!S.open) return;
  S.open = false;
  S.busy = false;
  S.seq += 1;
  S.poll = null;
  stopWaiting();
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = 0;
  if (S.mo) S.mo.disconnect();
  S.mo = null;
  listen(false);
  H.root?.querySelectorAll('[data-tour-on]').forEach((x) => x.removeAttribute('data-tour-on'));
  if (S.host) { S.host.innerHTML = ''; delete S.host.dataset.busy; }
  unlockInert();
}

// Done, Skip, Escape or leaving the tour's route: the tour counts as seen, the start route comes
// back, then focus returns to the opener (or the redrawn Take the tour button).
function end() {
  if (!S.open) return;
  const { start: from, opener } = S;
  teardown();
  try { window.localStorage.setItem(DONE_KEY, '1'); } catch (e) { /* storage unavailable: the tour may show again */ }
  if (from && !sameRoute(H.pageRoute(), from)) H.api.go(from.name, from.params, { replace: true });
  let target = null;
  if (opener && opener.isConnected && opener !== document.body) target = opener;
  else if (opener && opener.matches?.('[data-tour-start]')) target = q('[data-tour-start]');
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

// Once per page load, on a public demo the browser has not finished the tour in.
export function autoStart() {
  if (autoTried || !H) return;
  autoTried = true;
  if (H.api?.s?.live?.publicDemo !== true) return;
  let done = false;
  try { done = window.localStorage.getItem(DONE_KEY) === '1'; } catch (e) { /* unreadable: not done */ }
  if (!done) start(null);
}

/* ---------- screen contract ---------- */

export function mount() {
  const host = document.createElement('div');
  host.className = 'h-tour-host';
  host.addEventListener('click', onHostClick);
  H.root.appendChild(host);
  S.host = host;
}

export function unmount() {
  teardown();
  if (S.host) { S.host.removeEventListener('click', onHostClick); S.host.remove(); }
  S = fresh();
}

export function reset() {
  if (S.open) teardown();
  S = fresh();
}

// After every draw (name is the route, 'rec' under the rec dialog). A route the tour did not
// navigate to (Back, a hash link) ends it; otherwise the layers stay inert and the anchor is
// marked again on the new markup.
export function afterDraw(name) {
  if (!S.open) return;
  if (!S.nav && S.idx >= 0 && name !== TOUR_STOPS[S.idx].route) {
    // Ending navigates, so it runs after this draw has finished rather than inside it.
    const seq = S.seq;
    queueMicrotask(() => { if (S.open && S.seq === seq) end(); });
    holdInert();
    return;
  }
  holdInert();
  if (!S.busy) { mark(); schedule(); }
}

// The Settings row's Take the tour button.
export function onClick(e) {
  const b = e.target.closest?.('[data-tour-start]');
  if (!b || !H?.root?.contains(b)) return false;
  e.preventDefault();
  start(b);
  return true;
}

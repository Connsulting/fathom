// Console: a keyboard-first design for the Fathom mock.
// Left sidebar, list and detail split panes, a Cmd or Ctrl K command palette, mono for figures.
//
// Reading notes:
//  1. Route params are objects: rec {id}, packs {id}, wargame {name}, onboarding {step}.
//  2. Snooze wakes on the first of next month, labelled from the scenario clock.
//  3. Purely local review state (scope toggles, curve sliders, agenda notes, onboarding checks)
//     lives in this module because the core API has no place for it.
//  4. The design subscribes with api.on and does not define render(), so each change renders once.

const ui = {
  sel: null, packSel: null, fk: {}, kb: false,
  pal: false, pq: '', pi: 0, drawer: false, closed: false, draft: '', g: 0,
  ob: { conn: {}, modal: null, heard: {} },
  prio: {}, curve: {}, scopes: {}, copied: false, agenda: [], agendaDraft: '', ye: {},
};
let api = null;
let root = null;
let off = null;
let lastKey = '';
let lastDemo = '';
let resizeT = 0;
let toastT = 0;

// ---------------------------------------------------------------- helpers

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arr = v => (Array.isArray(v) ? v : []);
const T = s => (s == null || s === '' ? '' : api.t(String(s)));
const X = s => (s == null ? '' : api.txt(String(s)));
const A = s => esc(X(s));
const M = (n, o) => api.money(Number(n) || 0, o);
// Engine costs are small dollar amounts; api.money rounds to whole dollars, so keep cents when present.
const MC = n => { const v = Number(n) || 0; return Number.isInteger(v) ? api.money(v) : (v < 0 ? '-' : '') + '$' + Math.abs(v).toFixed(2); };
const S = () => api.s || {};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MODK = isMac ? '⌘K' : 'Ctrl K';
const narrow = () => window.innerWidth < 900;
const param = r => { const p = (r && r.params) || {}; return p.id ?? p.step ?? p.name; };

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
const today = () => parseISO(S().meta && S().meta.clock);
const daysTo = iso => Math.round((parseISO(iso) - today()) / 864e5);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function clockParts() { const d = new Date(today()); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; }
function wakeLabel() { const c = clockParts(); return MONTHS[(c.m + 1) % 12] + ' 1'; }

const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const visRecs = () => api.recs().filter(r => r.status !== 'hidden');
const domainOf = id => arr(S().domains).find(d => d.id === id);

const ST = { proposed: 'New', doing: 'Doing it', waiting: 'Waiting', snoozed: 'Snoozed', done: 'Done', dismissed: 'Dismissed', hidden: 'Behind a pack' };
function stLabel(r) {
  if (r.status === 'waiting') return 'Waiting on ' + (r.waitingOn || 'something');
  if (r.status === 'snoozed' && r.wake) return 'Snoozed until ' + X(r.wake);
  return ST[r.status] || r.status;
}
const TRIG = { calendar: 'Calendar', income: 'Income change', life: 'Life event', goal: 'Goal', advisor: 'Advisor' };
const VCLS = { tax: 'Tax', timing: 'Timing', retire: 'Retirement', risk: 'Risk', cash: 'Cash', goal: 'Goal' };
const ACT = {
  start: { l: 'Doing it', k: 'a', done: 'Doing it' },
  complete: { l: 'Complete', k: 'c', done: 'Completed' },
  snooze: { l: 'Snooze', k: 's', done: 'Snoozed until ' },
  dismiss: { l: 'Dismiss', k: 'd', done: 'Dismissed' },
  reopen: { l: 'Reopen', k: 'r', done: 'Reopened' },
};
function actionsFor(st) {
  return ({
    proposed: ['start', 'complete', 'snooze', 'dismiss'],
    doing: ['complete', 'snooze', 'dismiss'],
    waiting: ['complete', 'snooze'],
    snoozed: ['reopen', 'complete'],
    done: ['reopen'],
    dismissed: ['reopen'],
  })[st] || [];
}
const primaryAct = st => ({ proposed: 'start', doing: 'complete', waiting: 'complete', snoozed: 'reopen', done: 'reopen', dismissed: 'reopen' })[st];

function doAct(id, a) {
  const r = api.rec(id);
  if (!r || !ACT[a]) return;
  const before = api.verdict().level;
  const wake = wakeLabel();
  api.act(id, a, a === 'snooze' ? wake : undefined);
  let msg = ACT[a].done + (a === 'snooze' ? wake : '') + ': ' + X(r.title);
  if (before !== 'clear' && api.verdict().level === 'clear') msg = 'All clear. Nothing needs you.';
  toast(msg);
}

function toast(text) {
  const el = root && root.querySelector('.cx-toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('is-on'), 2200);
}

function go(name, params) { ui.drawer = false; api.go(name, params); }

// ---------------------------------------------------------------- icons

const ICONS = {
  brief: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  plan: '<path d="M5 7h1.5M5 12h1.5M5 17h1.5M10 7h9M10 12h9M10 17h9"/>',
  ask: '<path d="M5 5.5h14v10H10l-4 3.5v-3.5H5z"/>',
  wargame: '<path d="M4 4v16h16"/><circle cx="8.5" cy="15" r="1.3"/><circle cx="12.5" cy="10.5" r="1.3"/><circle cx="17.5" cy="7.5" r="1.3"/>',
  packs: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  goals: '<path d="M6 21V4M6 5h11l-2.5 4L17 13H6"/>',
  accounts: '<path d="M4 9.5L12 5l8 4.5M6 10v7M10 10v7M14 10v7M18 10v7M4 19.5h16"/>',
  advisor: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-4 3.8-6 7-6s6 2 7 6"/>',
  yearend: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M10 12h5M10 16h5"/>',
  connect: '<path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
  engine: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21"/>',
  email: '<rect x="3.5" y="6" width="17" height="12" rx="1.5"/><path d="M4 7l8 6 8-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  arrow: '<path d="M5 12h13M13 7l5 5-5 5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 2"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="1.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  doc: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4"/>',
};
const ico = (n, cls) => '<svg class="cx-ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';

function glyph(st) {
  const c = '<circle cx="8" cy="8" r="6"/>';
  const inner = {
    proposed: '<circle cx="8" cy="8" r="6" stroke-dasharray="2.2 2.1"/>',
    open: c,
    doing: c + '<path class="f" d="M8 4.5a3.5 3.5 0 0 1 0 7z"/>',
    waiting: c + '<path d="M6.6 6v4M9.4 6v4"/>',
    snoozed: c + '<path d="M8 5.2v3l2 1.3"/>',
    done: '<circle class="f" cx="8" cy="8" r="6.5"/><path class="k" d="M5.3 8.2l1.9 1.9 3.6-3.8"/>',
    dismissed: c + '<path d="M6 6l4 4M10 6l-4 4"/>',
    hidden: '<circle cx="8" cy="8" r="6" stroke-dasharray="1 2.4"/>',
  }[st] || c;
  return '<svg class="cx-st cx-st-' + esc(st) + '" viewBox="0 0 16 16" aria-label="' + esc(ST[st] || st) + '">' + inner + '</svg>';
}

function advMark(r) {
  if (!r.advisor) return '';
  const v = r.advisor.verdict;
  const body = v === 'confirmed' ? '<path d="M5.2 8.3l2 2 3.7-4"/>' : v === 'vetoed' ? '<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>' : '<path d="M5 8h.01M8 8h.01M11 8h.01"/>';
  const label = v === 'confirmed' ? 'Advisor confirmed' : v === 'vetoed' ? 'Advisor vetoed' : 'Advisor review pending';
  return '<svg class="cx-adv cx-adv-' + esc(v) + '" viewBox="0 0 16 16" role="img" aria-label="' + label + '"><title>' + label + '</title><rect x="1.5" y="1.5" width="13" height="13" rx="3.5"/>' + body + '</svg>';
}
const advWord = v => ({ confirmed: 'Confirmed', vetoed: 'Vetoed', pending: 'Pending review' })[v] || 'Not reviewed';

const kbd = k => (k ? '<kbd>' + esc(k) + '</kbd>' : '');

function bar(frac, cls) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return '<svg class="cx-bar' + (cls ? ' ' + cls : '') + '" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="t" x="0" y="0" width="100" height="4" rx="0"/><rect class="v" x="0" y="0" width="' + (f * 100).toFixed(2) + '" height="4"/></svg>';
}

// ---------------------------------------------------------------- shell

const NAV = [
  ['', [['brief', 'Brief', 'b'], ['plan', 'Plan', 'p'], ['ask', 'Ask', 'a'], ['wargame', 'War game', 'w']]],
  ['Household', [['goals', 'Goals', 'o'], ['accounts', 'Accounts', 'c'], ['packs', 'Packs', 'k'], ['advisor', 'Advisor', 'v'], ['yearend', 'Year-end', 'y']]],
  ['Settings', [['connect', 'Connect AI', 'n'], ['engine', 'Engine', 'e'], ['email', 'Monthly email', 'm']]],
];
const ROUTE_LABEL = {};
NAV.forEach(g => g[1].forEach(([n, l]) => { ROUTE_LABEL[n] = l; }));

function navCount(n) {
  if (n === 'brief') return api.needsYou().length;
  if (n === 'plan') return visRecs().filter(r => !['done', 'dismissed'].includes(r.status)).length;
  if (n === 'advisor') return arr(S().advisor && S().advisor.pending).filter(id => { const r = api.rec(id); return r && r.status !== 'hidden' && r.status !== 'done' && r.status !== 'dismissed'; }).length;
  if (n === 'packs') return api.packs().filter(p => p.status === 'suggested').length;
  return 0;
}

function sidebar(active) {
  const meta = S().meta || {};
  const groups = NAV.map(([title, items]) =>
    '<div class="cx-nav-g">' + (title ? '<div class="cx-nav-h">' + esc(title) + '</div>' : '') +
    items.map(([n, l, k]) => {
      const c = navCount(n);
      const on = active === n || (active === 'rec' && n === 'plan');
      return '<a class="cx-nav-i' + (on ? ' is-on' : '') + '" href="#/' + n + '" data-c="go" data-r="' + n + '">' + ico(n) +
        '<span class="cx-nav-l">' + esc(l) + '</span>' +
        (c ? '<span class="cx-nav-n' + (n === 'brief' ? ' is-acc' : '') + '">' + c + '</span>' : '') +
        '<span class="cx-nav-k">g ' + k + '</span></a>';
    }).join('') + '</div>').join('');
  return '<aside class="cx-side">' +
    '<div class="cx-brand">' + logo() + '<div class="cx-brand-t"><div class="cx-brand-n">' + T(meta.product || 'Fathom') + '</div><div class="cx-brand-h">' + T(meta.household) + '</div></div></div>' +
    '<button type="button" class="cx-search" data-c="pal">' + ico('search') + '<span>Search or jump</span>' + kbd(MODK) + '</button>' +
    '<nav class="cx-nav" aria-label="Main">' + groups + '</nav>' +
    '<div class="cx-side-foot"><span>Mirrored through ' + T(meta.dataThrough) + '</span><span>Read-only</span></div>' +
    '</aside>';
}

function logo() {
  return '<svg class="cx-logo" viewBox="0 0 20 20" aria-hidden="true"><rect width="20" height="20" rx="5"/><path d="M5 7.5h10M6.5 10.5h7M8.5 13.5h3"/></svg>';
}

function crumbs(r) {
  const n = r.name;
  const id = param(r);
  if (n === 'rec') {
    const rec = api.rec(id);
    return '<a href="#/plan" data-c="go" data-r="plan">Plan</a><span class="cx-sep">/</span><span class="cx-crumb-cur">' + (rec ? T(rec.title) : '') + '</span>';
  }
  if (n === 'packs' && id) {
    const p = api.pack(id);
    return '<a href="#/packs" data-c="go" data-r="packs">Packs</a><span class="cx-sep">/</span><span class="cx-crumb-cur">' + (p ? T(p.name) : '') + '</span>';
  }
  return '<span class="cx-crumb-cur">' + esc(ROUTE_LABEL[n] || 'Brief') + '</span>';
}

function topbar(r) {
  const on = api.engineOn();
  const back = r.name === 'rec' ? '<button type="button" class="cx-iconbtn cx-mback" data-c="go" data-r="plan" aria-label="Back to plan">' + ico('back') + '</button>' : '';
  return '<header class="cx-top">' +
    '<button type="button" class="cx-iconbtn cx-menu" data-c="drawer" aria-label="Menu">' + ico('menu') + '</button>' + back +
    '<div class="cx-crumb">' + crumbs(r) + '</div>' +
    '<div class="cx-top-r">' +
      '<a class="cx-eng' + (on ? '' : ' is-off') + '" href="#/engine" data-c="go" data-r="engine"><i></i>' + (on ? 'Engine on' : 'Engine paused') + '</a>' +
      '<button type="button" class="cx-kbtn" data-c="pal" aria-label="Open command palette">' + ico('search') + '<span class="cx-kbtn-l">Jump to</span>' + kbd(MODK) + '</button>' +
    '</div></header>';
}

const SPLIT = new Set(['plan', 'rec', 'packs', 'ask']);

function shell(r) {
  const fn = PAGES[r.name] || PAGES.brief;
  const split = SPLIT.has(r.name);
  return '<div class="cx-shell' + (ui.drawer ? ' is-drawer' : '') + '">' + sidebar(r.name) +
    '<div class="cx-scrim" data-c="drawer"></div>' +
    '<main class="cx-main">' + topbar(r) +
    '<div class="cx-page' + (split ? ' is-split' : '') + ' cx-r-' + esc(r.name) + '"' + (split ? '' : ' data-sk="page"') + '>' + fn(r) + '</div>' +
    '</main></div>';
}

// ---------------------------------------------------------------- rows

function winCell(r) {
  if (r.status === 'done') return '<span class="cx-win is-muted">Done</span>';
  if (r.status === 'dismissed') return '<span class="cx-win is-muted">Dismissed</span>';
  if (r.status === 'snoozed') return '<span class="cx-win is-muted"><span class="cx-win-l">' + (r.wake ? T(r.wake) : 'Snoozed') + '</span></span>';
  const d = r.window && typeof r.window.days === 'number' ? r.window.days : null;
  return '<span class="cx-win' + (d != null && d <= 30 ? ' is-soon' : '') + '">' +
    (d != null ? '<span class="cx-win-d">' + d + 'd</span>' : '') +
    '<span class="cx-win-l">' + T(r.window && r.window.label) + '</span></span>';
}

function valueClasses(r) {
  const seen = [];
  arr(r.value).forEach(v => { const l = VCLS[v.cls] || v.cls; if (l && seen.indexOf(l) < 0) seen.push(l); });
  return seen.join(', ');
}

function inlineActs(r) {
  const p = primaryAct(r.status);
  const extra = actionsFor(r.status).filter(a => a !== p && (a === 'snooze' || a === 'dismiss'));
  return '<span class="cx-inl">' +
    (p ? '<button type="button" class="cx-ibtn is-p" data-c="act" data-id="' + esc(r.id) + '" data-a="' + p + '" title="' + ACT[p].l + (ACT[p].k ? ' (' + ACT[p].k + ')' : '') + '">' + ACT[p].l + '</button>' : '') +
    extra.map(a => '<button type="button" class="cx-ibtn is-i" data-c="act" data-id="' + esc(r.id) + '" data-a="' + a + '" title="' + ACT[a].l + ' (' + ACT[a].k + ')" aria-label="' + ACT[a].l + '">' + ico(a === 'snooze' ? 'clock' : 'x') + '</button>').join('') +
    '</span>';
}

function recRow(r, o) {
  o = o || {};
  const meta = [X(r.triggerText), X(r.effort), valueClasses(r)].filter(Boolean).map(esc).join('<span class="cx-dot"></span>');
  const attrs = o.select
    ? ' data-c="sel" data-id="' + esc(r.id) + '"'
    : ' data-c="go" data-r="rec" data-id="' + esc(r.id) + '"';
  return '<div class="cx-row' + (o.sel === r.id ? ' is-sel' : '') + (o.compact ? ' is-compact' : '') + '" data-nav data-key="' + esc(r.id) + '" data-rec="' + esc(r.id) + '"' + attrs + ' tabindex="-1">' +
    glyph(r.status) +
    '<div class="cx-row-main"><div class="cx-row-title">' + T(r.title) + '</div>' +
    (o.summary ? '<div class="cx-row-sum">' + T(r.summary) + '</div>' : '') +
    (o.compact ? '' : '<div class="cx-row-meta">' + meta + '</div>') + '</div>' +
    '<div class="cx-row-side">' + (o.inline === false ? '' : inlineActs(r)) + winCell(r) + '<span class="cx-adv-slot">' + advMark(r) + '</span></div>' +
    '</div>';
}

const hintLine = extra => '<span class="cx-hint">' + kbd('j') + kbd('k') + ' move ' + kbd('enter') + ' open' + (extra ? ' ' + extra : '') + '</span>';
const actHint = () => kbd('a') + kbd('s') + kbd('d') + kbd('c') + ' act';

function secHead(title, right, count) {
  return '<div class="cx-sh"><h2>' + esc(title) + (count != null ? '<span class="cx-sh-n">' + count + '</span>' : '') + '</h2>' + (right || '') + '</div>';
}

// ---------------------------------------------------------------- brief

function yearClock() {
  const c = clockParts();
  const y = c.y;
  const yearDays = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 864e5;
  const doy = d => (d - Date.UTC(y, 0, 1)) / 864e5;
  const ang = d => (doy(d) / yearDays) * Math.PI * 2 - Math.PI / 2;
  const R = 70; const cx = 90; const cy = 90;
  const pt = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  const t0 = today();
  const aNow = ang(t0);
  const [ex, ey] = pt(aNow, R);
  const large = aNow + Math.PI / 2 > Math.PI ? 1 : 0;
  let s = '<svg class="cx-clock" viewBox="0 0 180 180" role="img" aria-label="Year clock">';
  s += '<circle class="ring" cx="' + cx + '" cy="' + cy + '" r="' + R + '"/>';
  s += '<path class="elapsed" d="M' + cx + ' ' + (cy - R) + ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ex.toFixed(2) + ' ' + ey.toFixed(2) + '"/>';
  for (let m = 0; m < 12; m++) {
    const a = ang(Date.UTC(y, m, 1));
    const [x1, y1] = pt(a, R - 5); const [x2, y2] = pt(a, R + 5);
    s += '<line class="tick" x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    const am = ang(Date.UTC(y, m, 15));
    const [lx, ly] = pt(am, R + 13);
    s += '<text class="mo' + (m === c.m ? ' is-now' : '') + '" x="' + lx.toFixed(1) + '" y="' + (ly + 3).toFixed(1) + '" text-anchor="middle">' + MONTHS[m].charAt(0) + '</text>';
  }
  arr(S().deadlines).forEach(d => {
    const t = parseISO(d.date);
    if (!(t >= Date.UTC(y, 0, 1) && t < Date.UTC(y + 1, 0, 1))) return;
    const [x, yy] = pt(ang(t), R);
    s += '<circle class="dl' + (d.hard ? ' is-hard' : '') + (t < t0 ? ' is-past' : '') + '" cx="' + x.toFixed(1) + '" cy="' + yy.toFixed(1) + '" r="' + (d.hard ? 4 : 3.2) + '"><title>' + A(d.label) + ' ' + A(d.title) + '</title></circle>';
  });
  s += '<circle class="now" cx="' + ex.toFixed(1) + '" cy="' + ey.toFixed(1) + '" r="3.5"/>';
  const left = Math.round((Date.UTC(y + 1, 0, 1) - t0) / 864e5);
  s += '<text class="big" x="' + cx + '" y="' + (cy + 2) + '" text-anchor="middle">' + left + '</text>';
  s += '<text class="small" x="' + cx + '" y="' + (cy + 17) + '" text-anchor="middle">days left in ' + y + '</text>';
  s += '</svg>';
  return s;
}

function deadlineList() {
  const list = arr(S().deadlines).map(d => Object.assign({}, d, { dd: daysTo(d.date) })).filter(d => d.dd >= 0).sort((a, b) => a.dd - b.dd).slice(0, 7);
  if (!list.length) return '<div class="cx-empty">No deadlines ahead.</div>';
  return '<div class="cx-dl">' + list.map(d => {
    const rec = d.recId ? api.rec(d.recId) : null;
    const link = rec && rec.status !== 'hidden';
    return '<' + (link ? 'a href="#/rec/' + esc(d.recId) + '" data-c="go" data-r="rec" data-id="' + esc(d.recId) + '"' : 'div') + ' class="cx-dl-i' + (link ? ' is-link' : '') + '">' +
      '<span class="cx-dl-d">' + T(d.label) + '</span>' +
      '<span class="cx-dl-t">' + T(d.title) + (d.hard ? '<span class="cx-hard">hard</span>' : '') + '</span>' +
      '<span class="cx-dl-n">' + d.dd + 'd</span>' + (link ? glyph(rec.status) : '<span class="cx-st-sp"></span>') +
      '</' + (link ? 'a' : 'div') + '>';
  }).join('') + '</div>';
}

const DOM_ST = { covered: 'Covered', changed: 'Changed', needs: 'Needs you', waiting: 'Waiting' };
function domGlyph(st) {
  return { covered: glyph('done'), changed: glyph('doing'), needs: glyph('proposed'), waiting: glyph('waiting') }[st] || glyph('open');
}

const EV_KIND = { income: 'Income', life: 'Life', calendar: 'Calendar', account: 'Account', milestone: 'Milestone' };

function pgBrief() {
  const v = api.verdict();
  const needs = api.needsYou();
  const c = clockParts();
  const meta = S().meta || {};
  const clear = v.level === 'clear';
  const needIds = new Set(needs.map(r => r.id));
  const motion = visRecs().filter(r => !needIds.has(r.id) && ['doing', 'waiting'].includes(r.status)).sort((a, b) => (a.window.days || 0) - (b.window.days || 0));

  const verdict = '<section class="cx-verdict' + (clear ? ' is-clear' : '') + '">' +
    '<div class="cx-eyebrow">' + esc(MONTHS_LONG[c.m]) + ' brief<span class="cx-dot"></span>' + T(meta.clockLabel) + '</div>' +
    '<div class="cx-v-row"><span class="cx-v-mark">' + (clear ? ico('check') : '<span>' + needs.length + '</span>') + '</span>' +
    '<div><h1>' + T(v.headline) + '</h1><p>' + T(v.sub) + '</p></div></div></section>';

  const needsSec = '<section class="cx-sec">' + secHead('Needs you', needs.length ? hintLine(actHint()) : '', needs.length) +
    (needs.length
      ? '<div class="cx-list">' + needs.map(r => recRow(r, { summary: true })).join('') + '</div>'
      : '<div class="cx-empty is-clear">' + ico('check') + '<span>Nothing needs you right now. Fathom keeps watching and will tell you when something changes.</span></div>') +
    '</section>';

  const motionSec = motion.length ? '<section class="cx-sec">' + secHead('In motion', '<a class="cx-more" href="#/plan" data-c="go" data-r="plan">Open plan</a>', motion.length) +
    '<div class="cx-list">' + motion.map(r => recRow(r, { compact: true, inline: false })).join('') + '</div></section>' : '';

  const yearSec = '<section class="cx-sec">' + secHead('Year', '<span class="cx-hint">' + '<i class="cx-key-hard"></i>hard deadline <i class="cx-key-soft"></i>soft</span>') +
    '<div class="cx-year">' + yearClock() + deadlineList() + '</div></section>';

  const changed = '<section class="cx-sec">' + secHead('What changed') + '<div class="cx-events">' +
    arr(S().events).map(e => '<div class="cx-ev"><span class="cx-ev-d">' + T(e.date) + '</span><div><div class="cx-ev-t">' + T(e.title) + '<span class="cx-ev-k">' + esc(EV_KIND[e.kind] || e.kind) + '</span></div><div class="cx-ev-b">' + T(e.body) + '</div></div></div>').join('') +
    '</div></section>';

  const domains = '<section class="cx-sec">' + secHead('Coverage') + '<div class="cx-doms">' +
    arr(S().domains).map(d => '<div class="cx-dom">' + domGlyph(d.status) + '<div class="cx-dom-m"><div class="cx-dom-n">' + T(d.name) + '<span class="cx-dom-s is-' + esc(d.status) + '">' + esc(DOM_ST[d.status] || d.status) + '</span></div>' +
      '<div class="cx-dom-note">' + T(d.note) + '</div><div class="cx-dom-w">Watching: ' + T(d.watching) + '</div></div></div>').join('') +
    '</div></section>';

  return '<div class="cx-wrap cx-brief">' + verdict + needsSec + yearSec + motionSec +
    '<div class="cx-two">' + changed + domains + '</div>' +
    '<a class="cx-foot-link" href="#/email" data-c="go" data-r="email">' + ico('email') + '<span>This brief also went out as the monthly email</span>' + ico('arrow') + '</a>' +
    '</div>';
}

// ---------------------------------------------------------------- plan and rec detail

const GROUPS = [
  ['Needs a decision', ['proposed']], ['Doing it', ['doing']],
  ['Waiting', ['waiting']], ['Snoozed', ['snoozed']], ['Done', ['done']], ['Dismissed', ['dismissed']],
];

function orderedRecs() {
  const recs = visRecs();
  const out = [];
  GROUPS.forEach(([, sts]) => recs.filter(r => sts.includes(r.status)).sort((a, b) => (a.window.days || 0) - (b.window.days || 0)).forEach(r => out.push(r)));
  return out;
}

function planSel(id) {
  const recs = orderedRecs();
  if (id && api.rec(id)) return id;
  if (ui.sel && recs.find(r => r.id === ui.sel)) return ui.sel;
  const n = api.needsYou()[0];
  return n ? n.id : (recs[0] && recs[0].id);
}

function pgPlan(r) {
  const isRec = r.name === 'rec';
  const sel = planSel(isRec ? param(r) : null);
  ui.sel = sel;
  const recs = visRecs();
  const needs = api.needsYou().length;
  const open = recs.filter(x => !['done', 'dismissed'].includes(x.status)).length;
  const done = recs.filter(x => x.status === 'done').length;
  const list = GROUPS.map(([label, sts]) => {
    const items = recs.filter(x => sts.includes(x.status)).sort((a, b) => (a.window.days || 0) - (b.window.days || 0));
    if (!items.length) return '';
    const closed = sts[0] === 'done' || sts[0] === 'dismissed';
    const collapsed = closed && !ui.closed && !items.some(x => x.id === sel);
    return '<div class="cx-grp"><button type="button" class="cx-grp-h" data-c="closed">' + glyph(sts[0]) + '<span>' + esc(label) + '</span><span class="cx-grp-n">' + items.length + '</span>' + (closed ? '<span class="cx-grp-t">' + (collapsed ? 'Show' : 'Hide') + '</span>' : '') + '</button>' +
      (collapsed ? '' : items.map(x => recRow(x, { select: true, sel })).join('')) + '</div>';
  }).join('');
  const rec = sel ? api.rec(sel) : null;
  return '<div class="cx-split' + (isRec ? ' show-detail' : ' show-list') + '">' +
    '<div class="cx-pane cx-pane-list" data-sk="plan-list">' +
      '<div class="cx-pane-h"><h1>Plan</h1><div class="cx-stats"><span><b>' + needs + '</b> need you</span><span><b>' + open + '</b> open</span><span><b>' + done + '</b> done</span></div></div>' +
      '<div class="cx-pane-hint">' + hintLine(actHint()) + '</div>' +
      '<div class="cx-list">' + list + '</div>' +
    '</div>' +
    '<div class="cx-pane cx-pane-detail" data-sk="detail">' + (rec ? recDetail(rec) : '<div class="cx-empty">Nothing here yet.</div>') + '</div>' +
  '</div>';
}

function stripTags(h) { return String(h || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }

function thread(msgs, opts) {
  opts = opts || {};
  if (!msgs.length) return opts.empty ? '<div class="cx-empty">' + opts.empty + '</div>' : '';
  return '<div class="cx-thread">' + msgs.map(m => {
    const who = m.role === 'me' ? 'You' : m.role === 'advisor' ? T(S().advisor && S().advisor.name) : T((S().meta && S().meta.product) || 'Fathom');
    const refs = arr(m.refs).map(id => api.rec(id)).filter(x => x && x.status !== 'hidden' && x.id !== opts.self);
    return '<div class="cx-msg is-' + esc(m.role) + (m.notice ? ' is-notice' : '') + '">' +
      '<div class="cx-msg-h"><span class="cx-msg-who">' + who + '</span><span class="cx-msg-ts">' + esc(m.ts || '') + '</span></div>' +
      '<div class="cx-msg-b">' + (m.html || '') + '</div>' +
      (refs.length ? '<div class="cx-refs">' + refs.map(x => '<a href="#/rec/' + esc(x.id) + '" data-c="go" data-r="rec" data-id="' + esc(x.id) + '">' + glyph(x.status) + '<span>' + T(x.title) + '</span></a>').join('') + '</div>' : '') +
      '</div>';
  }).join('') + '</div>';
}

function recDetail(r) {
  const dom = domainOf(r.domain);
  const tasks = arr(r.tasks);
  const nd = tasks.filter(t => t.done).length;
  const acts = actionsFor(r.status);
  const days = r.window && typeof r.window.days === 'number' ? r.window.days : null;
  const conv = api.conversation(r.id);
  const askedQ = new Set(conv.filter(m => m.role === 'me').map(m => stripTags(m.html)));

  const actbar = '<div class="cx-actbar">' + acts.map((a, i) =>
    '<button type="button" class="cx-btn' + (i === 0 ? ' is-p' : '') + '" data-c="act" data-id="' + esc(r.id) + '" data-a="' + a + '">' + ACT[a].l + kbd(ACT[a].k) + '</button>').join('') + '</div>';

  const props = '<dl class="cx-props">' +
    '<div><dt>Status</dt><dd>' + glyph(r.status) + '<span>' + esc(stLabel(r)) + '</span></dd></div>' +
    '<div><dt>Window</dt><dd>' + (days != null && !['done', 'dismissed'].includes(r.status) ? '<span class="cx-mono' + (days <= 30 ? ' cx-acc' : '') + '">' + days + 'd</span>' : '') + '<span>' + T(r.window && r.window.label) + '</span></dd></div>' +
    '<div><dt>Trigger</dt><dd><span>' + esc(TRIG[r.trigger] || r.trigger) + '</span></dd></div>' +
    '<div><dt>Effort</dt><dd><span>' + T(r.effort) + '</span></dd></div>' +
    (dom ? '<div><dt>Domain</dt><dd><span>' + T(dom.name) + '</span></dd></div>' : '') +
    '<div><dt>Advisor</dt><dd>' + (advMark(r) || '') + '<span>' + advWord(r.advisor && r.advisor.verdict) + '</span></dd></div>' +
    '</dl>';

  const value = arr(r.value).length ? '<div class="cx-side-sec"><div class="cx-side-h">Value</div>' +
    arr(r.value).map(v => '<div class="cx-val"><span class="cx-val-c">' + esc(VCLS[v.cls] || v.cls) + '</span><span>' + T(v.text) + '</span></div>').join('') +
    '<div class="cx-faint cx-small">Listed, never summed.</div></div>' : '';

  const adv = r.advisor ? '<div class="cx-side-sec"><div class="cx-side-h">Advisor note</div><div class="cx-adv-note">' + advMark(r) + '<span>' + T(r.advisor.note) + '</span></div></div>' : '';

  const why = arr(r.why).length ? '<section class="cx-dsec"><h3>Why now</h3><div class="cx-trig">' + esc(TRIG[r.trigger] || '') + '<span class="cx-dot"></span>' + T(r.triggerText) + '</div>' + arr(r.why).map(p => '<p>' + T(p) + '</p>').join('') + '</section>' : '';

  const mine = arr(r.mine).length ? '<section class="cx-dsec"><h3>From your data</h3><div class="cx-figs">' +
    arr(r.mine).map(m => '<div class="cx-figt"><div class="cx-figt-l">' + T(m.label) + '</div><div class="cx-figt-v">' + T('{f:' + m.fig + '}') + '</div></div>').join('') +
    '</div></section>' : '';

  const check = tasks.length ? '<section class="cx-dsec"><h3>Checklist<span class="cx-h-n">' + nd + ' of ' + tasks.length + '</span></h3>' + bar(nd / tasks.length, 'cx-bar-acc') +
    '<div class="cx-tasks">' + tasks.map((t, i) => '<button type="button" class="cx-task' + (t.done ? ' is-done' : '') + '" data-c="task" data-id="' + esc(r.id) + '" data-i="' + i + '" role="checkbox" aria-checked="' + !!t.done + '"><span class="cx-cb">' + (t.done ? ico('check') : '') + '</span><span>' + T(t.t) + '</span></button>').join('') + '</div></section>' : '';

  const kb = arr(r.kb).length ? '<section class="cx-dsec"><h3>From the knowledge base</h3>' + arr(r.kb).map(k => {
    const p = k.pack ? api.pack(k.pack) : null;
    return '<div class="cx-kb"><div class="cx-kb-t">' + T(k.title) + '</div><div class="cx-kb-b">' + T(k.body) + '</div>' +
      '<div class="cx-kb-f"><span class="cx-cite">' + T(k.cite) + '</span>' +
      (p ? '<a href="#/packs/' + esc(p.id) + '" data-c="go" data-r="packs" data-id="' + esc(p.id) + '">' + ico('packs') + '<span>' + T(p.name) + ' pack</span></a>' : '') + '</div></div>';
  }).join('') + '</section>' : '';

  const cross = arr(r.cross).length ? '<section class="cx-dsec"><h3>Touches</h3><ul class="cx-cross">' + arr(r.cross).map(c => '<li>' + T(c) + '</li>').join('') + '</ul></section>' : '';

  const wg = r.scenario ? '<a class="cx-wglink" href="#/wargame/' + esc(r.scenario) + '" data-c="go" data-r="wargame" data-id="' + esc(r.scenario) + '">' + ico('wargame') + '<span>War-game this: ' + T(S().wargame && S().wargame[r.scenario] && S().wargame[r.scenario].title) + '</span>' + ico('arrow') + '</a>' : '';

  const qa = arr(r.qa);
  const follow = qa.length ? '<div class="cx-follow">' + qa.map((q, i) => {
    const asked = askedQ.has(X(q.q).trim());
    return '<button type="button" class="cx-fq' + (asked ? ' is-asked' : '') + '" data-c="askrec" data-id="' + esc(r.id) + '" data-i="' + i + '">' + ico('ask') + '<span>' + T(q.q) + '</span>' + (asked ? '<span class="cx-faint cx-small">asked</span>' : ico('arrow')) + '</button>';
  }).join('') + '</div>' : '';

  const discuss = '<section class="cx-dsec"><h3>Discuss</h3>' + thread(conv, { self: r.id }) + follow +
    (api.engineOn() ? '' : '<div class="cx-notice">Engine is off. Answers are paused.</div>') + '</section>';

  return '<article class="cx-rec">' +
    '<header class="cx-rec-h"><div class="cx-eyebrow">' + glyph(r.status) + '<span>' + esc(stLabel(r)) + '</span><span class="cx-dot"></span><span>' + T(r.triggerText) + '</span></div>' +
    '<h1>' + T(r.title) + '</h1><p class="cx-lede">' + T(r.summary) + '</p>' + actbar + '</header>' +
    '<div class="cx-rec-grid"><div class="cx-rec-main">' + why + mine + check + wg + kb + cross + discuss + '</div>' +
    '<aside class="cx-rec-side">' + props + value + adv + '</aside></div></article>';
}

// ---------------------------------------------------------------- ask

function pgAsk() {
  const sug = arr(S().ask && S().ask.suggested);
  const conv = api.conversation('ask');
  return '<div class="cx-split cx-ask">' +
    '<div class="cx-pane cx-pane-list" data-sk="ask-list">' +
      '<div class="cx-pane-h"><h1>Ask</h1><div class="cx-stats"><span>Answers cite your mirrored data and plan</span></div></div>' +
      '<div class="cx-pane-hint">' + hintLine() + '</div>' +
      '<div class="cx-list">' + sug.map((q, i) => '<div class="cx-row is-q" data-nav data-key="' + esc(q.id) + '" data-c="ask" data-id="' + esc(q.id) + '" tabindex="-1">' + ico('ask') + '<div class="cx-row-main"><div class="cx-row-title">' + T(q.q) + '</div></div><span class="cx-row-side">' + ico('arrow') + '</span></div>').join('') + '</div>' +
    '</div>' +
    '<div class="cx-pane cx-pane-detail cx-ask-d">' +
      '<div class="cx-ask-scroll" data-sk="ask-thread">' + thread(conv, { empty: 'Pick a question or type your own. Every figure links to its source.' }) + '</div>' +
      '<form class="cx-askf" data-f="ask">' +
        (api.engineOn() ? '' : '<div class="cx-notice">Engine is off. Answers are paused.</div>') +
        '<div class="cx-askbox"><input type="text" name="q" autocomplete="off" placeholder="Ask about your money, a deadline, a what-if" value="' + esc(ui.draft) + '" aria-label="Ask a question"><button type="submit" class="cx-btn is-p">Ask' + kbd('enter') + '</button></div>' +
      '</form>' +
    '</div></div>';
}

// ---------------------------------------------------------------- war game

function chartWidth(maxW, side) {
  const w = window.innerWidth;
  if (w < 900) return Math.max(280, w - 34);
  return Math.max(320, Math.min(maxW, w - 232 - 64 - (w >= 1180 ? side : 0)));
}

function ticks(lo, hi, n) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function salary() {
  const w = S().wargame && S().wargame.salary;
  if (!w) return '<div class="cx-empty">No salary scenario.</div>';
  const pts = arr(w.points);
  const pick = Math.max(0, Math.min(pts.length - 1, Number(api.state.picks && api.state.picks.salary) || 0));
  const W = chartWidth(720, 360);
  const H = Math.round(Math.max(240, Math.min(380, W * 0.56)));
  const pl = 58; const pr = 18; const pt = 26; const pb = 40;
  const xs = pts.map(p => p.x); const ys = pts.map(p => p.y).concat([0]);
  let x0 = Math.min(...xs); let x1 = Math.max(...xs); let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  const px = (x1 - x0) * 0.08 || 1; const py = (y1 - y0) * 0.12 || 1;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const sx = v => pl + (v - x0) / (x1 - x0) * (W - pl - pr);
  const sy = v => pt + (1 - (v - y0) / (y1 - y0)) * (H - pt - pb);
  let s = '<svg class="cx-scatter" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + A(w.title) + '">';
  ticks(y0, y1, 4).forEach(v => { s += '<line class="grid' + (v === 0 ? ' zero' : '') + '" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + sy(v).toFixed(1) + '" y2="' + sy(v).toFixed(1) + '"/><text class="ax" x="' + (pl - 8) + '" y="' + (sy(v) + 3.5).toFixed(1) + '" text-anchor="end">' + esc(M(v, { k: true, sign: true })) + '</text>'; });
  ticks(x0, x1, W < 480 ? 3 : 5).forEach(v => { s += '<line class="grid" y1="' + pt + '" y2="' + (H - pb) + '" x1="' + sx(v).toFixed(1) + '" x2="' + sx(v).toFixed(1) + '"/><text class="ax" x="' + sx(v).toFixed(1) + '" y="' + (H - pb + 16) + '" text-anchor="middle">' + esc(M(v, { k: true })) + '</text>'; });
  s += '<text class="axl" x="' + pl + '" y="14">' + A(w.yLabel) + '</text>';
  s += '<text class="axl" x="' + (W - pr) + '" y="' + (H - 6) + '" text-anchor="end">' + A(w.xLabel) + '</text>';
  const fr = pts.filter(p => p.frontier).sort((a, b) => a.x - b.x);
  if (fr.length > 1) s += '<polyline class="frontier" points="' + fr.map(p => sx(p.x).toFixed(1) + ',' + sy(p.y).toFixed(1)).join(' ') + '"/>';
  pts.forEach((p, i) => {
    const x = sx(p.x).toFixed(1); const y = sy(p.y).toFixed(1);
    const on = i === pick;
    s += '<g class="pt' + (p.frontier ? ' is-fr' : '') + (p.current ? ' is-cur' : '') + (on ? ' is-on' : '') + (p.warn ? ' is-warn' : '') + '" data-c="wg" data-n="salary" data-i="' + i + '">' +
      '<circle class="hit" cx="' + x + '" cy="' + y + '" r="14"/>' +
      (on ? '<circle class="ring" cx="' + x + '" cy="' + y + '" r="9"/>' : '') +
      '<circle class="dot" cx="' + x + '" cy="' + y + '" r="' + (p.current ? 5.5 : 4.5) + '"/>' +
      '<title>' + A(p.label) + '</title></g>';
    if (p.current || on) {
      const right = sx(p.x) < W - 120;
      s += '<text class="plab' + (on ? ' is-on' : '') + '" x="' + (sx(p.x) + (right ? 12 : -12)).toFixed(1) + '" y="' + (sy(p.y) - 10).toFixed(1) + '" text-anchor="' + (right ? 'start' : 'end') + '">' + A(p.label) + (p.current ? '  (now)' : '') + '</text>';
    }
  });
  s += '</svg>';
  const p = pts[pick] || {};
  const cur = pts.find(q => q.current);
  const detail = '<div class="cx-wg-d">' +
    '<div class="cx-eyebrow">' + (p.current ? 'Your plan today' : p.frontier ? 'On the frontier' : 'Off the frontier') + '</div>' +
    '<h3>' + T(p.label) + '</h3>' +
    '<dl class="cx-kv"><div><dt>' + T(w.xLabel) + '</dt><dd>' + esc(M(p.x)) + '</dd></div><div><dt>' + T(w.yLabel) + '</dt><dd>' + esc(M(p.y, { sign: true })) + '</dd></div>' +
    (cur && cur !== p ? '<div><dt>Room vs now</dt><dd>' + esc(M(p.x - cur.x, { sign: true })) + '</dd></div>' : '') + '</dl>' +
    (p.warn ? '<div class="cx-warn">' + T(p.warn) + '</div>' : '') +
    '<p>' + T(p.note) + '</p></div>';
  const list = '<div class="cx-list cx-wg-list">' + pts.map((q, i) =>
    '<div class="cx-row is-pt' + (i === pick ? ' is-sel' : '') + '" data-nav data-key="pt' + i + '" data-c="wg" data-n="salary" data-i="' + i + '" tabindex="-1"><span class="cx-ptdot' + (q.frontier ? ' is-fr' : '') + (q.current ? ' is-cur' : '') + '"></span><div class="cx-row-main"><div class="cx-row-title">' + T(q.label) + (q.current ? ' <span class="cx-faint">now</span>' : '') + '</div></div><span class="cx-row-side cx-mono"><span>' + esc(M(q.x, { k: true })) + '</span><span class="cx-faint">' + esc(M(q.y, { k: true, sign: true })) + '</span></span></div>').join('') + '</div>';
  return '<p class="cx-q">' + T(w.question) + '</p>' +
    '<div class="cx-wg-grid"><div class="cx-wg-chart">' + s + '<div class="cx-legend"><span><i class="lg-fr"></i>Frontier</span><span><i class="lg-cur"></i>Current plan</span><span><i class="lg-off"></i>Off the frontier</span></div></div>' +
    '<div class="cx-wg-side">' + detail + list + '</div></div>' +
    '<div class="cx-take"><span class="cx-side-h">Takeaway</span><p>' + T(w.takeaway) + '</p></div>';
}

function cashBar(o, max) {
  const f = v => Math.max(0, Math.min(1, v / max)) * 100;
  const short = o.decCash < o.need;
  return '<svg class="cx-cash' + (short ? ' is-short' : '') + '" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">' +
    '<rect class="t" x="0" y="2" width="100" height="6"/>' +
    '<rect class="v" x="0" y="2" width="' + f(o.decCash).toFixed(2) + '" height="6"/>' +
    (short ? '<rect class="gap" x="' + f(o.decCash).toFixed(2) + '" y="2" width="' + (f(o.need) - f(o.decCash)).toFixed(2) + '" height="6"/>' : '') +
    '<line class="need" x1="' + f(o.need).toFixed(2) + '" x2="' + f(o.need).toFixed(2) + '" y1="0" y2="10"/></svg>';
}

function deferral() {
  const w = S().wargame && S().wargame.deferral;
  if (!w) return '<div class="cx-empty">No invoicing scenario.</div>';
  const opts = arr(w.options);
  const pick = Math.max(0, Math.min(opts.length - 1, Number(api.state.picks && api.state.picks.deferral) || 0));
  const max = Math.max(...opts.map(o => Math.max(o.decCash, o.need))) * 1.12 || 1;
  const o = opts[pick] || {};
  const margin = o.decCash - o.need;
  const rows = opts.map((q, i) => '<div class="cx-row is-opt' + (i === pick ? ' is-sel' : '') + '" data-nav data-key="opt' + i + '" data-c="wg" data-n="deferral" data-i="' + i + '" tabindex="-1">' +
    '<span class="cx-radio' + (i === pick ? ' is-on' : '') + '"></span>' +
    '<div class="cx-opt-l"><div class="cx-row-title">' + T(q.label) + '</div><div class="cx-row-meta cx-mono">Deferred ' + esc(M(q.amount, { k: true })) + '</div></div>' +
    '<div class="cx-opt-n cx-mono"><span data-l="2026">' + esc(M(q.tax2026, { k: true, sign: true })) + '</span><span data-l="2027">' + esc(M(q.tax2027, { k: true, sign: true })) + '</span><span data-l="Net" class="' + (q.net > 0 ? 'cx-acc' : '') + '">' + esc(M(q.net, { k: true, sign: true })) + '</span></div>' +
    '<div class="cx-opt-c">' + cashBar(q, max) + '<span class="cx-mono cx-small">' + esc(M(q.decCash, { k: true })) + '</span></div>' +
    '</div>').join('');
  return '<p class="cx-q">' + T(w.question) + '</p>' +
    '<div class="cx-wg-grid"><div class="cx-defl">' +
      '<div class="cx-opt-head"><span></span><span>Option</span><span class="cx-opt-n"><span>2026 tax</span><span>2027 tax</span><span>Net</span></span><span>December cash vs payroll need</span></div>' +
      '<div class="cx-list">' + rows + '</div></div>' +
    '<div class="cx-wg-side"><div class="cx-wg-d"><div class="cx-eyebrow">Selected</div><h3>' + T(o.label) + '</h3>' +
      '<dl class="cx-kv"><div><dt>Deferred to January</dt><dd>' + esc(M(o.amount)) + '</dd></div><div><dt>2026 tax</dt><dd>' + esc(M(o.tax2026, { sign: true })) + '</dd></div><div><dt>2027 tax</dt><dd>' + esc(M(o.tax2027, { sign: true })) + '</dd></div><div><dt>Net</dt><dd class="' + (o.net > 0 ? 'cx-acc' : '') + '">' + esc(M(o.net, { sign: true })) + '</dd></div></dl>' +
      '<div class="cx-cashbig"><div class="cx-cashbig-h"><span>December business cash</span><span class="cx-mono">' + esc(M(o.decCash)) + '</span></div>' + cashBar(o, max) +
      '<div class="cx-cashbig-f"><span>Payroll need <span class="cx-mono">' + esc(M(o.need)) + '</span></span><span class="cx-mono' + (margin < 0 ? ' cx-acc' : '') + '">' + (margin < 0 ? 'Short ' + esc(M(-margin)) : 'Clears by ' + esc(M(margin))) + '</span></div></div>' +
      '<p>' + T(o.note) + '</p></div></div></div>' +
    '<div class="cx-take"><span class="cx-side-h">Takeaway</span><p>' + T(w.takeaway) + '</p></div>';
}

function pgWargame(r) {
  const name = param(r) === 'deferral' ? 'deferral' : 'salary';
  const wg = S().wargame || {};
  const recs = visRecs().filter(x => x.scenario === name);
  return '<div class="cx-wrap is-wide">' +
    '<div class="cx-pgh"><h1>War game</h1><div class="cx-tabs" role="tablist">' +
      ['salary', 'deferral'].filter(n => wg[n]).map(n => '<a role="tab" aria-selected="' + (n === name) + '" class="cx-tab' + (n === name ? ' is-on' : '') + '" href="#/wargame/' + n + '" data-c="go" data-r="wargame" data-id="' + n + '">' + T(wg[n].title) + '</a>').join('') +
    '</div></div>' +
    (name === 'salary' ? salary() : deferral()) +
    (recs.length ? '<div class="cx-sec">' + secHead('Related') + '<div class="cx-list">' + recs.map(x => recRow(x, { compact: true, inline: false })).join('') + '</div></div>' : '') +
    '</div>';
}

// ---------------------------------------------------------------- goals

const HZ = [['now', 'Now'], ['1-3y', '1 to 3 years'], ['3-10y', '3 to 10 years']];
const GST = { done: 'done', 'on track': 'doing', watch: 'waiting', open: 'open' };

function pgGoals() {
  const goals = arr(S().goals);
  const sec = HZ.map(([h, label]) => {
    const items = goals.filter(g => g.horizon === h);
    if (!items.length) return '';
    return '<section class="cx-sec">' + secHead(label, '', items.length) + '<div class="cx-goals">' + items.map(g => {
      let prog = '';
      if (g.progress) {
        const c = api.fig(g.progress.cur); const t = api.fig(g.progress.target);
        const frac = t && t.v ? c.v / t.v : 0;
        prog = '<div class="cx-prog">' + bar(frac, 'cx-bar-acc') + '<div class="cx-prog-l"><span>' + T('{f:' + g.progress.cur + '}') + ' of ' + T('{f:' + g.progress.target + '}') + '</span><span class="cx-mono">' + Math.round(frac * 100) + '%</span></div></div>';
      }
      return '<div class="cx-goal">' + glyph(GST[g.status] || 'open') + '<div class="cx-goal-m"><div class="cx-goal-t">' + T(g.title) + '<span class="cx-goal-s">' + esc(g.status) + '</span></div><p>' + T(g.prose) + '</p>' + prog + '</div></div>';
    }).join('') + '</div></section>';
  }).join('');
  return '<div class="cx-wrap"><div class="cx-pgh"><h1>Goals</h1><p class="cx-sub">In your words. Recommendations trace back to these.</p></div>' + sec +
    '<section class="cx-sec">' + secHead('Where you sit on the curve', '<span class="cx-hint">Drag to adjust</span>') + curveRows(arr(S().curve), 'curve') + '</section></div>';
}

function curveRows(items, store) {
  return '<div class="cx-curve">' + items.map(c => {
    const v = ui[store][c.id] != null ? ui[store][c.id] : c.value;
    const left = c.left != null ? T(c.left) : 'Less';
    const right = c.right != null ? T(c.right) : 'More';
    return '<div class="cx-cv">' + (c.label ? '<div class="cx-cv-t">' + T(c.label) + '</div>' : '') +
      '<div class="cx-cv-r"><span class="cx-cv-l">' + left + '</span><input type="range" min="0" max="100" value="' + Math.round(v * 100) + '" data-range="' + store + '" data-id="' + esc(c.id) + '" aria-label="' + A(c.label || (X(c.left) + ' vs ' + X(c.right))) + '"><span class="cx-cv-rr">' + right + '</span></div>' +
      (c.note ? '<div class="cx-cv-n">' + T(c.note) + '</div>' : '') + '</div>';
  }).join('') + '</div>';
}

// ---------------------------------------------------------------- accounts

const MIRROR = { connected: 'Connected', manual: 'Manual', missing: 'Missing' };

function spark(series) {
  const pts = arr(series.points);
  if (pts.length < 2) return '';
  const W = 160; const H = 36;
  const vs = pts.map(p => p.v); const lo = Math.min(...vs); const hi = Math.max(...vs) || 1;
  const x = i => 2 + i / (pts.length - 1) * (W - 4);
  const y = v => 3 + (1 - (v - lo) / ((hi - lo) || 1)) * (H - 6);
  const a = []; const p = [];
  pts.forEach((pt, i) => { const c = x(i).toFixed(1) + ',' + y(pt.v).toFixed(1); if (pt.kind === 'p') { if (!p.length && a.length) p.push(a[a.length - 1]); p.push(c); } else a.push(c); });
  const last = pts.filter(q => q.kind !== 'p').pop() || pts[pts.length - 1];
  const li = pts.indexOf(last);
  return '<svg class="cx-spark" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">' +
    (a.length > 1 ? '<polyline class="a" points="' + a.join(' ') + '"/>' : '') +
    (p.length > 1 ? '<polyline class="p" points="' + p.join(' ') + '"/>' : '') +
    '<circle cx="' + x(li).toFixed(1) + '" cy="' + y(last.v).toFixed(1) + '" r="2.5"/></svg>';
}

function pgAccounts() {
  const accts = arr(S().accounts);
  const counts = { connected: 0, manual: 0, missing: 0 };
  accts.forEach(a => { counts[a.mirror] = (counts[a.mirror] || 0) + 1; });
  const rows = accts.map(a => '<div class="cx-acct">' +
    '<div class="cx-acct-n"><div class="cx-row-title">' + T(a.name) + '</div><div class="cx-row-meta">' + T(a.inst) + '<span class="cx-dot"></span>' + T(a.owner) + '<span class="cx-dot"></span>' + esc(a.kind) + '</div>' + (a.note ? '<div class="cx-acct-note">' + T(a.note) + '</div>' : '') + '</div>' +
    '<div class="cx-acct-m is-' + esc(a.mirror) + '">' + (a.mirror === 'connected' ? ico('lock') : '') + esc(MIRROR[a.mirror] || a.mirror) + '</div>' +
    '<div class="cx-acct-v">' + (a.fig ? T('{f:' + a.fig + '}') : '<span class="cx-faint">n/a</span>') + '</div></div>').join('');
  const series = S().series || {};
  const trends = Object.keys(series).map(k => {
    const se = series[k]; const pts = arr(se.points);
    const last = pts.filter(q => q.kind !== 'p').pop();
    const proj = pts[pts.length - 1];
    return '<div class="cx-trend"><div class="cx-trend-l">' + T(se.label) + '</div>' + spark(se) +
      '<div class="cx-trend-v"><span class="cx-mono">' + (last ? esc(M(last.v, { k: true })) : '') + '</span><span class="cx-faint cx-small">' + (last ? esc(last.x) + ' actual' : '') + (proj && proj.kind === 'p' ? ', ' + esc(M(proj.v, { k: true })) + ' ' + esc(proj.x) + ' projected' : '') + '</span></div></div>';
  }).join('');
  return '<div class="cx-wrap is-wide"><div class="cx-pgh"><h1>Accounts</h1><p class="cx-sub">' + ico('lock') + ' A read-only mirror. Fathom can see balances and transactions. It cannot move, transfer or delete anything.</p>' +
    '<div class="cx-stats"><span><b>' + (counts.connected || 0) + '</b> connected</span><span><b>' + (counts.manual || 0) + '</b> manual</span><span><b>' + (counts.missing || 0) + '</b> missing</span></div></div>' +
    (trends ? '<section class="cx-sec">' + secHead('Trends', '<span class="cx-hint"><i class="cx-key-a"></i>actual <i class="cx-key-p"></i>projected</span>') + '<div class="cx-trends">' + trends + '</div></section>' : '') +
    '<section class="cx-sec">' + secHead('Accounts', '', accts.length) + '<div class="cx-accts">' + rows + '</div></section>' +
    '<section class="cx-sec">' + secHead('Detected events') + '<div class="cx-events">' + arr(S().events).map(e => '<div class="cx-ev"><span class="cx-ev-d">' + T(e.date) + '</span><div><div class="cx-ev-t">' + T(e.title) + '<span class="cx-ev-k">' + esc(EV_KIND[e.kind] || e.kind) + '</span></div><div class="cx-ev-b">' + T(e.body) + '</div></div></div>').join('') + '</div></section></div>';
}

// ---------------------------------------------------------------- advisor

function pgAdvisor() {
  const a = S().advisor || {};
  const pending = arr(a.pending).map(id => api.rec(id)).filter(r => r && r.status !== 'hidden');
  const reviewed = arr(a.reviewed);
  return '<div class="cx-wrap"><div class="cx-pgh"><div class="cx-eyebrow">' + T(a.role) + '</div><h1>' + T(a.name) + '</h1>' +
    '<div class="cx-next"><div><span class="cx-side-h">Next check-in</span><div class="cx-next-w">' + T(a.next && a.next.when) + '</div></div><div><span class="cx-side-h">Length</span><div class="cx-next-w">' + T(a.next && a.next.length) + '</div></div><div><span class="cx-side-h">Your advisor has seen</span><div class="cx-next-w">Every conversation and recommendation</div></div></div></div>' +
    '<section class="cx-sec">' + secHead('Agenda') + '<div class="cx-prose">' + T(a.agenda) + '</div>' +
      (ui.agenda.length ? '<ul class="cx-cross">' + ui.agenda.map(x => '<li>' + esc(x) + ' <span class="cx-faint cx-small">added by you</span></li>').join('') + '</ul>' : '') +
      '<form class="cx-inlinef" data-f="agenda"><input type="text" name="item" placeholder="Add something to the agenda" value="' + esc(ui.agendaDraft) + '" aria-label="Add to agenda"><button type="submit" class="cx-btn">Add</button></form></section>' +
    '<section class="cx-sec">' + secHead('Waiting on your advisor', hintLine(), pending.length) + '<div class="cx-list">' + (pending.length ? pending.map(r => recRow(r, { compact: true, inline: false })).join('') : '<div class="cx-empty">Nothing pending.</div>') + '</div></section>' +
    '<section class="cx-sec">' + secHead('Reviewed since last check-in', '', reviewed.length) + '<div class="cx-revs">' + reviewed.map(x => {
      const r = x.recId ? api.rec(x.recId) : null;
      const link = r && r.status !== 'hidden';
      return '<div class="cx-rev">' + advMark({ advisor: { verdict: x.verdict } }) + '<div class="cx-rev-m"><div class="cx-rev-t">' + (link ? '<a href="#/rec/' + esc(r.id) + '" data-c="go" data-r="rec" data-id="' + esc(r.id) + '">' + T(x.title) + '</a>' : T(x.title)) + '<span class="cx-rev-v is-' + esc(x.verdict) + '">' + advWord(x.verdict) + '</span></div><div class="cx-rev-n">' + T(x.note) + '</div></div></div>';
    }).join('') + '</div></section>' +
    '<section class="cx-sec">' + secHead('Not asking you about') + '<div class="cx-qa">' + arr(a.notAsking).map(x => '<div class="cx-qa-i"><div class="cx-qa-q">' + T(x.q) + '</div><div class="cx-qa-a">' + T(x.why) + '</div></div>').join('') + '</div></section>' +
    '<div class="cx-two"><section class="cx-sec">' + secHead('Shared with your advisor') + '<div class="cx-kvlist">' + arr(a.shared).map(x => '<div><span>' + T(x.title) + '</span><span class="cx-mono cx-faint">' + T(x.when) + '</span></div>').join('') + '</div></section>' +
    '<section class="cx-sec">' + secHead('Specialists') + '<div class="cx-kvlist">' + arr(a.experts).map(x => '<div><span>' + T(x.name) + '<span class="cx-faint"> ' + T(x.role) + '</span></span><span class="cx-mono cx-faint">' + T(x.when) + '</span></div>').join('') + '</div></section></div>' +
    '</div>';
}

// ---------------------------------------------------------------- year-end

const DOC_ST = { have: 'Have', expected: 'Expected', missing: 'Missing' };
function pgYearend() {
  const y = S().yearend || {};
  const docs = arr(y.docs);
  const decs = arr(y.decisions).map((d, i) => {
    const r = d.recId ? api.rec(d.recId) : null;
    const done = r ? r.status === 'done' : (ui.ye[i] != null ? ui.ye[i] : !!d.done);
    return Object.assign({}, d, { i, r, done });
  });
  const have = docs.filter(d => d.status === 'have').length;
  const dd = decs.filter(d => d.done).length;
  return '<div class="cx-wrap"><div class="cx-pgh"><h1>Year-end packet</h1><p class="cx-sub">What your accountant gets in January. Fathom does not file.</p></div>' +
    '<div class="cx-meters"><div class="cx-meter"><div class="cx-meter-h"><span>Documents</span><span class="cx-mono">' + have + ' of ' + docs.length + '</span></div>' + bar(docs.length ? have / docs.length : 0, 'cx-bar-acc') + '</div>' +
    '<div class="cx-meter"><div class="cx-meter-h"><span>Decisions</span><span class="cx-mono">' + dd + ' of ' + decs.length + '</span></div>' + bar(decs.length ? dd / decs.length : 0, 'cx-bar-acc') + '</div></div>' +
    '<section class="cx-sec">' + secHead('Decisions made this year', '', decs.length) + '<div class="cx-tasks">' + decs.map(d => d.r && d.r.status !== 'hidden'
      ? '<a class="cx-task' + (d.done ? ' is-done' : '') + '" href="#/rec/' + esc(d.r.id) + '" data-c="go" data-r="rec" data-id="' + esc(d.r.id) + '"><span class="cx-cb">' + (d.done ? ico('check') : '') + '</span><span>' + T(d.t) + '</span><span class="cx-task-x">' + glyph(d.r.status) + esc(stLabel(d.r)) + '</span></a>'
      : '<button type="button" class="cx-task' + (d.done ? ' is-done' : '') + '" data-c="ye" data-i="' + d.i + '" role="checkbox" aria-checked="' + d.done + '"><span class="cx-cb">' + (d.done ? ico('check') : '') + '</span><span>' + T(d.t) + '</span></button>').join('') + '</div></section>' +
    '<section class="cx-sec">' + secHead('Documents', '', docs.length) + '<div class="cx-docs">' + docs.map(d => '<div class="cx-doc">' +
      '<span class="cx-doc-s is-' + esc(d.status) + '">' + glyph(d.status === 'have' ? 'done' : d.status === 'expected' ? 'waiting' : 'proposed') + esc(DOC_ST[d.status] || d.status) + '</span>' +
      '<div class="cx-doc-m"><div class="cx-row-title">' + T(d.t) + '</div><div class="cx-row-meta">' + T(d.src) + '</div>' + (d.note ? '<div class="cx-acct-note">' + T(d.note) + '</div>' : '') + '</div></div>').join('') + '</div></section></div>';
}

// ---------------------------------------------------------------- connect, engine, email

function pgConnect() {
  const c = S().connect || {};
  const scopeOn = s => (ui.scopes[s.id] != null ? ui.scopes[s.id] : !!s.on);
  return '<div class="cx-wrap"><div class="cx-pgh"><h1>Connect your AI</h1><p class="cx-sub">Point any MCP client at Fathom. It gets the same read-only tools chat uses.</p></div>' +
    '<section class="cx-sec">' + secHead('Endpoint') + '<div class="cx-url"><code>' + T(c.url) + '</code><button type="button" class="cx-btn" data-c="copy">' + ico('copy') + (ui.copied ? 'Copied' : 'Copy') + '</button></div></section>' +
    '<section class="cx-sec">' + secHead('Scopes', '', arr(c.scopes).filter(scopeOn).length + ' on') + '<div class="cx-scopes">' + arr(c.scopes).map(s => '<div class="cx-scope"><div><div class="cx-row-title">' + T(s.label) + '</div><div class="cx-row-meta">' + (s.access === 'write' ? 'Write' : 'Read') + '</div></div>' +
      '<button type="button" class="cx-sw' + (scopeOn(s) ? ' is-on' : '') + '" data-c="scope" data-id="' + esc(s.id) + '" role="switch" aria-checked="' + scopeOn(s) + '" aria-label="' + A(s.label) + '"><i></i></button></div>').join('') + '</div></section>' +
    '<section class="cx-sec">' + secHead('Tools', '', arr(c.tools).length) + '<div class="cx-kvlist is-tools">' + arr(c.tools).map(t => '<div><code>' + T(t.name) + '</code><span>' + T(t.desc) + '</span></div>').join('') + '</div></section>' +
    '<section class="cx-sec">' + secHead('Example session') + '<div class="cx-log">' + arr(c.transcript).map(l => '<div class="cx-log-i is-' + esc(l.role) + '"><span class="cx-log-r">' + esc(l.role === 'me' ? 'you' : l.role) + '</span><div class="cx-log-t">' + T(l.text) + '</div></div>').join('') + '</div></section>' +
    '<section class="cx-sec">' + secHead('Client config') + '<pre class="cx-pre">' + T(c.config) + '</pre></section></div>';
}

function pgEngine() {
  const e = S().engine || {};
  const on = api.engineOn();
  const b = e.budget || {};
  const jobs = arr(e.jobs);
  return '<div class="cx-wrap is-wide"><div class="cx-pgh"><h1>Engine</h1><p class="cx-sub">What runs on its own, what it costs, and the switch to pause it.</p></div>' +
    '<div class="cx-meters">' +
      '<div class="cx-meter"><div class="cx-meter-h"><span>Status</span><span class="cx-eng' + (on ? '' : ' is-off') + '"><i></i>' + (on ? 'On' : 'Paused') + '</span></div><div class="cx-small cx-faint">' + (on ? 'Proactive jobs run on schedule.' : 'Proactive jobs and chat answers are paused.') + '</div><button type="button" class="cx-btn" data-fx-engine>' + (on ? 'Pause engine' : 'Turn engine on') + '</button></div>' +
      '<div class="cx-meter"><div class="cx-meter-h"><span>Model budget this month</span><span class="cx-mono">' + esc(MC(b.used)) + ' of ' + esc(MC(b.monthly)) + '</span></div>' + bar(b.monthly ? b.used / b.monthly : 0, 'cx-bar-acc') + '</div>' +
    '</div>' +
    '<section class="cx-sec">' + secHead('Proactive jobs', '', jobs.length) + '<div class="cx-jobs">' +
      '<div class="cx-job is-h"><span>Job</span><span>Cadence</span><span>Last</span><span>Next</span><span>Cost per run</span></div>' +
      jobs.map(j => '<div class="cx-job' + (on ? '' : ' is-paused') + '"><span class="cx-job-n"><span class="cx-row-title">' + T(j.name) + '</span><span class="cx-job-d">' + T(j.does) + '</span></span><span data-l="Cadence">' + T(j.cadence) + '</span><span data-l="Last" class="cx-mono">' + T(j.last) + '</span><span data-l="Next" class="cx-mono">' + (on ? T(j.next) : 'Paused') + '</span><span data-l="Cost" class="cx-mono">' + esc(MC(j.cost)) + '</span></div>').join('') +
    '</div></section>' +
    '<section class="cx-sec">' + secHead('Chat') + '<dl class="cx-kv is-row"><div><dt>Model</dt><dd>' + T(e.chat && e.chat.model) + '</dd></div></dl><p class="cx-prose">' + T(e.chat && e.chat.note) + '</p></section></div>';
}

function pgEmail() {
  const e = S().email || {};
  const meta = S().meta || {};
  return '<div class="cx-wrap"><div class="cx-pgh"><h1>Monthly email</h1><p class="cx-sub">Sent on the first of the month. Nothing goes out if nothing changed.</p></div>' +
    '<div class="cx-mail"><div class="cx-mail-h"><div class="cx-mail-r"><span>From</span><b>' + T(meta.product || 'Fathom') + '</b></div><div class="cx-mail-r"><span>Subject</span><b>' + T(e.subject) + '</b></div><div class="cx-mail-pre">' + T(e.preheader) + '</div></div>' +
    '<div class="cx-mail-b"><p>' + T(e.greeting) + '</p>' + arr(e.sections).map(s => '<h3>' + T(s.heading) + '</h3><ul>' + arr(s.items).map(i => '<li>' + T(i) + '</li>').join('') + '</ul>').join('') +
    '<a class="cx-btn is-p" href="#/brief" data-c="go" data-r="brief">Open the brief</a><p class="cx-mail-f">' + T(e.footer) + '</p></div></div></div>';
}

// ---------------------------------------------------------------- packs

const PST = { active: 'Active', exploring: 'Exploring', suggested: 'Suggested', available: 'Available' };
function packGlyph(st) {
  return { active: glyph('done'), exploring: glyph('doing'), suggested: glyph('proposed'), available: glyph('open') }[st] || glyph('open');
}

function pgPacks(r) {
  const packs = api.packs();
  let id = param(r) || ui.packSel;
  if (!packs.find(p => p.id === id)) id = (packs.find(p => p.status === 'suggested' || p.status === 'exploring') || packs[0] || {}).id;
  ui.packSel = id;
  const groups = ['active', 'exploring', 'suggested', 'available'].map(st => {
    const items = packs.filter(p => p.status === st);
    if (!items.length) return '';
    return '<div class="cx-grp"><div class="cx-grp-h is-static">' + packGlyph(st) + '<span>' + PST[st] + '</span><span class="cx-grp-n">' + items.length + '</span></div>' +
      items.map(p => '<div class="cx-row' + (p.id === id ? ' is-sel' : '') + '" data-nav data-key="' + esc(p.id) + '" data-c="pack" data-id="' + esc(p.id) + '" tabindex="-1">' + ico('packs') +
        '<div class="cx-row-main"><div class="cx-row-title">' + T(p.name) + '</div><div class="cx-row-meta">' + (p.entries != null ? p.entries + ' entries<span class="cx-dot"></span>' : '') + T(p.curator) + '</div></div>' +
        '<span class="cx-row-side">' + (p.status !== 'active' && p.whatIf ? '<button type="button" class="cx-ibtn is-p is-show" data-c="whatif" data-id="' + esc(p.id) + '">What if</button>' : '<span class="cx-mono cx-faint">' + plural(arr(p.recIds).filter(x => { const q = api.rec(x); return q && q.status !== 'hidden'; }).length, 'rec') + '</span>') + '</span></div>').join('') + '</div>';
  }).join('');
  const p = packs.find(x => x.id === id);
  return '<div class="cx-split' + (param(r) ? ' show-detail' : ' show-list') + '">' +
    '<div class="cx-pane cx-pane-list" data-sk="packs-list"><div class="cx-pane-h"><h1>Knowledge packs</h1><div class="cx-stats"><span><b>' + packs.filter(x => x.status === 'active').length + '</b> active</span><span>Curated by humans, used as retrieval context</span></div></div>' +
      '<div class="cx-pane-hint">' + hintLine() + '</div><div class="cx-list">' + groups + '</div></div>' +
    '<div class="cx-pane cx-pane-detail" data-sk="detail">' + (p ? packDetail(p) : '') + '</div></div>';
}

function packDetail(p) {
  const recs = arr(p.recIds).map(id => api.rec(id)).filter(Boolean);
  const live = recs.filter(r => r.status !== 'hidden');
  const hidden = recs.length - live.length;
  const active = p.status === 'active';
  const conv = api.conversation('pack:' + p.id);
  const unlocks = arr(p.whatIf && p.whatIf.unlocks);
  const explored = conv.some(m => m.role === 'fathom' && !m.notice);
  const actions = '<div class="cx-actbar">' + (active
    ? '<button type="button" class="cx-btn" data-c="packtog" data-id="' + esc(p.id) + '">Turn off</button>'
    : (p.whatIf ? '<button type="button" class="cx-btn' + (explored ? '' : ' is-p') + '" data-c="whatif" data-id="' + esc(p.id) + '">What if' + kbd('w') + '</button>' : '') +
      '<button type="button" class="cx-btn' + (explored ? ' is-p' : '') + '" data-c="packtog" data-id="' + esc(p.id) + '">Turn this pack on' + kbd('t') + '</button>') + '</div>';
  return '<article class="cx-rec cx-pack">' +
    '<header class="cx-rec-h"><div class="cx-eyebrow">' + packGlyph(p.status) + '<span>' + (PST[p.status] || p.status) + '</span></div><h1>' + T(p.name) + '</h1>' +
    '<div class="cx-why-l">' + (active ? 'Why it is on' : 'Why it might apply') + '</div><p class="cx-lede">' + T(p.why) + '</p>' + actions + '</header>' +
    '<dl class="cx-kv is-grid"><div><dt>Entries</dt><dd>' + esc(p.entries) + '</dd></div><div><dt>Curator</dt><dd>' + T(p.curator) + '</dd></div><div><dt>Updated</dt><dd>' + T(p.updated) + '</dd></div><div><dt>Powers</dt><dd>' + live.length + (hidden ? ' live, ' + hidden + ' waiting' : '') + '</dd></div></dl>' +
    '<section class="cx-dsec"><h3>Covers</h3><ul class="cx-covers">' + arr(p.covers).map(c => '<li>' + T(c) + '</li>').join('') + '</ul></section>' +
    (live.length ? '<section class="cx-dsec"><h3>Recommendations it powers</h3><div class="cx-list">' + live.map(r => recRow(r, { compact: true, inline: false })).join('') + '</div></section>' : '') +
    (p.whatIf && !active || conv.length ? '<section class="cx-dsec"><h3>What if</h3>' +
      (conv.length ? thread(conv) : '<button type="button" class="cx-fq" data-c="whatif" data-id="' + esc(p.id) + '">' + ico('ask') + '<span>' + T(p.whatIf && p.whatIf.prompt) + '</span>' + ico('arrow') + '</button>') +
      (explored && unlocks.length ? '<div class="cx-unlocks"><div class="cx-side-h">' + (active ? 'Unlocked' : 'Turning this on would add') + '</div>' + unlocks.map(u => {
        const r = u.recId ? api.rec(u.recId) : null;
        const link = r && r.status !== 'hidden';
        return '<div class="cx-unlock">' + (link ? glyph(r.status) : glyph('hidden')) + '<div><div class="cx-row-title">' + (link ? '<a href="#/rec/' + esc(r.id) + '" data-c="go" data-r="rec" data-id="' + esc(r.id) + '">' + T(u.title) + '</a>' : T(u.title)) + '</div><div class="cx-row-meta">' + T(u.text) + '</div></div></div>';
      }).join('') + (active ? '' : '<button type="button" class="cx-btn is-p" data-c="packtog" data-id="' + esc(p.id) + '">Turn this pack on</button>') + '</div>' : '') +
      '</section>' : '') +
    '</article>';
}

// ---------------------------------------------------------------- onboarding

const OB_STEPS = ['Sign in', 'Tell us everything', 'Connect accounts', 'What we heard', 'Your priorities', 'First brief'];

function heardItem(x) {
  if (x == null) return '';
  if (typeof x === 'object') return T(x.name || x.label || x.title || x.t || '') + (x.note || x.role ? '<span class="cx-faint"> ' + T(x.note || x.role) + '</span>' : '');
  return T(x);
}

function pgOnboarding(r) {
  const o = S().onboarding || {};
  const step = Math.max(0, Math.min(5, Number(param(r)) || 0));
  const meta = S().meta || {};
  let body = '';
  const nav = (next, label, back) => '<div class="cx-ob-nav">' + (step > 0 && back !== false ? '<button type="button" class="cx-btn" data-c="ob" data-i="' + (step - 1) + '">Back</button>' : '<span></span>') +
    '<button type="button" class="cx-btn is-p" data-c="ob" data-i="' + next + '">' + esc(label || 'Continue') + kbd('enter') + '</button></div>';

  if (step === 0) {
    body = '<div class="cx-ob-hero">' + logo() + '<h1>' + T(o.welcome && o.welcome.headline) + '</h1><p class="cx-lede">' + T(o.welcome && o.welcome.sub) + '</p></div>' +
      '<div class="cx-signin"><button type="button" class="cx-btn is-p is-block" data-c="ob" data-i="1">' + ico('lock') + 'Continue with passkey</button>' +
      '<div class="cx-or"><span>or</span></div><form class="cx-inlinef" data-f="signin"><input type="email" name="email" placeholder="Email address" aria-label="Email address" autocomplete="off"><button type="submit" class="cx-btn">Send link</button></form>' +
      '<p class="cx-faint cx-small">Invite-only. No passwords. Read-only by design.</p></div>';
  } else if (step === 1) {
    body = '<div class="cx-ob-h"><h1>Dump everything in</h1><p class="cx-sub">Write it the way you would tell a friend. Attach whatever you have. We sort it out.</p></div>' +
      '<textarea class="cx-dump" rows="9" aria-label="Tell us everything">' + esc(X(o.dump)) + '</textarea>' +
      '<div class="cx-files"><div class="cx-side-h">Attached</div>' + arr(o.files).map(f => '<div class="cx-file">' + ico('doc') + '<span class="cx-file-n">' + T(f.name) + '</span><span class="cx-mono cx-faint">' + T(f.status) + '</span></div>').join('') +
      '<div class="cx-drop">Drop files here or paste a link</div></div>' + nav(2);
  } else if (step === 2) {
    const inst = arr(o.institutions);
    const nConn = inst.filter((_, i) => ui.ob.conn[i]).length;
    body = '<div class="cx-ob-h"><h1>Connect accounts, read-only</h1><p class="cx-sub">Balances and transactions only. Fathom can never move money.</p></div>' +
      '<div class="cx-insts">' + inst.map((x, i) => '<div class="cx-inst"><div class="cx-inst-m"><div class="cx-row-title">' + T(x.inst) + '</div><div class="cx-row-meta">' + (typeof x.accounts === 'number' ? x.accounts + (x.accounts === 1 ? ' account' : ' accounts') : Array.isArray(x.accounts) ? x.accounts.map(T).join(', ') : T(x.accounts)) + '<span class="cx-dot"></span>' + esc(x.mode || 'read-only') + '</div></div>' +
        (ui.ob.conn[i] ? '<span class="cx-conn">' + ico('check') + 'Connected</span>' : '<button type="button" class="cx-btn" data-c="obconn" data-i="' + i + '">Connect</button>') + '</div>').join('') + '</div>' +
      '<div class="cx-faint cx-small">' + nConn + ' of ' + inst.length + ' connected</div>' + nav(3, nConn ? 'Continue' : 'Skip for now');
    if (ui.ob.modal != null && inst[ui.ob.modal]) {
      const x = inst[ui.ob.modal];
      body += '<div class="cx-modal-s" data-c="obclose"></div><div class="cx-modal" role="dialog" aria-modal="true" aria-label="Connect read-only">' +
        '<div class="cx-modal-i">' + ico('lock') + '</div><h2>Read-only access to ' + T(x.inst) + '</h2>' +
        '<div class="cx-perm"><div><span class="cx-side-h">Fathom can</span><ul><li>See balances and positions</li><li>Read transactions and statements</li></ul></div>' +
        '<div><span class="cx-side-h">Fathom cannot</span><ul><li>Move or transfer money</li><li>Trade, pay or withdraw</li><li>Change or delete anything</li></ul></div></div>' +
        '<div class="cx-modal-a"><button type="button" class="cx-btn" data-c="obclose">Cancel</button><button type="button" class="cx-btn is-p" data-c="obok" data-i="' + ui.ob.modal + '">Allow read-only</button></div></div>';
    }
  } else if (step === 3) {
    const h = o.heard || {};
    const grp = (k, label) => arr(h[k]).length ? '<div class="cx-heard-g"><div class="cx-side-h">' + label + '</div>' + arr(h[k]).map((x, i) => {
      const id = k + i; const ok = ui.ob.heard[id] !== false;
      return '<button type="button" class="cx-task' + (ok ? ' is-ok' : ' is-off') + '" data-c="heard" data-id="' + id + '"><span class="cx-cb">' + (ok ? ico('check') : '') + '</span><span>' + heardItem(x) + '</span>' + (ok ? '' : '<span class="cx-faint cx-small">we will ask</span>') + '</button>';
    }).join('') + '</div>' : '';
    body = '<div class="cx-ob-h"><h1>What we heard</h1><p class="cx-sub">Uncheck anything that is wrong. We will ask about it instead of guessing.</p></div>' +
      '<div class="cx-heard">' + grp('people', 'People') + grp('entities', 'Entities') + grp('income', 'Income') + grp('lifeEvents', 'Life events') + '</div>' +
      '<div class="cx-heard-d"><span class="cx-mono cx-big">' + esc(h.deadlines) + '</span><span>deadlines found</span></div>' +
      (arr(h.questions).length ? '<div class="cx-heard-g"><div class="cx-side-h">Open questions</div><ul class="cx-cross">' + arr(h.questions).map(q => '<li>' + T(q) + '</li>').join('') + '</ul></div>' : '') + nav(4, 'Looks right');
  } else if (step === 4) {
    body = '<div class="cx-ob-h"><h1>Where on the curve</h1><p class="cx-sub">There is rarely one right answer, only tradeoffs. Tell us which way you lean. You can change this any time.</p></div>' +
      curveRows(arr(o.priorities).map(p => Object.assign({}, p, { value: p.value > 1 ? p.value / 100 : p.value })), 'prio') + nav(5, 'Build my first brief');
  } else {
    const packsOn = api.packs().filter(p => p.status === 'active').length;
    const lines = [
      ['Mirrored accounts', arr(S().accounts).length],
      ['Mapped deadlines', arr(S().deadlines).length],
      ['Matched knowledge packs', packsOn],
      ['Drafted recommendations', visRecs().length],
      ['Wrote the verdict', null],
    ];
    body = '<div class="cx-ob-h"><h1>Building your first brief</h1><p class="cx-sub">This takes a minute the first time. After that it runs on its own every month.</p></div>' +
      '<div class="cx-build">' + bar(1, 'cx-bar-acc cx-build-bar') + lines.map((l, i) => '<div class="cx-build-i" style="animation-delay:' + (0.35 + i * 0.45) + 's">' + ico('check') + '<span>' + esc(l[0]) + '</span>' + (l[1] != null ? '<span class="cx-mono">' + l[1] + '</span>' : '') + '</div>').join('') + '</div>' +
      '<div class="cx-ob-nav"><button type="button" class="cx-btn" data-c="ob" data-i="4">Back</button><button type="button" class="cx-btn is-p cx-build-go" data-c="ob" data-i="6">Open my first brief' + kbd('enter') + '</button></div>';
  }

  return '<div class="cx-ob">' +
    '<aside class="cx-ob-side"><div class="cx-brand">' + logo() + '<div class="cx-brand-t"><div class="cx-brand-n">' + T(meta.product || 'Fathom') + '</div><div class="cx-brand-h">Setup</div></div></div>' +
      '<ol class="cx-steps">' + OB_STEPS.map((s, i) => '<li class="' + (i < step ? 'is-done' : i === step ? 'is-on' : '') + '"><button type="button" data-c="ob" data-i="' + i + '"' + (i > step ? ' disabled' : '') + '><span class="cx-step-n">' + (i < step ? ico('check') : i + 1) + '</span><span>' + esc(s) + '</span></button></li>').join('') + '</ol>' +
      '<div class="cx-ob-prog"><span class="cx-mono cx-faint">Step ' + (step + 1) + ' of 6</span>' + bar((step + 1) / 6, 'cx-bar-acc') + '</div></aside>' +
    '<section class="cx-ob-main" data-sk="page"><div class="cx-ob-in">' + body + '</div></section></div>';
}

// ---------------------------------------------------------------- pages map and render

const PAGES = {
  brief: pgBrief, plan: pgPlan, rec: pgPlan, ask: pgAsk, wargame: pgWargame, goals: pgGoals,
  accounts: pgAccounts, advisor: pgAdvisor, yearend: pgYearend, connect: pgConnect, engine: pgEngine,
  email: pgEmail, packs: pgPacks,
};

function render() {
  if (!api || !root) return;
  const host = root.querySelector('.cx-host');
  if (!host) return;
  const r = api.route || { name: 'brief', params: {} };
  const key = r.name + ':' + (param(r) ?? '');
  const demo = api.demo();
  if (demo !== lastDemo) { ui.sel = null; ui.packSel = null; ui.fk = {}; ui.closed = false; lastDemo = demo; }
  const changed = key !== lastKey;
  if (changed) ui.drawer = false;
  const saved = {};
  host.querySelectorAll('[data-sk]').forEach(n => { saved[n.dataset.sk] = n.scrollTop; });
  const active = document.activeElement;
  const refocus = active && host.contains(active) && active.matches('input[type=text],input[type=email]') ? active.getAttribute('name') : null;
  host.innerHTML = (demo === 'fresh' || r.name === 'onboarding') ? pgOnboarding(r) : shell(r);
  host.querySelectorAll('[data-sk]').forEach(n => {
    const k = n.dataset.sk;
    if (k === 'ask-thread') { n.scrollTop = n.scrollHeight; return; }
    if (/-list$/.test(k) || !changed) n.scrollTop = saved[k] || 0;
  });
  if (refocus) { const el = host.querySelector('input[name="' + refocus + '"]'); if (el) { el.focus(); const v = el.value; el.setSelectionRange && el.type === 'text' && el.setSelectionRange(v.length, v.length); } }
  lastKey = key;
  applyFocus(false);
  if (ui.pal) renderPal(false);
}

function applyFocus(scroll) {
  const r = api.route || {};
  const k = ui.fk[r.name];
  const rows = navRows();
  rows.forEach(n => n.classList.toggle('is-focus', ui.kb && n.dataset.key === k));
  if (scroll) {
    const n = rows.find(x => x.dataset.key === k) || rows.find(x => x.classList.contains('is-sel'));
    if (n) n.scrollIntoView({ block: 'nearest' });
  }
}
const navRows = () => Array.from(root.querySelectorAll('.cx-page [data-nav]'));

// ---------------------------------------------------------------- events

function onClick(e) {
  if (e.target.closest('.fx-fig')) return; // core shows the provenance popover
  const el = e.target.closest('[data-c]');
  if (!el || !root.contains(el)) return;
  const c = el.dataset.c;
  const id = el.dataset.id;
  if (el.tagName === 'A') e.preventDefault();
  ui.kb = false;
  switch (c) {
    case 'go': go(el.dataset.r, id != null ? (el.dataset.r === 'wargame' ? { name: id } : { id }) : undefined); break;
    case 'sel':
      if (narrow()) { go('rec', { id }); break; }
      ui.sel = id; ui.fk.plan = id; ui.fk.rec = id;
      if (api.route.name === 'rec') go('rec', { id }); else render();
      break;
    case 'act': doAct(id, el.dataset.a); break;
    case 'task': api.act(id, 'task', Number(el.dataset.i)); break;
    case 'askrec': api.ask(Number(el.dataset.i), id); break;
    case 'ask': api.ask(id, 'ask'); break;
    case 'wg': api.scenarioPick(el.dataset.n, Number(el.dataset.i)); break;
    case 'pack': ui.packSel = id; go('packs', { id }); break;
    case 'whatif': ui.packSel = id; api.whatIf(id); go('packs', { id }); break;
    case 'packtog': {
      const before = api.pack(id); const st = api.packToggle(id);
      toast((st === 'active' ? 'Turned on: ' : 'Turned off: ') + X(before && before.name));
      break;
    }
    case 'closed': ui.closed = !ui.closed; render(); break;
    case 'drawer': ui.drawer = !ui.drawer; render(); break;
    case 'pal': openPal(); break;
    case 'copy': {
      ui.copied = true;
      try { navigator.clipboard && navigator.clipboard.writeText(X(S().connect && S().connect.url)); } catch (err) { /* clipboard unavailable */ }
      render(); setTimeout(() => { ui.copied = false; render(); }, 1600);
      break;
    }
    case 'scope': {
      const s = arr(S().connect && S().connect.scopes).find(x => x.id === id);
      const cur = ui.scopes[id] != null ? ui.scopes[id] : !!(s && s.on);
      ui.scopes[id] = !cur; render();
      break;
    }
    case 'ye': { const i = Number(el.dataset.i); const d = arr(S().yearend && S().yearend.decisions)[i]; ui.ye[i] = !(ui.ye[i] != null ? ui.ye[i] : !!(d && d.done)); render(); break; }
    case 'ob': api.onboard(Number(el.dataset.i)); break;
    case 'obconn': ui.ob.modal = Number(el.dataset.i); render(); break;
    case 'obclose': ui.ob.modal = null; render(); break;
    case 'obok': ui.ob.conn[Number(el.dataset.i)] = true; ui.ob.modal = null; render(); break;
    case 'heard': ui.ob.heard[id] = ui.ob.heard[id] === false; render(); break;
    default: break;
  }
}

function onInput(e) {
  const t = e.target;
  if (t.matches('input[name="q"]')) ui.draft = t.value;
  else if (t.matches('input[name="item"]')) ui.agendaDraft = t.value;
  else if (t.dataset && t.dataset.range) ui[t.dataset.range][t.dataset.id] = Number(t.value) / 100;
}

function onSubmit(e) {
  const f = e.target.closest('form[data-f]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.f;
  if (kind === 'ask') {
    const v = (ui.draft || '').trim();
    if (!v) return;
    ui.draft = '';
    api.askFree(v, 'ask');
  } else if (kind === 'agenda') {
    const v = (ui.agendaDraft || '').trim();
    if (!v) return;
    ui.agenda.push(v); ui.agendaDraft = ''; render(); toast('Added to the agenda');
  } else if (kind === 'signin') {
    api.onboard(1);
  }
}

function focusedRecId() {
  const r = api.route || {};
  const row = navRows().find(n => n.classList.contains('is-focus') && n.dataset.rec);
  if (row) return row.dataset.rec;
  if (r.name === 'rec') return param(r);
  if (r.name === 'plan') return narrow() ? null : ui.sel;
  return null;
}

function move(d) {
  const rows = navRows();
  if (!rows.length) return;
  let i = ui.kb ? rows.findIndex(n => n.classList.contains('is-focus')) : -1;
  if (i < 0) i = rows.findIndex(n => n.classList.contains('is-sel'));
  i = i < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + d));
  const row = rows[i];
  const r = api.route;
  ui.kb = true;
  ui.fk[r.name] = row.dataset.key;
  const c = row.dataset.c;
  if (c === 'sel' && !narrow()) {
    ui.sel = row.dataset.id;
    if (r.name === 'rec') { ui.fk.rec = row.dataset.id; api.go('rec', { id: row.dataset.id }); } else render();
  } else if (c === 'pack') {
    ui.packSel = row.dataset.id; ui.fk.packs = row.dataset.id; api.go('packs', { id: row.dataset.id });
  } else if (c === 'wg') {
    api.scenarioPick(row.dataset.n, Number(row.dataset.i));
  }
  applyFocus(true);
}

function openFocused() {
  const row = navRows().find(n => n.classList.contains('is-focus')) || navRows().find(n => n.classList.contains('is-sel'));
  if (!row) return;
  const c = row.dataset.c;
  if (c === 'sel') go('rec', { id: row.dataset.id });
  else row.click();
}

function typingIn(t) {
  return t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

function onKey(e) {
  if (!api || !root) return;
  const k = e.key;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && k.toLowerCase() === 'k') {
    e.preventDefault();
    if (ui.pal) closePal(); else openPal();
    return;
  }
  if (ui.pal) { palKey(e); return; }
  if (typingIn(e.target)) {
    if (k === 'Escape') e.target.blur();
    return;
  }
  if (e.target.closest && e.target.closest('.fx-harness')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const r = api.route || {};

  if (api.demo() === 'fresh' || r.name === 'onboarding') {
    if (k === 'Escape' && ui.ob.modal != null) { ui.ob.modal = null; render(); return; }
    if (k === 'Enter' && !(e.target.closest && e.target.closest('button,a'))) {
      e.preventDefault();
      const step = Number(param(r)) || 0;
      if (step === 2 && ui.ob.modal != null) { ui.ob.conn[ui.ob.modal] = true; ui.ob.modal = null; render(); return; }
      api.onboard(step + 1);
    }
    return;
  }

  if (ui.g && Date.now() - ui.g < 1200) {
    ui.g = 0;
    const hit = NAV.flatMap(g => g[1]).find(x => x[2] === k.toLowerCase());
    if (hit) { e.preventDefault(); go(hit[0]); }
    return;
  }
  if (k === 'g') { ui.g = Date.now(); return; }
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); return; }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); return; }
  if (k === 'Enter') {
    if (e.target.closest && e.target.closest('button,a')) return;
    e.preventDefault(); openFocused(); return;
  }
  if (k === '/') { e.preventDefault(); openPal(); return; }
  if (k === 'Escape') {
    if (ui.drawer) { ui.drawer = false; render(); return; }
    if (r.name === 'rec') { go('plan'); return; }
    if (ui.kb) { ui.kb = false; applyFocus(false); }
    return;
  }
  if (r.name === 'packs') {
    const p = api.pack(ui.packSel);
    if (p && k === 'w' && p.status !== 'active' && p.whatIf) { api.whatIf(p.id); return; }
    if (p && k === 't' && p.status !== 'active') { api.packToggle(p.id); toast('Turned on: ' + X(p.name)); return; }
  }
  const map = { a: 'start', s: 'snooze', d: 'dismiss', c: 'complete', r: 'reopen' };
  if (map[k]) {
    const id = focusedRecId();
    if (!id) return;
    const rec = api.rec(id);
    if (!rec || rec.status === 'hidden') return;
    const a = map[k];
    if (a === 'reopen' && !['snoozed', 'done', 'dismissed'].includes(rec.status)) return;
    if (rec.status === ({ start: 'doing', snooze: 'snoozed', dismiss: 'dismissed', complete: 'done' })[a]) return;
    e.preventDefault();
    doAct(id, a);
  }
}

// ---------------------------------------------------------------- command palette

function commands() {
  const out = [];
  const r = api.route || {};
  if (api.demo() === 'fresh' || r.name === 'onboarding') {
    OB_STEPS.forEach((s, i) => out.push({ g: 'Setup', l: 'Step ' + (i + 1) + ': ' + s, run: () => api.onboard(i) }));
    return out;
  }
  const cur = focusedRecId() ? api.rec(focusedRecId()) : null;
  if (cur && cur.status !== 'hidden') {
    actionsFor(cur.status).forEach(a => out.push({ g: 'This recommendation', l: ACT[a].l + ': ' + X(cur.title), k: ACT[a].k, run: () => doAct(cur.id, a) }));
  }
  NAV.flatMap(g => g[1]).forEach(([n, l, k]) => out.push({ g: 'Go to', l: l, k: 'g ' + k, icon: n, run: () => go(n) }));
  orderedRecs().forEach(x => out.push({ g: 'Recommendations', l: X(x.title), meta: stLabel(x), st: x.status, run: () => go('rec', { id: x.id }) }));
  api.needsYou().forEach(x => {
    out.push({ g: 'Actions', l: 'Doing it: ' + X(x.title), run: () => doAct(x.id, 'start'), hide: x.status !== 'proposed' });
    out.push({ g: 'Actions', l: 'Complete: ' + X(x.title), run: () => doAct(x.id, 'complete') });
  });
  api.packs().forEach(p => {
    if (p.status !== 'active' && p.whatIf) out.push({ g: 'Packs', l: 'What if: ' + X(p.name), meta: X(p.whatIf.prompt), icon: 'packs', run: () => { ui.packSel = p.id; api.whatIf(p.id); go('packs', { id: p.id }); } });
  });
  api.packs().forEach(p => out.push({ g: 'Packs', l: 'Pack: ' + X(p.name), meta: PST[p.status] || p.status, icon: 'packs', run: () => { ui.packSel = p.id; go('packs', { id: p.id }); } }));
  const wg = S().wargame || {};
  ['salary', 'deferral'].forEach(n => { if (wg[n]) out.push({ g: 'War game', l: X(wg[n].title), icon: 'wargame', run: () => go('wargame', { name: n }) }); });
  arr(S().ask && S().ask.suggested).forEach(q => out.push({ g: 'Ask', l: X(q.q), icon: 'ask', run: () => { api.ask(q.id, 'ask'); go('ask'); } }));
  return out.filter(x => !x.hide);
}

let palItems = [];
function filtered() {
  const q = ui.pq.trim().toLowerCase();
  const all = commands();
  if (!q) return all;
  const words = q.split(/\s+/);
  return all.map(c => {
    const hay = (c.l + ' ' + (c.meta || '') + ' ' + c.g).toLowerCase();
    if (!words.every(w => hay.indexOf(w) >= 0)) return null;
    const lab = c.l.toLowerCase();
    const score = lab.startsWith(q) ? 0 : lab.indexOf(q) >= 0 ? 1 : 2;
    return Object.assign({ score }, c);
  }).filter(Boolean).sort((a, b) => a.score - b.score);
}

function openPal() {
  ui.pal = true; ui.pq = ''; ui.pi = 0;
  const host = root.querySelector('.cx-pal-host');
  host.innerHTML = '<div class="cx-pal-s" data-p="close"></div><div class="cx-pal" role="dialog" aria-modal="true" aria-label="Command palette">' +
    '<div class="cx-pal-in">' + ico('search') + '<input type="text" placeholder="Jump to a page, a recommendation, a pack, or run an action" aria-label="Command" autocomplete="off" spellcheck="false">' + kbd('esc') + '</div>' +
    '<div class="cx-pal-l" role="listbox"></div><div class="cx-pal-f"><span>' + kbd('↑') + kbd('↓') + ' move</span><span>' + kbd('enter') + ' run</span><span>' + kbd('esc') + ' close</span></div></div>';
  const input = host.querySelector('input');
  input.addEventListener('input', () => { ui.pq = input.value; ui.pi = 0; renderPal(true); });
  host.querySelector('.cx-pal-s').addEventListener('click', closePal);
  host.querySelector('.cx-pal-l').addEventListener('click', ev => {
    const it = ev.target.closest('[data-pi]');
    if (it) runPal(Number(it.dataset.pi));
  });
  host.querySelector('.cx-pal-l').addEventListener('mousemove', ev => {
    const it = ev.target.closest('[data-pi]');
    if (it && Number(it.dataset.pi) !== ui.pi) { ui.pi = Number(it.dataset.pi); markPal(); }
  });
  renderPal(true);
  setTimeout(() => input.focus(), 0);
}

function closePal() {
  ui.pal = false;
  const host = root && root.querySelector('.cx-pal-host');
  if (host) host.innerHTML = '';
}

function renderPal(reset) {
  const list = root.querySelector('.cx-pal-l');
  if (!list) return;
  palItems = filtered();
  if (ui.pi >= palItems.length) ui.pi = Math.max(0, palItems.length - 1);
  let g = '';
  list.innerHTML = palItems.length ? palItems.map((c, i) => {
    const head = c.g !== g ? '<div class="cx-pal-g">' + esc(c.g) + '</div>' : '';
    g = c.g;
    return head + '<div class="cx-pal-i' + (i === ui.pi ? ' is-on' : '') + '" role="option" data-pi="' + i + '" aria-selected="' + (i === ui.pi) + '">' +
      (c.st ? glyph(c.st) : ico(c.icon || 'arrow')) + '<span class="cx-pal-t">' + esc(c.l) + '</span>' +
      (c.meta ? '<span class="cx-pal-m">' + esc(c.meta) + '</span>' : '') + (c.k ? '<span class="cx-pal-k">' + c.k.split(' ').map(kbd).join('') + '</span>' : '') + '</div>';
  }).join('') : '<div class="cx-pal-e">No matches</div>';
  if (reset) list.scrollTop = 0;
  markPal();
}

function markPal() {
  const list = root.querySelector('.cx-pal-l');
  if (!list) return;
  list.querySelectorAll('[data-pi]').forEach(n => { const on = Number(n.dataset.pi) === ui.pi; n.classList.toggle('is-on', on); n.setAttribute('aria-selected', String(on)); });
  const on = list.querySelector('.is-on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function runPal(i) {
  const c = palItems[i];
  closePal();
  if (c) c.run();
}

function palKey(e) {
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); closePal(); return; }
  if (k === 'ArrowDown' || (e.ctrlKey && k === 'n')) { e.preventDefault(); ui.pi = Math.min(palItems.length - 1, ui.pi + 1); markPal(); return; }
  if (k === 'ArrowUp' || (e.ctrlKey && k === 'p')) { e.preventDefault(); ui.pi = Math.max(0, ui.pi - 1); markPal(); return; }
  if (k === 'Enter') { e.preventDefault(); runPal(ui.pi); }
}

// ---------------------------------------------------------------- lifecycle

function onResize() {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (api && api.route && api.route.name === 'wargame') render(); }, 120);
}

function mount(el, a) {
  api = a; root = el;
  lastKey = ''; lastDemo = api.demo();
  root.innerHTML = '<div class="cx-host"></div><div class="cx-pal-host"></div><div class="cx-toast" role="status" aria-live="polite"></div>';
  off = api.on(() => render());
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  render();
}

function unmount() {
  if (off) off();
  off = null;
  if (root) {
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('submit', onSubmit);
    root.innerHTML = '';
  }
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
  ui.pal = false;
  api = null; root = null;
}

const DESIGN = { id: 'console', name: 'Console', blurb: 'Keyboard-first. Sidebar, split panes, a command palette.', mount, unmount };

(function register() {
  if (window.Fathom && window.Fathom.registerDesign) window.Fathom.registerDesign(DESIGN);
  else setTimeout(register, 20);
})();

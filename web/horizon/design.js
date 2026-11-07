/* Horizon. Time is the interface: the calendar year is the spine, recommendations sit at their
   windows, and today is a line you can see. Everything else hangs off the timeline.
   Every figure, name and date comes from api.s; nothing here names a person or an amount.
   Reading notes on ambiguous contract points are at the bottom of this file.
   The Ask page (conversations), packs, engine and chat Sources screens live in ./screens/ and get this file's helpers
   through the kit below. */

import * as chatScreen from './screens/chat.js';
import * as packsScreen from './screens/packs.js';
import * as engineScreen from './screens/engine.js';
import * as yearendScreen from './screens/yearend.js';
import * as advisorScreen from './screens/advisor.js';
import * as connect from './screens/connect.js';
import { ingestScreens } from './screens/ingest.js';
import { emailScreen } from './screens/email.js';
import * as switcher from './screens/switcher.js';
import * as simplefin from './screens/simplefin.js';
import { createKeys } from './keys.js';
import { createSwipe } from './screens/swipe.js';
import { homeModel, homeHeadline, healthChip, healthLine, paceReason, boardCharts, reasonText, servedGoalIds, shortDate, longDate, windowSpan, askReason } from './screens/home-model.js';
import { STARTERS, existingStarterIds, otherGoals, goalsToCreate, inviteLine } from './screens/onboard-model.js';
import { KNOWN_FIGURES } from '/shared/goals.mjs';
import { OWNERS, OWNER_LABEL } from '/shared/rec-links.mjs';

const MS = 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const OPEN = ['proposed', 'doing'];
const STATUS = {
  proposed: 'New', doing: 'Doing it', waiting: 'Waiting',
  snoozed: 'Later', done: 'Done', dismissed: 'Not for us', hidden: 'Hidden'
};
const WAITING = { data: 'on data', advisor: 'on advisor', date: 'on a date' };
const VALUE = { tax: 'Tax', timing: 'Timing', retire: 'Retirement', risk: 'Risk', cash: 'Cash', goal: 'Goal' };
const TRIGGER = { calendar: 'Calendar', income: 'Income change', life: 'Life event', goal: 'Goal', advisor: 'Advisor' };
const KIND = { business: 'Business', checking: 'Cash', cash: 'Cash', taxable: 'Investing', retirement: 'Retirement', roth: 'Retirement', hsa: 'Health', '529': 'Education' };

// Four tabs, in order: route, label, phone bar icon. Every route belongs to one tab or to the gear
// (settings); the active one comes from the current route, never from the screen.
const TABS = [['home', 'Home', 'year'], ['plan', 'Plan', 'cal'], ['ask', 'Ask', 'chat'], ['money', 'Money', 'money']];
// The views inside a tab, shown as a sub-nav on each of them. Home and the gear have none.
const SUBNAV = {
  plan: [['plan', 'Plan'], ['yearend', 'Year end'], ['advisor', 'Advisor']],
  ask: [['ask', 'Conversations'], ['wargame', 'What-if'], ['packs', 'Packs']],
  money: [['money', 'Overview'], ['accounts', 'Accounts'], ['add', 'Files']]
};
// Routes with no sub-nav are listed by hand; every sub-nav view maps to its tab.
const TAB_OF = {
  home: 'home', pace: 'home', brief: 'home', goals: 'home', confirm: 'home',
  settings: 'settings', connect: 'settings', engine: 'settings', email: 'settings', onboarding: 'settings',
  ...Object.fromEntries(Object.entries(SUBNAV).flatMap(([tab, views]) => views.map(([k]) => [k, tab])))
};

let api = null;
let root = null;
let unsub = null;
let ui = null;
let ingest = null;
let email = null;
let lastKey = '';
let resizeTimer = 0;
let onResize = null;
let onDocKey = null;
let keys = null;
let onScroll = null;
let bodyLocked = false;
let connectOn = false;

const freshUi = () => ({
  curve: {}, prio: {}, modal: null, goalForm: null, goalDel: null,
  pick: { salary: null, deferral: null }, build: 0,
  buildTimer: 0, draft: {}, recReset: {}, dumped: null, noteBusy: false, understood: null,
  under: null, inApp: false, closing: false, ret: null, y: 0, msgN: {}, det: {}, owner: 'both',
  // The Goals step (onboarding step 1 and an empty Home): selected starter ids, own titles, whether
  // the own-goal field is open, and where a save is running ('onboarding' or 'home', else '').
  starterSel: [], ownGoals: [], ownOpen: false, goalsBusy: ''
});

/* ---------- small helpers ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = (s) => (s == null || s === '' ? '' : api.t(String(s)));
const X = (s) => (s == null || s === '' ? '' : esc(api.txt(String(s))));
const arr = (a) => (Array.isArray(a) ? a : []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
const clock = () => parseISO(api.s.meta.clock) || new Date(Date.UTC(new Date().getFullYear(), 0, 1));
const addDays = (d, n) => new Date(d.getTime() + n * MS);
const fmt = (d) => `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / MS);

function parseShort(s) {
  // 'Aug 14' style labels carry no year: assume the most recent such date on or before the clock
  // (plus a small grace window), which is what "what changed" means.
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(String(s || ''));
  if (!m) return parseISO(s);
  const mi = MON.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (mi < 0) return null;
  const c = clock();
  let d = new Date(Date.UTC(c.getUTCFullYear(), mi, +m[2]));
  if (d.getTime() > c.getTime() + 20 * MS) d = new Date(Date.UTC(c.getUTCFullYear() - 1, mi, +m[2]));
  return d;
}

const days = (r) => Number(r?.window?.days ?? 0);
const recDate = (r) => addDays(clock(), days(r));
const visibleRecs = () => arr(api.recs()).filter((r) => r.status !== 'hidden');
const recById = (id) => { const r = api.rec(id); return r && r.status !== 'hidden' ? r : null; };
const isNeeds = (r, ny) => ny.some((n) => n.id === r.id);

function figVal(key) {
  const f = api.fig(key);
  return f && typeof f.v === 'number' ? f.v : null;
}
function figHtml(key, opts = {}) {
  // Wrap a raw figure the same way api.t() does so provenance works everywhere.
  // opts: api.money options, plus cents (the Engine screen's usd() format), abs (magnitude only) and
  // inert (inside a button: no tab stop of its own, the button takes the click).
  const f = api.fig(key);
  if (!f) return '';
  const v = opts.abs ? Math.abs(f.v) : f.v;
  const text = opts.cents ? usd(v) : api.money(v, opts);
  return `<span class="fx-fig" data-fig="${esc(key)}" data-kind="${esc(f.kind || '')}"${f.unavailable ? ' data-unavailable="1"' : ''}${opts.inert ? '' : ' tabindex="0"'}>${esc(text)}</span>`;
}

function statusText(r) {
  if (r.status === 'waiting') return `Waiting ${WAITING[r.waitingOn] || ''}`.trim();
  if (r.status === 'snoozed') return r.wake ? `Later, until ${X(r.wake)}` : 'Later';
  return STATUS[r.status] || esc(r.status);
}
function countdown(r) {
  const d = days(r);
  if (d < 0) return { n: Math.abs(d), u: 'days late' };
  if (d === 0) return { n: 0, u: 'today' };
  return { n: d, u: d === 1 ? 'day' : 'days' };
}
function windowText(r) {
  const d = days(r);
  const lab = r.window?.label ? T(r.window.label) : fmt(recDate(r));
  if (d <= 0) return `Closes ${lab}`;
  return `Closes ${lab}, ${plural(d, 'day')}`;
}
function values(r) {
  const seen = [];
  arr(r.value).forEach((v) => { const l = VALUE[v.cls] || v.cls; if (l && !seen.includes(l)) seen.push(l); });
  return seen.join(', ');
}
function advisorText(r) {
  if (!r.advisor) return '';
  const v = r.advisor.verdict;
  if (v === 'confirmed') return `${icon('check')}Advisor confirmed`;
  if (v === 'vetoed') return `${icon('x')}Advisor vetoed`;
  return `${icon('clock')}Waiting on advisor`;
}

function icon(name) {
  const p = {
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
    chev: '<path d="M4 6.5l4 4 4-4"/>',
    back: '<path d="M13 8H3M7 4L3 8l4 4"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
    send: '<path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    doc: '<path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z"/><path d="M9.5 2.5V5H12"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2L13.5 13.5"/>',
    cal: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
    fork: '<circle cx="5" cy="3.5" r="1.5"/><circle cx="11" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><path d="M5 5v6M11 5c0 3.5-6 2.5-6 6"/>',
    stack: '<path d="M8 2.5l5.5 3-5.5 3-5.5-3z"/><path d="M2.5 8.5l5.5 3 5.5-3"/>',
    year: '<path d="M3.5 10.5a4.5 4.5 0 019 0"/><path d="M1.5 10.5h13M4.5 13h7"/>',
    chat: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>',
    gear: '<circle cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="1.25"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>',
    money: '<rect x="1.75" y="4" width="12.5" height="8" rx="1.5"/><circle cx="8" cy="8" r="1.75"/><path d="M4.25 8h.01M11.75 8h.01"/>'
  }[name] || '';
  return `<svg class="h-i" viewBox="0 0 16 16" aria-hidden="true">${p}</svg>`;
}
const MARK = '<svg class="h-mark-g" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 15a7 7 0 0114 0"/><path d="M2 15h20"/><path d="M7 19h10"/></svg>';

const btn = (label, attrs, cls = '') => `<button type="button" class="h-btn ${cls}" ${attrs}>${label}</button>`;
const goA = (route, label, params = {}, cls = '') => {
  const ps = Object.entries(params).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<a href="${href(route, params)}" class="${cls}" data-go="${route}" ${ps}>${label}</a>`;
};
function href(route, params = {}) {
  const v = params.id ?? params.name ?? params.step;
  return `#/${route}${v != null ? '/' + encodeURIComponent(v) : ''}`;
}

function snoozeLabel() { return fmt(addDays(clock(), 14)); }

// Key hints for the rec actions; the keys themselves live in screens/switcher.js.
const ACT_KEY = { start: 'D', snooze: 'L', complete: 'E', dismiss: 'Shift+X' };

function actionsFor(r, compact) {
  const a = (act, label, cls = '', arg) => {
    const hint = ACT_KEY[act] ? ` title="${esc(`${label} (${ACT_KEY[act]})`)}"` : '';
    return btn(label, `data-act="${act}" data-rec="${esc(r.id)}"${arg != null ? ` data-arg="${esc(arg)}"` : ''}${hint}`, cls);
  };
  const later = a('snooze', compact ? 'Later' : `Later, until ${snoozeLabel()}`, 'ghost', snoozeLabel());
  const notForUs = a('dismiss', 'Not for us', 'ghost');
  switch (r.status) {
    case 'proposed': return [a('start', 'Doing it', 'pri'), a('complete', 'Done', ''), later, notForUs];
    case 'doing': return [a('complete', 'Done', 'pri'), later, notForUs];
    case 'waiting': return [a('complete', 'Done', ''), a('reopen', 'Reopen', 'ghost')];
    case 'snoozed': return [a('reopen', 'Wake now', '')];
    case 'done': return [a('reopen', 'Reopen', 'ghost')];
    case 'dismissed': return [a('reopen', 'Restore', 'ghost')];
    default: return [];
  }
}

/* ---------- the timeline ---------- */

function scaleFor(start, now, end, W, pastShare) {
  const n = now.getTime(), s = start.getTime(), e = end.getTime();
  const P = W * pastShare;
  return (d) => {
    const t = d.getTime();
    if (t <= n) return Math.max(0, n === s ? P : ((t - s) / (n - s)) * P);
    return Math.min(W, P + ((t - n) / Math.max(1, e - n)) * (W - P));
  };
}

function stack(items, W, gap = 10) {
  // Greedy lane packing. Each item: { x, w }. Labels flip to the left of the dot near the right edge.
  const sorted = items.slice().sort((a, b) => (a.pri - b.pri) || (a.x - b.x));
  const lanes = [];
  sorted.forEach((it) => {
    it.flip = it.x + it.w > W - 2;
    it.x0 = it.flip ? it.x - it.w : it.x;
    it.x1 = it.flip ? it.x : it.x + it.w;
    let lane = lanes.findIndex((occ) => occ.every(([a, b]) => it.x1 + gap < a || it.x0 > b + gap));
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push([it.x0, it.x1]);
    it.lane = lane;
  });
  return lanes.length;
}
const labelW = (s, max = 190) => Math.min(max, 22 + String(s).length * 6.3);

function timeline(mode) {
  // mode: 'plan' (all but dismissed, with past What changed events)
  const c = clock();
  const ny = api.needsYou();
  const year = c.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const recs = visibleRecs().filter((r) => r.status !== 'dismissed');
  const dls = arr(api.s.deadlines).map((d) => ({ ...d, at: parseISO(d.date) })).filter((d) => d.at);
  let end = new Date(Date.UTC(year, 11, 31));
  const latest = Math.max(...recs.map((r) => recDate(r).getTime()), ...dls.map((d) => d.at.getTime()), end.getTime());
  const cap = addDays(c, 520).getTime();
  end = new Date(Math.min(cap, latest + 12 * MS));
  end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0));

  const rw = root?.clientWidth || 1200;
  const avail = Math.min(1240, rw - (rw < 720 ? 32 : 96));
  const W = Math.max(940, Math.min(1320, avail));
  const x = scaleFor(start, c, end, W, mode === 'plan' ? 0.22 : 0.3);

  // recs above the axis
  const up = recs.map((r) => {
    const needs = isNeeds(r, ny);
    const d = recDate(r);
    return {
      r, needs, x: x(d > end ? end : d), w: labelW(api.txt(r.title)),
      pri: needs ? 0 : OPEN.includes(r.status) ? 1 : r.status === 'done' ? 3 : 2
    };
  });
  const upL = Math.max(2, stack(up, W));

  // below the axis: deadlines without a rec, and past events
  const low = [];
  dls.forEach((d) => {
    if (d.recId && recById(d.recId)) return;
    low.push({ kind: 'dl', d, x: x(d.at > end ? end : d.at), w: labelW(api.txt(d.title) + ' ' + api.txt(d.label || ''), 210), pri: 0 });
  });
  const evs = arr(api.s.events).map((e) => ({ e, at: parseShort(e.date) })).filter((v) => v.at && v.at <= c);
  const lowL = low.length ? stack(low, W) : 0;

  const laneH = 30, top = 30, lowH = 24;
  const axisY = top + upL * laneH + 12;
  const lowTop = axisY + 34;
  const H = lowTop + lowL * lowH + (lowL ? 10 : 6);
  const nowX = x(c);

  let svg = `<svg class="h-tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  // month grid and labels
  for (let m = new Date(start); m <= end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const mx = x(m);
    const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const mid = (mx + x(next > end ? end : next)) / 2;
    const ny2 = m.getUTCMonth() === 0 && m.getUTCFullYear() !== year;
    svg += `<line class="h-tl-grid${ny2 ? ' yr' : ''}" x1="${mx}" x2="${mx}" y1="${mx < nowX ? axisY - 5 : top - 6}" y2="${axisY + 5}"/>`;
    const span = x(next > end ? end : next) - mx;
    if (span > 22) svg += `<text class="h-tl-mon${m.getUTCMonth() === c.getUTCMonth() && m.getUTCFullYear() === year ? ' cur' : ''}" x="${mid}" y="${axisY + 20}" text-anchor="middle">${MON[m.getUTCMonth()]}</text>`;
    if (ny2) svg += `<text class="h-tl-yr" x="${mx + 4}" y="${top + 4}">${m.getUTCFullYear()}</text>`;
  }
  svg += `<line class="h-tl-axis" x1="0" x2="${W}" y1="${axisY}" y2="${axisY}"/>`;
  svg += `<line class="h-tl-axis fut" x1="${nowX}" x2="${W}" y1="${axisY}" y2="${axisY}"/>`;
  // year-end close
  const ye = new Date(Date.UTC(year, 11, 31));
  if (ye <= end) svg += `<line class="h-tl-ye" x1="${x(ye)}" x2="${x(ye)}" y1="${top - 6}" y2="${H}"/>`;
  // stems
  up.forEach((it) => {
    const y = axisY - 12 - it.lane * laneH - laneH / 2 + 2;
    svg += `<line class="h-tl-stem${it.needs ? ' on' : ''}" x1="${it.x}" x2="${it.x}" y1="${y}" y2="${axisY}"/>`;
  });
  low.forEach((it) => {
    const y = lowTop + it.lane * lowH + lowH / 2 - 2;
    svg += `<line class="h-tl-stem lo" x1="${it.x}" x2="${it.x}" y1="${axisY}" y2="${y}"/>`;
    if (it.kind === 'dl') svg += `<rect class="h-tl-dia${it.d.hard ? ' hard' : ''}" x="${it.x - 3.5}" y="${axisY - 3.5}" width="7" height="7" transform="rotate(45 ${it.x} ${axisY})"/>`;
    else svg += `<circle class="h-tl-ev" cx="${it.x}" cy="${axisY}" r="2.5"/>`;
  });
  // deadline diamonds for rec-linked deadlines
  dls.forEach((d) => {
    if (!(d.recId && recById(d.recId))) return;
    const dx = x(d.at > end ? end : d.at);
    svg += `<rect class="h-tl-dia${d.hard ? ' hard' : ''}" x="${dx - 3.5}" y="${axisY - 3.5}" width="7" height="7" transform="rotate(45 ${dx} ${axisY})"/>`;
  });
  evs.forEach((v) => { svg += `<circle class="h-tl-ev" cx="${x(v.at)}" cy="${axisY}" r="3"><title>${X(v.e.date)}: ${X(v.e.title)}</title></circle>`; });
  svg += `<line class="h-tl-now" x1="${nowX}" x2="${nowX}" y1="${top - 14}" y2="${H}"/>`;
  svg += '</svg>';

  let html = `<div class="h-tl-now-lab" style="left:${nowX}px">Today <span>${fmt(c)}</span></div>`;
  if (ye <= end && x(ye) - nowX > 70) html += `<div class="h-tl-ye-lab" style="left:${x(ye)}px">Year closes</div>`;
  up.forEach((it) => {
    const r = it.r;
    const y = axisY - 12 - (it.lane + 1) * laneH + 2;
    const cls = it.needs ? 'needs' : r.status === 'done' ? 'done' : r.status === 'waiting' || r.status === 'snoozed' ? 'idle' : 'open';
    const tip = `${api.txt(r.title)}. ${STATUS[r.status] || ''}. ${api.txt(r.window?.label || '')}`;
    html += `<a class="h-tl-rec ${cls}${it.flip ? ' flip' : ''}" href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}" title="${esc(tip)}" style="left:${it.flip ? it.x - it.w : it.x}px;top:${y}px;width:${it.w}px;height:${laneH - 4}px">`
      + `<i class="h-tl-dot">${cls === 'done' ? icon('check') : ''}</i><span>${T(r.title)}</span></a>`;
  });
  low.forEach((it) => {
    const y = lowTop + it.lane * lowH;
    if (it.kind === 'dl') {
      const inner = `<b>${T(it.d.label || fmt(it.d.at))}</b> ${T(it.d.title)}`;
      html += `<div class="h-tl-low dl${it.d.hard ? ' hard' : ''}${it.flip ? ' flip' : ''}" style="left:${it.flip ? it.x - it.w : it.x}px;top:${y}px;width:${it.w}px">${inner}</div>`;
    } else {
      html += `<div class="h-tl-low ev${it.flip ? ' flip' : ''}" style="left:${it.flip ? it.x - it.w : it.x}px;top:${y}px;width:${it.w}px" title="${esc(api.txt(it.e.title))}"><b>${T(it.e.date)}</b> ${T(it.e.title)}</div>`;
    }
  });

  return `<div class="h-tl" data-tl="${mode}"><div class="h-tl-scroll" data-now="${nowX}">`
    + `<div class="h-tl-track" style="width:${W}px;height:${H}px">${svg}${html}</div></div>`
    + `<div class="h-tl-key"><span><i class="k needs"></i>Needs you</span><span><i class="k open"></i>In motion</span><span><i class="k idle"></i>Waiting or snoozed</span><span><i class="k done"></i>Done</span><span><i class="k dia"></i>Deadline</span>${evs.length ? '<span><i class="k ev"></i>What changed</span>' : ''}</div></div>`;
}

function windowStrip(r) {
  // A close-up of the rec's own window: today to close, with neighbouring deadlines.
  const c = clock();
  const d = days(r);
  const close = recDate(r);
  const span = Math.max(45, d + 21);
  const s = addDays(c, -10);
  const e = addDays(c, span);
  const W = 640, H = 64, pad = 14;
  const x = (t) => pad + ((t.getTime() - s.getTime()) / (e.getTime() - s.getTime())) * (W - pad * 2);
  const mons = [];
  let g = `<svg class="h-strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
  g += `<line class="h-strip-ax" x1="${pad}" x2="${W - pad}" y1="34" y2="34"/>`;
  for (let k = new Date(s); k <= e; k = addDays(k, 1)) {
    if (k.getUTCDate() === 1) {
      g += `<line class="h-strip-m" x1="${x(k)}" x2="${x(k)}" y1="26" y2="42"/>`;
      mons.push(`<span class="mon" style="left:${(x(k) / W) * 100}%">${MON[k.getUTCMonth()]}</span>`);
    }
  }
  arr(api.s.deadlines).forEach((dl) => {
    const at = parseISO(dl.date);
    if (!at || at < s || at > e || dl.recId === r.id) return;
    g += `<rect class="h-tl-dia" x="${x(at) - 3}" y="31" width="6" height="6" transform="rotate(45 ${x(at)} 34)"/>`;
  });
  if (d >= 0) g += `<line class="h-strip-win" x1="${x(c)}" x2="${x(close)}" y1="34" y2="34"/>`;
  g += `<line class="h-tl-now" x1="${x(c)}" x2="${x(c)}" y1="12" y2="46"/>`;
  g += `<circle class="h-strip-close" cx="${x(close)}" cy="34" r="5"/>`;
  g += '</svg>';
  const cd = countdown(r);
  return `<div class="h-strip-wrap">${g}<div class="h-strip-labs"><span style="left:${(x(c) / W) * 100}%">Today</span><span class="end" style="left:${(x(close) / W) * 100}%">${T(r.window?.label || fmt(close))}</span>${mons.join('')}</div>`
    + `<div class="h-strip-cd"><b>${cd.n}</b> ${cd.u}</div></div>`;
}

/* ---------- shell ---------- */

function whoLine() {
  const id = api.identity?.();
  if (!id) return '';
  const who = id.email || id.login || id.name;
  const role = id.role === 'admin' ? 'Household admin' : id.role === 'member' ? 'Household member' : '';
  return `<div class="h-who">Signed in as ${esc(who)}${role ? `<span>${role}</span>` : ''}</div>`;
}

// The route the tabs read: the page under the rec dialog when one is open.
function navRoute() {
  const r = routeNow();
  return r.name === 'rec' ? underRoute() : r;
}
const tabOf = (name) => TAB_OF[name] || 'home';
const onAttr = (on) => (on ? ' class="on" aria-current="page"' : '');

// Desktop header tabs, with the G hint in the title. Hidden at phone width by CSS.
function tabLinks(tab) {
  return TABS.map(([k, l]) => {
    const hint = switcher.goHint(k);
    return `<a href="${href(k)}" data-go="${k}"${onAttr(tab === k)}${hint ? ` title="${esc(`${l} (${hint})`)}"` : ''}>${l}</a>`;
  }).join('');
}

// Phone-width bottom tab bar: the same four tabs with icons, hidden above 720px by CSS.
function tabBar(tab) {
  const tabs = TABS.map(([k, l, ic]) => `<a href="${href(k)}" data-go="${k}"${onAttr(tab === k)}>${icon(ic)}<span>${l}</span></a>`).join('');
  return `<nav class="h-tabs" aria-label="Tabs">${tabs}</nav>`;
}

function gearLink(tab) {
  const on = tab === 'settings';
  const hint = switcher.goHint('settings');
  return `<a class="h-gear${on ? ' on' : ''}" href="${href('settings')}" data-go="settings" aria-label="Settings"${on ? ' aria-current="page"' : ''}${hint ? ` title="${esc(`Settings (${hint})`)}"` : ''}>${icon('gear')}</a>`;
}

// The views of the current tab, at the top of the page. A pack or a named what-if lights its list.
function subNav(tab, route) {
  const views = SUBNAV[tab];
  if (!views) return '';
  const label = TABS.find(([k]) => k === tab)[1];
  return `<nav class="h-subnav" aria-label="${label} views">${views.map(([k, l]) => `<a href="${href(k)}" data-go="${k}"${onAttr(route === k)}>${l}</a>`).join('')}</nav>`;
}

function shell(inner) {
  const r = navRoute();
  const tab = tabOf(r.name);
  const off = api.engineOn() ? '' : `<div class="h-engine-off">${icon('clock')}Engine off. Proactive jobs are paused. ${goA('engine', 'Engine settings')}</div>`;
  return `<header class="h-top"><div class="h-top-in">
    <a class="h-mark" href="${href('home')}" data-go="home" aria-label="${esc(api.s.meta.product || 'Fathom')}">${MARK}<span>${esc(api.s.meta.product || 'Fathom')}</span></a>
    <div class="h-navbar"><nav class="h-nav" aria-label="Main">${tabLinks(tab)}</nav></div>
    <div class="h-top-act"><button type="button" class="h-search-btn" data-keys="switcher" aria-label="Search" title="Search (Ctrl+K)">${icon('search')}</button>${gearLink(tab)}</div>
  </div></header>${off}<main class="h-main">${subNav(tab, r.name)}${inner}</main>${tabBar(tab)}`;
}

function section(title, body, aside = '', cls = '') {
  return `<section class="h-sec ${cls}"><div class="h-sec-h"><h2>${title}</h2>${aside ? `<div class="h-sec-aside">${aside}</div>` : ''}</div>${body}</section>`;
}

function pageHead(kicker, title, sub = '') {
  return `<div class="h-ph"><div class="h-kicker">${kicker}</div><h1>${title}</h1>${sub ? `<p class="h-lede">${sub}</p>` : ''}</div>`;
}

/* ---------- home ---------- */

// Phone width, the same breakpoint as the bottom tab bar. Home redraws on resize.
const isPhone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches;
const WHO = { you: 'You', spouse: 'Spouse', both: 'Both', advisor: 'Advisor', automatic: 'Auto' };
const SUBJECT = { both: 'either of you', me: 'you', spouse: 'your spouse' };
const chipHtml = (c, cls) => `<span class="${cls} ${c.tone}">${esc(c.label)}</span>`;
const whoTag = (r) => `<span class="h-who">${WHO[r.owner] || ''}</span>`;
const recLink = (r, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}">${T(r.title)}</a>`;
const pct = (v) => Math.round(v * 1000) / 10;

function liveDomainStatus(dm, ny) {
  if (ny.some((r) => r.domain === dm.id)) return 'needs';
  if (dm.status === 'needs') return 'covered';
  return dm.status;
}

const cdTone = (r) => { const d = days(r); return d < 0 ? ' late' : d <= 30 ? ' soon' : ''; };

function cdHtml(r, cls) {
  const cd = countdown(r);
  return `<div class="${cls}${cdTone(r)}"><b>${cd.n}</b><span>${cd.u}</span></div>`;
}

function gnextHtml(r) {
  return `<div class="h-gnext" data-rec="${esc(r.id)}">${cdHtml(r, 'h-gcd')}${recLink(r, 'h-gnext-t')}${whoTag(r)}</div>`;
}

// A goal title by id: the stored goal, else the title the rec's serves entry carries.
function servedTitle(r, id) {
  const g = arr(api.s.goals).find((x) => x.id === id);
  if (g) return goalTitle(g);
  const s = arr(r.serves).find((x) => x && x.id === id);
  return s && s.title ? (s.origin === 'owner' ? esc(s.title) : T(s.title)) : esc(id);
}

function goalCardHome(c, subject) {
  const p = c.pace;
  const fk = (k) => `pace.goals.${c.paceIndex}.${k}`;
  let bar = '';
  if (c.bar) {
    const asOf = c.bar.muted && p.dataThrough ? `<em>as of ${esc(shortDate(p.dataThrough))}</em>` : '';
    bar = `<div class="h-pbar ${c.chip.tone}${c.bar.muted ? ' muted' : ''}" aria-hidden="true"><i class="fill" style="width:${pct(c.bar.fill)}%"></i><i class="tick" style="left:${pct(c.bar.tick)}%"></i></div>`
      + `<div class="h-pbar-l"><span>${figHtml(fk('actual'), { k: true })} of ${figHtml(fk('target'), { k: true })}</span><span>plan today ${figHtml(fk('expected'), { k: true })}${asOf}</span></div>`;
  } else if (c.suggestion) {
    bar = suggestHtml(c.suggestion);
  } else if (c.goal.origin === 'owner' && Number.isFinite(c.goal.target) && !c.goal.track) {
    // A target with nothing tracked: say so rather than the pace reason for a missing plan start.
    bar = `<p class="h-gwhy">${esc(reasonText('missing_actual'))}</p>`;
  } else if (p && p.reason) {
    bar = `<p class="h-gwhy">${esc(reasonText(p.reason))}</p>`;
  }
  const next = c.next ? gnextHtml(c.next) : `<p class="h-gnext-none">Nothing due for ${subject}</p>`;
  const more = c.actions.length > 1 ? `<a class="h-gmore" href="${href('plan')}" data-go="plan">${plural(c.actions.length - 1, 'more action')} on the plan</a>` : '';
  return `<article class="h-gcard" data-goal-card="${esc(c.id)}"><div class="h-gcard-h"><a class="h-gcard-t" href="${href('goals')}" data-go="goals">${goalTitle(c.goal)}</a>${chipHtml(c.chip, 'h-pchip')}</div>${bar}${next}${more}</article>`;
}

function hkHtml(list) {
  if (!list.length) return '';
  return `<details class="h-hk" data-det="home-hk"${ui.det['home-hk'] ? ' open' : ''}><summary><span>Housekeeping, serves no goal: <b>${list.length}</b></span>${icon('chev')}</summary><div class="h-hk-b">${list.map(gnextHtml).join('')}</div></details>`;
}

function ownerFilterHtml(m) {
  const b = (k, l) => `<button type="button" data-owner="${k}" aria-pressed="${m.filter === k}">${l} <span>${m.counts[k]}</span></button>`;
  return `<div class="h-ownerf" role="group" aria-label="Whose actions">${b('both', 'Both')}${b('me', 'Me')}${b('spouse', 'Spouse')}</div>`;
}

const healthLinks = (h) => `${h.pending > 0 ? goA('confirm', 'Confirm') : ''}${goA('add', 'Files')}${goA('accounts', 'Accounts')}`;

function dhealthHtml(h) {
  const links = healthLinks(h);
  return `<div class="h-dhealth${h.stale ? ' stale' : ''}"><i class="h-dh-dot" aria-hidden="true"></i><span class="h-dhealth-t">${esc(h.parts.join(', '))}</span><span class="h-dhealth-a">${links}</span></div>`;
}

const homeHealth = () => healthLine({
  pace: api.s.pace || null, ingest: api.ingest(), accounts: api.s.accounts,
  metaDataThrough: api.s.meta?.dataThrough ? api.txt(api.s.meta.dataThrough) : null
});

// Phone: the one next thing for the filtered owner, with Done, Later and Ask.
function nextHtml(m, subject) {
  const r = m.nextThing;
  if (!r) return `<div class="h-next-empty">Nothing open for ${subject}</div>`;
  const first = arr(r.why)[0];
  const why = first ? T(first) : T(r.summary);
  const ids = servedGoalIds(r);
  const serves = ids.length && !r.housekeeping
    ? `Serves ${ids.map((id) => `<a href="${href('goals')}" data-go="goals">${servedTitle(r, id)}</a>`).join(', ')}`
    : 'Housekeeping, serves no goal';
  const cd = countdown(r);
  const id = esc(r.id);
  return `<div class="h-next-deck${m.afterThat.length ? ' stack' : ''}"><article class="h-next" data-next-rec="${id}">
    <div class="h-next-top"><span class="h-next-k">Next</span>${whoTag(r)}<span class="h-next-cd${cdTone(r)}"><b>${cd.n}</b><span>${cd.u}</span></span></div>
    <h2 class="h-next-t">${recLink(r)}</h2>
    ${why ? `<p class="h-next-why">${why}</p>` : ''}
    <p class="h-serves-l">${serves}</p>
    <p class="h-next-win">${windowText(r)}</p>
    <div class="h-next-acts"><button type="button" class="h-btn pri" data-act="complete" data-rec="${id}">Done</button><button type="button" class="h-btn" data-act="snooze" data-rec="${id}" data-arg="${esc(snoozeLabel())}">Later</button><button type="button" class="h-btn" data-ask-next="${id}">Ask</button></div>
  </article></div>
  <p class="h-next-hint"><span>Swipe left for later, right for done</span></p>`;
}

function afterHtml(m) {
  if (!m.afterThat.length) return '';
  return `<div class="h-after"><div class="h-after-l">After that</div>${m.afterThat.map((r) => `<div class="h-after-r" data-rec="${esc(r.id)}"><span class="h-after-d">${fmt(recDate(r))}</span>${recLink(r)}${whoTag(r)}</div>`).join('')}</div>`;
}

/* ---------- suggested targets (Home cards and Goals) ---------- */

// The suggestion record for a goal, from scenario.suggestions; null when it has none.
const suggOf = (id) => arr(api.s.suggestions).find((r) => r && String(r.goalId) === String(id)) || null;

// The end-of-horizon note on a date that is not a projection.
const horizonNote = (label) => (label === 'This year' ? ' (the end of the year you picked)' : ` (the end of the ${esc(label)} you picked)`);

// One goal's suggested target: the line, why, what it comes from, the withdrawal rate when it can
// be changed, and Accept, Edit, Dismiss. A question asks for an amount; a dismissed one offers Add one.
// Every amount is a calc:targets figure; the rate is a parameter in percent.
function suggestHtml(s) {
  const id = esc(s.goalId);
  const edit = (label, cls) => btn(label, `data-sugg-act="edit" data-id="${id}"`, cls);
  if (s.state === 'dismissed') {
    return `<p class="h-gnone">No target yet. <button type="button" class="h-link" data-sugg-act="edit" data-id="${id}">Add one</button></p>`;
  }
  if (s.state !== 'suggested') {
    return `<div class="h-sugg ask" data-sugg="${id}"><p class="h-sugg-q">${esc(s.ask || 'What amount would make this real?')}</p>`
      + `<p class="h-sugg-why">${esc(askReason(s))}</p><div class="h-sugg-acts">${edit('Edit goal', '')}</div></div>`;
  }
  const f = s.figures || {};
  const amt = (k) => (k ? figHtml(k, { k: true }) : '');
  const nAccts = arr(s.track?.accounts).length;
  const tracks = !s.track ? ', tracks nothing automatically: contributions are not measured yet'
    : s.trackLabel && nAccts <= 3 ? `, tracks ${T(s.trackLabel)}`
      : `, tracks ${plural(nAccts, s.kind === 'independence' ? 'investment account' : s.kind === 'cushion' ? 'cash account' : 'account')}`;
  let head;
  if (s.covered) {
    head = `Already covered: ${f.current ? `${amt(f.current)} against ${amt(f.target)}` : amt(f.target)}`;
  } else {
    const when = longDate(s.targetDate);
    head = `Suggested: ${amt(f.target)}${when ? ` by ${when}` : ''}${when && s.dateSource === 'horizon' && s.horizonLabel ? horizonNote(s.horizonLabel) : ''}`;
  }
  const win = windowSpan(s.window);
  const src = [];
  if (s.kind === 'cushion' && f.monthlySpend) {
    const n = Number(s.params?.cushionMonths);
    src.push(`From ${amt(f.monthlySpend)} a month of spending${win ? `, ${win}` : ''}${Number.isFinite(n) && n > 0 ? `, times ${plural(n, 'month')}` : ''}`);
  } else if (s.kind === 'independence' && f.annualSpend) {
    src.push(`From ${amt(f.annualSpend)} a year of spending${win ? `, ${win}` : ''}, over the withdrawal rate`);
  } else if (s.kind === 'tax' && arr(f.rooms).length) {
    src.push(`From this year's unused room: ${arr(f.rooms).map((k) => `${esc(api.fig(k)?.label || 'Room')} ${amt(k)}`).join(', ')}`);
  } else if (win) {
    src.push(`Spending ${win}`);
  }
  if (f.monthlySavings && s.dateSource === 'projected') src.push(`Saving ${amt(f.monthlySavings)} a month`);
  let rate = '';
  if (arr(s.editable).includes('withdrawalRate')) {
    const r = Number(s.params?.withdrawalRate);
    const pv = Math.round((Number.isFinite(r) ? r : 0.04) * 10000) / 100;
    rate = `<label class="h-sugg-rate">Withdrawal rate <input type="number" data-sugg-rate="${id}" min="2" max="6" step="0.25" inputmode="decimal" value="${pv}"><span>%</span></label>`;
  }
  return `<div class="h-sugg" data-sugg="${id}"><p class="h-sugg-l">${head}${tracks}</p>`
    + `${s.why ? `<p class="h-sugg-why">${T(s.why)}</p>` : ''}`
    + `${src.length ? `<p class="h-sugg-src">${src.join('. ')}.</p>` : ''}${rate}`
    + `<div class="h-sugg-acts">${btn('Accept', `data-sugg-act="accept" data-id="${id}"`, 'pri')}${edit('Edit', '')}${btn('Dismiss', `data-sugg-act="dismiss" data-id="${id}"`, 'ghost')}</div></div>`;
}

// Edit from Home or Goals: the goal form on #/goals, prefilled from the suggestion's accept body;
// a question or a dismissed suggestion opens it with the goal's own values. Nothing is saved.
function openSuggForm(id) {
  const g = arr(api.s.goals).find((x) => String(x.id) === String(id));
  if (!g) return;
  const s = suggOf(id);
  const draft = draftOf(g);
  const a = s && s.state === 'suggested' ? s.accept : null;
  if (a) {
    if (Number.isFinite(a.target)) draft.target = String(a.target);
    if (a.targetDate) draft.targetDate = a.targetDate;
    if (a.track && Array.isArray(a.track.accounts)) { draft.trackKind = 'accounts'; draft.accounts = a.track.accounts.slice(); draft.figure = ''; }
  }
  if (routeNow().name !== 'goals') api.go('goals', {});
  openGoalForm(g.id, draft);
}

// Accept, Edit, Dismiss and Accept all. Accept posts the record's accept body as the goal update;
// Accept all posts each pending one in card order and redraws once.
function suggClick(e) {
  const t = e.target.closest('[data-sugg-act],[data-sugg-all]');
  if (!t || !root.contains(t)) return false;
  e.preventDefault();
  if (t.dataset.suggAll != null) {
    const list = homeModelNow().pending.filter((s) => s.accept).map((s) => ({ id: s.goalId, fields: s.accept }));
    if (list.length) api.goalsAccept(list);
    return true;
  }
  const id = t.dataset.id;
  const act = t.dataset.suggAct;
  const s = suggOf(id);
  if (act === 'edit') openSuggForm(id);
  else if (act === 'accept' && s?.accept) api.goalUpdate(id, s.accept);
  else if (act === 'dismiss' && s) api.goalSuggestion(id, { action: 'dismiss' });
  return true;
}

// The withdrawal rate input commits on change, as a fraction, clamped to the calculator's range.
function suggRate(t) {
  const v = Number(t.value);
  if (t.value === '' || !Number.isFinite(v)) { draw(); return; }
  const pv = Math.max(2, Math.min(6, v));
  api.goalSuggestion(t.dataset.suggRate, { withdrawalRate: Math.round(pv * 100) / 10000 });
}

// Desktop: the next goal actions due before Dec 31, up to five, each with date, title and owner.
function dueHtml(m) {
  const list = m.due.slice(0, 5);
  if (!list.length) return '';
  const row = (r) => `<div class="h-due-r" data-rec="${esc(r.id)}"><span class="h-due-d${days(r) < 0 ? ' late' : ''}">${fmt(recDate(r))}</span>${recLink(r)}${whoTag(r)}</div>`;
  return `<div class="h-due"><div class="h-due-l">Due before Dec 31</div>${list.map(row).join('')}</div>`;
}

const homeModelNow = () => homeModel({
  goals: api.s.goals, pace: api.s.pace || null, recs: api.recs(), filter: ui.owner,
  suggestions: api.s.suggestions, clock: api.s.meta?.clock
});

function pHome() {
  const pace = api.s.pace || null;
  const m = homeModelNow();
  // No open goals: Home is the Goals step (kept while its save runs), with the data-health line.
  if (!m.cards.length || ui.goalsBusy === 'home') {
    return shell(`<section class="h-home h-home-gs">${goalsStartHtml('home')}${dhealthHtml(homeHealth())}</section>`);
  }
  const subject = SUBJECT[m.filter];
  const hd = homeHeadline({ cards: m.cards, pace, pending: m.pending });
  const hc = healthChip(pace);
  const due = m.due.length;
  const bulk = hd.bulk ? `<div class="h-home-bulk">${btn('Accept all', 'data-sugg-all="1"', 'pri')}${goA('goals', 'Review targets', {}, 'h-home-rev')}</div>` : '';
  const head = `<div class="h-home-head"><div class="h-home-k">${T(api.s.meta.clockLabel)}</div>`
    + `<a class="h-hchip ${hc.tone}" href="${href('pace')}" data-go="pace">${esc(hc.label)}${icon('arrow')}</a>`
    + `<h1 class="h-home-h">${esc(hd.title)}</h1>`
    + `<p class="h-home-sub">${due ? `${plural(due, 'thing')} before Dec 31` : 'Nothing due before Dec 31'}</p>${bulk}</div>`;
  const health = dhealthHtml(homeHealth());
  const cards = `<div class="h-gcards">${m.cards.map((x) => goalCardHome(x, subject)).join('')}</div>`;
  const goalsH = `<div class="h-home-sec"><h2>Goals</h2>${goA('goals', 'All goals')}</div>`;
  const rest = `${goalsH}${cards}${hkHtml(m.housekeeping)}`;
  const inner = isPhone()
    ? `${ownerFilterHtml(m)}${head}${nextHtml(m, subject)}${afterHtml(m)}${health}${rest}`
    : `<header class="h-home-top">${head}${ownerFilterHtml(m)}</header>${dueHtml(m)}${health}${rest}`;
  return shell(`<section class="h-home">${inner}</section>`);
}

/* ---------- pace board ---------- */

// 'YYYY-MM' of the scenario clock, the form pace series months use.
const clockMonth = () => { const c = clock(); return `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}`; };
const monthIdx = (m) => Number(String(m?.month || '').slice(5, 7)) - 1;

const METERS = [['retirement', 'Retirement room used, closes Dec 31'], ['tax', 'Tax reserved vs owed'], ['income', 'Income vs plan']];

function meterHtml([k, label]) {
  const mt = api.s.pace?.meters?.[k];
  const base = `pace.meters.${k}.meter`;
  const ratio = mt?.meter ? (figVal(`${base}.ratio`) ?? (Number.isFinite(mt.meter.ratio?.v) ? mt.meter.ratio.v : null)) : null;
  if (ratio == null) {
    return `<div class="h-meter" data-meter="${k}"><div class="h-meter-top"><span>${label}</span></div><p class="h-meter-none">${esc(reasonText(mt?.reason))}</p></div>`;
  }
  const r = Math.max(0, Math.min(1, ratio));
  const asOf = mt.stale && mt.dataThrough ? `<p class="h-meter-note">Data stale, as of ${esc(shortDate(mt.dataThrough))}</p>` : '';
  return `<div class="h-meter" data-meter="${k}"><div class="h-meter-top"><span>${label}</span><span>${figHtml(`${base}.used`, { k: true })} of ${figHtml(`${base}.limit`, { k: true })}</span></div>`
    + `<div class="h-mbar${mt.stale ? ' muted' : ''}" aria-hidden="true"><i style="width:${pct(r)}%"></i></div>${asOf}</div>`;
}

// Diverging monthly bars of actual minus plan. One axis with a zero baseline; observed months are
// filled (accent ahead, warn behind), projected months are a dashed outline. Bars are clipped at
// the baseline so only the data end is rounded.
function paceChart(ch, ci) {
  const W = 360, H = 196, L = 46, R = 6, Tp = 24, B = 24;
  const ser = arr(ch.series);
  const n = ser.length || 12;
  const vals = ser.map((m) => (m && m.gap && Number.isFinite(m.gap.v) ? m.gap.v : null));
  const fin = vals.filter((v) => v != null);
  const yt = niceTicks(Math.min(0, ...fin), Math.max(0, ...fin), 4);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const sy = (v) => Tp + (1 - (v - y0) / ((y1 - y0) || 1)) * (H - Tp - B);
  const slot = (W - L - R) / n;
  const bw = slot - 2;
  const zy = sy(0);
  const cid = `h-pc-${ci}`;
  const curM = clockMonth();
  const g0 = arr(api.s.goals).find((x) => x.id === ch.id);
  const title = g0 ? goalTitle(g0) : esc(ch.title);
  let g = `<svg class="h-pc" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(api.txt(ch.title || ''))}: ahead or behind plan, by month">`;
  g += `<defs><clipPath id="${cid}-p"><rect x="0" y="0" width="${W}" height="${zy}"/></clipPath><clipPath id="${cid}-n"><rect x="0" y="${zy}" width="${W}" height="${H - zy}"/></clipPath></defs>`;
  yt.forEach((v) => {
    if (v !== 0) g += `<line class="h-pc-grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>`;
    g += `<text class="h-pc-t h-sc-t" x="${L - 7}" y="${sy(v) + 3.5}" text-anchor="end">${esc(api.money(v, { k: true, sign: v !== 0 }))}</text>`;
  });
  let pos = '', neg = '';
  ser.forEach((m, i) => {
    const v = vals[i];
    const mi = monthIdx(m);
    const x = L + i * slot + 1;
    g += `<text class="h-pc-m${m?.month === curM ? ' cur' : ''}" x="${x + bw / 2}" y="${H - 7}" text-anchor="middle">${MON[mi] ? MON[mi][0] : ''}</text>`;
    if (v == null) return;
    const h = Math.max(1.5, Math.abs(sy(v) - zy));
    const rr = Math.min(4, bw / 2);
    const up = v >= 0;
    const y = up ? zy - h : zy - rr;
    const tip = `${MONTH_FULL[mi] || m.month}: ${api.money(Math.abs(v), { k: true })} ${up ? 'ahead of' : 'behind'} plan${m.projected ? ', projected' : ''}`;
    const rect = `<rect class="h-pbar-m fx-fig ${up ? 'pos' : 'neg'}${m.projected ? ' proj' : ''}" data-month="${esc(m.month)}" data-fig="${esc(`${ch.figBase}.${i}.gap`)}" data-kind="${esc(m.gap.kind || '')}" tabindex="0" x="${x}" y="${y}" width="${bw}" height="${h + rr}" rx="${rr}"><title>${esc(tip)}</title></rect>`;
    if (up) pos += rect; else neg += rect;
  });
  g += `<g clip-path="url(#${cid}-p)">${pos}</g><g clip-path="url(#${cid}-n)">${neg}</g>`;
  g += `<line class="h-pc-zero" x1="${L}" x2="${W - R}" y1="${zy}" y2="${zy}"/>`;
  const endIdx = ch.dataEnd ? ser.findIndex((m) => m?.month === ch.dataEnd.slice(0, 7)) : -1;
  if (endIdx >= 0) {
    const ex = L + (endIdx + 1) * slot;
    const right = ex > W - 96;
    g += `<line class="h-pc-end" x1="${ex}" x2="${ex}" y1="${Tp - 14}" y2="${H - B}"/>`;
    g += `<text class="h-pc-endl" x="${right ? ex - 5 : ex + 5}" y="${Tp - 6}" text-anchor="${right ? 'end' : 'start'}">data ends ${esc(shortDate(ch.dataEnd))}</text>`;
  }
  g += '</svg>';
  // Headline: the gap at the data end, from the stored figure.
  const li = endIdx >= 0 && vals[endIdx] != null ? endIdx : vals.map((v, i) => (v != null && !ser[i].projected ? i : -1)).filter((i) => i >= 0).pop();
  const last = li != null && li >= 0 ? `<span class="h-pc-last ${vals[li] >= 0 ? 'pos' : 'neg'}">${figHtml(`${ch.figBase}.${li}.gap`, { k: true, abs: true })} ${vals[li] >= 0 ? 'ahead' : 'behind'} in ${MON[monthIdx(ser[li])]}</span>` : '';
  const cell = (i, k, o = {}) => (ser[i]?.[k] && api.fig(`${ch.figBase}.${i}.${k}`) ? figHtml(`${ch.figBase}.${i}.${k}`, o) : '<span class="h-mute">No reading</span>');
  const rows = ser.map((m, i) => `<tr${m.projected ? ' class="proj"' : ''}><th scope="row">${MON[monthIdx(m)] || esc(m.month)}${m.projected ? '<em>projected</em>' : ''}</th><td>${cell(i, 'plan')}</td><td>${cell(i, 'actual')}</td><td>${cell(i, 'gap', { sign: true })}</td></tr>`).join('');
  const det = `pace-table-${ch.id}`;
  return `<figure class="h-pchart" data-chart="${esc(ch.id)}"><figcaption><div><b>${title}</b><span>Ahead or behind plan, by month</span></div>${last}</figcaption>${g}`
    + '<div class="h-pc-key"><span><i class="k pos"></i>Ahead of plan</span><span><i class="k neg"></i>Behind plan</span><span><i class="k proj"></i>Projected</span></div>'
    + `<details class="h-ptable" data-det="${esc(det)}"${ui.det[det] ? ' open' : ''}><summary>As a table</summary><div class="h-ptable-s"><table><thead><tr><th scope="col">Month</th><th scope="col">Plan</th><th scope="col">Actual</th><th scope="col">Gap</th></tr></thead><tbody>${rows}</tbody></table></div></details></figure>`;
}

function pPace() {
  const pace = api.s.pace || null;
  const hc = healthChip(pace);
  const charts = boardCharts(pace);
  const curM = clockMonth();
  const projected = charts.some((ch) => ch.dataEnd && ch.dataEnd.slice(0, 7) < curM);
  const body = charts.length
    ? `<div class="h-pcharts">${charts.map(paceChart).join('')}</div>`
    : `<p class="h-pchart-none">${esc(reasonText(pace?.series?.householdSavings?.reason))}</p>`;
  const h = homeHealth();
  return shell(`<section class="h-pace"><a class="h-back" href="${href('home')}" data-go="home">${icon('back')}Home</a>
    <div class="h-pace-head"><span class="h-hchip ${hc.tone}">${esc(hc.label)}</span><h1>${esc(pace?.rollup?.headline || 'No goals with targets')}</h1><p class="h-pace-why">${esc(paceReason(pace))}</p></div>
    ${section(charts.length && charts[0].id === 'householdSavings' ? 'Household savings' : 'By goal', body, charts.length ? 'Solid is observed, dashed is projected' : '')}
    ${section('This year', `<div class="h-meters">${METERS.map(meterHtml).join('')}</div>`)}
    <p class="h-pace-fresh">${icon('clock')}<span>${esc(h.dataLabel)}.${projected ? ' Later months are projected.' : ''} ${goA('add', 'Files')} ${goA('accounts', 'Accounts')}</span></p></section>`);
}

/* ---------- plan ---------- */

function recRow(r, ny) {
  const cd = countdown(r);
  const live = OPEN.includes(r.status);
  const fin = r.status === 'done' || r.status === 'dismissed';
  return `<article class="h-row ${r.status}${isNeeds(r, ny) ? ' needs' : ''}">
    ${fin ? `<div class="h-cd fin"><i>${r.status === 'done' ? icon('check') : icon('x')}</i></div>` : `<div class="h-cd${live && cd.n <= 30 ? ' soon' : ''}${live ? '' : ' dim'}"><b>${cd.n}</b><span>${cd.u}</span></div>`}
    <div class="h-row-b">
      <div class="h-row-top"><a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}">${T(r.title)}</a><span class="h-st ${r.status}">${statusText(r)}</span></div>
      <p>${T(r.summary)}</p>
      <div class="h-meta"><span>${T(r.triggerText || TRIGGER[r.trigger] || '')}</span>${r.status === 'done' || r.status === 'dismissed' ? '' : `<span>${T(r.window?.label || '')}</span>`}${r.effort ? `<span>${T(r.effort)}</span>` : ''}${values(r) ? `<span>${values(r)}</span>` : ''}${r.advisor ? `<span class="h-adv ${r.advisor.verdict}">${advisorText(r)}</span>` : ''}${servesHtml(r)}</div>
    </div>
    <div class="h-acts">${actionsFor(r, true).join('')}${advisorScreen.rowAction(r)}</div>
  </article>`;
}

function pPlan() {
  const ny = api.needsYou();
  const recs = visibleRecs().slice().sort((a, b) => days(a) - days(b));
  const c = clock();
  const ye = daysBetween(c, new Date(Date.UTC(c.getUTCFullYear(), 11, 31)));
  const open = recs.filter((r) => OPEN.includes(r.status));
  const groups = [
    ['Next 30 days', open.filter((r) => days(r) <= 30)],
    ['Before the year closes', open.filter((r) => days(r) > 30 && days(r) <= ye)],
    [`${c.getUTCFullYear() + 1} and later`, open.filter((r) => days(r) > ye)],
    ['Waiting', recs.filter((r) => r.status === 'waiting')],
    ['Later', recs.filter((r) => r.status === 'snoozed')],
    ['Done', recs.filter((r) => r.status === 'done')]
  ];
  const dismissed = recs.filter((r) => r.status === 'dismissed');
  const counts = [
    [ny.length, 'need you'], [open.length, 'open'], [recs.filter((r) => r.status === 'waiting').length, 'waiting'],
    [recs.filter((r) => r.status === 'done').length, 'done']
  ];
  const stats = `<div class="h-stats">${counts.map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>`;
  const body = groups.filter((g) => g[1].length).map(([t, list]) => section(`${t} <em>${list.length}</em>`, `<div class="h-rows">${list.map((r) => recRow(r, ny)).join('')}</div>`)).join('')
    + (dismissed.length ? `<details class="h-details" data-det="dismissed"${ui.det.dismissed ? ' open' : ''}><summary>Not for us <em>${dismissed.length}</em></summary><div class="h-rows">${dismissed.map((r) => recRow(r, ny)).join('')}</div></details>` : '');
  // Covered domains, What changed and the email note moved here from the old Year page.
  const evs = arr(api.s.events);
  const changed = evs.length ? `<ol class="h-evs">${evs.map((e) => `<li><time>${T(e.date)}</time><div><b>${T(e.title)}</b><p>${T(e.body)}</p></div></li>`).join('')}</ol>` : '<p class="h-mute">Nothing new since the last brief.</p>';
  const doms = arr(api.s.domains).map((dm) => {
    const st = liveDomainStatus(dm, ny);
    const lab = { covered: 'Covered', changed: 'Changed', needs: 'Needs you', waiting: 'Waiting' }[st] || st;
    return `<div class="h-dom ${st}"><div class="h-dom-h"><i></i><b>${T(dm.name)}</b><span>${lab}</span></div><p>${T(dm.note)}</p><p class="h-mute sm">${T(dm.watching)}</p></div>`;
  }).join('');
  const quiet = arr(api.s.domains).filter((d) => liveDomainStatus(d, ny) === 'covered').length;
  const more = `<div class="h-cols">
      <div class="h-col-main">${section('Covered', `<div class="h-doms">${doms}</div>`, `${quiet} of ${arr(api.s.domains).length} quiet`)}</div>
      <div class="h-col-side">${section('What changed', changed)}
        <div class="h-mailnote">${icon('doc')}<div>This brief also went out as your monthly email. ${goA('email', 'Read the email')}</div></div></div>
    </div>`;
  return shell(`${pageHead('Plan', 'Everything on the calendar', 'Each item sits at the date its window closes. Decide, do it, or set it aside.')}${stats}
    ${section('Timeline', timeline('plan'))}${body || '<p class="h-mute">No recommendations yet.</p>'}${more}`);
}

/* ---------- rec detail ---------- */

function thread(msgs, selfId = '') {
  if (!msgs.length) return '';
  return `<div class="h-thread">${msgs.map((m) => {
    const who = m.role === 'me' ? 'You' : m.role === 'advisor' ? (api.s.advisor?.name ? T(api.s.advisor.name) : esc(api.s.names?.advisor || 'Advisor')) : m.role === 'claude' ? 'Claude' : esc(api.s.meta.product || 'Fathom');
    const refs = arr(m.refs).filter((id) => id !== selfId).map((id) => recById(id)).filter(Boolean);
    return `<div class="h-msg ${esc(m.role)}${m.notice ? ' notice' : ''}"><div class="h-msg-who">${who}${m.ts ? `<time>${X(m.ts)}</time>` : ''}</div><div class="h-msg-b">${m.html || ''}</div>`
      + (refs.length ? `<div class="h-refs">${refs.map((r) => `<a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}"><span>${T(r.title)}</span><em>${T(r.window?.label || '')}</em>${icon('arrow')}</a>`).join('')}</div>` : '')
      + chatScreen.proposalHtml(m)
      + chatScreen.goalProposalHtml(m)
      + chatScreen.sourcesHtml(m)
      + '</div>';
  }).join('')}</div>`;
}

function asked(msgs, q) {
  const qt = api.txt(q).trim();
  return msgs.some((m) => m.role === 'me' && (m.html || '').replace(/<[^>]+>/g, '').trim() === qt);
}

// busy: a question is in flight; the field is read-only (it keeps focus) and Send is disabled.
function composer(key, placeholder, busy = false) {
  const off = !api.engineOn();
  return `<form class="h-compose" data-free="${esc(key)}"${busy ? ' aria-busy="true"' : ''}>
    <input name="q" type="text" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(ui.draft[key] || '')}" data-draft="${esc(key)}"${busy ? ' readonly' : ''}>
    <button type="submit" class="h-btn pri" aria-label="Send"${busy ? ' disabled' : ''}>${icon('send')}</button>
  </form>${off ? '<p class="h-mute sm">Engine off. Answers are paused until it is back on.</p>' : ''}`;
}

function packName(id) {
  const p = id ? arr(api.packs()).find((x) => x.id === id) : null;
  return p ? T(p.name) : '';
}

function dlgHtml(id) {
  const close = `<button type="button" class="h-dlg-x" data-dlg="close" aria-label="Close">${icon('x')}</button>`;
  const frame = (kick, body) => `<div class="h-dlg-back" data-dlg="close"></div><div class="h-dlg" role="dialog" aria-modal="true" aria-labelledby="h-dlg-t" tabindex="-1"><div class="h-dlg-bar"><div class="h-kicker">${kick}</div>${close}</div><div class="h-dlg-body">${body}</div></div>`;
  const r = recById(id);
  if (!r) return frame('Plan', `<h1 id="h-dlg-t" class="h-dlg-title">Not on your plan</h1><p class="h-mute">That recommendation is not on your plan right now.</p>`);
  // The conversation is the rec's attached Ask thread (none until the first question, and none
  // again after Start over); a question in flight shows as the Ask page's pending block.
  const th = api.recThread(r.id);
  const tkey = th ? chatScreen.keyOf(th) : '';
  const msgs = tkey ? arr(api.conversation(tkey)) : [];
  const pend = chatScreen.recPendingHtml(r.id, tkey);
  const busy = chatScreen.askBusy() || !!ui.recReset[r.id];
  const tasks = arr(r.tasks);
  const doneN = tasks.filter((t) => t.done).length;
  const ny = api.needsYou();

  const why = arr(r.why).map((p) => `<p>${T(p)}</p>`).join('');
  const mine = arr(r.mine).length ? `<dl class="h-mine">${arr(r.mine).map((m) => `<div><dt>${T(m.label)}</dt><dd>${figHtml(m.fig)}</dd></div>`).join('')}</dl>` : '';
  const kb = arr(r.kb).map((k) => `<blockquote class="h-kb"><b>${T(k.title)}</b><p>${T(k.body)}</p><footer>${k.cite ? `<cite>${T(k.cite)}</cite>` : ''}${k.pack && packName(k.pack) ? `${goA('packs', `${packName(k.pack)} pack`, { id: k.pack }, 'h-kb-pack')}` : ''}</footer></blockquote>`).join('');
  const cross = arr(r.cross).length ? `<ul class="h-cross">${arr(r.cross).map((x) => `<li>${T(x)}</li>`).join('')}</ul>` : '';
  const val = arr(r.value).length ? `<ul class="h-vals">${arr(r.value).map((v) => `<li><span class="h-vk">${VALUE[v.cls] || esc(v.cls)}</span><div>${T(v.text)}</div></li>`).join('')}</ul>` : '';

  const pct = tasks.length ? doneN / tasks.length : 0;
  const check = tasks.length ? `<div class="h-prog"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="4" rx="2"/><rect class="fg" width="${pct * 100}" height="4" rx="2"/></svg><span>${doneN} of ${tasks.length}</span></div>
    <ul class="h-tasks">${tasks.map((t, i) => `<li><button type="button" class="h-task${t.done ? ' done' : ''}" data-act="task" data-rec="${esc(r.id)}" data-arg="${i}" aria-pressed="${t.done}"><i>${t.done ? icon('check') : ''}</i><span>${T(t.t)}</span></button></li>`).join('')}</ul>` : '<p class="h-mute">No steps.</p>';

  const adv = advisorScreen.recBox(r);

  const chips = arr(r.qa).map((q, i) => asked(msgs, q.q) ? '' : `<button type="button" class="h-chip" data-askrec="${esc(r.id)}" data-i="${i}"${busy ? ' disabled' : ''}>${T(q.q)}</button>`).join('');
  const wg = r.scenario && api.s.wargame?.[r.scenario]?.status !== 'unavailable' ? `<a class="h-wglink" href="${href('wargame', { name: r.scenario })}" data-go="wargame" data-name="${esc(r.scenario)}"><div><b>War-game this</b><span>${T(api.s.wargame?.[r.scenario]?.title || '')}</span></div>${icon('arrow')}</a>` : '';

  const convAside = th
    ? `<div class="h-sec-aside h-conv-acts"><a class="h-conv-open" href="${href('ask', { id: th.id })}" data-go="ask" data-id="${esc(th.id)}">Open in Ask</a><button type="button" class="h-conv-reset" data-recstart="${esc(r.id)}"${busy ? ' disabled' : ''}>Start over</button></div>`
    : '<div class="h-sec-aside">Answers use the figures below</div>';
  const conv = `<section class="h-sec h-conv"><div class="h-sec-h"><h2>Ask about this</h2>${convAside}</div>
    ${thread(msgs, r.id)}${pend}${chips ? `<div class="h-chips">${chips}</div>` : ''}${composer('rec:' + r.id, 'Ask about this', busy)}</section>`;

  return frame(`${T(TRIGGER[r.trigger] || r.trigger || '')}<span>${T(r.triggerText)}</span>`, `<div class="h-rec-head">
      <h1 id="h-dlg-t" class="h-dlg-title">${T(r.title)}</h1>
      <p class="h-lede">${T(r.summary)}</p>
      <div class="h-meta"><span class="h-st ${r.status}">${statusText(r)}</span>${ownerHtml(r)}${isNeeds(r, ny) ? '<span class="h-acc">Needs you</span>' : ''}${r.effort ? `<span>${T(r.effort)}</span>` : ''}${values(r) ? `<span>${values(r)}</span>` : ''}${servesHtml(r, { dialog: true })}</div>
    </div>
    ${windowStrip(r)}
    <div class="h-acts big">${actionsFor(r, false).join('')}</div>
    <div class="h-dcols">
      <div class="h-dmain">
        ${conv}
        ${section('Why now', `<div class="h-prose">${why}</div>${val}`)}
        ${mine ? section('From your data', mine) : ''}
        ${kb ? section('From the knowledge base', kb) : ''}
        ${cross ? section('Touches', cross) : ''}
      </div>
      <div class="h-dside">
        ${section('Steps', check)}
        ${section('Advisor', adv)}
        ${wg}
      </div>
    </div>`);
}

/* ---------- war game ---------- */

function pick(name) {
  const st = api.state || {};
  const v = st.picks?.[name] ?? st.wargame?.[name] ?? st.scenarioPick?.[name] ?? st.pick?.[name];
  return typeof v === 'number' ? v : ui.pick[name];
}

function niceTicks(lo, hi, n = 5) {
  const raw = (hi - lo) / n || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) || raw;
  const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = t0; v <= t1 + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function salaryChart(sg) {
  const pts = arr(sg.points);
  if (!pts.length) return '';
  const W = 720, H = 400, L = 92, R = 24, Tp = 20, B = 52;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs));
  const yt = niceTicks(Math.min(...ys, 0), Math.max(...ys));
  const x0 = xt[0], x1 = xt[xt.length - 1], y0 = yt[0], y1 = yt[yt.length - 1];
  const sx = (v) => L + ((v - x0) / ((x1 - x0) || 1)) * (W - L - R);
  const sy = (v) => Tp + (1 - (v - y0) / ((y1 - y0) || 1)) * (H - Tp - B);
  let sel = pick('salary');
  if (sel == null) sel = Math.max(0, pts.findIndex((p) => p.current));
  let g = `<svg class="h-sc" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(api.txt(sg.title || 'Tradeoff'))}">`;
  yt.forEach((v) => {
    g += `<line class="h-sc-grid${v === 0 ? ' zero' : ''}" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text class="h-sc-t" x="${L - 10}" y="${sy(v) + 4}" text-anchor="end">${esc(api.money(v, { k: true, sign: v !== 0 }))}</text>`;
  });
  xt.forEach((v) => { g += `<text class="h-sc-t" x="${sx(v)}" y="${H - B + 20}" text-anchor="middle">${esc(api.money(v, { k: true }))}</text>`; });
  const fr = pts.filter((p) => p.frontier).sort((a, b) => a.x - b.x);
  if (fr.length > 1) g += `<polyline class="h-sc-front" points="${fr.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}"/>`;
  // label placement: try four spots around the dot, keep the first that does not collide
  const placed = pts.map((p) => ({ x0: sx(p.x) - 8, x1: sx(p.x) + 8, y0: sy(p.y) - 8, y1: sy(p.y) + 8 }));
  const labs = pts.map((p, i) => {
    const cx = sx(p.x), cy = sy(p.y);
    const text = api.txt(p.label) + (p.current ? ' (now)' : '');
    const w = text.length * 6.6 + 4;
    const tries = [[12, -10, 'start'], [12, 18, 'start'], [-12, -10, 'end'], [-12, 18, 'end'], [12, -26, 'start'], [-12, 34, 'end']];
    let pick2 = tries[0];
    for (const t of tries) {
      const bx0 = t[2] === 'start' ? cx + t[0] : cx + t[0] - w;
      const box = { x0: bx0, x1: bx0 + w, y0: cy + t[1] - 12, y1: cy + t[1] + 3 };
      if (box.x0 < L - 4 || box.x1 > W) continue;
      if (!placed.some((o, j) => j !== i && !(box.x1 < o.x0 || box.x0 > o.x1 || box.y1 < o.y0 || box.y0 > o.y1))) { pick2 = t; placed.push(box); break; }
    }
    return { text, dx: pick2[0], dy: pick2[1], anchor: pick2[2] };
  });
  pts.forEach((p, i) => {
    const on = i === sel;
    const cx = sx(p.x), cy = sy(p.y);
    const lb = labs[i];
    g += `<g class="h-sc-pt${p.frontier ? ' fr' : ''}${on ? ' on' : ''}${p.current ? ' cur' : ''}" data-wg="salary" data-i="${i}" tabindex="0" role="button" aria-label="${esc(lb.text)}">`
      + `<circle class="hit" cx="${cx}" cy="${cy}" r="16"/>`
      + (p.current ? `<circle class="ring" cx="${cx}" cy="${cy}" r="11"/>` : '')
      + `<circle class="dot" cx="${cx}" cy="${cy}" r="${on ? 6.5 : 5}"/>`
      + `<text class="lab" x="${cx + lb.dx}" y="${cy + lb.dy}" text-anchor="${lb.anchor}">${esc(lb.text)}</text></g>`;
  });
  g += `<text class="h-sc-ax" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${X(sg.xLabel)}</text>`;
  g += `<text class="h-sc-ax" transform="translate(14 ${(Tp + H - B) / 2}) rotate(-90)" text-anchor="middle">${X(sg.yLabel)}</text></svg>`;
  const p = pts[sel] || pts[0];
  const note = `<div class="h-wg-note"><div class="h-kicker">${p.frontier ? 'On the frontier' : 'Off the frontier'}${p.current ? '<span>Where you are</span>' : ''}</div><h3>${T(p.label)}</h3>
    <dl class="h-kvs"><div><dt>${T(sg.xLabel)}</dt><dd>${figHtml(`wg.salary.${p.id}.x`)}</dd></div><div><dt>${T(sg.yLabel)}</dt><dd>${figHtml(`wg.salary.${p.id}.y`, { sign: true })}</dd></div></dl>
    <p>${T(p.note)}</p>${p.warn ? `<p class="h-warn">${icon('clock')}${T(p.warn)}</p>` : ''}</div>`;
  return `<div class="h-wg-split"><div class="h-wg-chart">${g}</div>${note}</div>`;
}

function deferralView(df) {
  const opts = arr(df.options);
  if (!opts.length) return '';
  let sel = pick('deferral');
  if (sel == null) sel = 0;
  const o = opts[sel] || opts[0];
  const max = Math.max(...opts.map((x) => Math.max(x.decCash, x.need))) * 1.08 || 1;
  const W = 640, rowH = 34, L = 0, H = opts.length * rowH + 4;
  let g = `<svg class="h-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true">`;
  opts.forEach((x, i) => {
    const y = i * rowH + 8;
    const w = (x.decCash / max) * W;
    const short = x.decCash < x.need;
    g += `<rect class="h-bar-bg" x="${L}" y="${y}" width="${W}" height="14" rx="2"/>`;
    g += `<rect class="h-bar${i === sel ? ' on' : ''}${short ? ' short' : ''}" x="${L}" y="${y}" width="${Math.max(2, w)}" height="14" rx="2" data-wg="deferral" data-i="${i}"/>`;
    const nx = (x.need / max) * W;
    g += `<line class="h-bar-need" x1="${nx}" x2="${nx}" y1="${y - 4}" y2="${y + 18}"/>`;
  });
  g += '</svg>';
  const fk = (x, field) => `wg.deferral.${x.id}.${field}`;
  const labels = opts.map((x, i) => `<button type="button" class="h-bar-row${i === sel ? ' on' : ''}" data-wg="deferral" data-i="${i}" style="top:${i * 34}px"><span>${T(x.label)}</span><em>${figHtml(fk(x, 'decCash'), { k: true, inert: true })} vs ${figHtml(fk(x, 'need'), { k: true, inert: true })}</em></button>`).join('');
  const shortBy = o.need - o.decCash;
  // Tax years are model data: each stat is labeled from its option field (tax2026 -> 2026), never the clock.
  const taxYears = Object.keys(o).map((k) => /^tax(\d{4})$/.exec(k)).filter(Boolean).map((m) => m[1]).sort();
  const taxStats = taxYears.map((y) => `<div><span>${y} tax change</span><b>${figHtml(fk(o, `tax${y}`), { sign: true })}</b></div>`).join('');
  return `<div class="h-def">
    <div class="h-seg" role="radiogroup">${opts.map((x, i) => `<button type="button" role="radio" aria-checked="${i === sel}" class="${i === sel ? 'on' : ''}" data-wg="deferral" data-i="${i}"><b>${T(x.label)}</b><span>${figHtml(fk(x, 'amount'), { k: true, inert: true })}</span></button>`).join('')}</div>
    <div class="h-def-stats">
      ${taxStats}
      <div><span>Net over both years</span><b>${figHtml(fk(o, 'net'), { sign: true })}</b></div>
      <div><span>December business cash</span><b class="${shortBy > 0 ? 'short' : ''}">${figHtml(fk(o, 'decCash'))}</b></div>
    </div>
    <div class="h-sub-h">December cash against payroll need <span>${shortBy > 0 ? `Short by ${figHtml(fk(o, 'gap'))}` : `Clears by ${figHtml(fk(o, 'gap'), { abs: true })}`}</span></div>
    <div class="h-bars-wrap"><div class="h-bars-labs" style="height:${H}px">${labels}</div>${g}</div>
    <p class="h-mute sm">Bar is projected December cash. The tick is what payroll needs that month.</p>
    <p>${T(o.note)}</p>
  </div>`;
}

function decisionList() {
  const wg = api.s.wargame || {};
  let list = arr(api.s.decisions);
  if (!list.length) {
    list = ['salary', 'deferral'].filter((k) => wg[k] && wg[k].status !== 'unavailable').map((k) => ({ id: k, title: wg[k].title, status: wg[k].status || 'open', wargame: k, when: '', note: wg[k].question || '' }));
  }
  // The server derives each decision's status and its explanation line; they are used as is.
  return list.map((d) => {
    const r = d.recId ? recById(d.recId) : null;
    const status = ['open', 'upcoming', 'decided', 'unavailable'].includes(d.status) ? d.status : 'open';
    return { ...d, status, line: d.line || '', r };
  });
}

function decideLinks(d, primary) {
  const out = [];
  if (d.wargame) out.push(`<a href="${href('wargame', { name: d.wargame })}" data-go="wargame" data-name="${esc(d.wargame)}" class="h-btn${primary ? ' pri' : ''}">${d.status === 'decided' ? 'See the curve' : d.status === 'upcoming' ? 'Preview' : d.status === 'unavailable' ? 'See the history' : 'War game'}</a>`);
  if (d.r) out.push(`<a href="${href('rec', { id: d.r.id })}" data-go="rec" data-id="${esc(d.r.id)}" class="h-btn${primary && !d.wargame ? ' pri' : ' ghost'}">${d.status === 'open' ? (d.wargame ? 'Details' : 'Open') : 'Details'}</a>`);
  return out.join('');
}

function decRow(d) {
  const st = d.r && d.status === 'open' ? `<span>${statusText(d.r)}</span>` : '';
  const title = d.r && !d.wargame
    ? `<a class="h-dec-t" href="${href('rec', { id: d.r.id })}" data-go="rec" data-id="${esc(d.r.id)}">${T(d.title)}</a>`
    : d.wargame ? `<a class="h-dec-t" href="${href('wargame', { name: d.wargame })}" data-go="wargame" data-name="${esc(d.wargame)}">${T(d.title)}</a>` : `<span class="h-dec-t">${T(d.title)}</span>`;
  const body = d.status === 'decided' ? `<p>${T(d.line)}</p>` : d.status === 'unavailable' ? `<p>${esc(d.unavailable || '')}</p>` : `${d.note ? `<p>${T(d.note)}</p>` : ''}${d.when || st ? `<div class="h-meta">${d.when ? `<span class="h-when">${T(d.when)}</span>` : ''}${st}</div>` : ''}`;
  return `<article class="h-dec ${d.status}"><div class="h-dec-b">${title}${body}</div><div class="h-acts">${decideLinks(d, d.status === 'open')}</div></article>`;
}

// War games the planner could not build, each with the data that would unlock it (plain text
// from the server, no figures) and a link to Add files or Confirm.
function notBuiltRows() {
  const nb = api.s.wargame?.notBuilt || {};
  return ['salary', 'deferral'].filter((k) => nb[k] && typeof nb[k].text === 'string').map((k) => {
    const answers = nb[k].unlock === 'answers';
    const link = answers
      ? `<a href="${href('confirm')}" data-go="confirm" class="h-btn ghost">Open Confirm</a>`
      : `<a href="${href('add')}" data-go="add" class="h-btn ghost">Add files</a>`;
    return `<article class="h-dec unbuilt" data-not-built="${esc(k)}"><div class="h-dec-b"><p>${esc(nb[k].text)}</p></div><div class="h-acts">${link}</div></article>`;
  });
}

function pDecide() {
  const list = decisionList();
  const unbuilt = notBuiltRows();
  const open = list.filter((d) => d.status === 'open');
  const soon = list.filter((d) => d.status === 'upcoming');
  const done = list.filter((d) => d.status === 'decided');
  const gone = list.filter((d) => d.status === 'unavailable');
  const stats = `<div class="h-stats"><div><b>${open.length}</b><span>open</span></div><div><b>${soon.length}</b><span>coming up</span></div><div><b>${done.length}</b><span>decided</span></div></div>`;
  return shell(`${pageHead('Decide', 'What is open, and what is coming', 'Open choices come first. Each one opens its war game, or the item on your plan when there is nothing to trade off.')}${stats}
    ${section(`Open <em>${open.length}</em>`, open.length ? `<div class="h-decs">${open.map(decRow).join('')}</div>` : '<p class="h-mute">Nothing is waiting on a decision.</p>')}
    ${unbuilt.length ? section(`Not built yet <em>${unbuilt.length}</em>`, `<div class="h-decs">${unbuilt.join('')}</div>`, 'Needs data') : ''}
    ${soon.length ? section(`Coming up <em>${soon.length}</em>`, `<div class="h-decs">${soon.map(decRow).join('')}</div>`, 'Not open yet') : ''}
    ${done.length ? `<details class="h-details" data-det="decided"${ui.det.decided ? ' open' : ''}><summary>Decided <em>${done.length}</em></summary><div class="h-decs">${done.map(decRow).join('')}</div></details>` : ''}
    ${gone.length ? `<details class="h-details" data-det="unavailable"${ui.det.unavailable ? ' open' : ''}><summary>No longer current <em>${gone.length}</em></summary><div class="h-decs">${gone.map(decRow).join('')}</div></details>` : ''}`);
}

function pWargame(name) {
  const wg = api.s.wargame || {};
  const cur = ['salary', 'deferral'].includes(name) && wg[name] ? name : null;
  if (!cur) return pDecide();
  const g = wg[cur];
  const decided = g.status === 'decided';
  const gone = g.status === 'unavailable';
  const past = decided || gone;
  const dec = decisionList().find((d) => d.wargame === cur && d.status === (decided ? 'decided' : gone ? 'unavailable' : 'open'));
  const back = `<a class="h-back" href="${href('wargame')}" data-go="wargame">${icon('back')}Decide</a>`;
  const linked = visibleRecs().filter((r) => r.scenario === cur);
  const lead = gone
    ? `<div class="h-decided"><div><div class="h-kicker">Not a current choice</div><p>${esc(g.unavailable || '')}</p></div></div>`
    : decided
    ? `<div class="h-decided"><i class="h-ok sm">${icon('check')}</i><div><div class="h-kicker">Decided</div><p>${T(g.decided || '')}</p></div></div>`
    : (dec?.when ? `<div class="h-meta h-wg-when"><span class="h-when">${T(dec.when)}</span>${dec.note ? `<span>${T(dec.note)}</span>` : ''}</div>` : '');
  const body = cur === 'salary' ? salaryChart(g) : deferralView(g);
  // Decide on the picked point (an open decision) or revisit it (a decision made here). A decision
  // that became decided because its recommendation finished has no stored choice to revisit.
  const decideBar = !past && dec && dec.status === 'open'
    ? `<div class="h-decide-bar"><button type="button" class="h-btn pri" data-decide="${esc(dec.id)}">Decide on this</button><span class="h-mute sm">Saves the point you picked as your decision and as the assumption for your plan.</span></div>`
    : decided && dec && dec.revisitable
    ? `<div class="h-decide-bar"><button type="button" class="h-btn" data-revisit="${esc(dec.id)}">Revisit</button><span class="h-mute sm">Reopens this choice and goes back to your data on the next plan run.</span></div>`
    : '';
  const secTitle = gone ? 'For reference' : decided ? 'For reference and for next year' : cur === 'salary' ? 'Tradeoff' : 'Options';
  const aside = gone ? 'Not a current choice' : decided ? 'Not an open choice' : cur === 'salary' ? 'Pick a point' : '';
  const intro = gone ? `<p class="h-mute h-wg-intro">This stays here so you can check the reasoning. It becomes a choice again once its inputs are current.</p>`
    : decided ? `<p class="h-mute h-wg-intro">This is no longer a choice to make. It stays here so you can check the reasoning, and it is where next year starts.</p>` : '';
  return shell(`${back}${pageHead(past ? 'Decide' : 'Open decision', T(g.title), past ? '' : T(g.question))}${lead}
    ${section(secTitle, intro + body + decideBar, aside)}
    ${g.takeaway ? `<div class="h-takeaway"><div class="h-kicker">${past ? 'What the curve said' : 'Takeaway'}</div><p>${T(g.takeaway)}</p></div>` : ''}
    ${linked.length ? section('On your plan', `<div class="h-refs wide">${linked.map((r) => `<a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}"><span>${T(r.title)}</span><em>${T(r.window?.label || '')}</em>${icon('arrow')}</a>`).join('')}</div>`) : ''}`);
}

/* ---------- goals ---------- */

// Goal text: an owner goal is plain text the owner typed (escaped, never token-resolved); a seed
// goal is scenario text with tokens.
const gText = (g, s) => (g && g.origin === 'owner' ? esc(s) : T(s));
const goalTitle = (g) => gText(g, g.title);

// The goals a rec serves. In the dialog a rec that serves no open goal reads Housekeeping; plan
// rows show nothing for it.
function servesHtml(r, { dialog = false } = {}) {
  const list = arr(r.serves);
  if (!list.length) return dialog && r.housekeeping ? '<span class="h-serves h-hk">Housekeeping</span>' : '';
  return `<span class="h-serves">Serves: ${list.map((g) => `<a href="${href('goals')}" data-go="goals">${g.origin === 'owner' ? esc(g.title) : T(g.title)}</a>`).join(', ')}</span>`;
}

// Who acts on the rec: a select in the dialog's meta row; a change saves it as an owner override.
function ownerHtml(r) {
  const opts = OWNERS.map((o) => `<option value="${o}"${o === r.owner ? ' selected' : ''}>${OWNER_LABEL[o]}</option>`).join('');
  return `<label class="h-owner"><span>Owner</span><select data-recowner="${esc(r.id)}" aria-label="Action owner">${opts}</select></label>`;
}

const emptyDraft = (horizon = 'now') => ({ title: '', note: '', horizon, target: '', targetDate: '', trackKind: 'none', accounts: [], figure: '' });

function draftOf(g) {
  const t = g.track || null;
  return {
    title: g.title || '', note: g.note || '', horizon: g.horizon || 'now',
    target: typeof g.target === 'number' ? String(g.target) : '', targetDate: g.targetDate || '',
    trackKind: t && Array.isArray(t.accounts) ? 'accounts' : t && t.figure ? 'figure' : 'none',
    accounts: t && Array.isArray(t.accounts) ? t.accounts.slice() : [], figure: t && t.figure ? t.figure : ''
  };
}

function openGoalForm(id, draft) {
  const g = id ? arr(api.s.goals).find((x) => x.id === id) : null;
  ui.goalForm = { id: g ? g.id : null, draft: g ? (draft || draftOf(g)) : emptyDraft(), err: '' };
  ui.goalDel = null;
  draw();
  const el = root?.querySelector('.h-gform [data-gf="title"]');
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

// Trackable figures the store holds, by the shared list.
const trackFigures = () => KNOWN_FIGURES.filter((k) => api.s.fig && api.s.fig[k.key]);

function goalFormHtml() {
  const f = ui.goalForm;
  const d = f.draft;
  const accts = arr(api.s.accounts).filter((a) => a.fig);
  const figs = trackFigures();
  const chip = (h) => `<button type="button" class="h-chip${d.horizon === h[0] ? ' on' : ''}" data-goal-h="${h[0]}" aria-pressed="${d.horizon === h[0]}">${h[1]}</button>`;
  const opt = (v, l) => `<option value="${esc(v)}"${(d.trackKind === 'figure' ? d.figure : d.trackKind) === v ? ' selected' : ''}>${esc(l)}</option>`;
  const acctList = d.trackKind === 'accounts' ? `<div class="h-gaccts">${accts.length ? accts.map((a) => `<label class="h-gacct"><input type="checkbox" data-gf="acct" value="${esc(a.id)}"${d.accounts.includes(a.id) ? ' checked' : ''}><span>${a.imported ? esc(a.name) : T(a.name)}</span><small>${a.imported ? esc(a.inst) : T(a.inst)}</small></label>`).join('') : '<p class="h-mute sm">No accounts with a balance yet.</p>'}</div>` : '';
  return `<form class="h-gform" data-goalform="1" aria-label="${f.id ? 'Edit goal' : 'New goal'}" novalidate>
    <h2>${f.id ? 'Edit goal' : 'New goal'}</h2>
    <label class="h-gf">Your goal, in your own words<input type="text" data-gf="title" maxlength="120" value="${esc(d.title)}" placeholder="For example, a year of cash in the bank" autocomplete="off"></label>
    <label class="h-gf">A short note <span class="h-mute">optional</span><textarea data-gf="note" maxlength="500" rows="2">${esc(d.note)}</textarea></label>
    <div class="h-gf"><span>When</span><div class="h-chips" role="group" aria-label="Horizon">${GOAL_BANDS.map(chip).join('')}</div></div>
    <div class="h-gf2">
      <label class="h-gf">Target amount <span class="h-mute">optional</span><input type="number" data-gf="target" min="0" step="any" inputmode="decimal" value="${esc(d.target)}" placeholder="0"></label>
      <label class="h-gf">Target date <span class="h-mute">optional</span><input type="date" data-gf="targetDate" value="${esc(d.targetDate)}"></label>
    </div>
    <label class="h-gf">Track with <span class="h-mute">optional</span><select data-gf="track">${opt('none', 'Nothing yet')}${accts.length ? opt('accounts', 'One or more accounts') : ''}${figs.map((k) => opt(k.key, k.label)).join('')}</select></label>
    ${acctList}
    ${f.err ? `<p class="h-gerr" role="alert">${esc(f.err)}</p>` : ''}
    <div class="h-ob-nav">${btn('Cancel', 'data-goal="cancel"', 'ghost')}<button type="submit" class="h-btn pri">${f.id ? 'Save changes' : 'Save goal'}</button></div>
  </form>`;
}

// Form draft -> API fields, or an error message.
function goalFields(d) {
  const title = d.title.trim();
  if (!title) return { err: 'Write the goal in your own words.' };
  const out = { title, note: d.note.trim(), horizon: d.horizon, target: null, targetDate: d.targetDate || null, track: null };
  if (d.target !== '') {
    const n = Number(d.target);
    if (!Number.isFinite(n) || n < 0) return { err: 'The target amount must be zero or more.' };
    out.target = n;
  }
  if (d.trackKind === 'accounts' && d.accounts.length) out.track = { accounts: d.accounts.slice() };
  if (d.trackKind === 'figure' && d.figure) out.track = { figure: d.figure };
  return { fields: out };
}

function saveGoal() {
  const f = ui.goalForm;
  if (!f || f.saving) return;
  const { fields, err } = goalFields(f.draft);
  if (err) { f.err = err; draw(); return; }
  f.saving = true;
  const p = f.id ? api.goalUpdate(f.id, fields) : api.goalCreate(fields);
  p.then((g) => {
    if (ui.goalForm !== f) return;
    f.saving = false;
    if (g) { ui.goalForm = null; draw(); }
  });
}

const GOAL_BANDS = [['now', 'This year'], ['1-3y', 'Next few years'], ['3-10y', 'Long range']];

function goalCard(g) {
  const owner = g.origin === 'owner';
  let prog = '';
  if (g.progress) {
    const cur = figVal(g.progress.cur), tgt = figVal(g.progress.target);
    if (cur != null && tgt) {
      const p = Math.max(0, Math.min(1, cur / tgt));
      prog = `<div class="h-prog"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="4" rx="2"/><rect class="fg" width="${p * 100}" height="4" rx="2"/></svg><span>${figHtml(g.progress.cur, { k: true })} of ${figHtml(g.progress.target, { k: true })}</span></div>`;
    }
  }
  const sugg = owner && !g.archived ? suggOf(g.id) : null;
  if (!prog && sugg) prog = suggestHtml(sugg);
  else if (!prog && owner) {
    const tKey = `goal.${g.id}.target`;
    if (!(api.s.fig && api.s.fig[tKey])) prog = `<p class="h-gnone">No target yet. <button type="button" class="h-link" data-goal="edit" data-id="${esc(g.id)}">Add one</button></p>`;
    else if (g.trackWaiting) prog = `<p class="h-gnone">Target ${figHtml(tKey, { k: true })}. Waiting on a balance for what it tracks.</p>`;
    else prog = `<p class="h-gnone">Target ${figHtml(tKey, { k: true })}. <button type="button" class="h-link" data-goal="edit" data-id="${esc(g.id)}">Pick what to track</button> to see progress.</p>`;
  }
  const meta = [];
  if (owner && g.targetDate) { const d = parseISO(g.targetDate); if (d) meta.push(`By ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`); }
  if (owner && g.trackLabel) meta.push(`Tracks ${esc(g.trackLabel)}`);
  const del = ui.goalDel === g.id
    ? `<span class="h-gdel">Delete for good?</span>${btn('Delete', `data-goal="delete-yes" data-id="${esc(g.id)}"`, 'danger')}${btn('Keep', 'data-goal="delete-no"', 'ghost')}`
    : `${owner && !g.archived ? btn('Edit', `data-goal="edit" data-id="${esc(g.id)}"`, 'ghost') : ''}${btn(g.archived ? 'Restore' : 'Archive', `data-goal="${g.archived ? 'restore' : 'archive'}" data-id="${esc(g.id)}"`, 'ghost')}${btn('Delete', `data-goal="delete" data-id="${esc(g.id)}"`, 'ghost')}`;
  const note = owner ? g.note : g.prose;
  return `<article class="h-goal ${esc((g.status || '').replace(/\s+/g, '-'))}${g.archived ? ' archived' : ''}" data-goal-id="${esc(g.id)}"><div class="h-goal-h"><b>${goalTitle(g)}</b><span>${g.archived ? 'Archived' : owner ? '' : T(g.status)}</span></div>${note ? `<p>${gText(g, note)}</p>` : ''}${meta.length ? `<div class="h-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>` : ''}${prog}<div class="h-gacts">${del}</div></article>`;
}

function pGoals() {
  const y = clock().getUTCFullYear();
  const bands = [
    ['now', 'This year', `${y}`],
    ['1-3y', 'Next few years', `${y + 1} to ${y + 3}`],
    ['3-10y', 'Long range', `${y + 3} to ${y + 10}`]
  ];
  const all = arr(api.s.goals);
  const goals = all.filter((g) => !g.archived);
  const archived = all.filter((g) => g.archived);
  const axis = `<div class="h-gaxis">${bands.map((b) => `<div><b>${b[1]}</b><span>${b[2]}</span></div>`).join('')}</div>`;
  const cols = `<div class="h-gcols">${bands.map((b) => `<div class="h-gcol"><div class="h-gcol-h"><b>${b[1]}</b><span>${b[2]}</span></div>${goals.filter((g) => (g.horizon || 'now') === b[0]).map(goalCard).join('') || '<p class="h-mute sm">Nothing here.</p>'}</div>`).join('')}</div>`;
  const curve = arr(api.s.curve).map((c) => {
    const v = ui.curve[c.id] ?? c.value ?? 0.5;
    return `<div class="h-curve"><div class="h-curve-ends"><span class="${v < 0.5 ? 'lean' : ''}">${T(c.left)}</span><span class="${v > 0.5 ? 'lean' : ''}">${T(c.right)}</span></div>
      <input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-curve="${esc(c.id)}" aria-label="${esc(api.txt(c.left) + ' or ' + api.txt(c.right))}">
      ${c.note ? `<p>${T(c.note)}</p>` : ''}</div>`;
  }).join('');
  const add = ui.goalForm && !ui.goalForm.id ? '' : `<div class="h-gadd">${btn(`${icon('plus')}Goal`, 'data-goal="new" aria-keyshortcuts="n"', 'pri')}<span class="h-mute sm">Press N</span></div>`;
  const form = ui.goalForm ? goalFormHtml() : '';
  const arch = archived.length ? `<details class="h-garch" data-det="goals-archived"${ui.det['goals-archived'] ? ' open' : ''}><summary>${plural(archived.length, 'archived goal')}</summary><div class="h-garch-l">${archived.map(goalCard).join('')}</div></details>` : '';
  return shell(`${pageHead('Goals', 'Where you are headed', 'Goals in your own words, placed on the years they live in.')}
    ${add}${form}
    ${axis}${cols}${arch}
    ${curve ? section('Where on the curve', `<p class="h-mute">Every plan trades one thing for another. These set where you sit. Recommendations respect them.</p><div class="h-curves">${curve}</div>`) : ''}`);
}

function goalClick(t) {
  const d = t.dataset;
  const act = d.goal;
  if (act === 'new') { openGoalForm(null); return; }
  if (act === 'edit') { openGoalForm(d.id); return; }
  if (act === 'cancel') { ui.goalForm = null; draw(); return; }
  if (act === 'archive' || act === 'restore') { if (ui.goalForm?.id === d.id) ui.goalForm = null; api.goalArchive(d.id, act === 'archive'); return; }
  if (act === 'delete') { ui.goalDel = d.id; draw(); return; }
  if (act === 'delete-no') { ui.goalDel = null; draw(); return; }
  if (act === 'delete-yes') { ui.goalDel = null; if (ui.goalForm?.id === d.id) ui.goalForm = null; api.goalDelete(d.id); }
}

function goalInput(t) {
  const f = ui.goalForm;
  if (!f) return false;
  const k = t.dataset.gf;
  if (!k) return false;
  if (k === 'acct') {
    const set = new Set(f.draft.accounts);
    if (t.checked) set.add(t.value); else set.delete(t.value);
    f.draft.accounts = [...set];
  } else if (k === 'track') {
    if (t.value === 'none' || t.value === 'accounts') { f.draft.trackKind = t.value; f.draft.figure = ''; }
    else { f.draft.trackKind = 'figure'; f.draft.figure = t.value; }
    draw();
  } else f.draft[k] = t.value;
  return true;
}

/* ---------- accounts ---------- */

function spark([key, sr]) {
  const pts = arr(sr.points);
  if (pts.length < 2) return '';
  const W = 260, H = 56, P = 4;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const sx = (i) => P + (i / (pts.length - 1)) * (W - P * 2);
  const sy = (v) => P + (1 - (v - lo) / ((hi - lo) || 1)) * (H - P * 2 - 10);
  const lastA = pts.map((p) => p.kind).lastIndexOf('a');
  const a = pts.slice(0, lastA + 1).map((p, i) => `${sx(i)},${sy(p.v)}`).join(' ');
  const pr = lastA >= 0 ? pts.slice(lastA).map((p, i) => `${sx(i + lastA)},${sy(p.v)}`).join(' ') : pts.map((p, i) => `${sx(i)},${sy(p.v)}`).join(' ');
  const last = pts[pts.length - 1];
  // A series built from uploaded accounts carries imported text: plain text, no tokens or markup.
  return `<div class="h-spark" data-series="${esc(key)}"><div class="h-spark-h"><span>${sr.imported ? esc(sr.label) : T(sr.label)}</span><b>${figHtml(`series.${key}.${pts.length - 1}`, { k: true })}</b></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${a ? `<polyline class="a" points="${a}"/>` : ''}${pr && lastA < pts.length - 1 ? `<polyline class="p" points="${pr}"/>` : ''}
    ${lastA >= 0 ? `<circle class="pt" cx="${sx(lastA)}" cy="${sy(pts[lastA].v)}" r="2.5"/>` : ''}
    <text x="${P}" y="${H - 1}">${X(pts[0].x)}</text><text x="${W - P}" y="${H - 1}" text-anchor="end">${X(last.x)}</text></svg></div>`;
}

// The account mirror: balances by kind, trend, connections, files and sources. Accounts and the
// Money overview both render it, so neither carries its own account or file logic.
function accountsBody() {
  const accs = arr(api.s.accounts);
  const order = ['Business', 'Cash', 'Investing', 'Retirement', 'Health', 'Education'];
  const groups = {};
  accs.forEach((a) => { const k = KIND[a.kind] || 'Other'; (groups[k] = groups[k] || []).push(a); });
  const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  const mirror = { connected: 'Mirrored', manual: 'Manual', missing: 'Not connected' };
  // Imported accounts carry text from uploaded files: plain text, no tokens or markup.
  const lbl = (a, s) => (a.imported === false ? T(s) : esc(s));
  const list = keys.map((k) => section(k, `<div class="h-accs">${groups[k].map((a) => `<div class="h-acc ${a.mirror}">
      <div class="h-acc-n"><b>${lbl(a, a.name)}</b><span>${lbl(a, a.inst)}${a.owner ? `, ${lbl(a, a.owner)}` : ''}</span></div>
      <div class="h-acc-v">${a.fig ? figHtml(a.fig) : '<span class="h-mute">No balance</span>'}</div>
      <div class="h-acc-m"><i></i>${mirror[a.mirror] || esc(a.mirror)}</div>
      ${ingest.accountMeta(a)}${a.note ? `<p>${lbl(a, a.note)}</p>` : ''}</div>`).join('')}</div>`)).join('');
  const series = Object.entries(api.s.series || {});
  const evs = arr(api.s.events).filter((e) => ['income', 'account'].includes(e.kind));
  return `<div class="h-ro">${icon('lock')}<span>Read-only. ${esc(api.s.meta.product || 'Fathom')} can see balances and transactions. It cannot move, delete or change anything.</span></div>${ingest.pendingBanner()}
    ${series.length ? section('Trend', `<div class="h-sparks">${series.map(spark).join('')}</div>`, 'Solid is actual, dashed is projected') : ''}
    <div class="h-cols"><div class="h-col-main">${list}</div>
    <div class="h-col-side">${section('Connect accounts', simplefin.block(), 'Read-only, through SimpleFIN Bridge')}${ingest.addFiles('accounts')}${ingest.sourcesSection()}${section('Detected', evs.length ? `<ol class="h-evs">${evs.map((e) => `<li><time>${T(e.date)}</time><div><b>${T(e.title)}</b><p>${T(e.body)}</p></div></li>`).join('')}</ol>` : '<p class="h-mute">Nothing unusual detected.</p>')}</div></div>`;
}

const mirrorText = () => {
  const accs = arr(api.s.accounts);
  return `${accs.filter((a) => a.mirror === 'connected').length} of ${accs.length} accounts mirrored.`;
};

function pAccounts() {
  return shell(`${pageHead('Accounts', 'Read-only mirror', `${mirrorText()} Data through ${T(api.s.meta.dataThrough)}. ${goA('add', 'Add more files')}`)}${accountsBody()}`);
}

// The Home data-health line, spelled out: one row per part of the same healthLine() model, then
// the places that fix it.
function moneyHealthHtml(h) {
  const suffix = { ok: '', ask: ' ask', bad: ' bad' };
  const rows = h.rows.map(({ text, tone }) => `<li class="h-mh-r${suffix[tone]}"><i class="h-dh-dot" aria-hidden="true"></i><span>${esc(text.charAt(0).toUpperCase() + text.slice(1))}</span></li>`).join('');
  const links = healthLinks(h);
  return `<div class="h-money-health${h.stale ? ' stale' : ''}"><div class="h-mh-h">Data health</div><ul class="h-mh-rows">${rows}</ul><div class="h-dhealth-a">${links}</div></div>`;
}

function pMoney() {
  return shell(`<section class="h-money">${pageHead('Household', 'Money', `${mirrorText()} Balances, files and the data behind every figure.`)}
    ${moneyHealthHtml(homeHealth())}${accountsBody()}</section>`);
}

/* ---------- settings ---------- */

// The gear: system screens and, on a real store, the account pages. Account and Household are plain
// links that leave the hash router for the server's pages. The description sits outside the link,
// so each link is named by its label alone.
function pSettings() {
  const id = api.identity?.();
  const rows = [
    ['connect', 'Connect', 'Point your own AI client at the household, read-only.'],
    ['engine', 'Engine', 'Proactive jobs, their schedule and what they last did.'],
    ['email', 'Email', 'The monthly digest and what lands in your inbox.']
  ];
  // A real store reaches onboarding again as Setup, to add more context.
  if (api.s?.live?.mode === 'real') rows.push(['onboarding', 'Setup', 'Goals, priorities, notes and files.']);
  const row = (link, desc) => `<li class="h-set-r">${link}<p>${esc(desc)}</p>${icon('arrow')}</li>`;
  let list = rows.map(([k, l, d]) => row(goA(k, l), d)).join('');
  if (id) list += row('<a href="/account">Account</a>', 'Passkeys and sign out.');
  if (id?.role === 'admin') list += row('<a href="/admin/users">Household</a>', 'People, roles and invitations.');
  return shell(`<section class="h-settings">${pageHead('System', 'Settings')}${whoLine()}<ul class="h-set">${list}</ul></section>`);
}

/* ---------- advisor ---------- */

/* The advisor screen lives in screens/advisor.js. */

/* ---------- packs ---------- */

/* The packs screen lives in screens/packs.js. */

/* ---------- year end ---------- */

/* The year end screen lives in screens/yearend.js. */

/* ---------- connect ---------- */

// The screen lives in screens/connect.js; these are the helpers it renders with.
const connectH = { esc, btn, section, pageHead, shell, icon, redraw: () => draw() };

/* ---------- engine ---------- */

const usd = (n) => {
  n = Number(n);
  if (!isFinite(n)) return '';
  const [w, f] = (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)).split('.');
  return '$' + w.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
};

/* The engine screen lives in screens/engine.js; usd() stays for figHtml. */

/* ---------- email ---------- */

function pEmail(fresh) {
  return email.page(fresh);
}

function pAdd() {
  return shell(pageHead('Files', 'Add more files', 'Drop in statements, exports and other documents. New accounts and open questions show up in Confirm.')
    + ingest.addFiles('add') + ingest.sourcesSection());
}

/* ---------- onboarding ---------- */

// The rail's three labelled steps; step 0 (demo sign-in) comes before them, steps 4 and 5 after.
const OB_RAIL = ['Goals', 'Curve', 'Tell us'];

function pOnboarding(step) {
  const ob = api.s.onboarding || {};
  const first = api.s?.live?.mode === 'real' ? 1 : 0; // a real store has no demo sign-in step
  const s = Math.max(first, Math.min(5, step));
  const W = 600;
  const n = OB_RAIL.length;
  // Rail position: -1 before Goals (step 0), 0 to 2 on steps 1 to 3, n (all done) on steps 4 and 5.
  const ri = s < 1 ? -1 : Math.min(s - 1, n);
  const sx = (i) => 10 + (i / (n - 1)) * (W - 20);
  const rail = `<div class="h-ob-rail"><svg viewBox="0 0 ${W} 20" preserveAspectRatio="none" aria-hidden="true"><line class="bg" x1="10" x2="${W - 10}" y1="10" y2="10"/><line class="fg" x1="10" x2="${ri < 0 ? 10 : sx(Math.min(ri, n - 1))}" y1="10" y2="10"/>${OB_RAIL.map((_, i) => `<circle class="${i < ri ? 'done' : i === ri ? 'cur' : ''}" cx="${sx(i)}" cy="10" r="${i === ri ? 5 : 3.5}"/>`).join('')}</svg>
    <div class="h-ob-steps">${OB_RAIL.map((l, i) => `<span class="${i === ri ? 'on' : ''}" style="left:${(sx(i) / W) * 100}%">${l}</span>`).join('')}</div></div>`;
  const next = (label = 'Continue', to = s + 1) => btn(`${label}${icon('arrow')}`, `data-onboard="${to}"`, 'pri');
  const back = s > first ? btn('Back', `data-onboard="${s - 1}"`, 'ghost') : '';
  const kick = s >= 1 && s <= 3 ? `<div class="h-kicker" data-ob-kicker="1">Step ${s} of ${n}</div>` : '';
  let body = '';
  if (s === 0) {
    const who = api.identity?.();
    const line = who
      ? `<b>Signed in through your private network</b><span>${esc(who.name || who.login)}${who.login && who.login !== who.name ? ` (${esc(who.login)})` : ''}</span>`
      : '<b>Reached through your private network</b><span>This demo does not sign anyone in, and no account is created.</span>';
    body = `<div class="h-ob-hero">${MARK}<h1>${T(ob.welcome?.headline)}</h1><p class="h-lede">${T(ob.welcome?.sub)}</p></div>
      <div class="h-ob-who" data-ob-who="1">${icon('lock')}<div>${line}</div></div>
      <div class="h-ob-nav">${next()}</div>`;
  } else if (s === 1) {
    body = kick + goalsStartHtml('onboarding', back);
  } else if (s === 2) {
    body = `${kick}${prioHtml(ob)}
      <div class="h-ob-nav">${back}${next()}</div>`;
  } else if (s === 3) {
    // Tell us, then the connections: SimpleFIN Bridge (a synthetic bridge on a demo store) and the
    // accounts already imported from files. Imported names are file text: escaped, never tokens.
    const draft = String(ui.dumped ?? '');
    const dirty = draft.trim() !== '';
    const go = noteGo(dirty, ui.noteBusy);
    const imported = arr(api.s.accounts).filter((a) => a.mirror !== 'connected');
    const lbl = (a, v) => (a.imported === false ? T(v) : esc(v));
    body = `${kick}<h1>Dump everything in</h1><p class="h-lede">Write it the way you would tell a friend: who is in the house, how money comes in, what is coming up, what worries you. It is stored encrypted and read the way an uploaded notes file is. Attach whatever you have.</p>
      <textarea class="h-dump" rows="9" data-dump="1" aria-label="Tell us about your household" placeholder="For example: we file jointly in Virginia, I run an S corporation, my spouse freelances, we have two kids and a third on the way.">${esc(draft)}</textarea>
      ${understoodHtml()}
      ${ingest.addFiles('onboarding')}
      <div class="h-ob-conn"><div class="h-sub-h">Mirror your accounts</div><p class="h-mute sm">Read-only. ${esc(api.s.meta.product || 'Fathom')} sees balances and transactions so the brief stays current. It cannot move money, place trades or change anything.</p>
      ${simplefin.block()}
      ${imported.length ? `<div class="h-sub-h">Already in Fathom, not mirrored</div><ul class="h-insts">${imported.map((a) => `<li><div><b>${lbl(a, a.name)}</b><span>${lbl(a, a.inst || '')}${a.mask ? `, ending ${esc(a.mask)}` : ''}</span></div></li>`).join('')}</ul>` : ''}</div>
      <div class="h-ob-nav">${back}${go}</div>`;
  } else if (s === 4) {
    body = heardHtml(back, next);
  } else {
    const h = api.heard();
    const lines = [
      `Reading ${plural(arr(api.s.accounts).length, 'account')}`,
      `Placing ${plural(h.deadlines ?? 0, 'deadline')} on your year`,
      `Checking ${plural(arr(api.s.domains).length, 'area')} for gaps`,
      'Drafting your first brief'
    ];
    const b = ui.build;
    body = `<h1>${b >= lines.length ? 'Your year is ready' : 'Building your year'}</h1>
      <div class="h-build"><svg viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden="true"><line class="bg" x1="0" x2="600" y1="20" y2="20"/><line class="fg" x1="0" x2="${(b / lines.length) * 600}" y1="20" y2="20"/>
      ${MON.map((m, i) => `<line class="tk" x1="${i * 50 + 25}" x2="${i * 50 + 25}" y1="14" y2="26"/><text x="${i * 50 + 25}" y="40" text-anchor="middle">${m}</text>`).join('')}</svg></div>
      <ul class="h-build-l">${lines.map((l, i) => `<li class="${i < b ? 'done' : i === b ? 'cur' : ''}"><i>${i < b ? icon('check') : ''}</i>${l}</li>`).join('')}</ul>
      <div class="h-ob-nav">${back}${b >= lines.length ? btn(`${api.demo() === 'fresh' ? 'Open my first brief' : 'Back to my brief'}${icon('arrow')}`, 'data-onboard="6"', 'pri') : ''}</div>`;
    if (b < lines.length && !ui.buildTimer) {
      ui.buildTimer = setTimeout(() => { ui.buildTimer = 0; ui.build += 1; draw(); }, 650);
    }
  }
  const who = api.identity?.();
  const exit = api.demo() !== 'fresh' ? goA('home', 'Back to the app', {}, 'h-ob-x') : (who ? `<span class="h-ob-id">Signed in as ${esc(who.name || who.login)}</span>` : '');
  return `<div class="h-ob"><div class="h-ob-top"><span class="h-mark">${MARK}<span>${esc(api.s.meta.product || 'Fathom')}</span></span>${exit}</div>${rail}<div class="h-ob-card">${body}</div></div>`;
}

// "Where on the curve": the priority sliders, saved to the tradeoff curve on release.
function prioHtml(ob) {
  return `<h1>Where on the curve</h1><p class="h-lede">Every choice trades one good thing for another. Tell us how much each matters. You can change this any time.</p>
      <div class="h-prios">${arr(ob.priorities).map((p) => {
        const raw = ui.prio[p.id] ?? p.value;
        const v = raw > 1 ? raw / 100 : raw;
        const parts = api.txt(p.label).split(/\s+vs\.?\s+/i);
        const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
        const ends = parts.length === 2 ? parts.map(cap) : [api.txt(p.label), ''];
        return `<div class="h-curve" data-prio-box><div class="h-curve-ends"><span class="${v < 0.5 ? 'lean' : ''}">${esc(ends[0])}</span><span class="${v > 0.5 ? 'lean' : ''}">${esc(ends[1])}</span></div><input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-prio="${esc(p.id)}" aria-label="${esc(api.txt(p.label))}"></div>`;
      }).join('')}</div>`;
}

// The Goals step, on onboarding step 1 (where 'onboarding', primary Continue) and on a Home with no
// open goals (where 'home', primary Save goals). Selection is ui state until the primary button.
function goalsStartHtml(where, back = '') {
  const goals = arr(api.s.goals);
  const have = new Set(existingStarterIds(goals));
  const check = `<i class="h-starter-c" aria-hidden="true">${icon('check')}</i>`;
  const cards = STARTERS.map((st) => {
    const on = have.has(st.id) || ui.starterSel.includes(st.id);
    return `<button type="button" class="h-starter${on ? ' on' : ''}" data-goal-starter="${esc(st.id)}" aria-pressed="${on}"${have.has(st.id) ? ' aria-disabled="true"' : ''}><span class="h-starter-t"><b>${esc(st.title)}</b><span>${esc(st.sub)}</span></span>${check}</button>`;
  }).join('');
  const own = `<button type="button" class="h-starter h-starter-own" data-goal-own="1" aria-expanded="${ui.ownOpen}"><span class="h-starter-t"><b>Write your own</b><span>In your words. Fathom asks for a target later.</span></span><i class="h-starter-c" aria-hidden="true">${icon('plus')}</i></button>`;
  const field = ui.ownOpen
    ? `<div class="h-own-add"><input type="text" class="h-own-in" maxlength="120" autocomplete="off" data-goal-own-input="1" data-draft="goals-own" aria-label="Your own goal, in your words" placeholder="For example: a sabbatical in the mountains" value="${esc(ui.draft['goals-own'] || '')}">${btn('Add', 'data-goal-own-add="1"')}</div>` : '';
  const owned = ui.ownGoals.length
    ? `<ul class="h-own-l">${ui.ownGoals.map((t, i) => `<li class="h-starter on" data-goal-own-item="${i}"><span class="h-starter-t"><b>${esc(t)}</b><span>Your own goal</span></span><button type="button" class="h-own-x" data-goal-own-remove="${i}" aria-label="Remove ${esc(t)}">${icon('x')}</button></li>`).join('')}</ul>` : '';
  const others = otherGoals(goals);
  const goalsLink = api.demo() !== 'fresh' ? goA('goals', 'Goals') : 'Goals';
  const existing = others.length
    ? `<div class="h-gs-have" data-goals-existing="1"><div class="h-sub-h">Already your goals</div><ul>${others.map((g) => `<li>${icon('check')}<span>${goalTitle(g)}</span></li>`).join('')}</ul><p class="h-mute sm">These stay as they are. Change them on ${goalsLink}.</p></div>` : '';
  const busy = ui.goalsBusy === where;
  const label = where === 'home' ? 'Save goals' : `Continue${icon('arrow')}`;
  const primary = busy
    ? btn('Saving goals', `data-goals-save="${where}" disabled aria-busy="true"`, 'pri')
    : btn(label, `data-goals-save="${where}"`, 'pri');
  return `<div class="h-gs" data-goals-start="1"><h1>What is the money for?</h1><p class="h-lede">Fathom can only say if you are ahead or behind once it knows where you are going. Pick a few or write your own. You can change them any time.</p>
      <div class="h-starters">${cards}${own}</div>${field}${owned}${existing}${obInviteHtml()}
      <div class="h-ob-nav">${back}${primary}</div></div>`;
}

// "Add your spouse": a link to the household page for an admin on a real store, an explanation on
// the demo, nothing for anyone else.
function obInviteHtml() {
  const line = inviteLine({ mode: api.s?.live?.mode, identity: api.identity?.() });
  const same = 'They see their own actions and the same goals.';
  const dot = '<i class="h-inv-dot" aria-hidden="true"></i>';
  if (line.kind === 'link') return `<div class="h-ob-inv" data-ob-invite="1" data-kind="link">${dot}<p><a href="${esc(line.href)}">Add your spouse</a>. ${same}</p></div>`;
  if (line.kind === 'text') return `<div class="h-ob-inv" data-ob-invite="1" data-kind="text">${dot}<p>In your own ${esc(api.s.meta.product || 'Fathom')}, the household admin adds a spouse from Settings, Household. ${same}</p></div>`;
  return '';
}

// A starter card toggles in place (no redraw), so focus stays on it for Space and Enter.
function toggleStarter(el) {
  const id = el.dataset.goalStarter;
  if (el.getAttribute('aria-disabled') === 'true' || ui.goalsBusy) return;
  const on = !ui.starterSel.includes(id);
  ui.starterSel = on ? [...ui.starterSel, id] : ui.starterSel.filter((x) => x !== id);
  el.setAttribute('aria-pressed', String(on));
  el.classList.toggle('on', on);
}

// Adds the typed own goal to the selection; a blank or repeated title adds nothing.
function addOwnGoal() {
  const t = String(ui.draft['goals-own'] ?? '').trim();
  if (!t) return;
  if (!ui.ownGoals.some((x) => x.toLowerCase() === t.toLowerCase())) ui.ownGoals = [...ui.ownGoals, t];
  ui.draft['goals-own'] = '';
  draw();
  root.querySelector('[data-goal-own-input]')?.focus();
}

// Creates the selected goals one at a time through the goals API, with no target. A failure stops
// there and keeps what is still unsaved selected (core shows the error line). On onboarding it then
// goes on to the curve; on Home the new goals redraw it as the normal Home.
async function saveStarterGoals(where) {
  if (ui.goalsBusy) return;
  const bodies = goalsToCreate({ starterIds: ui.starterSel, ownTitles: ui.ownGoals, goals: api.s.goals });
  if (bodies.length) {
    ui.goalsBusy = where;
    draw();
    for (const b of bodies) {
      const saved = await api.goalCreate(b);
      if (!saved) { ui.goalsBusy = ''; draw(); return; }
      const k = b.title.toLowerCase();
      ui.starterSel = ui.starterSel.filter((id) => STARTERS.find((st) => st.id === id)?.title.toLowerCase() !== k);
      ui.ownGoals = ui.ownGoals.filter((t) => t.toLowerCase() !== k);
    }
  }
  ui.goalsBusy = '';
  ui.starterSel = [];
  ui.ownGoals = [];
  ui.ownOpen = false;
  ui.draft['goals-own'] = '';
  if (where === 'onboarding') { ui.modal = null; ui.build = 0; api.onboard(2); return; }
  draw();
}

// The Tell us primary button: Continue with nothing typed, Save and read once there is text.
function noteGo(dirty, busy) {
  if (busy) return btn('Reading your note', 'data-ob-go="1" disabled aria-busy="true"', 'pri');
  if (dirty) return btn(`Save and read${icon('arrow')}`, 'data-ob-go="1" data-savenote="1"', 'pri');
  return btn(`Continue${icon('arrow')}`, 'data-ob-go="1" data-onboard="4"', 'pri');
}

// What the Tell us note added, as the server read it. Facts, goals and open questions come from the
// stored rows of that file; with the engine off the note is saved and waits.
function understoodHtml() {
  const u = ui.understood;
  if (!u) return '';
  let head;
  if (u.status === 'duplicate') head = 'You already saved this exact note.';
  else if (u.waiting) head = u.engineOn ? 'Saved. It could not be read just now, and it waits in Confirm under Waiting files.' : 'Saved encrypted. The engine is off, so nothing was read from it yet. It is read when the engine is on.';
  else if (!arr(u.facts).length && !arr(u.goals).length) head = 'Saved. Nothing in it matched a household fact, so nothing was recorded.';
  else head = 'Saved. Here is what we understood.';
  const facts = arr(u.facts).map((f) => `<li><span>${esc(f.label)}</span><b>${esc(f.value)}</b>${f.confirmed ? '' : '<em>to confirm</em>'}</li>`).join('');
  const goals = arr(u.goals).map((g) => `<li><span>Goal</span><b>${esc(g.title)}</b>${g.when ? `<em>${esc(g.when)}</em>` : ''}</li>`).join('');
  const asks = Number(u.asked) > 0 && api.demo() !== 'fresh' ? `<p class="h-mute sm">${plural(u.asked, 'question')} to answer. ${goA('confirm', 'Open Confirm')}</p>` : (Number(u.asked) > 0 ? `<p class="h-mute sm">${plural(u.asked, 'question')} to answer in Confirm.</p>` : '');
  const eng = u.waiting && !u.engineOn && api.demo() !== 'fresh' ? `<p class="h-mute sm">${goA('engine', 'Engine settings')}</p>` : '';
  return `<div class="h-ob-under" data-understood="1" aria-live="polite"><div class="h-sub-h">What we understood</div><p>${head}</p>${facts || goals ? `<ul class="h-ob-facts">${facts}${goals}</ul>` : ''}${asks}${eng}</div>`;
}

// "Here is what we heard": the stored household with provenance and an edit link per item, never
// a value the store does not hold. Away from first-run demo onboarding the edit links go to the
// Confirm card or Accounts; there (and for facts with no open question) they go back to Tell us.
function heardHtml(back, next) {
  const h = api.heard();
  const canLeave = api.demo() !== 'fresh';
  const edit = (e) => {
    if (!e || e.route === 'onboarding' || !canLeave) return `<a href="${href('onboarding', { step: 3 })}" data-onboard="3">Correct in notes</a>`;
    return goA(e.route, esc(e.label));
  };
  const sections = arr(h.sections).map((sec) => `<div class="h-heard" data-heard="${esc(sec.id)}"><div class="h-sub-h">${esc(sec.title)}</div><ul class="h-heard-l">${arr(sec.items).map((it) =>
    `<li data-heard-item="${esc(it.id)}"><div class="h-heard-t"><span>${esc(it.label)}</span><b>${esc(it.value)}</b></div><div class="h-heard-p"><em>${esc(it.prov)}</em>${edit(it.edit)}</div></li>`).join('')}</ul></div>`).join('');
  const empty = `<div class="h-empty"><div><b>Nothing stored yet</b><p>Tell us about the household in the previous step or add accounts, then come back to check it.</p></div></div>`;
  const dl = Number(h.deadlines) > 0 ? `<div class="h-heard-dl"><b>${Number(h.deadlines)}</b><span>deadlines on your year for the next twelve months, from the plan</span></div>` : '';
  const q = Number(h.pending) > 0
    ? `<div class="h-heard-q" data-heard-open="1"><b>${Number(h.pending)}</b><span>${Number(h.pending) === 1 ? 'question is' : 'questions are'} still open. ${canLeave ? goA('confirm', 'Answer them in Confirm') : 'Answer them in Confirm once you are in the app.'}</span></div>` : '';
  return `<h1>Here is what we heard</h1><p class="h-lede">Fix anything that is wrong before we build your year. Each line shows where it came from.</p>
      ${h.empty ? empty : `<div class="h-heards">${sections}</div>`}${dl}${q}
      <div class="h-ob-nav">${back}${next('Looks right')}</div>`;
}

/* ---------- draw and events ---------- */

function routeNow() {
  const r = api.route || { name: 'home', params: {} };
  if (api.demo() === 'fresh' && r.name !== 'onboarding') return { name: 'onboarding', params: { step: onboardStep() } };
  return r;
}
function onboardStep() {
  const st = api.state || {};
  const p = api.route?.params?.step;
  const v = p != null ? Number(p) : Number(st.onboardStep ?? st.onboarding?.step ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function underRoute() {
  const u = ui.under;
  return u && u.name !== 'rec' && u.name !== 'onboarding' ? u : { name: 'plan', params: {} };
}

function lockBody(on) {
  const b = document.body;
  if (on && !bodyLocked) {
    const sw = window.innerWidth - document.documentElement.clientWidth;
    b.style.overflow = 'hidden';
    if (sw > 0) b.style.paddingRight = `${sw}px`;
    bodyLocked = true;
  } else if (!on && bodyLocked) {
    b.style.overflow = '';
    b.style.paddingRight = '';
    bodyLocked = false;
  }
}

function focusSig(el) {
  if (!el || !el.getAttribute) return null;
  const a = (n) => el.getAttribute(n);
  if (a('data-dlg')) return `[data-dlg="${a('data-dlg')}"].h-dlg-x`;
  if (a('data-act')) return `[data-act="${a('data-act')}"][data-rec="${CSS.escape(a('data-rec') || '')}"]${a('data-arg') != null ? `[data-arg="${CSS.escape(a('data-arg'))}"]` : ''}`;
  if (a('data-recowner') != null) return `[data-recowner="${CSS.escape(a('data-recowner'))}"]`;
  if (a('data-askrec') != null) return '[data-draft]';
  if (a('data-draft')) return `[data-draft="${CSS.escape(a('data-draft'))}"]`;
  return null;
}

function retSig(el) {
  if (!el || !el.dataset) return null;
  const d = el.dataset;
  const sel = d.go === 'rec' && d.id ? `[data-go="rec"][data-id="${CSS.escape(d.id)}"]` : d.go ? `[data-go="${d.go}"]` : null;
  if (!sel) return null;
  const idx = [...root.querySelectorAll(sel)].indexOf(el);
  return idx < 0 ? null : { sel, idx };
}

function syncDialog(r, page) {
  const host = root.querySelector('.h-dlg-host');
  const isRec = r.name === 'rec';
  const wasOpen = !host.hidden;
  if (isRec) {
    const id = String(r.params?.id || '');
    const same = host.dataset.id === id;
    const body0 = host.querySelector('.h-dlg-body');
    const top = same && body0 ? body0.scrollTop : 0;
    const active = document.activeElement;
    const sig = wasOpen && active && host.contains(active) ? focusSig(active) : null;
    const caret = sig && active.selectionStart != null ? active.selectionStart : null;
    host.classList.toggle('enter', !wasOpen);
    host.innerHTML = dlgHtml(id);
    host.dataset.id = id;
    host.hidden = false;
    page.inert = true;
    lockBody(true);
    const body = host.querySelector('.h-dlg-body');
    if (body) body.scrollTop = top;
    // Messages of the rec's attached thread: a landed answer scrolls to its question.
    const rth = api.recThread(id);
    const n = rth ? arr(api.conversation(chatScreen.keyOf(rth))).length : 0;
    const prev = ui.msgN[id];
    ui.msgN[id] = n;
    if (prev != null && n > prev) {
      const mine = host.querySelectorAll('.h-msg.me');
      const last = mine[mine.length - 1];
      if (last) last.scrollIntoView({ block: 'start' });
    }
    const dlg = host.querySelector('.h-dlg');
    let target = null;
    if (!wasOpen || !same) target = dlg;
    else if (sig) target = host.querySelector(sig) || host.querySelector('[data-draft]') || dlg;
    else if (!host.contains(document.activeElement)) target = dlg;
    if (target) {
      target.focus({ preventScroll: true });
      if (caret != null && target.setSelectionRange && target.value != null) target.setSelectionRange(caret, caret);
    }
  } else if (wasOpen) {
    host.hidden = true;
    host.innerHTML = '';
    delete host.dataset.id;
    page.inert = false;
    lockBody(false);
    ui.under = null;
    ui.inApp = false;
    ui.closing = false;
  }
  return { wasOpen, isRec };
}

function draw() {
  if (!root || !api) return;
  const rr = routeNow();
  const r = rr.name === 'rec' ? underRoute() : rr;
  const key = `${r.name}/${r.params?.id ?? r.params?.name ?? r.params?.step ?? ''}`;
  const routeChanged = key !== lastKey;
  if (r.name !== 'onboarding' || (r.name === 'onboarding' && routeChanged && Number(r.params?.step ?? onboardStep()) !== 5)) {
    if (ui.buildTimer) { clearTimeout(ui.buildTimer); ui.buildTimer = 0; }
    if (routeChanged) ui.build = 0;
  }
  const page = root.querySelector('.h-root');
  const scrollers = [...page.querySelectorAll('.h-tl-scroll')].map((el) => el.scrollLeft);
  const active = document.activeElement;
  const focusDraft = active && page.contains(active) ? active.getAttribute('data-draft') : null;
  if ((r.name === 'connect') !== connectOn) {
    connectOn = r.name === 'connect';
    if (connectOn) connect.enter(connectH); else connect.leave();
  }
  let html;
  switch (r.name) {
    case 'onboarding': html = pOnboarding(Number(r.params?.step ?? onboardStep())); break;
    case 'pace': html = pPace(); break;
    case 'plan': html = pPlan(); break;
    case 'ask': html = chatScreen.render(r.params?.id); break;
    case 'wargame': html = pWargame(r.params?.name); break;
    case 'goals': html = pGoals(); break;
    case 'money': html = pMoney(); break;
    case 'accounts': html = pAccounts(); break;
    case 'add': html = pAdd(); break;
    case 'confirm': html = ingest.confirmPage(routeChanged); break;
    case 'advisor': html = advisorScreen.render(); break;
    case 'packs': html = packsScreen.render(r.params?.id); break;
    case 'yearend': html = yearendScreen.render(); break;
    case 'connect': html = connect.render(connectH); break;
    case 'engine': html = engineScreen.render(); break;
    case 'email': html = pEmail(routeChanged); break;
    case 'settings': html = pSettings(); break;
    default: html = pHome();
  }
  page.innerHTML = html;
  // On a narrow screen the sub-nav scrolls inside itself; keep the active link in view.
  const navOn = page.querySelector('.h-subnav a.on');
  const navEl = navOn?.parentElement;
  if (navEl && navEl.scrollWidth > navEl.clientWidth) {
    const over = navOn.getBoundingClientRect().right - navEl.getBoundingClientRect().right;
    if (over > 0) navEl.scrollLeft = over;
  }
  page.querySelectorAll('.h-tl-scroll').forEach((el, i) => {
    if (!routeChanged && scrollers[i] != null) el.scrollLeft = scrollers[i];
    else if (el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, Number(el.dataset.now) - el.clientWidth * 0.25);
  });
  if (focusDraft) {
    const el = page.querySelector(`[data-draft="${CSS.escape(focusDraft)}"]`);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
  if (routeChanged) { lastKey = key; ui.y = 0; window.scrollTo(0, 0); }
  else if (Math.abs(window.scrollY - ui.y) > 1) window.scrollTo(0, ui.y);
  const { wasOpen, isRec } = syncDialog(rr, page);
  if (wasOpen && !isRec && ui.ret) {
    const list = root.querySelectorAll(ui.ret.sel);
    const el = list[ui.ret.idx] || list[0];
    if (el) el.focus({ preventScroll: true });
    ui.ret = null;
  }
  switcher.afterDraw(rr.name);
}

// History: one entry per modal session. Opening a rec from a page pushes one entry and remembers the
// page under it; moving from rec to rec inside the modal replaces that entry. Closing goes back to
// the page when the modal was opened in the app, and replaces the entry with the page under it after
// a deep link or reload. Either way Back after closing never shows the modal again.
function openRec(id, trigger) {
  const cur = api.route || { name: 'plan', params: {} };
  if (cur.name === 'rec') {
    api.go('rec', { id }, { replace: true });
    return;
  }
  ui.under = { name: cur.name, params: { ...(cur.params || {}) } };
  ui.y = window.scrollY;
  ui.ret = retSig(trigger);
  ui.inApp = true;
  api.go('rec', { id });
  if (api.route?.name !== 'rec') ui.inApp = false;
}

function closeRec() {
  if (ui.closing) return;
  if (ui.inApp) {
    ui.closing = true;
    window.history.back();
    return;
  }
  const u = underRoute();
  api.go(u.name, u.params, { replace: true });
}

function onClick(e) {
  if (SCREENS.some((s) => s.onClick?.(e))) return;
  const cn = e.target.closest('[data-conn]');
  if (cn && root.contains(cn)) { e.preventDefault(); connect.onClick(cn, connectH); return; }
  if (ingest.handleClick(e)) return;
  if (email.handleClick(e)) return;
  if (goalsStartClick(e)) return;
  if (suggClick(e)) return;
  const gt = e.target.closest('[data-goal],[data-goal-h]');
  if (gt && root.contains(gt)) {
    e.preventDefault();
    if (gt.dataset.goalH) {
      if (ui.goalForm) ui.goalForm.draft.horizon = gt.dataset.goalH;
      gt.parentElement.querySelectorAll('[data-goal-h]').forEach((b) => { const on = b === gt; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      return;
    }
    goalClick(gt);
    return;
  }
  const ow = e.target.closest('[data-owner]');
  if (ow && root.contains(ow)) { e.preventDefault(); ui.owner = ow.dataset.owner; draw(); return; }
  const an = e.target.closest('[data-ask-next]');
  if (an && root.contains(an)) { e.preventDefault(); askNext(an.dataset.askNext, an); return; }
  const sel = '[data-go],[data-act],[data-askrec],[data-recstart],[data-wg],[data-onboard],[data-savenote],[data-modal],[data-whatif],[data-packtoggle],[data-decide],[data-revisit],[data-dlg]';
  let t = e.target.closest(`${sel},.fx-fig`);
  if (!t || !root.contains(t)) return;
  // A figure inside a button or link is part of its label: the control takes the click, and the
  // core does not open a popover for it.
  if (t.classList.contains('fx-fig')) {
    const ctl = t.parentElement?.closest(sel);
    if (ctl && root.contains(ctl) && ctl.matches('button,a[href]')) { e.preventDefault(); t = ctl; }
  }
  const d = t.dataset;
  if (d.dlg === 'close') { e.preventDefault(); closeRec(); return; }
  if (t.classList.contains('fx-fig')) {
    e.preventDefault();
    if (typeof api.figPopover === 'function') api.figPopover(t);
    return;
  }
  if (d.act) { e.preventDefault(); api.act(d.rec, d.act, d.act === 'task' ? Number(d.arg) : d.arg); return; }
  if (d.askrec) { askRec(d.askrec, Number(d.i)); return; }
  if (d.recstart) { e.preventDefault(); startOver(d.recstart); return; }
  if (d.whatif) { e.preventDefault(); const cur = routeNow(); api.whatIf(d.whatif); if (!(cur.name === 'packs' && cur.params?.id === d.whatif)) api.go('packs', { id: d.whatif }); return; }
  if (d.packtoggle) { api.packToggle(d.packtoggle); return; }
  if (d.decide) { e.preventDefault(); const gm = api.s.decisions?.find((x) => x.id === d.decide)?.wargame; api.decide(d.decide, gm ? pick(gm) : undefined); return; }
  if (d.revisit) { e.preventDefault(); api.revisit(d.revisit); return; }
  if (d.wg && api.s.wargame?.[d.wg]?.status === 'unavailable') { e.preventDefault(); return; }
  if (d.wg) { e.preventDefault(); ui.pick[d.wg] = Number(d.i); api.scenarioPick(d.wg, Number(d.i)); draw(); return; }
  if (d.savenote != null) { e.preventDefault(); saveNote(); return; }
  if (d.onboard != null && d.onboard !== '') {
    e.preventDefault(); ui.modal = null; ui.build = 0;
    // Finishing Setup for a returning owner has no first-run flip to the brief, so go there.
    if (Number(d.onboard) === 6 && api.demo() !== 'fresh') { api.onboard(6).then(() => api.go('home')); return; }
    api.onboard(Number(d.onboard));
    return;
  }
  if (d.modal === 'close') { ui.modal = null; draw(); return; }
  if (d.go) {
    e.preventDefault();
    if (d.go === 'rec' && d.id) { openRec(d.id, t); return; }
    const params = {};
    if (d.id) params.id = d.id;
    if (d.name) params.name = d.name;
    api.go(d.go, params);
  }
}

// The Goals step's controls: starter cards, Write your own, Add, Remove and the primary button.
function goalsStartClick(e) {
  const t = e.target.closest('[data-goal-starter],[data-goal-own],[data-goal-own-add],[data-goal-own-remove],[data-goals-save]');
  if (!t || !root.contains(t) || !t.closest('[data-goals-start]')) return false;
  e.preventDefault();
  const d = t.dataset;
  if (d.goalStarter != null) toggleStarter(t);
  else if (d.goalOwn != null) {
    ui.ownOpen = !ui.ownOpen;
    draw();
    if (ui.ownOpen) root.querySelector('[data-goal-own-input]')?.focus();
  } else if (d.goalOwnAdd != null) addOwnGoal();
  else if (d.goalOwnRemove != null) { ui.ownGoals = ui.ownGoals.filter((_, i) => i !== Number(d.goalOwnRemove)); draw(); }
  else if (d.goalsSave) saveStarterGoals(d.goalsSave);
  return true;
}

// Ask on the Home next-thing card: the rec's Ask thread when it has one, else the rec dialog with
// its composer focused.
function askNext(id, trigger) {
  const th = api.recThread(id);
  if (th) { api.go('ask', { id: th.id }); return; }
  openRec(id, trigger);
  const focus = () => { const el = root?.querySelector(`.h-dlg-host [data-draft="rec:${CSS.escape(id)}"]`); if (el) el.focus(); return !!el; };
  if (!focus()) setTimeout(focus, 0);
}

// Save the Tell us note through the server's ingest path and show what it understood. The draft
// stays in the box while the save runs and a failure keeps it (core shows the error line).
function saveNote() {
  const text = String(ui.dumped ?? '').trim();
  if (!text || ui.noteBusy) return;
  ui.noteBusy = true;
  ui.understood = null;
  draw();
  Promise.resolve(api.saveNotes(text)).then((r) => {
    ui.noteBusy = false;
    if (r && r.understood) { ui.understood = r.understood; ui.dumped = ''; }
    draw();
  });
}

// A follow-up chip: the rec's canned question i, asked into the rec's attached thread (a new
// thread asked from the rec when none is attached). The chip text is what the pending block shows.
function askRec(recId, i) {
  if (ui.recReset[recId]) return;
  const r = recById(recId);
  const q = r && arr(r.qa)[i];
  if (!q) return;
  chatScreen.askFromRec({ recId, text: api.txt(q.q), questionId: i });
}

// Start over: the dialog lets go of its thread (it stays in Ask) and the composer starts empty.
function startOver(recId) {
  if (chatScreen.askBusy() || ui.recReset[recId]) return;
  ui.draft['rec:' + recId] = '';
  ui.recReset[recId] = true;
  const settle = () => { delete ui.recReset[recId]; draw(); };
  Promise.resolve(api.startOver(recId)).then(settle, settle);
  draw();
}

function onSubmit(e) {
  if (SCREENS.some((s) => s.onSubmit?.(e))) return;
  const f = e.target;
  if (f.dataset.connForm) { e.preventDefault(); connect.onSubmit(f, connectH); return; }
  if (f.dataset.goalform) { e.preventDefault(); saveGoal(); return; }
  if (f.dataset.free != null) {
    e.preventDefault();
    const key = f.dataset.free;
    const v = (f.q?.value || '').trim();
    if (!v) return;
    if (key.startsWith('rec:')) {
      // Through the Ask page's pending and streaming path; it clears the draft once it sends.
      const recId = key.slice(4);
      if (ui.recReset[recId]) return;
      chatScreen.askFromRec({ recId, text: v, draftKey: key, refocus: document.activeElement === f.q });
      return;
    }
    ui.draft[key] = '';
    api.askFree(v, key);
  }
}

function onInput(e) {
  if (SCREENS.some((s) => s.onInput?.(e))) return;
  if (ingest.handleChange(e)) return;
  const t = e.target;
  if (t.dataset.connInput) { connect.onInput(t); return; }
  if (t.dataset.gf && t.dataset.gf !== 'track' && t.dataset.gf !== 'acct') { goalInput(t); return; }
  if (t.dataset.draft) { ui.draft[t.dataset.draft] = t.value; return; }
  if (t.dataset.dump) {
    const was = String(ui.dumped ?? '').trim() !== '';
    ui.dumped = t.value;
    // Swap the primary button in place (a redraw would drop the caret) when the draft becomes empty or not.
    const go = root.querySelector('[data-ob-go]');
    if (go && was !== (t.value.trim() !== '') && !ui.noteBusy) go.outerHTML = noteGo(t.value.trim() !== '', false);
    return;
  }
  if (t.dataset.curve) {
    ui.curve[t.dataset.curve] = Number(t.value) / 100;
    const box = t.closest('.h-curve');
    const v = ui.curve[t.dataset.curve];
    if (box) { const [l, r] = box.querySelectorAll('.h-curve-ends span'); l.classList.toggle('lean', v < 0.5); r.classList.toggle('lean', v > 0.5); }
    return;
  }
  if (t.dataset.prio) {
    ui.prio[t.dataset.prio] = Number(t.value) / 100;
    const [l, r] = t.parentElement.querySelectorAll('.h-curve-ends span');
    if (l && r) { l.classList.toggle('lean', t.value < 50); r.classList.toggle('lean', t.value > 50); }
  }
}

// Committed changes: a goal form select or checkbox, and a released curve or priority slider
// (saved to the store, so both feed the planner and chat).
function onChange(e) {
  const t = e.target;
  if (t?.dataset?.gf === 'track' || t?.dataset?.gf === 'acct') { goalInput(t); return; }
  if (t?.dataset?.suggRate) { suggRate(t); return; }
  if (t?.dataset?.recowner) { api.act(t.dataset.recowner, 'owner', t.value); return; }
  if (t?.dataset?.curve) { api.setCurve(t.dataset.curve, Number(t.value) / 100); return; }
  if (t?.dataset?.prio) { api.setCurve(t.dataset.prio, Number(t.value) / 100); return; }
  ingest?.handleChange(e);
}

function onToggle(e) {
  const k = e.target?.dataset?.det;
  if (k && ui) ui.det[k] = e.target.open;
}

// Home next-thing card swipe (phone): right is Done, left is Later. The card flies off while the
// action saves; the redraw replaces it, and a failed save brings it back.
const homeSwipe = createSwipe({
  when: () => routeNow().name === 'home' && isPhone(),
  card: 'article.h-next',
  onSwipe: (dir, el) => {
    const id = el.dataset.nextRec;
    if (!id) return;
    el.classList.add(dir > 0 ? 'out-r' : 'out-l');
    setTimeout(() => { if (el.isConnected) el.classList.remove('out-r', 'out-l'); }, 1500);
    if (dir > 0) api.act(id, 'complete'); else api.act(id, 'snooze', snoozeLabel());
  }
});
const onPointer = (e) => ingest?.handlePointer(e) || homeSwipe(e);
const POINTER = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];

// Root keys that are not shortcuts: Enter in the Ask composer and rename field first. Shortcuts go
// through the registry in onDocumentKey, so Escape is never prevented here.
function onKey(e) {
  // Enter in the own-goal field adds it and submits nothing else.
  if (e.key === 'Enter' && !e.isComposing && e.target.matches?.('[data-goal-own-input]')) { e.preventDefault(); addOwnGoal(); return; }
  if (chatScreen.onFieldKey(e)) return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-wg][tabindex]')) { e.preventDefault(); onClick(e); }
  if (e.key === 'Escape' && ui.modal != null) { ui.modal = null; draw(); }
}

// One document listener: the key registry (Escape, Ctrl+K, G sequences, list and rec keys; the
// tables live in screens/switcher.js), then the Tab trap for the rec modal.
function onDocumentKey(e) {
  if (!root || !api || !keys) return;
  if (switcher.captures(e)) return;
  if (!e.defaultPrevented && keys.handle(e, document.activeElement)) { e.preventDefault(); return; }
  if (e.key === 'Tab' && api.route?.name === 'rec') {
    const host = root.querySelector('.h-dlg-host');
    if (!host || host.hidden) return;
    const f = [...host.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),textarea,[tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], act = document.activeElement;
    if (!host.contains(act) || act === host.querySelector('.h-dlg')) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
  }
}

// Helpers the screen modules use. Getters, because api, root and ui change on mount.
const SCREENS = [switcher, chatScreen, packsScreen, engineScreen, advisorScreen, yearendScreen, simplefin];
const KIT = {
  get api() { return api; }, get root() { return root; }, get ui() { return ui; }, get keys() { return keys; }, get ingest() { return ingest; },
  draw: () => draw(),
  esc, T, X, arr, plural, icon, btn, goA, href, shell, section, pageHead, thread, composer, figHtml, recById,
  openRec, closeRec, decisionList, statusText, routeNow, visibleRecs,
  newGoal: () => { if (routeNow().name !== 'goals') api.go('goals', {}); openGoalForm(null); }
};
SCREENS.forEach((s) => s.bind(KIT));

function mount(r, a) {
  api = a; root = r; ui = freshUi(); lastKey = ''; connectOn = false;
  SCREENS.forEach((s) => s.reset?.());
  ingest = ingestScreens({ api, shell, section, pageHead, btn, icon, esc, T, X, draw, goA });
  email = emailScreen({ shell, section, pageHead, btn, esc, draw });
  root.innerHTML = '<div class="h-root"></div><div class="h-dlg-host" hidden></div>';
  keys = createKeys();
  switcher.mount();
  ui.y = window.scrollY;
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKey);
  root.addEventListener('toggle', onToggle, true);
  POINTER.forEach((t) => root.addEventListener(t, onPointer));
  onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 120); };
  window.addEventListener('resize', onResize);
  onDocKey = onDocumentKey;
  document.addEventListener('keydown', onDocKey);
  onScroll = () => { if (!bodyLocked) ui.y = window.scrollY; };
  window.addEventListener('scroll', onScroll, { passive: true });
  let lastDemo = api.demo();
  unsub = api.on(() => {
    if (api.demo() !== lastDemo) { lastDemo = api.demo(); const keep = ui; ui = freshUi(); clearTimeout(keep.buildTimer); if (connectOn) { connectOn = false; connect.leave(); } }
    draw();
  });
  draw();
}

function unmount() {
  if (unsub) unsub();
  unsub = null;
  if (root) {
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('toggle', onToggle, true);
    POINTER.forEach((t) => root.removeEventListener(t, onPointer));
    switcher.unmount();
    root.innerHTML = '';
  }
  window.removeEventListener('resize', onResize);
  if (onDocKey) document.removeEventListener('keydown', onDocKey);
  if (onScroll) window.removeEventListener('scroll', onScroll);
  onDocKey = null; onScroll = null;
  lockBody(false);
  if (connectOn) { connectOn = false; connect.leave(); }
  if (ui?.buildTimer) clearTimeout(ui.buildTimer);
  api = null; root = null; keys = null;
}

function register() {
  window.Fathom.registerDesign({
    id: 'horizon',
    name: 'Horizon',
    blurb: 'Time is the interface. Your year is a line, recommendations sit at their windows, and today is always visible.',
    mount,
    unmount
  });
}
if (window.Fathom?.registerDesign) register();
else window.addEventListener('DOMContentLoaded', () => window.Fathom?.registerDesign && register(), { once: true });

/* Reading notes:
   1. The plan timeline uses a split scale: Jan 1 to today takes the left share, today to the last
      window takes the rest, so the months that still matter get the room. Month labels stay true.
   2. Event dates carry no year; they are read as the most recent such date on or before the clock.
   3. Domain status on Plan turns to "needs you" when a needs-you rec sits in that domain, and a
      scenario "needs" domain reads as covered once none of its recs need the person.
   4. Year-end decisions linked to a rec read as done when that rec is done. */

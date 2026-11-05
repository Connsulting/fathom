/* Horizon. Time is the interface: the calendar year is the spine, recommendations sit at their
   windows, and today is a line you can see. Everything else hangs off the timeline.
   Every figure, name and date comes from api.s; nothing here names a person or an amount.
   Reading notes on ambiguous contract points are at the bottom of this file. */

import { ingestScreens } from './screens/ingest.js';
import { emailScreen } from './screens/email.js';

const MS = 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const OPEN = ['proposed', 'accepted', 'doing'];
const STATUS = {
  proposed: 'New', accepted: 'Accepted', doing: 'In progress', waiting: 'Waiting',
  snoozed: 'Snoozed', done: 'Done', dismissed: 'Dismissed', hidden: 'Hidden'
};
const WAITING = { data: 'on data', advisor: 'on advisor', date: 'on a date' };
const VALUE = { tax: 'Tax', timing: 'Timing', retire: 'Retirement', risk: 'Risk', cash: 'Cash', goal: 'Goal' };
const TRIGGER = { calendar: 'Calendar', income: 'Income change', life: 'Life event', goal: 'Goal', advisor: 'Advisor' };
const KIND = { business: 'Business', checking: 'Cash', cash: 'Cash', taxable: 'Investing', retirement: 'Retirement', roth: 'Retirement', hsa: 'Health', '529': 'Education' };

const NAV = [['brief', 'Year'], ['plan', 'Plan'], ['wargame', 'Decide'], ['ask', 'Ask'], ['packs', 'Packs']];
const MORE = [
  ['Household', [['goals', 'Goals'], ['accounts', 'Accounts'], ['advisor', 'Advisor'], ['yearend', 'Year end']]],
  ['System', [['connect', 'Connect'], ['engine', 'Engine'], ['email', 'Email']]]
];

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
let onScroll = null;
let bodyLocked = false;

const freshUi = () => ({
  scopes: {}, curve: {}, prio: {}, connected: {}, modal: null, copied: false,
  packet: false, pick: { salary: null, deferral: null }, signing: false, build: 0,
  buildTimer: 0, draft: {}, dumped: null,
  more: false, under: null, inApp: false, closing: false, ret: null, y: 0, msgN: {}, det: {}
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
  return `<span class="fx-fig" data-fig="${esc(key)}" data-kind="${esc(f.kind || '')}"${opts.inert ? '' : ' tabindex="0"'}>${esc(text)}</span>`;
}

function statusText(r) {
  if (r.status === 'waiting') return `Waiting ${WAITING[r.waitingOn] || ''}`.trim();
  if (r.status === 'snoozed') return r.wake ? `Snoozed to ${X(r.wake)}` : 'Snoozed';
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
  return `${icon('clock')}Advisor reviewing`;
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
    doc: '<path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z"/><path d="M9.5 2.5V5H12"/>'
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

function actionsFor(r, compact) {
  const a = (act, label, cls = '', arg) => btn(label, `data-act="${act}" data-rec="${esc(r.id)}"${arg != null ? ` data-arg="${esc(arg)}"` : ''}`, cls);
  const sz = a('snooze', compact ? 'Snooze' : `Snooze to ${snoozeLabel()}`, 'ghost', snoozeLabel());
  switch (r.status) {
    case 'proposed': return [a('accept', 'Accept', 'pri'), a('complete', 'Done', ''), sz, a('dismiss', 'Dismiss', 'ghost')];
    case 'accepted': return [a('complete', 'Done', 'pri'), a('start', 'Start', ''), sz];
    case 'doing': return [a('complete', 'Done', 'pri'), sz];
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
  // mode: 'brief' (year, open and done recs, events in the past) | 'plan' (all but dismissed)
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
    if (d.at < c && mode === 'brief') return;
    low.push({ kind: 'dl', d, x: x(d.at > end ? end : d.at), w: labelW(api.txt(d.title) + ' ' + api.txt(d.label || ''), 210), pri: 0 });
  });
  const evs = mode === 'brief' ? arr(api.s.events).map((e) => ({ e, at: parseShort(e.date) })).filter((v) => v.at && v.at <= c) : [];
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
    + `<div class="h-tl-key"><span><i class="k needs"></i>Needs you</span><span><i class="k open"></i>In motion</span><span><i class="k idle"></i>Waiting or snoozed</span><span><i class="k done"></i>Done</span><span><i class="k dia"></i>Deadline</span>${mode === 'brief' ? '<span><i class="k ev"></i>What changed</span>' : ''}</div></div>`;
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

function shell(inner, active) {
  const link = (k, l) => `<a href="${href(k)}" data-go="${k}" class="${active === k ? 'on' : ''}"${active === k ? ' aria-current="page"' : ''}>${l}</a>`;
  const nav = NAV.map(([k, l]) => link(k, l)).join('');
  const moreOn = MORE.some((g) => g[1].some((i) => i[0] === active));
  const groups = MORE.map(([title, items]) => `<div class="h-more-g"><div class="h-more-h">${title}</div>${items.map(([k, l]) => link(k, l)).join('')}</div>`).join('');
  const more = `<div class="h-more-wrap"><button type="button" class="h-more-btn${moreOn ? ' on' : ''}" data-more="toggle" aria-expanded="${ui.more}" aria-controls="h-more-p">More${icon('chev')}</button>
    <div class="h-more-p" id="h-more-p" aria-label="More"${ui.more ? '' : ' hidden'}>${groups}</div></div>`;
  const off = api.engineOn() ? '' : `<div class="h-engine-off">${icon('clock')}Engine off. Proactive jobs are paused. ${goA('engine', 'Engine settings')}</div>`;
  return `<header class="h-top"><div class="h-top-in">
    <a class="h-mark" href="${href('brief')}" data-go="brief" aria-label="${X(api.s.meta.product || 'Fathom')}">${MARK}<span>${T(api.s.meta.product || 'Fathom')}</span></a>
    <div class="h-navbar"><nav class="h-nav" aria-label="Main">${nav}</nav><span class="h-nav-sep"></span>${more}</div>
  </div></header>${off}<main class="h-main">${inner}</main>`;
}

function section(title, body, aside = '', cls = '') {
  return `<section class="h-sec ${cls}"><div class="h-sec-h"><h2>${title}</h2>${aside ? `<div class="h-sec-aside">${aside}</div>` : ''}</div>${body}</section>`;
}

function pageHead(kicker, title, sub = '') {
  return `<div class="h-ph"><div class="h-kicker">${kicker}</div><h1>${title}</h1>${sub ? `<p class="h-lede">${sub}</p>` : ''}</div>`;
}

/* ---------- brief ---------- */

function liveDomainStatus(dm, ny) {
  if (ny.some((r) => r.domain === dm.id)) return 'needs';
  if (dm.status === 'needs') return 'covered';
  return dm.status;
}

function pBrief() {
  const c = clock();
  const v = api.verdict();
  const ny = api.needsYou();
  const recs = visibleRecs();
  const clear = v.level === 'clear';
  const motion = recs.filter((r) => ['accepted', 'doing', 'waiting'].includes(r.status) && !isNeeds(r, ny));
  const done = recs.filter((r) => r.status === 'done').length;

  const hero = `<section class="h-hero${clear ? ' clear' : ''}">
    <div class="h-kicker">${MONTH_FULL[c.getUTCMonth()]} brief<span>${T(api.s.meta.clockLabel)}</span><span>Data through ${T(api.s.meta.dataThrough)}</span></div>
    <h1 class="h-verdict">${clear ? `<i class="h-ok">${icon('check')}</i>` : ''}<span>${T(v.headline)}</span></h1>
    <p class="h-lede">${T(v.sub)}</p>
  </section>`;

  const tl = section('Your year', timeline('brief'), `${plural(ny.length, 'item')} need you<span class="h-dotsep"></span>${motion.length} in motion<span class="h-dotsep"></span>${done} done`);

  let needs;
  if (!ny.length) {
    const job = arr(api.s.engine?.jobs).find((j) => /month/i.test(api.txt(j.cadence || '') + api.txt(j.name || '')));
    needs = `<div class="h-empty"><i class="h-ok sm">${icon('check')}</i><div><b>Nothing needs you right now.</b><p>${job?.next ? `Next brief ${T(job.next)}. ` : ''}${motion.length ? `${plural(motion.length, 'item')} still in motion. ` : ''}${goA('plan', 'See the plan')}</p></div></div>`;
  } else {
    needs = `<div class="h-ny-list">${ny.map((r) => {
      const cd = countdown(r);
      return `<article class="h-ny">
        <div class="h-cd${cd.n <= 30 ? ' soon' : ''}"><b>${cd.n}</b><span>${cd.u}</span></div>
        <div class="h-ny-b">
          <a class="h-ny-t" href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}">${T(r.title)}</a>
          <p>${T(r.summary)}</p>
          <div class="h-meta"><span>${windowText(r)}</span>${r.effort ? `<span>${T(r.effort)}</span>` : ''}${values(r) ? `<span>${values(r)}</span>` : ''}<span>${statusText(r)}</span></div>
        </div>
        <div class="h-acts">${actionsFor(r, true).slice(0, 3).join('')}</div>
      </article>`;
    }).join('')}</div>`;
  }

  const evs = arr(api.s.events);
  const changed = evs.length ? `<ol class="h-evs">${evs.map((e) => `<li><time>${T(e.date)}</time><div><b>${T(e.title)}</b><p>${T(e.body)}</p></div></li>`).join('')}</ol>` : '<p class="h-mute">Nothing new since the last brief.</p>';

  const doms = arr(api.s.domains).map((dm) => {
    const st = liveDomainStatus(dm, ny);
    const lab = { covered: 'Covered', changed: 'Changed', needs: 'Needs you', waiting: 'Waiting' }[st] || st;
    return `<div class="h-dom ${st}"><div class="h-dom-h"><i></i><b>${T(dm.name)}</b><span>${lab}</span></div><p>${T(dm.note)}</p><p class="h-mute sm">${T(dm.watching)}</p></div>`;
  }).join('');

  return shell(`${hero}${tl}
    <div class="h-cols">
      <div class="h-col-main">${ingest.pendingBanner()}${section(clear ? 'Needs you' : `Needs you <em>${ny.length}</em>`, needs)}
        ${section('Covered', `<div class="h-doms">${doms}</div>`, `${arr(api.s.domains).filter((d) => liveDomainStatus(d, ny) === 'covered').length} of ${arr(api.s.domains).length} quiet`)}</div>
      <div class="h-col-side">${section('What changed', changed)}
        <div class="h-mailnote">${icon('doc')}<div>This brief also went out as your monthly email. ${goA('email', 'Read the email')}</div></div></div>
    </div>`, 'brief');
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
      <div class="h-meta"><span>${T(r.triggerText || TRIGGER[r.trigger] || '')}</span>${r.status === 'done' || r.status === 'dismissed' ? '' : `<span>${T(r.window?.label || '')}</span>`}${r.effort ? `<span>${T(r.effort)}</span>` : ''}${values(r) ? `<span>${values(r)}</span>` : ''}${r.advisor ? `<span class="h-adv ${r.advisor.verdict}">${advisorText(r)}</span>` : ''}</div>
    </div>
    <div class="h-acts">${actionsFor(r, true).join('')}</div>
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
    ['Snoozed', recs.filter((r) => r.status === 'snoozed')],
    ['Done', recs.filter((r) => r.status === 'done')]
  ];
  const dismissed = recs.filter((r) => r.status === 'dismissed');
  const counts = [
    [ny.length, 'need you'], [open.length, 'open'], [recs.filter((r) => r.status === 'waiting').length, 'waiting'],
    [recs.filter((r) => r.status === 'done').length, 'done']
  ];
  const stats = `<div class="h-stats">${counts.map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>`;
  const body = groups.filter((g) => g[1].length).map(([t, list]) => section(`${t} <em>${list.length}</em>`, `<div class="h-rows">${list.map((r) => recRow(r, ny)).join('')}</div>`)).join('')
    + (dismissed.length ? `<details class="h-details" data-det="dismissed"${ui.det.dismissed ? ' open' : ''}><summary>Dismissed <em>${dismissed.length}</em></summary><div class="h-rows">${dismissed.map((r) => recRow(r, ny)).join('')}</div></details>` : '');
  return shell(`${pageHead('Plan', 'Everything on the calendar', 'Each item sits at the date its window closes. Decide, do it, or set it aside.')}${stats}
    ${section('Timeline', timeline('plan'))}${body || '<p class="h-mute">No recommendations yet.</p>'}`, 'plan');
}

/* ---------- rec detail ---------- */

function thread(msgs, selfId = '') {
  if (!msgs.length) return '';
  return `<div class="h-thread">${msgs.map((m) => {
    const who = m.role === 'me' ? 'You' : m.role === 'advisor' ? T(api.s.advisor?.name || api.s.names?.advisor || 'Advisor') : m.role === 'claude' ? 'Claude' : T(api.s.meta.product || 'Fathom');
    const refs = arr(m.refs).filter((id) => id !== selfId).map((id) => recById(id)).filter(Boolean);
    return `<div class="h-msg ${esc(m.role)}"><div class="h-msg-who">${who}${m.ts ? `<time>${X(m.ts)}</time>` : ''}</div><div class="h-msg-b">${m.html || ''}</div>`
      + (refs.length ? `<div class="h-refs">${refs.map((r) => `<a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}"><span>${T(r.title)}</span><em>${T(r.window?.label || '')}</em>${icon('arrow')}</a>`).join('')}</div>` : '')
      + '</div>';
  }).join('')}</div>`;
}

function asked(msgs, q) {
  const qt = api.txt(q).trim();
  return msgs.some((m) => m.role === 'me' && (m.html || '').replace(/<[^>]+>/g, '').trim() === qt);
}

function composer(key, placeholder) {
  const off = !api.engineOn();
  return `<form class="h-compose" data-free="${esc(key)}">
    <input name="q" type="text" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(ui.draft[key] || '')}" data-draft="${esc(key)}">
    <button type="submit" class="h-btn pri" aria-label="Send">${icon('send')}</button>
  </form>${off ? '<p class="h-mute sm">Engine off. Answers come from what is already on file.</p>' : ''}`;
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
  const msgs = arr(api.conversation(r.id));
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

  const adv = r.advisor ? `<div class="h-advbox ${r.advisor.verdict}"><div class="h-adv ${r.advisor.verdict}">${advisorText(r)}</div><p>${T(r.advisor.note)}</p></div>`
    : `<div class="h-advbox"><div class="h-adv">${icon('clock')}Not yet reviewed</div><p class="h-mute">Goes on the agenda for the next check-in. ${goA('advisor', 'Check-in')}</p></div>`;

  const chips = arr(r.qa).map((q, i) => asked(msgs, q.q) ? '' : `<button type="button" class="h-chip" data-askrec="${esc(r.id)}" data-i="${i}">${T(q.q)}</button>`).join('');
  const wg = r.scenario ? `<a class="h-wglink" href="${href('wargame', { name: r.scenario })}" data-go="wargame" data-name="${esc(r.scenario)}"><div><b>War-game this</b><span>${T(api.s.wargame?.[r.scenario]?.title || '')}</span></div>${icon('arrow')}</a>` : '';

  const conv = `<section class="h-sec h-conv"><div class="h-sec-h"><h2>Ask about this</h2><div class="h-sec-aside">Answers use the figures below</div></div>
    ${thread(msgs, r.id)}${chips ? `<div class="h-chips">${chips}</div>` : ''}${composer('rec:' + r.id, 'Ask about this')}</section>`;

  return frame(`${T(TRIGGER[r.trigger] || r.trigger || '')}<span>${T(r.triggerText)}</span>`, `<div class="h-rec-head">
      <h1 id="h-dlg-t" class="h-dlg-title">${T(r.title)}</h1>
      <p class="h-lede">${T(r.summary)}</p>
      <div class="h-meta"><span class="h-st ${r.status}">${statusText(r)}</span>${isNeeds(r, ny) ? '<span class="h-acc">Needs you</span>' : ''}${r.effort ? `<span>${T(r.effort)}</span>` : ''}${values(r) ? `<span>${values(r)}</span>` : ''}</div>
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

/* ---------- ask ---------- */

function pAsk() {
  const msgs = arr(api.conversation());
  const sug = arr(api.s.ask?.suggested);
  const chips = sug.map((q) => asked(msgs, q.q) ? '' : `<button type="button" class="h-chip" data-ask="${esc(q.id)}">${T(q.q)}</button>`).join('');
  return shell(`${pageHead('Ask', 'Ask about your money', `Answers come from your snapshot through ${T(api.s.meta.dataThrough)} and your plan. Tap any figure to see where it came from.`)}
    <div class="h-ask">
      ${thread(msgs) || '<div class="h-ask-empty"><p>Try one of these.</p></div>'}
      ${chips ? `<div class="h-chips">${chips}</div>` : ''}
      ${composer('ask', 'Ask a question')}
    </div>`, 'ask');
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
    list = ['salary', 'deferral'].filter((k) => wg[k]).map((k) => ({ id: k, title: wg[k].title, status: wg[k].status || 'open', wargame: k, when: '', note: wg[k].question || '' }));
  }
  // The server derives each decision's status and its explanation line; they are used as is.
  return list.map((d) => {
    const r = d.recId ? recById(d.recId) : null;
    const status = ['open', 'upcoming', 'decided'].includes(d.status) ? d.status : 'open';
    return { ...d, status, line: d.line || '', r };
  });
}

function decideLinks(d, primary) {
  const out = [];
  if (d.wargame) out.push(`<a href="${href('wargame', { name: d.wargame })}" data-go="wargame" data-name="${esc(d.wargame)}" class="h-btn${primary ? ' pri' : ''}">${d.status === 'decided' ? 'See the curve' : d.status === 'upcoming' ? 'Preview' : 'War game'}</a>`);
  if (d.r) out.push(`<a href="${href('rec', { id: d.r.id })}" data-go="rec" data-id="${esc(d.r.id)}" class="h-btn${primary && !d.wargame ? ' pri' : ' ghost'}">${d.status === 'open' ? (d.wargame ? 'Details' : 'Open') : 'Details'}</a>`);
  return out.join('');
}

function decRow(d) {
  const st = d.r && d.status === 'open' ? `<span>${statusText(d.r)}</span>` : '';
  const title = d.r && !d.wargame
    ? `<a class="h-dec-t" href="${href('rec', { id: d.r.id })}" data-go="rec" data-id="${esc(d.r.id)}">${T(d.title)}</a>`
    : d.wargame ? `<a class="h-dec-t" href="${href('wargame', { name: d.wargame })}" data-go="wargame" data-name="${esc(d.wargame)}">${T(d.title)}</a>` : `<span class="h-dec-t">${T(d.title)}</span>`;
  const body = d.status === 'decided' ? `<p>${T(d.line)}</p>` : `${d.note ? `<p>${T(d.note)}</p>` : ''}${d.when || st ? `<div class="h-meta">${d.when ? `<span class="h-when">${T(d.when)}</span>` : ''}${st}</div>` : ''}`;
  return `<article class="h-dec ${d.status}"><div class="h-dec-b">${title}${body}</div><div class="h-acts">${decideLinks(d, d.status === 'open')}</div></article>`;
}

function pDecide() {
  const list = decisionList();
  const open = list.filter((d) => d.status === 'open');
  const soon = list.filter((d) => d.status === 'upcoming');
  const done = list.filter((d) => d.status === 'decided');
  const stats = `<div class="h-stats"><div><b>${open.length}</b><span>open</span></div><div><b>${soon.length}</b><span>coming up</span></div><div><b>${done.length}</b><span>decided</span></div></div>`;
  return shell(`${pageHead('Decide', 'What is open, and what is coming', 'Open choices come first. Each one opens its war game, or the item on your plan when there is nothing to trade off.')}${stats}
    ${section(`Open <em>${open.length}</em>`, open.length ? `<div class="h-decs">${open.map(decRow).join('')}</div>` : '<p class="h-mute">Nothing is waiting on a decision.</p>')}
    ${soon.length ? section(`Coming up <em>${soon.length}</em>`, `<div class="h-decs">${soon.map(decRow).join('')}</div>`, 'Not open yet') : ''}
    ${done.length ? `<details class="h-details" data-det="decided"${ui.det.decided ? ' open' : ''}><summary>Decided <em>${done.length}</em></summary><div class="h-decs">${done.map(decRow).join('')}</div></details>` : ''}`, 'wargame');
}

function pWargame(name) {
  const wg = api.s.wargame || {};
  const cur = ['salary', 'deferral'].includes(name) && wg[name] ? name : null;
  if (!cur) return pDecide();
  const g = wg[cur];
  const decided = g.status === 'decided';
  const dec = decisionList().find((d) => d.wargame === cur && d.status === (decided ? 'decided' : 'open'));
  const back = `<a class="h-back" href="${href('wargame')}" data-go="wargame">${icon('back')}Decide</a>`;
  const linked = visibleRecs().filter((r) => r.scenario === cur);
  const lead = decided
    ? `<div class="h-decided"><i class="h-ok sm">${icon('check')}</i><div><div class="h-kicker">Decided</div><p>${T(g.decided || '')}</p></div></div>`
    : (dec?.when ? `<div class="h-meta h-wg-when"><span class="h-when">${T(dec.when)}</span>${dec.note ? `<span>${T(dec.note)}</span>` : ''}</div>` : '');
  const body = cur === 'salary' ? salaryChart(g) : deferralView(g);
  const secTitle = decided ? 'For reference and for next year' : cur === 'salary' ? 'Tradeoff' : 'Options';
  const aside = decided ? 'Not an open choice' : cur === 'salary' ? 'Pick a point' : '';
  const intro = decided ? `<p class="h-mute h-wg-intro">This is no longer a choice to make. It stays here so you can check the reasoning, and it is where next year starts.</p>` : '';
  return shell(`${back}${pageHead(decided ? 'Decide' : 'Open decision', T(g.title), decided ? '' : T(g.question))}${lead}
    ${section(secTitle, intro + body, aside)}
    ${g.takeaway ? `<div class="h-takeaway"><div class="h-kicker">${decided ? 'What the curve said' : 'Takeaway'}</div><p>${T(g.takeaway)}</p></div>` : ''}
    ${linked.length ? section('On your plan', `<div class="h-refs wide">${linked.map((r) => `<a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}"><span>${T(r.title)}</span><em>${T(r.window?.label || '')}</em>${icon('arrow')}</a>`).join('')}</div>`) : ''}`, 'wargame');
}

/* ---------- goals ---------- */

function pGoals() {
  const y = clock().getUTCFullYear();
  const bands = [
    ['now', 'This year', `${y}`],
    ['1-3y', 'Next few years', `${y + 1} to ${y + 3}`],
    ['3-10y', 'Long range', `${y + 3} to ${y + 10}`]
  ];
  const goals = arr(api.s.goals);
  const card = (g) => {
    let prog = '';
    if (g.progress) {
      const cur = figVal(g.progress.cur), tgt = figVal(g.progress.target);
      if (cur != null && tgt) {
        const p = Math.max(0, Math.min(1, cur / tgt));
        prog = `<div class="h-prog"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="4" rx="2"/><rect class="fg" width="${p * 100}" height="4" rx="2"/></svg><span>${figHtml(g.progress.cur, { k: true })} of ${figHtml(g.progress.target, { k: true })}</span></div>`;
      }
    }
    return `<article class="h-goal ${esc((g.status || '').replace(/\s+/g, '-'))}"><div class="h-goal-h"><b>${T(g.title)}</b><span>${T(g.status)}</span></div><p>${T(g.prose)}</p>${prog}</article>`;
  };
  const axis = `<div class="h-gaxis">${bands.map((b) => `<div><b>${b[1]}</b><span>${b[2]}</span></div>`).join('')}</div>`;
  const cols = `<div class="h-gcols">${bands.map((b) => `<div class="h-gcol"><div class="h-gcol-h"><b>${b[1]}</b><span>${b[2]}</span></div>${goals.filter((g) => g.horizon === b[0]).map(card).join('') || '<p class="h-mute sm">Nothing here.</p>'}</div>`).join('')}</div>`;
  const curve = arr(api.s.curve).map((c) => {
    const v = ui.curve[c.id] ?? c.value;
    return `<div class="h-curve"><div class="h-curve-ends"><span class="${v < 0.5 ? 'lean' : ''}">${T(c.left)}</span><span class="${v > 0.5 ? 'lean' : ''}">${T(c.right)}</span></div>
      <input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-curve="${esc(c.id)}" aria-label="${esc(api.txt(c.left) + ' or ' + api.txt(c.right))}">
      <p>${T(c.note)}</p></div>`;
  }).join('');
  return shell(`${pageHead('Goals', 'Where you are headed', 'Goals in your own words, placed on the years they live in.')}
    ${axis}${cols}
    ${curve ? section('Where on the curve', `<p class="h-mute">Every plan trades one thing for another. These set where you sit. Recommendations respect them.</p><div class="h-curves">${curve}</div>`) : ''}`, 'goals');
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
  return `<div class="h-spark"><div class="h-spark-h"><span>${T(sr.label)}</span><b>${figHtml(`series.${key}.${pts.length - 1}`, { k: true })}</b></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${a ? `<polyline class="a" points="${a}"/>` : ''}${pr && lastA < pts.length - 1 ? `<polyline class="p" points="${pr}"/>` : ''}
    ${lastA >= 0 ? `<circle class="pt" cx="${sx(lastA)}" cy="${sy(pts[lastA].v)}" r="2.5"/>` : ''}
    <text x="${P}" y="${H - 1}">${X(pts[0].x)}</text><text x="${W - P}" y="${H - 1}" text-anchor="end">${X(last.x)}</text></svg></div>`;
}

function pAccounts() {
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
  const conn = accs.filter((a) => a.mirror === 'connected').length;
  return shell(`${pageHead('Accounts', 'Read-only mirror', `${conn} of ${accs.length} accounts mirrored. Data through ${T(api.s.meta.dataThrough)}.`)}
    <div class="h-ro">${icon('lock')}<span>Read-only. ${T(api.s.meta.product || 'Fathom')} can see balances and transactions. It cannot move, delete or change anything.</span></div>${ingest.pendingBanner()}
    ${series.length ? section('Trend', `<div class="h-sparks">${series.map(spark).join('')}</div>`, 'Solid is actual, dashed is projected') : ''}
    <div class="h-cols"><div class="h-col-main">${list}</div>
    <div class="h-col-side">${ingest.addFiles('accounts')}${ingest.sourcesSection()}${section('Detected', evs.length ? `<ol class="h-evs">${evs.map((e) => `<li><time>${T(e.date)}</time><div><b>${T(e.title)}</b><p>${T(e.body)}</p></div></li>`).join('')}</ol>` : '<p class="h-mute">Nothing unusual detected.</p>')}</div></div>`, 'accounts');
}

/* ---------- advisor ---------- */

function pAdvisor() {
  const a = api.s.advisor || {};
  const recLink = (id, fallback) => {
    const r = id ? recById(id) : null;
    return r ? goA('rec', T(r.title), { id: r.id }) : T(fallback || '');
  };
  const reviewed = arr(a.reviewed).map((v) => `<li class="h-rv ${v.verdict}"><div class="h-adv ${v.verdict}">${v.verdict === 'vetoed' ? icon('x') + 'Vetoed' : icon('check') + 'Confirmed'}</div><div><b>${recLink(v.recId, v.title)}</b><p>${T(v.note)}</p></div></li>`).join('');
  const pending = arr(a.pending).map((id) => recById(id)).filter(Boolean).map((r) => `<li><a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}"><span>${T(r.title)}</span><em>${statusText(r)}</em>${icon('arrow')}</a></li>`).join('');
  const notAsk = arr(a.notAsking).map((n) => `<li><b>${T(n.q)}</b><p>${T(n.why)}</p></li>`).join('');
  const shared = arr(a.shared).map((s) => `<li><span>${T(s.title)}</span><time>${T(s.when)}</time></li>`).join('');
  const experts = arr(a.experts).map((e) => `<li><b>${T(e.name)}</b><span>${T(e.role)}</span><p>${T(e.when)}</p></li>`).join('');
  const conf = arr(a.reviewed).filter((v) => v.verdict === 'confirmed').length;
  const vet = arr(a.reviewed).filter((v) => v.verdict === 'vetoed').length;
  return shell(`${pageHead('Quarterly check-in', T(a.name || api.s.names?.advisor || 'Your advisor'), T(a.role))}
    <div class="h-next"><div><span>Next check-in</span><b>${T(a.next?.when)}</b></div><div><span>Length</span><b>${T(a.next?.length)}</b></div><div><span>Reviewed</span><b>${conf} confirmed, ${vet} vetoed</b></div><div><span>Waiting on review</span><b>${arr(a.pending).length}</b></div></div>
    <div class="h-cols"><div class="h-col-main">
      ${section('Agenda', `<div class="h-prose"><p>${T(a.agenda)}</p></div>`)}
      ${reviewed ? section('What the advisor said', `<ul class="h-rvs">${reviewed}</ul>`, 'Seen your conversations with the AI') : ''}
      ${pending ? section('To review together', `<ul class="h-links">${pending}</ul>`) : ''}
    </div><div class="h-col-side">
      ${notAsk ? section('Not asking you', `<ul class="h-qs">${notAsk}</ul>`) : ''}
      ${shared ? section('Shared with the advisor', `<ul class="h-kv">${shared}</ul>`) : ''}
      ${experts ? section('Specialists', `<ul class="h-experts">${experts}</ul>`) : ''}
    </div></div>`, 'advisor');
}

/* ---------- packs ---------- */

function packCard(p) {
  const on = p.status === 'active';
  const recs = arr(p.recIds).map((id) => recById(id)).filter(Boolean);
  const st = { active: 'On', suggested: 'Suggested', available: 'Available', exploring: 'Exploring' }[p.status] || esc(p.status);
  return `<article class="h-pack ${esc(p.status)}">
    <div class="h-pack-h"><a href="${href('packs', { id: p.id })}" data-go="packs" data-id="${esc(p.id)}"><b>${T(p.name)}</b></a><span class="h-pack-st">${on ? '<i></i>' : ''}${st}</span></div>
    <p>${T(p.why)}</p>
    ${arr(p.covers).length ? `<p class="h-mute sm">Covers ${arr(p.covers).map((c) => T(c)).join(', ')}</p>` : ''}
    <div class="h-meta"><span>${plural(p.entries || 0, 'entry', 'entries')}</span>${p.curator ? `<span>${T(p.curator)}</span>` : ''}${p.updated ? `<span>Updated ${T(p.updated)}</span>` : ''}${on ? `<span>Powers ${plural(recs.length, 'item')}</span>` : ''}</div>
    <div class="h-acts">${on ? goA('packs', `Open${icon('arrow')}`, { id: p.id }, 'h-more') : btn('What if', `data-whatif="${esc(p.id)}"`, '')}</div>
  </article>`;
}

function pPacks(id) {
  const packs = arr(api.packs());
  const p = id ? packs.find((x) => x.id === id) : null;
  if (p) {
    const on = p.status === 'active';
    const recs = arr(p.recIds).map((rid) => recById(rid)).filter(Boolean);
    const msgs = arr(api.conversation('pack:' + p.id));
    const explored = msgs.length > 0 || p.status === 'exploring';
    const unlocks = arr(p.whatIf?.unlocks);
    const st = { active: 'On', suggested: 'Suggested', available: 'Available', exploring: 'Exploring' }[p.status] || esc(p.status);
    return shell(`<div class="h-rec">
      <a class="h-back" href="${href('packs')}" data-go="packs">${icon('back')}Packs</a>
      <div class="h-rec-head"><div class="h-kicker">Knowledge pack<span>${st}</span></div><h1>${T(p.name)}</h1><p class="h-lede">${T(p.why)}</p>
      <div class="h-meta"><span>${plural(p.entries || 0, 'curated entry', 'curated entries')}</span>${p.curator ? `<span>Curated by ${T(p.curator)}</span>` : ''}${p.updated ? `<span>Updated ${T(p.updated)}</span>` : ''}</div></div>
      ${on ? `<div class="h-acts big">${btn('Turn off', `data-packtoggle="${esc(p.id)}"`, 'ghost')}</div>` : explored ? '' : `<div class="h-acts big">${btn('What if', `data-whatif="${esc(p.id)}"`, '')}${btn('Turn this pack on', `data-packtoggle="${esc(p.id)}"`, 'pri')}</div>`}
      <div class="h-cols rec"><div class="h-col-main">
        ${!on || explored ? section('What if', explored
          ? `${thread(msgs)}${unlocks.length ? `<div class="h-unlocks"><div class="h-sub-h">Would add to your plan</div><ul>${unlocks.map((u) => {
            const r = u.recId ? api.rec(u.recId) : null;
            const live = r && r.status !== 'hidden';
            return `<li><div><b>${live ? goA('rec', T(u.title), { id: r.id }) : T(u.title)}</b><p>${T(u.text)}</p></div>${live ? `<em>${T(r.window?.label || '')}</em>` : ''}</li>`;
          }).join('')}</ul>${on ? `<p class="h-acc">${icon('check')}Pack is on. These are on your plan.</p>` : `<div class="h-acts">${btn('Turn this pack on', `data-packtoggle="${esc(p.id)}"`, 'pri')}</div>`}</div>` : (on ? '' : `<div class="h-acts">${btn('Turn this pack on', `data-packtoggle="${esc(p.id)}"`, 'pri')}</div>`)}`
          : `<p class="h-mute">Talk through what changes if this applied to you. Nothing turns on until you say so.</p><button type="button" class="h-chip" data-whatif="${esc(p.id)}">${T(p.whatIf?.prompt || 'What if')}</button>`) : ''}
        ${on ? section('Powers on your plan', recs.length ? `<div class="h-refs wide">${recs.map((r) => `<a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}"><span>${T(r.title)}</span><em>${T(r.window?.label || '')}</em>${icon('arrow')}</a>`).join('')}</div>` : '<p class="h-mute">Nothing on the plan right now. It still informs answers.</p>') : ''}
      </div><div class="h-col-side">
        ${section('Covers', arr(p.covers).length ? `<ul class="h-cross">${arr(p.covers).map((c) => `<li>${T(c)}</li>`).join('')}</ul>` : '<p class="h-mute">Not listed.</p>')}
      </div></div></div>`, 'packs');
  }
  const act = packs.filter((x) => x.status === 'active');
  const sug = packs.filter((x) => x.status === 'suggested' || x.status === 'exploring');
  const av = packs.filter((x) => x.status === 'available');
  return shell(`${pageHead('Packs', 'What Fathom knows', 'Curated knowledge that grounds answers and recommendations. Packs turn on when your facts make them apply. Explore the rest with a what-if.')}
    ${act.length ? section(`On <em>${act.length}</em>`, `<div class="h-packs">${act.map(packCard).join('')}</div>`) : ''}
    ${sug.length ? section(`Might apply <em>${sug.length}</em>`, `<div class="h-packs">${sug.map(packCard).join('')}</div>`) : ''}
    ${av.length ? section(`Available <em>${av.length}</em>`, `<div class="h-packs">${av.map(packCard).join('')}</div>`) : ''}
    ${packs.length ? '' : '<p class="h-mute">No packs.</p>'}`, 'packs');
}

/* ---------- year end ---------- */

function pYearend() {
  const ye = api.s.yearend || {};
  const docs = arr(ye.docs);
  const decs = arr(ye.decisions).map((d) => {
    const r = d.recId ? recById(d.recId) : null;
    return { ...d, r, done: r ? r.status === 'done' : d.done };
  });
  const have = docs.filter((d) => d.status === 'have').length;
  const decDone = decs.filter((d) => d.done).length;
  const W = 100;
  const meter = (n, t) => `<svg viewBox="0 0 ${W} 4" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="${W}" height="4" rx="2"/><rect class="fg" width="${t ? (n / t) * W : 0}" height="4" rx="2"/></svg>`;
  const stLab = { have: 'In hand', expected: 'Expected', missing: 'Missing' };
  const docsHtml = ['missing', 'expected', 'have'].map((s) => {
    const list = docs.filter((d) => d.status === s);
    if (!list.length) return '';
    return `<div class="h-docgrp"><div class="h-sub-h">${stLab[s]} <span>${list.length}</span></div><ul class="h-docs">${list.map((d) => `<li class="${s}"><i>${s === 'have' ? icon('check') : ''}</i><div><b>${T(d.t)}</b><p>${T(d.src)}${d.note ? `. ${T(d.note)}` : ''}</p></div></li>`).join('')}</ul></div>`;
  }).join('');
  const decHtml = `<ul class="h-docs">${decs.map((d) => `<li class="${d.done ? 'have' : 'expected'}"><i>${d.done ? icon('check') : ''}</i><div><b>${d.r ? goA('rec', T(d.t), { id: d.r.id }) : T(d.t)}</b>${d.r ? `<p>${statusText(d.r)}${d.r.status === 'done' ? '' : `, ${T(d.r.window?.label || '')}`}</p>` : ''}</div></li>`).join('')}</ul>`;
  const ready = have === docs.length && decDone === decs.length;
  const packet = ui.packet
    ? `<div class="h-packet">${icon('doc')}<div><b>Packet assembled</b><p>${have} of ${docs.length} documents and ${decDone} of ${decs.length} decisions. ${ready ? 'Complete.' : 'Missing items are listed on the cover page.'}</p></div>${btn('Undo', 'data-packet="0"', 'ghost')}</div>`
    : `<div class="h-acts">${btn('Assemble packet', 'data-packet="1"', 'pri')}</div>`;
  return shell(`${pageHead('Year end', 'The packet for your accountant', 'Documents and decisions in one place, so nothing gets rebuilt in March.')}
    <div class="h-next"><div><span>Documents in hand</span><b>${have} of ${docs.length}</b>${meter(have, docs.length)}</div><div><span>Decisions made</span><b>${decDone} of ${decs.length}</b>${meter(decDone, decs.length)}</div></div>
    ${packet}
    <div class="h-cols"><div class="h-col-main">${section('Documents', docsHtml || '<p class="h-mute">None listed.</p>')}</div>
    <div class="h-col-side">${section('Decisions', decHtml)}</div></div>`, 'yearend');
}

/* ---------- connect ---------- */

function pConnect() {
  const cn = api.s.connect || {};
  const scopes = arr(cn.scopes);
  const isOn = (s) => ui.scopes[s.id] ?? s.on;
  const scopeHtml = scopes.map((s) => `<li><button type="button" class="h-toggle${isOn(s) ? ' on' : ''}" data-scope="${esc(s.id)}" role="switch" aria-checked="${isOn(s)}"><i></i></button><div><b>${T(s.label)}</b><span>${s.access === 'write' ? 'Write' : 'Read'}</span></div></li>`).join('');
  const tools = arr(cn.tools).map((t) => `<li><code>${X(t.name)}</code><p>${T(t.desc)}</p></li>`).join('');
  const who = { me: 'You', claude: 'Your AI', tool: 'Tool' };
  const tr = arr(cn.transcript).map((m) => `<div class="h-tr ${esc(m.role)}"><span>${who[m.role] || esc(m.role)}</span><div>${T(m.text)}</div></div>`).join('');
  const onN = scopes.filter(isOn).length;
  return shell(`${pageHead('Connect', 'Bring your own AI', 'Point any MCP client at your plan. It sees what you allow, and nothing else.')}
    <div class="h-url"><code>${X(cn.url)}</code>${btn(ui.copied ? 'Copied' : 'Copy', 'data-copy="1"', ui.copied ? '' : 'ghost')}</div>
    <div class="h-cols"><div class="h-col-main">
      ${tr ? section('From a session', `<div class="h-trs">${tr}</div>`) : ''}
      ${cn.config ? section('Client config', `<pre class="h-pre">${X(cn.config)}</pre>`) : ''}
    </div><div class="h-col-side">
      ${section('Access', `<ul class="h-scopes">${scopeHtml}</ul>`, `${onN} of ${scopes.length} on`)}
      ${tools ? section('Tools', `<ul class="h-tools">${tools}</ul>`) : ''}
    </div></div>`, 'connect');
}

/* ---------- engine ---------- */

const usd = (n) => {
  n = Number(n);
  if (!isFinite(n)) return '';
  const [w, f] = (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)).split('.');
  return '$' + w.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
};

function pEngine() {
  const en = api.s.engine || {};
  const b = en.budget || {};
  const on = api.engineOn();
  const used = Number(b.used) || 0, mo = Number(b.monthly) || 0;
  const p = mo ? Math.min(1, used / mo) : 0;
  const jobsList = arr(en.jobs);
  const cost = (j) => (typeof j.cost === 'number' ? figHtml(`engine.job.${j.id}.cost`, { cents: true }) : T(j.cost));
  const rows = jobsList.map((j) => `<div class="h-jt-r" role="row">
      <div class="h-jt-n" role="cell"><b>${T(j.name)}</b><p>${T(j.does)}</p></div>
      <div class="h-jt-c" role="cell" data-l="Cadence">${T(j.cadence)}</div>
      <div class="h-jt-c" role="cell" data-l="Last run">${T(j.last)}</div>
      <div class="h-jt-c${on ? '' : ' off'}" role="cell" data-l="Next run">${on ? T(j.next) : 'Paused'}</div>
      <div class="h-jt-c r mono" role="cell" data-l="Cost per run">${cost(j)}</div>
    </div>`).join('');
  const summary = `<div class="h-eng-sum">
      <div class="h-eng-c"><span class="h-eng-l">Status</span><b class="h-eng-v${on ? ' acc' : ''}">${on ? 'On' : 'Off'}</b><div class="h-eng-s"><button type="button" class="h-btn" data-fx-engine>${on ? 'Turn the engine off' : 'Turn the engine on'}</button></div></div>
      <div class="h-eng-c"><span class="h-eng-l">Spent this month</span><b class="h-eng-v"><span class="mono">${figHtml('engine.budget.used', { cents: true })}</span> <em>of ${figHtml('engine.budget.monthly', { cents: true })}</em></b>
        <div class="h-eng-s col"><svg class="h-eng-meter" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${Math.round(p * 100)} percent of the monthly budget used"><rect class="bg" width="100" height="4" rx="2"/><rect class="fg" width="${p * 100}" height="4" rx="2"/></svg>
        <div class="h-eng-sub"><span class="mono">${figHtml('engine.budget.left', { cents: true })} left</span><span class="mono">${Math.round(p * 100)}% used</span></div></div></div>
      <div class="h-eng-c"><span class="h-eng-l">Chat engine</span><b class="h-eng-v">${T(en.chat?.model)}</b>${en.chat?.note ? `<div class="h-eng-s"><p>${T(en.chat.note)}</p></div>` : ''}</div>
    </div>`;
  const table = jobsList.length ? `<div class="h-card h-jt" role="table" aria-label="Scheduled jobs">
      <div class="h-jt-h" role="row"><span role="columnheader">Job</span><span role="columnheader">Cadence</span><span role="columnheader">Last run</span><span role="columnheader">Next run</span><span role="columnheader" class="r">Cost per run</span></div>${rows}</div>` : '<p class="h-mute">No jobs scheduled.</p>';
  return shell(`${pageHead('Engine', on ? 'Running' : 'Paused', on ? 'Proactive jobs run on schedule and stay inside the monthly budget.' : 'Proactive jobs are paused. Chat answers only from what is on file. Turn it back on here.')}
    <div class="h-card">${summary}</div>
    ${section('Jobs', table, `${jobsList.length} scheduled`)}`, 'engine');
}

/* ---------- email ---------- */

function pEmail(fresh) {
  return email.page(fresh);
}

/* ---------- onboarding ---------- */

const STEPS = ['Sign in', 'Tell us', 'Accounts', 'Confirm', 'Priorities', 'First brief'];

function pOnboarding(step) {
  const ob = api.s.onboarding || {};
  const s = Math.max(0, Math.min(5, step));
  const W = 600;
  const sx = (i) => 10 + (i / 5) * (W - 20);
  const rail = `<div class="h-ob-rail"><svg viewBox="0 0 ${W} 20" preserveAspectRatio="none" aria-hidden="true"><line class="bg" x1="10" x2="${W - 10}" y1="10" y2="10"/><line class="fg" x1="10" x2="${sx(s)}" y1="10" y2="10"/>${STEPS.map((_, i) => `<circle class="${i < s ? 'done' : i === s ? 'cur' : ''}" cx="${sx(i)}" cy="10" r="${i === s ? 5 : 3.5}"/>`).join('')}</svg>
    <div class="h-ob-steps">${STEPS.map((l, i) => `<span class="${i === s ? 'on' : ''}" style="left:${(sx(i) / W) * 100}%">${l}</span>`).join('')}</div></div>`;
  const next = (label = 'Continue', n = s + 1) => btn(`${label}${icon('arrow')}`, `data-onboard="${n}"`, 'pri');
  const back = s > 0 ? btn('Back', `data-onboard="${s - 1}"`, 'ghost') : '';
  let body = '';
  if (s === 0) {
    body = `<div class="h-ob-hero">${MARK}<h1>${T(ob.welcome?.headline)}</h1><p class="h-lede">${T(ob.welcome?.sub)}</p></div>
      <form class="h-ob-sign" data-signin="1"><label>Email<input type="email" placeholder="you@example.com" autocomplete="off"></label>
      <button type="submit" class="h-btn pri wide">${ui.signing ? 'Checking passkey' : `Continue with passkey${icon('arrow')}`}</button></form>
      <p class="h-mute sm center">Demo sign-in. No account is created.</p>`;
  } else if (s === 1) {
    body = `<h1>Dump everything in</h1><p class="h-lede">Write it the way you would tell a friend: who is in the house, how money comes in, what is coming up, what worries you. Attach whatever you have.</p>
      <textarea class="h-dump" rows="9" data-dump="1">${X(ui.dumped ?? ob.dump)}</textarea>
      ${ingest.addFiles('onboarding')}
      <div class="h-ob-nav">${back}${next()}</div>`;
  } else if (s === 2) {
    const insts = arr(ob.institutions);
    const n = insts.filter((x, i) => ui.connected[i]).length;
    body = `<h1>Mirror your accounts</h1><p class="h-lede">Read-only. ${T(api.s.meta.product || 'Fathom')} sees balances and transactions so the brief stays current.</p>
      <ul class="h-insts">${insts.map((x, i) => `<li><div><b>${T(x.inst)}</b><span>${typeof x.accounts === 'number' ? plural(x.accounts, 'account') : T(x.accounts)}, ${T(x.mode || 'read-only')}</span></div>${ui.connected[i] ? `<span class="h-acc">${icon('check')}Connected</span>` : btn('Connect', `data-inst="${i}"`, '')}</li>`).join('')}</ul>
      <p class="h-mute sm">${n} of ${insts.length} connected. You can add the rest later.</p>
      <div class="h-ob-nav">${back}${next(n ? 'Continue' : 'Skip for now')}</div>`;
    if (ui.modal != null) {
      const x = insts[ui.modal] || {};
      body += `<div class="h-modal" role="dialog" aria-modal="true" aria-label="Read-only access"><div class="h-modal-b">
        ${icon('lock')}<h2>Read-only access to ${T(x.inst)}</h2>
        <ul><li>Sees balances, holdings and transactions.</li><li>Cannot move money, place trades, or pay anyone.</li><li>Cannot delete or change anything in the account.</li><li>You can disconnect at any time.</li></ul>
        <div class="h-ob-nav">${btn('Cancel', 'data-modal="close"', 'ghost')}${btn('Allow read-only', `data-allow="${ui.modal}"`, 'pri')}</div></div></div>`;
    }
  } else if (s === 3) {
    const h = ob.heard || {};
    const list = (t, a) => arr(a).length ? `<div class="h-heard"><div class="h-sub-h">${t}</div><ul>${arr(a).map((x) => `<li>${T(typeof x === 'string' ? x : (x.name || x.label || x.t || ''))}</li>`).join('')}</ul></div>` : '';
    body = `<h1>Here is what we heard</h1><p class="h-lede">Fix anything that is wrong before we build your year.</p>
      <div class="h-heards">${list('People', h.people)}${list('Entities', h.entities)}${list('Income', h.income)}${list('Life events', h.lifeEvents)}</div>
      <div class="h-heard-dl"><b>${h.deadlines ?? 0}</b><span>deadlines found for the next twelve months</span></div>
      ${list('Questions we still have', h.questions)}
      <div class="h-ob-nav">${back}${next('Looks right')}</div>`;
  } else if (s === 4) {
    body = `<h1>Where on the curve</h1><p class="h-lede">Every choice trades one good thing for another. Tell us how much each matters. You can change this any time.</p>
      <div class="h-prios">${arr(ob.priorities).map((p) => {
        const raw = ui.prio[p.id] ?? p.value;
        const v = raw > 1 ? raw / 100 : raw;
        const parts = api.txt(p.label).split(/\s+vs\.?\s+/i);
        const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
        const ends = parts.length === 2 ? parts.map(cap) : [api.txt(p.label), ''];
        return `<div class="h-curve" data-prio-box><div class="h-curve-ends"><span class="${v < 0.5 ? 'lean' : ''}">${esc(ends[0])}</span><span class="${v > 0.5 ? 'lean' : ''}">${esc(ends[1])}</span></div><input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-prio="${esc(p.id)}" aria-label="${esc(api.txt(p.label))}"></div>`;
      }).join('')}</div>
      <div class="h-ob-nav">${back}${next('Build my year')}</div>`;
  } else {
    const h = ob.heard || {};
    const lines = [
      `Reading ${plural(arr(ob.institutions).reduce((n, x) => n + (Number(x.accounts) || 1), 0), 'account')}`,
      `Placing ${plural(h.deadlines ?? arr(api.s.deadlines).length, 'deadline')} on your year`,
      `Checking ${plural(arr(api.s.domains).length, 'area')} for gaps`,
      'Drafting your first brief'
    ];
    const b = ui.build;
    body = `<h1>${b >= lines.length ? 'Your year is ready' : 'Building your year'}</h1>
      <div class="h-build"><svg viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden="true"><line class="bg" x1="0" x2="600" y1="20" y2="20"/><line class="fg" x1="0" x2="${(b / lines.length) * 600}" y1="20" y2="20"/>
      ${MON.map((m, i) => `<line class="tk" x1="${i * 50 + 25}" x2="${i * 50 + 25}" y1="14" y2="26"/><text x="${i * 50 + 25}" y="40" text-anchor="middle">${m}</text>`).join('')}</svg></div>
      <ul class="h-build-l">${lines.map((l, i) => `<li class="${i < b ? 'done' : i === b ? 'cur' : ''}"><i>${i < b ? icon('check') : ''}</i>${l}</li>`).join('')}</ul>
      <div class="h-ob-nav">${back}${b >= lines.length ? btn(`Open my first brief${icon('arrow')}`, 'data-onboard="6"', 'pri') : ''}</div>`;
    if (b < lines.length && !ui.buildTimer) {
      ui.buildTimer = setTimeout(() => { ui.buildTimer = 0; ui.build += 1; draw(); }, 650);
    }
  }
  return `<div class="h-ob"><div class="h-ob-top"><span class="h-mark">${MARK}<span>${T(api.s.meta.product || 'Fathom')}</span></span></div>${rail}<div class="h-ob-card">${body}</div></div>`;
}

/* ---------- draw and events ---------- */

function routeNow() {
  const r = api.route || { name: 'brief', params: {} };
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
    const n = arr(api.conversation(id)).length;
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
  if (routeChanged) ui.more = false;
  if (r.name !== 'onboarding' || (r.name === 'onboarding' && routeChanged && Number(r.params?.step ?? onboardStep()) !== 5)) {
    if (ui.buildTimer) { clearTimeout(ui.buildTimer); ui.buildTimer = 0; }
    if (routeChanged) ui.build = 0;
  }
  const page = root.querySelector('.h-root');
  const scrollers = [...page.querySelectorAll('.h-tl-scroll')].map((el) => el.scrollLeft);
  const active = document.activeElement;
  const focusDraft = active && page.contains(active) ? active.getAttribute('data-draft') : null;
  let html;
  switch (r.name) {
    case 'onboarding': html = pOnboarding(Number(r.params?.step ?? onboardStep())); break;
    case 'plan': html = pPlan(); break;
    case 'ask': html = pAsk(); break;
    case 'wargame': html = pWargame(r.params?.name); break;
    case 'goals': html = pGoals(); break;
    case 'accounts': html = pAccounts(); break;
    case 'confirm': html = ingest.confirmPage(); break;
    case 'advisor': html = pAdvisor(); break;
    case 'packs': html = pPacks(r.params?.id); break;
    case 'yearend': html = pYearend(); break;
    case 'connect': html = pConnect(); break;
    case 'engine': html = pEngine(); break;
    case 'email': html = pEmail(routeChanged); break;
    default: html = pBrief();
  }
  page.innerHTML = html;
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
}

function setMore(on) {
  ui.more = on;
  const b = root?.querySelector('.h-more-btn');
  const p = root?.querySelector('.h-more-p');
  if (b) b.setAttribute('aria-expanded', String(on));
  if (p) p.hidden = !on;
}

// History: one entry per modal session. Opening a rec from a page pushes one entry and remembers the
// page under it; moving from rec to rec inside the modal replaces that entry. Closing goes back to
// the page when the modal was opened in the app, and replaces the entry with the page under it after
// a deep link or reload. Either way Back after closing never shows the modal again.
function openRec(id, trigger) {
  const cur = api.route || { name: 'plan', params: {} };
  setMore(false);
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
  if (ui.more && !e.target.closest('.h-more-wrap')) setMore(false);
  if (ingest.handleClick(e)) return;
  if (email.handleClick(e)) return;
  const sel = '[data-go],[data-act],[data-ask],[data-askrec],[data-wg],[data-onboard],[data-inst],[data-allow],[data-modal],[data-scope],[data-copy],[data-packet],[data-whatif],[data-packtoggle],[data-more],[data-dlg]';
  let t = e.target.closest(`${sel},.fx-fig`);
  if (!t || !root.contains(t)) return;
  // A figure inside a button or link is part of its label: the control takes the click, and the
  // core does not open a popover for it.
  if (t.classList.contains('fx-fig')) {
    const ctl = t.parentElement?.closest(sel);
    if (ctl && root.contains(ctl) && ctl.matches('button,a[href]')) { e.preventDefault(); t = ctl; }
  }
  const d = t.dataset;
  if (d.more) { e.preventDefault(); setMore(!ui.more); return; }
  if (d.dlg === 'close') { e.preventDefault(); closeRec(); return; }
  if (t.classList.contains('fx-fig')) {
    e.preventDefault();
    if (typeof api.figPopover === 'function') api.figPopover(t);
    return;
  }
  if (d.act) { e.preventDefault(); api.act(d.rec, d.act, d.act === 'task' ? Number(d.arg) : d.arg); return; }
  if (d.ask) { api.ask(d.ask); return; }
  if (d.askrec) { askRec(d.askrec, Number(d.i)); return; }
  if (d.whatif) { e.preventDefault(); const cur = routeNow(); api.whatIf(d.whatif); if (!(cur.name === 'packs' && cur.params?.id === d.whatif)) api.go('packs', { id: d.whatif }); return; }
  if (d.packtoggle) { api.packToggle(d.packtoggle); return; }
  if (d.wg) { e.preventDefault(); ui.pick[d.wg] = Number(d.i); api.scenarioPick(d.wg, Number(d.i)); draw(); return; }
  if (d.onboard != null && d.onboard !== '') { e.preventDefault(); ui.modal = null; ui.build = 0; api.onboard(Number(d.onboard)); return; }
  if (d.inst != null && d.inst !== '') { ui.modal = Number(d.inst); draw(); return; }
  if (d.allow != null && d.allow !== '') { ui.connected[Number(d.allow)] = true; ui.modal = null; draw(); return; }
  if (d.modal === 'close') { ui.modal = null; draw(); return; }
  if (d.scope) { const s = arr(api.s.connect?.scopes).find((x) => x.id === d.scope); ui.scopes[d.scope] = !(ui.scopes[d.scope] ?? s?.on); draw(); return; }
  if (d.copy) {
    try { navigator.clipboard?.writeText(api.txt(api.s.connect?.url || '')).catch(() => {}); } catch (err) { /* clipboard is optional */ }
    ui.copied = true; draw(); setTimeout(() => { ui.copied = false; draw(); }, 1600); return;
  }
  if (d.packet != null) { ui.packet = d.packet === '1'; draw(); return; }
  if (d.go) {
    e.preventDefault();
    if (d.go === 'rec' && d.id) { openRec(d.id, t); return; }
    setMore(false);
    const params = {};
    if (d.id) params.id = d.id;
    if (d.name) params.name = d.name;
    api.go(d.go, params);
  }
}

function askRec(recId, i) {
  api.ask(String(i), recId);
}

function onSubmit(e) {
  const f = e.target;
  if (f.dataset.signin) {
    e.preventDefault();
    if (ui.signing) return;
    ui.signing = true; draw();
    setTimeout(() => { ui.signing = false; api.onboard(1); }, 700);
    return;
  }
  if (f.dataset.free != null) {
    e.preventDefault();
    const key = f.dataset.free;
    const v = (f.q?.value || '').trim();
    if (!v) return;
    ui.draft[key] = '';
    api.askFree(v, key.startsWith('rec:') ? key.slice(4) : 'ask');
  }
}

function onInput(e) {
  if (ingest.handleChange(e)) return;
  const t = e.target;
  if (t.dataset.draft) { ui.draft[t.dataset.draft] = t.value; return; }
  if (t.dataset.dump) { ui.dumped = t.value; return; }
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

const onChange = (e) => ingest?.handleChange(e);

function onToggle(e) {
  const k = e.target?.dataset?.det;
  if (k && ui) ui.det[k] = e.target.open;
}

function onKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-wg][tabindex]')) { e.preventDefault(); onClick(e); }
  if (e.key === 'Escape' && ui.modal != null) { ui.modal = null; draw(); }
}

function onDocumentKey(e) {
  if (!root || !api) return;
  if (e.key === 'Escape') {
    if (ui.more) { setMore(false); root.querySelector('.h-more-btn')?.focus(); return; }
    if (api.route?.name === 'rec') { e.preventDefault(); closeRec(); }
    return;
  }
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

function mount(r, a) {
  api = a; root = r; ui = freshUi(); lastKey = '';
  ingest = ingestScreens({ api, shell, section, pageHead, btn, icon, esc, T, X, draw, goA });
  email = emailScreen({ shell, section, pageHead, btn, esc, draw });
  root.innerHTML = '<div class="h-root"></div><div class="h-dlg-host" hidden></div>';
  ui.y = window.scrollY;
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKey);
  root.addEventListener('toggle', onToggle, true);
  onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 120); };
  window.addEventListener('resize', onResize);
  onDocKey = onDocumentKey;
  document.addEventListener('keydown', onDocKey);
  onScroll = () => { if (!bodyLocked) ui.y = window.scrollY; };
  window.addEventListener('scroll', onScroll, { passive: true });
  let lastDemo = api.demo();
  unsub = api.on(() => {
    if (api.demo() !== lastDemo) { lastDemo = api.demo(); const keep = ui; ui = freshUi(); clearTimeout(keep.buildTimer); }
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
    root.innerHTML = '';
  }
  window.removeEventListener('resize', onResize);
  if (onDocKey) document.removeEventListener('keydown', onDocKey);
  if (onScroll) window.removeEventListener('scroll', onScroll);
  onDocKey = null; onScroll = null;
  lockBody(false);
  if (ui?.buildTimer) clearTimeout(ui.buildTimer);
  api = null; root = null;
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
   1. The brief timeline uses a split scale: Jan 1 to today takes the left share, today to the last
      window takes the rest, so the months that still matter get the room. Month labels stay true.
   2. Event dates carry no year; they are read as the most recent such date on or before the clock.
   3. Domain status on the brief turns to "needs you" when a needs-you rec sits in that domain, and a
      scenario "needs" domain reads as covered once none of its recs need the person.
   4. Year-end decisions linked to a rec read as done when that rec is done. */

// Thread: conversation-first design for the Fathom mock.
// Home is one thread. Fathom posts the monthly brief into it, recommendations arrive as compact
// interactive cards, and every deeper topic (a rec, a war game, a pack what-if, the advisor
// check-in) opens as a side thread. Plan, data and settings live in a slide-over drawer.
// Reading of the contract: thread views are brief, ask, rec, wargame, advisor and packs/<id>;
// drawer panels are plan, goals, accounts, packs, yearend, connect, engine and email.

const ID = 'thread';

let api = null;
let root = null;
let unsub = null;
let timers = [];
let resizeT = 0;

const ui = {
  menu: false,            // drawer opened on its index, without a drawer route
  lastThread: { name: 'brief', params: {} },
  briefSet: null,
  briefDemo: null,
  viewKey: '',
  drawerKey: '',
  count: 0,
  draft: '',
  modal: null,            // 'connect'
  connected: false,
  build: 0,               // onboarding build progress
  buildFor: -1,
  dumpOpen: false,
  scopes: null,
  copied: false,
  exported: false,
  sliders: {},
};

// ------------------------------------------------------------------ helpers

const A = v => (Array.isArray(v) ? v : []);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = s => (s == null || s === '' ? '' : api.t(String(s)));
const X = s => (s == null || s === '' ? '' : api.txt(String(s)));
const S = () => api.s || {};
const M = (n, o) => api.money(Number(n) || 0, o);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
const today = () => parseDate(S().meta && S().meta.clock);
const DAY = 86400000;
function shortDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const wakeLabel = () => shortDate(today() + 14 * DAY);
const monthName = () => {
  const d = today();
  return isNaN(d) ? 'Monthly' : new Date(d).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
};

const STATUS = {
  proposed: 'New', doing: 'Doing it', waiting: 'Waiting',
  snoozed: 'Snoozed', done: 'Done', dismissed: 'Dismissed', hidden: 'Hidden',
};
function statusText(r) {
  if (r.status === 'waiting') return 'Waiting on ' + (r.waitingOn || 'something');
  if (r.status === 'snoozed') return 'Snoozed to ' + X(r.wake || 'later');
  return STATUS[r.status] || r.status;
}
const VALUE = { tax: 'Tax', timing: 'Timing', retire: 'Retirement', risk: 'Risk', cash: 'Cash', goal: 'Goal' };
const ADV = { confirmed: 'Confirmed', pending: 'Pending review', vetoed: 'Vetoed' };

function daysText(days) {
  if (typeof days !== 'number') return '';
  if (days < 0) return Math.abs(days) + 'd over';
  if (days === 0) return 'today';
  return days + (days === 1 ? ' day' : ' days');
}

function firstParam(r) {
  const p = (r && r.params) || {};
  return p.id != null ? p.id : p.name != null ? p.name : p.step != null ? p.step : '';
}

const DRAWER = new Set(['plan', 'goals', 'accounts', 'yearend', 'connect', 'engine', 'email']);
function isDrawer(r) {
  if (!r) return false;
  if (r.name === 'packs') return !firstParam(r);
  return DRAWER.has(r.name);
}

const advisorName = () => X(S().advisor && S().advisor.name) || X('{n:advisor}');
const initial = s => (String(s || '?').trim()[0] || '?').toUpperCase();

// ------------------------------------------------------------------ icons and avatars

const ICON = {
  menu: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h9"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>',
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4l-6 6 6 6"/></svg>',
  send: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>',
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4l6 6-6 6"/></svg>',
  lock: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 016 0V9"/></svg>',
};

function mark(size) {
  return '<svg class="t-mark" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M5 13.5c2.3-2 4.7-2 7 0s4.7 2 7 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="12" cy="8.2" r="1.6" fill="currentColor"/></svg>';
}

function avatar(role) {
  if (role === 'fathom') return '<div class="t-av t-av--fathom">' + mark(18) + '</div>';
  if (role === 'advisor') return '<div class="t-av t-av--advisor">' + esc(initial(advisorName())) + '</div>';
  return '<div class="t-av t-av--me">' + esc(initial(X('{n:me}'))) + '</div>';
}

function whoName(role) {
  if (role === 'fathom') return 'Fathom';
  if (role === 'advisor') return esc(advisorName());
  return 'You';
}

// One message. body is HTML; extra is HTML appended under the text (cards).
function message(role, body, opts) {
  opts = opts || {};
  const cls = 't-msg t-msg--' + role + (opts.fresh ? ' is-new' : '') + (opts.notice ? ' is-notice' : '');
  if (role === 'me') {
    return '<div class="' + cls + '"><div class="t-bubble">' + body + '</div>' +
      (opts.ts ? '<div class="t-ts">' + esc(opts.ts) + '</div>' : '') + (opts.extra || '') + '</div>';
  }
  return '<div class="' + cls + '">' + avatar(role) + '<div class="t-mbody">' +
    '<div class="t-who"><span>' + whoName(role) + '</span>' + (opts.tag ? '<span class="t-tag">' + opts.tag + '</span>' : '') +
    (opts.ts ? '<span class="t-ts">' + esc(opts.ts) + '</span>' : '') + '</div>' +
    (body ? '<div class="t-text">' + body + '</div>' : '') + (opts.extra || '') + '</div></div>';
}

function paras(list) { return A(list).map(p => '<p>' + T(p) + '</p>').join(''); }

function recLink(id, label) {
  const r = api.rec(id);
  if (!r || r.status === 'hidden') return label ? '<span>' + label + '</span>' : '';
  return '<button type="button" class="t-link" data-go="rec" data-p="' + esc(id) + '">' + (label || T(r.title)) + '</button>';
}

function refsBlock(refs) {
  const list = A(refs).map(id => api.rec(id)).filter(r => r && r.status !== 'hidden');
  if (!list.length) return '';
  return '<div class="t-refs"><span class="t-refs-k">Related</span>' +
    list.map(r => '<button type="button" class="t-ref" data-go="rec" data-p="' + esc(r.id) + '">' + T(r.title) + ICON.arrow + '</button>').join('') + '</div>';
}

function convo(list, from) {
  return A(list).map((m, i) => message(m.role === 'me' ? 'me' : m.role, m.html, {
    ts: m.ts, fresh: i >= from, notice: m.notice, extra: refsBlock(m.refs),
  })).join('');
}

function divider(label) { return '<div class="t-divider"><span>' + esc(label) + '</span></div>'; }

// ------------------------------------------------------------------ charts

function sparkline(series, w, h) {
  const pts = A(series && series.points);
  if (pts.length < 2) return '';
  const vs = pts.map(p => Number(p.v) || 0);
  const lo = Math.min(0, ...vs), hi = Math.max(...vs) || 1;
  const x = i => (i / (pts.length - 1)) * w;
  const y = v => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
  const lastA = pts.reduce((k, p, i) => (p.kind === 'a' ? i : k), -1);
  const seg = (a, b) => pts.slice(a, b + 1).map((p, j) => (j ? 'L' : 'M') + x(a + j).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
  let out = '<svg class="t-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">';
  if (lastA > 0) out += '<path d="' + seg(0, lastA) + '" class="t-spark-a"/>';
  if (lastA < pts.length - 1) out += '<path d="' + seg(Math.max(lastA, 0), pts.length - 1) + '" class="t-spark-p"/>';
  if (lastA >= 0) out += '<circle cx="' + x(lastA).toFixed(1) + '" cy="' + y(pts[lastA].v).toFixed(1) + '" r="2.2" class="t-spark-dot"/>';
  return out + '</svg>';
}

function bar(frac, cls) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return '<div class="t-bar ' + (cls || '') + '"><span style="width:' + (f * 100).toFixed(1) + '%"></span></div>';
}

function yearClock() {
  const now = today();
  if (isNaN(now)) return '';
  const year = new Date(now).getUTCFullYear();
  const y0 = Date.UTC(year, 0, 1), y1 = Date.UTC(year + 1, 0, 1);
  const span = y1 - y0;
  const C = 92, R = 66;
  const ang = ms => ((ms - y0) / span) * Math.PI * 2 - Math.PI / 2;
  const pt = (a, r) => [C + Math.cos(a) * r, C + Math.sin(a) * r];
  const a1 = ang(now);
  const [ex, ey] = pt(a1, R);
  const large = a1 + Math.PI / 2 > Math.PI ? 1 : 0;
  let svg = '<svg class="t-clock" viewBox="0 0 184 184" role="img" aria-label="Year clock">';
  svg += '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" class="t-clock-track"/>';
  svg += '<path d="M' + C + ' ' + (C - R) + ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ex.toFixed(2) + ' ' + ey.toFixed(2) + '" class="t-clock-past"/>';
  'JFMAMJJASOND'.split('').forEach((l, m) => {
    const a = ang(Date.UTC(year, m, 1));
    const [x1, y1_] = pt(a, R - 6), [x2, y2] = pt(a, R + 6);
    svg += '<line x1="' + x1.toFixed(1) + '" y1="' + y1_.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" class="t-clock-gap"/>';
    const am = ang(Date.UTC(year, m, 15));
    const [lx, ly] = pt(am, R + 17);
    svg += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 3.5).toFixed(1) + '" class="t-clock-m' + (m === new Date(now).getUTCMonth() ? ' is-now' : '') + '">' + l + '</text>';
  });
  A(S().deadlines).forEach(d => {
    const ms = parseDate(d.date);
    if (isNaN(ms) || ms < y0 || ms >= y1) return;
    const r = d.recId ? api.rec(d.recId) : null;
    const done = r && r.status === 'done';
    const [dx, dy] = pt(ang(ms), R);
    const cls = done ? 'is-done' : ms < now ? 'is-past' : d.hard ? 'is-hard' : 'is-soft';
    svg += '<circle cx="' + dx.toFixed(1) + '" cy="' + dy.toFixed(1) + '" r="4.6" class="t-clock-dl ' + cls + '"><title>' + esc(X(d.label) + ' ' + X(d.title)) + '</title></circle>';
  });
  const [tx, ty] = pt(a1, R - 16), [tx2, ty2] = pt(a1, R + 9);
  svg += '<line x1="' + tx.toFixed(1) + '" y1="' + ty.toFixed(1) + '" x2="' + tx2.toFixed(1) + '" y2="' + ty2.toFixed(1) + '" class="t-clock-now"/>';
  const left = Math.round((y1 - now) / DAY);
  svg += '<text x="' + C + '" y="' + (C - 4) + '" class="t-clock-big">' + left + '</text>';
  svg += '<text x="' + C + '" y="' + (C + 13) + '" class="t-clock-small">days left in ' + year + '</text>';
  svg += '</svg>';

  const upcoming = A(S().deadlines).map(d => Object.assign({ ms: parseDate(d.date) }, d))
    .filter(d => !isNaN(d.ms) && d.ms >= now).sort((a, b) => a.ms - b.ms).slice(0, 5);
  const list = upcoming.map(d => {
    const r = d.recId ? api.rec(d.recId) : null;
    const done = r && r.status === 'done';
    const days = Math.round((d.ms - now) / DAY);
    const title = r && r.status !== 'hidden'
      ? '<button type="button" class="t-link" data-go="rec" data-p="' + esc(r.id) + '">' + T(d.title) + '</button>'
      : '<span>' + T(d.title) + '</span>';
    return '<li class="' + (done ? 'is-done' : '') + '"><span class="t-dl-date">' + T(d.label) + '</span>' +
      '<span class="t-dl-title">' + title + '</span>' +
      '<span class="t-dl-meta">' + (done ? 'Done' : (d.hard ? 'Hard, ' : '') + daysText(days)) + '</span></li>';
  }).join('');
  return '<div class="t-card t-clockcard"><div class="t-card-h"><span>The year so far</span>' +
    '<span class="t-legend"><i class="is-hard"></i>Hard <i class="is-soft"></i>Soft</span></div>' +
    '<div class="t-clockwrap">' + svg + '<ol class="t-dl">' + list + '</ol></div></div>';
}

function chartWidth() {
  const w = root ? root.clientWidth : 720;
  return Math.max(300, Math.min(640, w - 32 - 46));
}

function scatter(w, sel) {
  const pts = A(w.points);
  if (!pts.length) return '';
  const W = chartWidth(), H = W < 420 ? 250 : 300;
  const m = { l: 50, r: 16, t: 30, b: 38 };
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const px = (x1 - x0) * 0.08 || 1, py = (y1 - y0) * 0.12 || 1;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const sx = x => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
  const sy = y => m.t + (1 - (y - y0) / (y1 - y0)) * (H - m.t - m.b);
  let s = '<svg class="t-scatter" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(X(w.title)) + '">';
  for (let i = 0; i <= 3; i++) {
    const yv = y0 + ((y1 - y0) * i) / 3, xv = x0 + ((x1 - x0) * i) / 3;
    s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + sy(yv).toFixed(1) + '" y2="' + sy(yv).toFixed(1) + '" class="t-grid"/>';
    s += '<text x="' + (m.l - 6) + '" y="' + (sy(yv) + 3.5).toFixed(1) + '" class="t-axis t-axis-y">' + esc(M(yv, { k: true, sign: true })) + '</text>';
    s += '<text x="' + sx(xv).toFixed(1) + '" y="' + (H - m.b + 15) + '" class="t-axis t-axis-x">' + esc(M(xv, { k: true })) + '</text>';
  }
  if (y0 < 0 && y1 > 0) s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '" class="t-zero"/>';
  s += '<text x="' + (W - m.r) + '" y="' + (H - 4) + '" class="t-axis t-axis-lab">' + esc(X(w.xLabel)) + '</text>';
  s += '<text x="4" y="12" class="t-axis t-axis-lab t-axis-lab-y">' + esc(X(w.yLabel)) + '</text>';
  const fr = pts.filter(p => p.frontier).sort((a, b) => a.x - b.x);
  if (fr.length > 1) s += '<polyline points="' + fr.map(p => sx(p.x).toFixed(1) + ',' + sy(p.y).toFixed(1)).join(' ') + '" class="t-frontier"/>';
  pts.forEach((p, i) => {
    const cx = sx(p.x).toFixed(1), cy = sy(p.y).toFixed(1);
    const cls = 't-pt' + (p.frontier ? ' is-front' : '') + (p.warn ? ' is-warn' : '') + (i === sel ? ' is-sel' : '');
    s += '<g class="' + cls + '" data-act="pick" data-name="salary" data-i="' + i + '" tabindex="0" role="button" aria-label="' + esc(X(p.label)) + '">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="14" class="t-pt-hit"/>' +
      (p.current ? '<circle cx="' + cx + '" cy="' + cy + '" r="10" class="t-pt-cur"/>' : '') +
      '<circle cx="' + cx + '" cy="' + cy + '" r="5" class="t-pt-dot"/></g>';
    if (p.current || i === sel) {
      const right = sx(p.x) < W * 0.62;
      s += '<text x="' + (sx(p.x) + (right ? 13 : -13)).toFixed(1) + '" y="' + (sy(p.y) - 9).toFixed(1) + '" class="t-pt-lab" text-anchor="' + (right ? 'start' : 'end') + '">' +
        esc(X(p.label)) + (p.current ? ' (today)' : '') + '</text>';
    }
  });
  return s + '</svg>';
}

// ------------------------------------------------------------------ rec card and actions

function actionButtons(r, compact) {
  const b = (a, label, primary, arg) => '<button type="button" class="t-btn' + (primary ? ' t-btn--pri' : '') + '" data-act="rec" data-rec="' + esc(r.id) + '" data-a="' + a + '"' +
    (arg ? ' data-arg="' + esc(arg) + '"' : '') + '>' + label + '</button>';
  const wake = wakeLabel();
  let out = '';
  switch (r.status) {
    case 'proposed': out = b('start', 'Doing it', true) + b('snooze', 'Later', false, wake) + b('dismiss', 'Not for us'); break;
    case 'doing': out = b('complete', 'Done', true) + b('snooze', 'Later', false, wake) + b('dismiss', 'Not for us'); break;
    case 'waiting': out = b('start', 'Unblock') + b('complete', 'Mark done'); break;
    case 'snoozed': out = b('reopen', 'Wake now'); break;
    case 'done': out = b('reopen', 'Reopen'); break;
    case 'dismissed': out = b('reopen', 'Restore'); break;
    default: break;
  }
  return out;
}

function taskProgress(r) {
  const t = A(r.tasks);
  if (!t.length) return '';
  const d = t.filter(x => x.done).length;
  return '<span class="t-prog">' + bar(d / t.length, 't-bar--xs') + '<span>' + d + ' of ' + t.length + '</span></span>';
}

function recCard(r, opts) {
  opts = opts || {};
  const resolved = !['proposed', 'doing'].includes(r.status);
  const replies = api.conversation(r.id).length;
  const days = r.window && typeof r.window.days === 'number' ? r.window.days : null;
  const adv = r.advisor && r.advisor.verdict ? '<span class="t-meta-i">' + esc(advisorName().split(',')[0]) + ': ' + esc(ADV[r.advisor.verdict] || r.advisor.verdict) + '</span>' : '';
  const value = A(r.value).map(v => VALUE[v.cls] || v.cls);
  return '<div class="t-card t-rec' + (resolved ? ' is-resolved' : '') + ' st-' + esc(r.status) + '">' +
    '<div class="t-rec-top">' +
      '<button type="button" class="t-rec-title" data-go="rec" data-p="' + esc(r.id) + '">' +
        (r.status === 'done' ? '<span class="t-tick">' + ICON.check + '</span>' : '') + T(r.title) + '</button>' +
      (r.window ? '<div class="t-win"><span class="t-win-d">' + T(r.window.label) + '</span>' +
        (days != null && !resolved ? '<span class="t-win-n' + (days <= 30 ? ' is-soon' : '') + '">' + esc(daysText(days)) + '</span>' : '') + '</div>' : '') +
    '</div>' +
    (opts.noSummary ? '' : '<p class="t-rec-sum">' + T(r.summary) + '</p>') +
    '<div class="t-meta"><span class="t-meta-i">' + T(r.triggerText) + '</span>' +
      (r.effort ? '<span class="t-meta-i">' + T(r.effort) + '</span>' : '') +
      (value.length ? '<span class="t-meta-i">' + esc(value.join(', ')) + '</span>' : '') + adv + '</div>' +
    '<div class="t-rec-foot"><span class="t-status">' + esc(statusText(r)) + '</span>' + taskProgress(r) +
      '<span class="t-rec-acts">' + actionButtons(r, true) +
      '<button type="button" class="t-btn t-btn--ghost" data-go="rec" data-p="' + esc(r.id) + '">' + (replies ? plural(replies, 'reply', 'replies') : 'Discuss') + '</button></span></div>' +
    '</div>';
}

// ------------------------------------------------------------------ main thread (brief + ask)

function syncBriefSet() {
  const d = api.demo();
  const ny = api.needsYou().map(r => r.id);
  if (ui.briefDemo !== d || !ui.briefSet) {
    ui.briefDemo = d;
    ui.briefSet = ny.slice();
    ui.lastThread = { name: 'brief', params: {} };
    ui.connected = false; ui.build = 0; ui.buildFor = -1; ui.scopes = null; ui.exported = false; ui.copied = false;
  } else {
    ny.forEach(id => { if (!ui.briefSet.includes(id)) ui.briefSet.push(id); });
  }
}

function briefThread(route) {
  const s = S();
  const v = api.verdict();
  const brief = ui.briefSet.map(id => api.rec(id)).filter(r => r && r.status !== 'hidden');
  const open = brief.filter(r => ['proposed', 'doing'].includes(r.status));
  const needIds = new Set(api.needsYou().map(r => r.id));
  const motion = api.recs().filter(r => ['doing', 'waiting'].includes(r.status) && !needIds.has(r.id) && !ui.briefSet.includes(r.id));
  const date = (s.meta && s.meta.clockLabel) || '';
  let h = divider(date);

  // The brief itself.
  const verdictHtml = '<div class="t-verdict is-' + v.level + '">' +
    '<div class="t-verdict-k">' + esc(monthName()) + ' brief</div>' +
    '<h1 class="t-verdict-h">' + T(v.headline) + '</h1>' + (v.sub ? '<p class="t-verdict-s">' + T(v.sub) + '</p>' : '') + '</div>';
  h += message('fathom', verdictHtml, { tag: 'Monthly brief' });

  if (brief.length) {
    const cards = brief.map(r => recCard(r)).join('');
    const lead = open.length
      ? 'Needs you before the window closes. ' + plural(open.length, 'item') + ' left.'
      : 'All handled.';
    h += message('fathom', '<p>' + esc(lead) + '</p>', { extra: '<div class="t-stack">' + cards + '</div>' });
    if (!open.length && v.level === 'clear') {
      h += message('fathom', '<p>That was the last one. Nothing else needs you before the next brief. I will keep watching.</p>', { fresh: true });
    }
  }

  if (motion.length) {
    h += message('fathom', '<p>Also in motion. Nothing due from you yet.</p>', {
      extra: '<div class="t-qlist t-motion">' + motion.slice(0, 4).map(r => '<button type="button" class="t-q" data-go="rec" data-p="' + esc(r.id) + '"><span class="t-q-l">' + T(r.title) + '</span>' +
        '<span class="t-q-m">' + esc(statusText(r)) + (r.window ? ', ' + T(r.window.label) : '') + '</span></button>').join('') +
        '<button type="button" class="t-q t-q--more" data-go="plan"><span>' + (motion.length > 4 ? (motion.length - 4) + ' more in the plan' : 'Open the plan') + '</span>' + ICON.arrow + '</button></div>',
    });
  }

  h += message('fathom', '', { extra: yearClock() });

  // What changed.
  const ev = A(s.events);
  if (ev.length) {
    h += message('fathom', '<p>What changed since the last brief.</p>', {
      extra: '<div class="t-card"><ul class="t-events">' + ev.map(e =>
        '<li><span class="t-ev-date">' + T(e.date) + '</span><div><div class="t-ev-title">' + T(e.title) +
        '<span class="t-ev-kind">' + esc(e.kind || '') + '</span></div><div class="t-ev-body">' + T(e.body) + '</div></div></li>').join('') + '</ul></div>',
    });
  }

  // Covered domains plus trends.
  const doms = A(s.domains);
  if (doms.length) {
    const covered = doms.filter(d => d.status === 'covered').length;
    const ser = Object.values(s.series || {}).slice(0, 2);
    h += message('fathom', '<p>' + covered + ' of ' + doms.length + ' areas are covered. Here is what I watch in each.</p>', {
      extra: '<div class="t-card"><ul class="t-domains">' + doms.map(d =>
        '<li><div class="t-dom-h"><span class="t-dom-dot is-' + esc(d.status) + '"></span><span class="t-dom-name">' + T(d.name) + '</span>' +
        '<span class="t-dom-st">' + esc(d.status) + '</span></div><div class="t-dom-note">' + T(d.note) + '</div>' +
        '<div class="t-dom-watch">' + T(d.watching) + '</div></li>').join('') + '</ul>' +
        (ser.length ? '<div class="t-trends">' + ser.map(x => {
          const pts = A(x.points); const lastA = [...pts].reverse().find(p => p.kind === 'a');
          return '<div class="t-trend"><div class="t-trend-l">' + T(x.label) + '</div>' + sparkline(x, 160, 34) +
            (lastA ? '<div class="t-trend-v">' + esc(M(lastA.v, { k: true })) + ' <span>' + esc(lastA.x) + '</span></div>' : '') + '</div>';
        }).join('') + '</div>' : '') + '</div>',
    });
  }

  // Packs nudge.
  const sug = api.packs().filter(p => p.status === 'suggested');
  sug.forEach(p => {
    h += message('fathom', '<p>Something in your data hints at the <strong>' + T(p.name) + '</strong> pack. ' + T(p.why) + '</p>', {
      extra: '<div class="t-inline-acts"><button type="button" class="t-btn" data-act="whatif" data-pack="' + esc(p.id) + '">What if</button>' +
        '<button type="button" class="t-btn t-btn--ghost" data-go="packs">All packs</button></div>',
    });
  });

  // Advisor.
  const adv = s.advisor || {};
  if (adv.next) {
    if (api.demo() === 'checkin' && adv.agenda) {
      h += message('advisor', '<p>' + T(adv.agenda) + '</p>', {
        tag: esc(X(adv.role)),
        extra: '<div class="t-inline-acts"><button type="button" class="t-btn" data-go="advisor">Open the check-in</button></div>',
      });
    } else {
      h += message('fathom', '<p>Next check-in with ' + esc(advisorName()) + ': ' + T(adv.next.when) + ', ' + T(adv.next.length) + '. ' +
        '<button type="button" class="t-link t-link--acc" data-go="advisor">See what goes to them</button></p>');
    }
  }

  h += '<div class="t-emailnote">This brief also went out by email. <button type="button" class="t-link" data-go="email">View the email</button></div>';

  // Side conversations (pack what-ifs).
  api.packs().forEach(p => {
    const c = api.conversation('pack:' + p.id);
    if (!c.length) return;
    h += message('me', T(p.whatIf && p.whatIf.prompt), {
      extra: '<button type="button" class="t-sidestub" data-go="packs" data-p="' + esc(p.id) + '">' +
        '<span>Side thread, ' + plural(c.length, 'message') + (p.status === 'active' ? ', pack on' : '') + '</span>' + ICON.arrow + '</button>',
    });
  });

  // The ask conversation.
  const conv = api.conversation();
  h += convo(conv, ui.prevMainLen != null ? ui.prevMainLen : conv.length);
  ui.prevMainLen = conv.length;

  if (route.name === 'ask') {
    const asked = new Set(conv.filter(m => m.role === 'me').map(m => (m.html || '').replace(/<[^>]+>/g, '').trim()));
    const rest = A(s.ask && s.ask.suggested).filter(q => !asked.has(X(q.q).trim()));
    if (rest.length) {
      h += message('fathom', '<p>' + (conv.length ? 'Anything else?' : 'Ask me anything about the plan or your numbers. Some places to start:') + '</p>', {
        extra: '<div class="t-qlist">' + rest.map(q => '<button type="button" class="t-q" data-act="ask" data-q="' + esc(q.id) + '">' + T(q.q) + ICON.arrow + '</button>').join('') + '</div>',
      });
    }
  }
  return {
    key: 'main', count: conv.length + api.packs().reduce((n, p) => n + api.conversation('pack:' + p.id).length, 0),
    head: '', body: h,
    follow: route.name === 'ask' ? '' : followUps(A(s.ask && s.ask.suggested), conv, q => 'data-act="ask" data-q="' + esc(q.id) + '"'),
    placeholder: 'Ask about your money, a goal, or a what if',
  };
}

function followUps(list, conv, attr) {
  const asked = new Set(A(conv).filter(m => m.role === 'me').map(m => (m.html || '').replace(/<[^>]+>/g, '').trim()));
  const rest = list.map((q, i) => Object.assign({ i }, q)).filter(q => !asked.has(X(q.q).trim())).slice(0, 3);
  return rest.map(q => '<button type="button" class="t-follow" ' + attr(q) + '>' + T(q.q) + '</button>').join('');
}

// ------------------------------------------------------------------ rec side thread

function recThread(id) {
  const r = api.rec(id);
  if (!r) return briefThread({ name: 'brief' });
  const s = S();
  let h = '';
  const intro = '<p class="t-lead">' + T(r.summary) + '</p>' +
    '<div class="t-meta t-meta--lg"><span class="t-meta-i">' + T(r.triggerText) + '</span>' +
    (r.window ? '<span class="t-meta-i">Window ' + T(r.window.label) + (r.window.days > 0 ? ', ' + esc(daysText(r.window.days)) : '') + '</span>' : '') +
    (r.effort ? '<span class="t-meta-i">' + T(r.effort) + '</span>' : '') + '</div>';
  h += message('fathom', intro, { tag: 'Recommendation' });

  if (A(r.why).length) h += message('fathom', '<h3 class="t-h3">Why this, why now</h3>' + paras(r.why));

  const value = A(r.value);
  if (value.length) {
    h += message('fathom', '', {
      extra: '<div class="t-card"><div class="t-card-h"><span>What it gets you</span><span class="t-muted">not summed</span></div><dl class="t-dl2">' +
        value.map(v => '<dt>' + esc(VALUE[v.cls] || v.cls) + '</dt><dd>' + T(v.text) + '</dd>').join('') + '</dl></div>',
    });
  }

  const mine = A(r.mine);
  if (mine.length) {
    h += message('fathom', '', {
      extra: '<div class="t-card"><div class="t-card-h"><span>From your data</span><span class="t-muted">tap a figure for its source</span></div><dl class="t-figs">' +
        mine.map(m => '<div><dt>' + T(m.label) + '</dt><dd>' + T('{f:' + m.fig + '}') + '</dd></div>').join('') + '</dl></div>',
    });
  }

  const kb = A(r.kb);
  if (kb.length) {
    h += message('fathom', '', {
      extra: '<div class="t-card"><div class="t-card-h"><span>From the knowledge base</span></div><div class="t-kb">' + kb.map(k => {
        const p = k.pack ? api.pack(k.pack) : null;
        return '<div class="t-kb-i"><div class="t-kb-t">' + T(k.title) + '</div><div class="t-kb-b">' + T(k.body) + '</div>' +
          '<div class="t-kb-c"><span>' + T(k.cite) + '</span>' +
          (p ? '<button type="button" class="t-link t-link--acc" data-go="packs" data-p="' + esc(p.id) + '">' + T(p.name) + ' pack</button>' : '') + '</div></div>';
      }).join('') + '</div></div>',
    });
  }

  if (A(r.cross).length) {
    h += message('fathom', '<h3 class="t-h3">How this touches other decisions</h3><ul class="t-ul">' + A(r.cross).map(c => '<li>' + T(c) + '</li>').join('') + '</ul>');
  }

  if (r.scenario) {
    const w = s.wargame && s.wargame[r.scenario];
    h += message('fathom', '<p>This one has tradeoffs worth playing with yourself.</p>', {
      extra: '<button type="button" class="t-sidestub" data-go="wargame" data-p="' + esc(r.scenario) + '"><span>War game: ' + T(w ? w.title : r.scenario) + '</span>' + ICON.arrow + '</button>',
    });
  }

  if (r.advisor) {
    const v = r.advisor.verdict;
    const body = '<p><span class="t-verdict-tag is-' + esc(v) + '">' + esc(ADV[v] || v) + '</span> ' + T(r.advisor.note) + '</p>';
    h += v === 'pending'
      ? message('fathom', '<p>Waiting on ' + esc(advisorName()) + ' to review this at the next check-in.</p>' + (r.advisor.note ? '<p class="t-muted">' + T(r.advisor.note) + '</p>' : ''))
      : message('advisor', body, { tag: esc(X(s.advisor && s.advisor.role) || 'Advisor') });
  }

  const tasks = A(r.tasks);
  const d = tasks.filter(x => x.done).length;
  const checklist = tasks.length ? '<div class="t-card t-check"><div class="t-card-h"><span>Checklist</span><span class="t-muted">' + d + ' of ' + tasks.length + '</span></div>' +
    bar(tasks.length ? d / tasks.length : 0, 't-bar--sm') +
    '<ul>' + tasks.map((tk, i) => '<li><button type="button" class="t-task' + (tk.done ? ' is-done' : '') + '" data-act="task" data-rec="' + esc(r.id) + '" data-i="' + i + '" aria-pressed="' + !!tk.done + '">' +
      '<span class="t-box">' + (tk.done ? ICON.check : '') + '</span><span>' + T(tk.t) + '</span></button></li>').join('') + '</ul></div>' : '';
  h += message('fathom', '', {
    extra: checklist + '<div class="t-card t-actcard"><div class="t-actcard-st"><span class="t-k">Status</span><span class="t-status t-status--lg">' + esc(statusText(r)) + '</span></div>' +
      '<div class="t-rec-acts">' + actionButtons(r, false) + '</div></div>',
  });

  const conv = api.conversation(r.id);
  h += divider('Conversation');
  if (!conv.length) h += '<p class="t-empty">Ask about this one. Why now, what it gets you, how long the window stays open.</p>';
  h += convo(conv, ui.viewKey === 'rec:' + id ? ui.count : conv.length);

  return {
    key: 'rec:' + id, count: conv.length,
    head: sideHead(T(r.title), esc(statusText(r)) + (r.window ? ', ' + T(r.window.label) : '')),
    body: h,
    follow: followUps(A(r.qa), conv, q => 'data-act="askrec" data-rec="' + esc(r.id) + '" data-i="' + q.i + '"'),
    placeholder: 'Reply about this recommendation',
    conv: r.id,
  };
}

function sideHead(title, sub) {
  return '<div class="t-side"><button type="button" class="t-iconbtn" data-go="brief" aria-label="Back to the main thread">' + ICON.back + '</button>' +
    '<div class="t-side-t"><div class="t-side-title">' + title + '</div>' + (sub ? '<div class="t-side-sub">' + sub + '</div>' : '') + '</div></div>';
}

// ------------------------------------------------------------------ war game side thread

function wargameThread(name) {
  const s = S();
  const wg = s.wargame || {};
  const names = ['salary', 'deferral'].filter(n => wg[n]);
  const cur = names.includes(name) ? name : names[0];
  const w = wg[cur];
  const picks = (api.state && api.state.picks) || {};
  const sel = typeof picks[cur] === 'number' ? picks[cur] : 0;
  let h = '<div class="t-tabs" role="tablist">' + names.map(n => '<button type="button" role="tab" class="t-tab' + (n === cur ? ' is-on' : '') + '" aria-selected="' + (n === cur) + '" data-go="wargame" data-p="' + n + '">' + T(wg[n].title) + '</button>').join('') + '</div>';
  if (!w) return { key: 'wg', count: 0, head: sideHead('War game', ''), body: '<p class="t-empty">No scenarios yet.</p>' };
  h += message('fathom', '<p class="t-lead">' + T(w.question) + '</p>', { tag: 'War game' });

  if (cur === 'salary') {
    const p = A(w.points)[sel] || {};
    h += message('fathom', '<p>Each dot is a salary level. The line is the frontier: you cannot do better on one axis without giving up the other. Tap a dot.</p>', {
      extra: '<div class="t-card t-chartcard">' + scatter(w, sel) +
        '<div class="t-legend t-legend--chart"><i class="is-front"></i>On the frontier <i class="is-off"></i>Off it <i class="is-cur"></i>Today</div></div>' +
        '<div class="t-card t-pick"><div class="t-pick-h"><span class="t-pick-l">' + T(p.label) + (p.current ? ' <span class="t-muted">today</span>' : '') + '</span>' +
        '<span class="t-pick-n"><span><span class="t-k">' + esc(X(w.xLabel)) + '</span>' + esc(M(p.x, { k: true })) + '</span><span><span class="t-k">' + esc(X(w.yLabel)) + '</span>' + esc(M(p.y, { k: true, sign: true })) + '</span></span></div>' +
        '<p>' + T(p.note) + '</p>' + (p.warn ? '<p class="t-warn">' + T(p.warn) + '</p>' : '') + '</div>' +
        '<div class="t-optlist">' + A(w.points).map((q, i) => '<button type="button" class="t-opt' + (i === sel ? ' is-on' : '') + '" data-act="pick" data-name="salary" data-i="' + i + '">' +
          '<span class="t-opt-l">' + T(q.label) + (q.current ? ' <span class="t-muted">today</span>' : '') + '</span>' +
          '<span class="t-opt-v">' + esc(M(q.x, { k: true })) + '</span><span class="t-opt-v">' + esc(M(q.y, { k: true, sign: true })) + '</span></button>').join('') + '</div>',
    });
  } else {
    const opts = A(w.options);
    const o = opts[sel] || {};
    const max = Math.max(1, ...opts.map(x => Math.max(x.decCash || 0, x.need || 0))) * 1.08;
    const bars = opts.map((x, i) => {
      const short = (x.need || 0) - (x.decCash || 0);
      return '<button type="button" class="t-cbar' + (i === sel ? ' is-on' : '') + '" data-act="pick" data-name="deferral" data-i="' + i + '">' +
        '<span class="t-cbar-l">' + T(x.label) + '</span>' +
        '<svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="1.5" width="100" height="7" class="t-cbar-track"/>' +
        '<rect x="0" y="1.5" width="' + ((x.decCash / max) * 100).toFixed(2) + '" height="7" class="t-cbar-fill' + (short > 0 ? ' is-short' : '') + '"/>' +
        '<line x1="' + ((x.need / max) * 100).toFixed(2) + '" x2="' + ((x.need / max) * 100).toFixed(2) + '" y1="0" y2="10" class="t-cbar-need" vector-effect="non-scaling-stroke"/></svg>' +
        '<span class="t-cbar-v">' + esc(M(x.decCash, { k: true })) + (short > 0 ? ' <em>short ' + esc(M(short, { k: true })) + '</em>' : '') + '</span></button>';
    }).join('');
    h += message('fathom', '<p>Pick an option. The bars are December business cash; the tick is what payroll needs.</p>', {
      extra: '<div class="t-card"><div class="t-card-h"><span>December cash against payroll need</span><span class="t-legend"><i class="is-need"></i>Need</span></div>' + bars + '</div>' +
        '<div class="t-card t-pick"><div class="t-pick-h"><span class="t-pick-l">' + T(o.label) + '</span><span class="t-muted">' + esc(M(o.amount)) + ' deferred</span></div>' +
        '<dl class="t-figs t-figs--4"><div><dt>2026 tax</dt><dd>' + esc(M(o.tax2026, { sign: true })) + '</dd></div><div><dt>2027 tax</dt><dd>' + esc(M(o.tax2027, { sign: true })) + '</dd></div>' +
        '<div><dt>Net</dt><dd>' + esc(M(o.net, { sign: true })) + '</dd></div><div><dt>December cash</dt><dd>' + esc(M(o.decCash)) + '<span class="t-sub">payroll needs ' + esc(M(o.need)) + '</span></dd></div></dl>' +
        '<p>' + T(o.note) + '</p></div>',
    });
  }
  if (w.takeaway) h += message('fathom', '<p>' + T(w.takeaway) + '</p>', { tag: 'Takeaway' });
  const rec = api.recs().find(r => r.scenario === cur);
  if (rec) h += message('fathom', '<p>This feeds ' + recLink(rec.id) + '.</p>');
  return { key: 'wg:' + cur, count: sel, head: sideHead('War game', T(w.title)), body: h, keepScroll: true };
}

// ------------------------------------------------------------------ advisor side thread

function advisorThread() {
  const a = S().advisor || {};
  const name = esc(advisorName());
  let h = '';
  h += message('fathom', '<p>Next check-in with ' + name + ': <strong>' + T(a.next && a.next.when) + '</strong>, ' + T(a.next && a.next.length) + '. ' +
    name + ' sees the same plan, the same numbers and these conversations.</p>', { tag: 'Check-in' });
  if (a.agenda) h += message('me', '<span class="t-k">Your agenda</span>' + T(a.agenda));
  const rev = A(a.reviewed);
  if (rev.length) {
    h += message('advisor', '<p>I went through what Fathom proposed since we last talked.</p>', {
      tag: esc(X(a.role)),
      extra: '<div class="t-card"><ul class="t-reviews">' + rev.map(x =>
        '<li><span class="t-verdict-tag is-' + esc(x.verdict) + '">' + esc(ADV[x.verdict] || x.verdict) + '</span><div><div class="t-rev-t">' +
        (x.recId ? recLink(x.recId, T(x.title)) : T(x.title)) + '</div><div class="t-rev-n">' + T(x.note) + '</div></div></li>').join('') + '</ul></div>',
    });
  }
  const pend = A(a.pending).map(id => api.rec(id)).filter(r => r && r.status !== 'hidden');
  if (pend.length) {
    h += message('fathom', '<p>Waiting on ' + name + ' for these. They are on the agenda.</p>', {
      extra: '<div class="t-stack">' + pend.map(r => recCard(r)).join('') + '</div>',
    });
  }
  const na = A(a.notAsking);
  if (na.length) {
    h += message('fathom', '<p>Things you do not need to bring, and why.</p>', {
      extra: '<div class="t-card"><dl class="t-dl2 t-dl2--stack">' + na.map(x => '<dt>' + T(x.q) + '</dt><dd>' + T(x.why) + '</dd>').join('') + '</dl></div>',
    });
  }
  const sh = A(a.shared), ex = A(a.experts);
  if (sh.length || ex.length) {
    h += message('fathom', '', {
      extra: '<div class="t-card t-two">' +
        (sh.length ? '<div><div class="t-card-h"><span>Shared with ' + name + '</span></div><ul class="t-rows">' + sh.map(x => '<li><span>' + T(x.title) + '</span><span class="t-muted">' + T(x.when) + '</span></li>').join('') + '</ul></div>' : '') +
        (ex.length ? '<div><div class="t-card-h"><span>Specialists on call</span></div><ul class="t-rows">' + ex.map(x => '<li><span>' + T(x.name) + '<span class="t-sub">' + T(x.role) + '</span></span><span class="t-muted">' + T(x.when) + '</span></li>').join('') + '</ul></div>' : '') +
        '</div>',
    });
  }
  return { key: 'advisor', count: 0, head: sideHead('Quarterly check-in', name + ', ' + T(a.next && a.next.when)), body: h, placeholder: 'Ask Fathom, or add to the agenda' };
}

// ------------------------------------------------------------------ pack side thread (what if)

function packThread(id) {
  const p = api.pack(id);
  if (!p) return briefThread({ name: 'brief' });
  const on = p.status === 'active';
  const conv = api.conversation('pack:' + id);
  let h = '';
  h += message('fathom', '<p>' + (on ? 'This pack is on. ' : '') + T(p.why) + '</p>', { tag: 'Knowledge pack', extra: packFacts(p) });
  if (!conv.length && p.whatIf) {
    h += message('fathom', '<p>Want to talk through what changes if this applied to you? Nothing switches on until you say so.</p>', {
      extra: '<div class="t-inline-acts"><button type="button" class="t-btn t-btn--pri" data-act="whatif" data-pack="' + esc(id) + '">' + T(p.whatIf.prompt) + '</button></div>',
    });
  }
  h += convo(conv, ui.viewKey === 'pack:' + id ? ui.count : conv.length);
  const unlocks = A(p.whatIf && p.whatIf.unlocks);
  if (conv.length && api.engineOn() !== false && unlocks.length) {
    h += message('fathom', '<p>' + (on ? 'With the pack on, these are in your plan.' : 'Turning this pack on would add:') + '</p>', {
      extra: '<div class="t-card"><ul class="t-unlocks">' + unlocks.map(u => {
        const r = u.recId ? api.rec(u.recId) : null;
        const live = r && r.status !== 'hidden';
        return '<li><div class="t-unl-t">' + (live ? recLink(r.id, T(u.title)) : T(u.title)) + (live ? '<span class="t-status">' + esc(statusText(r)) + '</span>' : '') + '</div><div class="t-unl-b">' + T(u.text) + '</div></li>';
      }).join('') + '</ul></div>' +
      '<div class="t-inline-acts">' + (on
        ? '<span class="t-ok">' + ICON.check + 'Pack on</span><button type="button" class="t-btn t-btn--ghost" data-act="packtoggle" data-pack="' + esc(id) + '">Turn off</button>'
        : '<button type="button" class="t-btn t-btn--pri" data-act="packtoggle" data-pack="' + esc(id) + '">Turn this pack on</button>') + '</div>',
    });
  } else if (on && !conv.length) {
    h += message('fathom', '', { extra: '<div class="t-inline-acts"><button type="button" class="t-btn t-btn--ghost" data-act="packtoggle" data-pack="' + esc(id) + '">Turn this pack off</button></div>' });
  }
  return {
    key: 'pack:' + id, count: conv.length,
    head: sideHead((p.whatIf && !on ? 'What if: ' : '') + T(p.name), esc(on ? 'On' : p.status === 'exploring' ? 'Exploring' : p.status === 'suggested' ? 'Suggested' : 'Available')),
    body: h, placeholder: 'Ask about this pack',
  };
}

function packFacts(p) {
  const recs = A(p.recIds).map(id => api.rec(id)).filter(r => r && r.status !== 'hidden');
  return '<div class="t-card t-pack-facts"><dl class="t-dl2">' +
    (A(p.covers).length ? '<dt>Covers</dt><dd>' + A(p.covers).map(T).join(', ') + '</dd>' : '') +
    '<dt>Entries</dt><dd>' + esc(p.entries) + ' curated</dd>' +
    '<dt>Curator</dt><dd>' + T(p.curator) + '</dd>' +
    '<dt>Updated</dt><dd>' + T(p.updated) + '</dd>' +
    (recs.length ? '<dt>Powers</dt><dd class="t-powers">' + recs.map(r => recLink(r.id)).join('') + '</dd>' : '') +
    '</dl></div>';
}

// ------------------------------------------------------------------ drawer panels

function drawerIndex() {
  const s = S();
  const recs = api.recs();
  const needs = api.needsYou().length;
  const motion = recs.filter(r => ['doing', 'waiting'].includes(r.status)).length;
  const packs = api.packs();
  const docs = A(s.yearend && s.yearend.docs);
  const scopes = currentScopes();
  const eng = s.engine || {};
  const items = [
    ['plan', 'Plan', needs + ' need you, ' + motion + ' in motion'],
    ['goals', 'Goals', plural(A(s.goals).length, 'goal') + ', ' + A(s.curve).length + ' preferences'],
    ['accounts', 'Accounts', A(s.accounts).filter(a => a.mirror === 'connected').length + ' of ' + A(s.accounts).length + ' mirrored, read-only'],
    ['packs', 'Knowledge packs', packs.filter(p => p.status === 'active').length + ' on, ' + packs.filter(p => p.status === 'suggested').length + ' suggested'],
    ['advisor', 'Check-in', advisorName() + ', ' + X(s.advisor && s.advisor.next && s.advisor.next.when)],
    ['wargame', 'War game', ['salary', 'deferral'].filter(n => s.wargame && s.wargame[n]).map(n => X(s.wargame[n].title)).join(', ')],
    ['yearend', 'Year-end packet', docs.filter(d => d.status === 'have').length + ' of ' + docs.length + ' documents in hand'],
    ['connect', 'Your own AI', scopes.filter(x => x.on).length + ' of ' + scopes.length + ' scopes shared over MCP'],
    ['engine', 'Engine', (api.engineOn() ? 'On' : 'Off') + ', ' + M(eng.budget && eng.budget.used) + ' of ' + M(eng.budget && eng.budget.monthly) + ' this month'],
    ['email', 'Monthly email', X(s.email && s.email.subject)],
  ];
  return { title: 'Everything else', body: '<ul class="t-index">' + items.map(([r, l, sub]) =>
    '<li><button type="button" data-go="' + r + '"><span class="t-index-l">' + esc(l) + '</span><span class="t-index-s">' + esc(sub) + '</span>' + ICON.arrow + '</button></li>').join('') + '</ul>' };
}

function planPanel() {
  const recs = api.recs();
  const need = new Set(api.needsYou().map(r => r.id));
  const groups = [
    ['Needs you', r => need.has(r.id)],
    ['In motion', r => ['doing'].includes(r.status) && !need.has(r.id)],
    ['Waiting', r => r.status === 'waiting'],
    ['Snoozed', r => r.status === 'snoozed'],
    ['Done', r => r.status === 'done'],
    ['Dismissed', r => r.status === 'dismissed'],
  ];
  let b = '';
  groups.forEach(([label, fn]) => {
    const list = recs.filter(fn);
    if (!list.length) return;
    if (label === 'Needs you') list.sort((x, y) => (x.window ? x.window.days : 999) - (y.window ? y.window.days : 999));
    b += '<section class="t-psec"><h3 class="t-psec-h">' + esc(label) + '<span>' + list.length + '</span></h3>' + list.map(r => planRow(r)).join('') + '</section>';
  });
  return { title: 'Plan', sub: plural(recs.length, 'recommendation'), body: b || '<p class="t-empty">Nothing in the plan yet.</p>' };
}

function planRow(r) {
  const value = A(r.value).map(v => VALUE[v.cls] || v.cls);
  const days = r.window && typeof r.window.days === 'number' ? r.window.days : null;
  const live = ['proposed', 'doing', 'waiting'].includes(r.status);
  return '<div class="t-prow st-' + esc(r.status) + '">' +
    '<div class="t-prow-top"><button type="button" class="t-prow-title" data-go="rec" data-p="' + esc(r.id) + '">' + T(r.title) + '</button>' +
    (r.window && live ? '<span class="t-win-n' + (days != null && days <= 30 ? ' is-soon' : '') + '">' + T(r.window.label) + (days > 0 ? ', ' + esc(daysText(days)) : '') + '</span>' : '') + '</div>' +
    '<div class="t-meta"><span class="t-meta-i">' + T(r.triggerText) + '</span>' + (r.effort ? '<span class="t-meta-i">' + T(r.effort) + '</span>' : '') +
    (value.length ? '<span class="t-meta-i">' + esc(value.join(', ')) + '</span>' : '') +
    (r.advisor ? '<span class="t-meta-i">Advisor ' + esc((ADV[r.advisor.verdict] || '').toLowerCase()) + '</span>' : '') + '</div>' +
    '<div class="t-prow-foot"><span class="t-status">' + esc(statusText(r)) + '</span>' + taskProgress(r) + '<span class="t-rec-acts">' + actionButtons(r, true) + '</span></div></div>';
}

function goalsPanel() {
  const s = S();
  const hz = [['now', 'Now'], ['1-3y', 'One to three years'], ['3-10y', 'Three to ten years']];
  let b = '';
  hz.forEach(([k, l]) => {
    const list = A(s.goals).filter(g => g.horizon === k);
    if (!list.length) return;
    b += '<section class="t-psec"><h3 class="t-psec-h">' + esc(l) + '</h3>' + list.map(g => {
      let prog = '';
      if (g.progress) {
        const c = api.fig(g.progress.cur), t = api.fig(g.progress.target);
        const f = c && t && t.v ? c.v / t.v : 0;
        prog = '<div class="t-goal-prog">' + bar(f, 't-bar--sm') + '<span>' + T('{f:' + g.progress.cur + '}') + ' of ' + T('{f:' + g.progress.target + '}') + '</span></div>';
      }
      return '<div class="t-goal"><div class="t-goal-h"><span class="t-goal-t">' + T(g.title) + '</span><span class="t-goal-s is-' + esc(String(g.status).replace(/\s/g, '-')) + '">' + esc(g.status) + '</span></div>' +
        '<p>' + T(g.prose) + '</p>' + prog + '</div>';
    }).join('') + '</section>';
  });
  const curve = A(s.curve);
  if (curve.length) {
    b += '<section class="t-psec"><h3 class="t-psec-h">Where you sit on the curve</h3><p class="t-muted t-psec-p">Drag to change. Fathom uses these to break ties between options on the frontier.</p>' +
      curve.map(c => {
        const v = ui.sliders[c.id] != null ? ui.sliders[c.id] : Math.round((c.value <= 1 ? c.value * 100 : c.value));
        return '<div class="t-curve"><div class="t-curve-ends"><span>' + T(c.left) + '</span><span>' + T(c.right) + '</span></div>' +
          '<input type="range" min="0" max="100" value="' + v + '" data-slider="' + esc(c.id) + '" aria-label="' + esc(X(c.left) + ' to ' + X(c.right)) + '">' +
          '<p class="t-curve-n">' + T(c.note) + '</p></div>';
      }).join('') + '</section>';
  }
  return { title: 'Goals', sub: 'In your words', body: b };
}

function accountsPanel() {
  const s = S();
  const accts = A(s.accounts);
  const owners = [];
  accts.forEach(a => { const o = X(a.owner) || 'Other'; if (!owners.includes(o)) owners.push(o); });
  let b = '<p class="t-ro">' + ICON.lock + 'Read-only. Fathom can see balances and transactions. It cannot move, pay or delete anything.</p>';
  owners.forEach(o => {
    const list = accts.filter(a => (X(a.owner) || 'Other') === o);
    b += '<section class="t-psec"><h3 class="t-psec-h">' + esc(o) + '</h3><ul class="t-accts">' + list.map(a =>
      '<li><div class="t-acct-l"><div class="t-acct-n">' + T(a.name) + '</div><div class="t-acct-s">' + T(a.inst) + ', ' + esc(a.kind) + (a.note ? '. ' + T(a.note) : '') + '</div></div>' +
      '<div class="t-acct-r"><div class="t-acct-v">' + (a.fig ? T('{f:' + a.fig + '}') : '<span class="t-muted">no balance</span>') + '</div>' +
      '<div class="t-mirror is-' + esc(a.mirror) + '">' + esc(a.mirror) + '</div></div></li>').join('') + '</ul></section>';
  });
  const ser = Object.values(s.series || {});
  if (ser.length) {
    b += '<section class="t-psec"><h3 class="t-psec-h">Trends</h3><p class="t-muted t-psec-p">Solid is actual, dashed is projected.</p>' + ser.map(x => {
      const pts = A(x.points);
      return '<div class="t-trendrow"><div class="t-trend-l">' + T(x.label) + '</div>' + sparkline(x, 240, 40) +
        '<div class="t-trend-ax"><span>' + esc(pts[0] && pts[0].x) + '</span><span>' + esc(pts.length ? pts[pts.length - 1].x : '') + '</span></div></div>';
    }).join('') + '</section>';
  }
  const ev = A(s.events);
  if (ev.length) {
    b += '<section class="t-psec"><h3 class="t-psec-h">Detected events</h3><ul class="t-events">' + ev.map(e =>
      '<li><span class="t-ev-date">' + T(e.date) + '</span><div><div class="t-ev-title">' + T(e.title) + '<span class="t-ev-kind">' + esc(e.kind) + '</span></div><div class="t-ev-body">' + T(e.body) + '</div></div></li>').join('') + '</ul></section>';
  }
  return { title: 'Accounts', sub: 'Data through ' + X(s.meta && s.meta.dataThrough), body: b };
}

function packsPanel() {
  const ps = api.packs();
  const groups = [
    ['On', p => p.status === 'active'],
    ['Exploring', p => p.status === 'exploring'],
    ['Suggested', p => p.status === 'suggested'],
    ['Available', p => p.status === 'available'],
  ];
  let b = '<p class="t-muted t-psec-p">Curated knowledge Fathom reads when it advises you. A pack switches on when your facts say it applies. Any pack can be explored with a what if, even when nothing in your data triggers it.</p>';
  groups.forEach(([l, fn]) => {
    const list = ps.filter(fn);
    if (!list.length) return;
    b += '<section class="t-psec"><h3 class="t-psec-h">' + esc(l) + '<span>' + list.length + '</span></h3>' + list.map(p => {
      const on = p.status === 'active';
      const recs = A(p.recIds).map(id => api.rec(id)).filter(r => r && r.status !== 'hidden');
      return '<div class="t-packrow"><div class="t-packrow-h"><button type="button" class="t-prow-title" data-go="packs" data-p="' + esc(p.id) + '">' + T(p.name) + '</button>' +
        '<span class="t-muted">' + esc(p.entries) + ' entries</span></div>' +
        '<p class="t-packrow-why">' + T(p.why) + '</p>' +
        (A(p.covers).length ? '<p class="t-packrow-cov"><span class="t-k">Covers</span>' + A(p.covers).map(T).join(', ') + '</p>' : '') +
        '<p class="t-packrow-cov"><span class="t-k">Curator</span>' + T(p.curator) + ', updated ' + T(p.updated) + '</p>' +
        (on && recs.length ? '<div class="t-packrow-cov"><span class="t-k">Powers</span><div class="t-powers">' + recs.map(r => recLink(r.id)).join('') + '</div></div>' : '') +
        '<div class="t-inline-acts">' + (on
          ? '<button type="button" class="t-btn" data-go="packs" data-p="' + esc(p.id) + '">Open</button>'
          : '<button type="button" class="t-btn" data-act="whatif" data-pack="' + esc(p.id) + '">What if</button><button type="button" class="t-btn t-btn--ghost" data-act="packtoggle" data-pack="' + esc(p.id) + '">Turn on</button>') +
        '</div></div>';
    }).join('') + '</section>';
  });
  return { title: 'Knowledge packs', sub: ps.filter(p => p.status === 'active').length + ' on', body: b };
}

function yearendPanel() {
  const y = S().yearend || {};
  const docs = A(y.docs), dec = A(y.decisions);
  const have = docs.filter(d => d.status === 'have').length;
  const decided = dec.filter(d => d.done || (d.recId && api.rec(d.recId) && api.rec(d.recId).status === 'done')).length;
  let b = '<div class="t-ye-sum"><div><span class="t-k">Documents</span><strong>' + have + ' of ' + docs.length + '</strong>' + bar(docs.length ? have / docs.length : 0, 't-bar--sm') + '</div>' +
    '<div><span class="t-k">Decisions</span><strong>' + decided + ' of ' + dec.length + '</strong>' + bar(dec.length ? decided / dec.length : 0, 't-bar--sm') + '</div></div>';
  const order = { missing: 0, expected: 1, have: 2 };
  b += '<section class="t-psec"><h3 class="t-psec-h">Documents</h3><ul class="t-docs">' + docs.slice().sort((a, c) => order[a.status] - order[c.status]).map(d =>
    '<li><span class="t-doc-st is-' + esc(d.status) + '">' + esc(d.status) + '</span><div><div class="t-doc-t">' + T(d.t) + '</div><div class="t-doc-s">' + T(d.src) + (d.note ? '. ' + T(d.note) : '') + '</div></div></li>').join('') + '</ul></section>';
  b += '<section class="t-psec"><h3 class="t-psec-h">Decisions the accountant will ask about</h3><ul class="t-docs">' + dec.map(d => {
    const r = d.recId ? api.rec(d.recId) : null;
    const done = d.done || (r && r.status === 'done');
    return '<li><span class="t-doc-st is-' + (done ? 'have' : 'expected') + '">' + (done ? 'decided' : 'open') + '</span><div><div class="t-doc-t">' + (r && r.status !== 'hidden' ? recLink(r.id, T(d.t)) : T(d.t)) + '</div></div></li>';
  }).join('') + '</ul></section>';
  b += '<div class="t-inline-acts">' + (ui.exported
    ? '<span class="t-ok">' + ICON.check + 'Packet prepared. Missing items are flagged inside.</span>'
    : '<button type="button" class="t-btn t-btn--pri" data-act="export">Prepare packet for the accountant</button>') + '</div>';
  return { title: 'Year-end packet', sub: 'For your accountant', body: b };
}

function currentScopes() {
  const c = S().connect || {};
  if (!ui.scopes) ui.scopes = A(c.scopes).map(x => Object.assign({}, x));
  return ui.scopes;
}

function connectPanel() {
  const c = S().connect || {};
  const scopes = currentScopes();
  let b = '<p class="t-muted t-psec-p">Point your own assistant at Fathom over MCP. It gets the same read-only tools Fathom uses, limited to the scopes below.</p>';
  b += '<div class="t-url"><code>' + T(c.url) + '</code><button type="button" class="t-btn" data-act="copy">' + (ui.copied ? 'Copied' : 'Copy') + '</button></div>';
  b += '<section class="t-psec"><h3 class="t-psec-h">Scopes</h3><ul class="t-scopes">' + scopes.map((x, i) =>
    '<li><div><div>' + T(x.label) + '</div><div class="t-muted">' + esc(x.access) + '</div></div>' +
    '<button type="button" class="t-switch' + (x.on ? ' is-on' : '') + '" role="switch" aria-checked="' + !!x.on + '" data-act="scope" data-i="' + i + '" aria-label="' + esc(X(x.label)) + '"><span></span></button></li>').join('') + '</ul></section>';
  b += '<section class="t-psec"><h3 class="t-psec-h">Tools</h3><dl class="t-dl2 t-dl2--mono">' + A(c.tools).map(x => '<dt>' + T(x.name) + '</dt><dd>' + T(x.desc) + '</dd>').join('') + '</dl></section>';
  if (A(c.transcript).length) {
    b += '<section class="t-psec"><h3 class="t-psec-h">What it looks like</h3><div class="t-transcript">' + A(c.transcript).map(m =>
      '<div class="t-tr t-tr--' + esc(m.role) + '"><span class="t-tr-r">' + esc(m.role === 'claude' ? 'assistant' : m.role === 'me' ? 'you' : 'tool') + '</span><div>' + T(m.text) + '</div></div>').join('') + '</div></section>';
  }
  if (c.config) b += '<section class="t-psec"><h3 class="t-psec-h">Config</h3><pre class="t-pre">' + T(c.config) + '</pre></section>';
  return { title: 'Your own AI', sub: 'MCP, read-only by default', body: b };
}

function enginePanel() {
  const e = S().engine || {};
  const on = api.engineOn();
  const bud = e.budget || {};
  let b = '<div class="t-eng-state"><span class="t-dom-dot is-' + (on ? 'covered' : 'needs') + '"></span><div><strong>' + (on ? 'Engine on' : 'Engine off') + '</strong>' +
    '<div class="t-muted">' + (on ? 'Proactive jobs run on schedule. Chat answers live.' : 'Proactive jobs paused. Chat answers paused.') + '</div></div><button type="button" class="t-btn" data-fx-engine>' + (on ? 'Turn off' : 'Turn on') + '</button></div>';
  b += '<section class="t-psec"><h3 class="t-psec-h">Monthly budget</h3><div class="t-budget"><strong>' + esc(M(bud.used, {})) + '</strong><span class="t-muted"> of ' + esc(M(bud.monthly)) + '</span></div>' +
    bar(bud.monthly ? bud.used / bud.monthly : 0) + '</section>';
  b += '<section class="t-psec"><h3 class="t-psec-h">Jobs</h3><ul class="t-jobs">' + A(e.jobs).map(j =>
    '<li class="' + (on ? '' : 'is-paused') + '"><div class="t-job-h"><span class="t-job-n">' + T(j.name) + '</span><span class="t-job-c">' + esc(fmtCost(j.cost)) + '</span></div>' +
    '<div class="t-job-d">' + T(j.does) + '</div><div class="t-job-m"><span>' + T(j.cadence) + '</span><span>Last ' + T(j.last) + '</span><span>' + (on ? 'Next ' + T(j.next) : 'Paused') + '</span></div></li>').join('') + '</ul></section>';
  if (e.chat) b += '<section class="t-psec"><h3 class="t-psec-h">Chat</h3><p><strong>' + T(e.chat.model) + '</strong></p><p class="t-muted">' + T(e.chat.note) + '</p></section>';
  return { title: 'Engine', sub: on ? 'On' : 'Off', body: b };
}

function fmtCost(n) {
  const v = Number(n) || 0;
  if (v > 0 && v < 1) return '$' + v.toFixed(2) + ' a run';
  return M(v) + ' a run';
}

function emailPanel() {
  const e = S().email || {};
  const b = '<div class="t-email"><div class="t-email-hd"><div><span class="t-k">From</span>Fathom</div><div><span class="t-k">Subject</span><strong>' + T(e.subject) + '</strong></div>' +
    '<div class="t-muted">' + T(e.preheader) + '</div></div><div class="t-email-bd"><p>' + T(e.greeting) + '</p>' +
    A(e.sections).map(sc => '<h4>' + T(sc.heading) + '</h4><ul>' + A(sc.items).map(i => '<li>' + T(i) + '</li>').join('') + '</ul>').join('') +
    '<p class="t-muted">' + T(e.footer) + '</p></div></div>' +
    '<div class="t-inline-acts"><button type="button" class="t-btn" data-go="brief">Open the brief in the thread</button></div>';
  return { title: 'Monthly email', sub: 'Preview', body: b };
}

const PANELS = { plan: planPanel, goals: goalsPanel, accounts: accountsPanel, packs: packsPanel, yearend: yearendPanel, connect: connectPanel, engine: enginePanel, email: emailPanel };

// ------------------------------------------------------------------ onboarding

const STEP_LABELS = ['Sign in', 'Tell me everything', 'Connect accounts', 'What I heard', 'Priorities', 'First brief'];

function onboarding(step) {
  const o = S().onboarding || {};
  const done = n => step > n;
  let h = '';
  // Step 0: welcome.
  h += message('fathom', '<h1 class="t-verdict-h">' + T(o.welcome && o.welcome.headline) + '</h1><p>' + T(o.welcome && o.welcome.sub) + '</p>', {
    extra: step === 0 ? '<div class="t-card t-signin"><div class="t-signin-h">Sign in to ' + T(S().meta && S().meta.household) + '</div>' +
      '<button type="button" class="t-btn t-btn--pri t-btn--wide" data-act="onb" data-step="1">Continue with passkey</button>' +
      '<button type="button" class="t-btn t-btn--ghost t-btn--wide" data-act="onb" data-step="1">Email me a sign-in link</button>' +
      '<p class="t-muted">Private to your household. Your advisor sees it only after you invite them.</p></div>' : '',
  });
  if (done(0)) h += message('me', 'Signed in with a passkey.');
  if (step >= 1) {
    h += message('fathom', '<p>Tell me everything. Paste notes, attach last year\'s return, ramble about what you want. I will sort it out and ask about anything I am unsure of.</p>');
    const files = A(o.files).map(f => '<li><span class="t-file-n">' + T(f.name) + '</span><span class="t-muted">' + T(f.status) + '</span></li>').join('');
    if (step === 1) {
      h += '<div class="t-card t-dump"><textarea rows="8" aria-label="Everything about your finances">' + esc(X(o.dump)) + '</textarea>' +
        (files ? '<ul class="t-files">' + files + '</ul>' : '') +
        '<div class="t-inline-acts"><button type="button" class="t-btn t-btn--pri" data-act="onb" data-step="2">Send</button></div></div>';
    } else {
      const full = X(o.dump);
      const long = full.length > 260;
      h += message('me', esc(ui.dumpOpen || !long ? full : full.slice(0, 260) + '...') +
        (long ? ' <button type="button" class="t-link" data-act="dump">' + (ui.dumpOpen ? 'Less' : 'More') + '</button>' : ''), {
        extra: files ? '<ul class="t-files t-files--me">' + files + '</ul>' : '',
      });
    }
  }
  if (step >= 2) {
    const inst = A(o.institutions);
    h += message('fathom', '<p>Now connect your accounts. Read-only: I can see balances and transactions, never move money.</p>', {
      extra: step === 2 ? '<div class="t-card"><ul class="t-rows">' + inst.map(i => '<li><span>' + T(i.inst) + '<span class="t-sub">' + plural(Number(i.accounts) || 0, 'account') + '</span></span>' +
        '<span class="' + (ui.connected ? 't-ok' : 't-muted') + '">' + (ui.connected ? ICON.check + 'Connected, ' : '') + esc(i.mode) + '</span></li>').join('') + '</ul>' +
        '<div class="t-inline-acts">' + (ui.connected
          ? '<button type="button" class="t-btn t-btn--pri" data-act="onb" data-step="3">Continue</button>'
          : '<button type="button" class="t-btn t-btn--pri" data-act="modal" data-m="connect">Connect ' + plural(inst.length, 'institution') + '</button>') + '</div></div>' : '',
    });
    if (done(2)) h += message('me', 'Connected ' + plural(inst.length, 'institution') + ', read-only.');
  }
  if (step >= 3) {
    const hd = o.heard || {};
    const sec = (l, list) => A(list).length ? '<div class="t-heard-s"><div class="t-k">' + esc(l) + '</div><ul>' + A(list).map(x => '<li>' + T(x) + '</li>').join('') + '</ul></div>' : '';
    h += message('fathom', '<p>Here is what I heard. Correct anything that is off.</p>', {
      extra: '<div class="t-card t-heard">' + sec('People', hd.people) + sec('Entities', hd.entities) + sec('Income', hd.income) + sec('Life events', hd.lifeEvents) +
        '<div class="t-heard-s"><div class="t-k">Deadlines</div><p>' + plural(Number(hd.deadlines) || 0, 'deadline') + ' on your calendar for the next twelve months.</p></div>' +
        sec('I still need to ask', hd.questions) +
        (step === 3 ? '<div class="t-inline-acts"><button type="button" class="t-btn t-btn--pri" data-act="onb" data-step="4">That is right</button></div>' : '') + '</div>',
    });
    if (done(3)) h += message('me', 'That is right.');
  }
  if (step >= 4) {
    const pr = A(o.priorities);
    h += message('fathom', '<p>Most choices here are tradeoffs. Tell me where you lean and I will pick from the frontier accordingly. You can change this any time.</p>', {
      extra: step === 4 ? '<div class="t-card">' + pr.map(p => {
        const v = ui.sliders['p:' + p.id] != null ? ui.sliders['p:' + p.id] : Math.round(p.value <= 1 ? p.value * 100 : p.value);
        const parts = X(p.label).split(/\s+vs\.?\s+/i);
        return '<div class="t-curve"><div class="t-curve-ends"><span>' + esc(parts[0] || '') + '</span><span>' + esc(parts[1] || '') + '</span></div>' +
          '<input type="range" min="0" max="100" value="' + v + '" data-slider="p:' + esc(p.id) + '" aria-label="' + esc(X(p.label)) + '"></div>';
      }).join('') + '<div class="t-inline-acts"><button type="button" class="t-btn t-btn--pri" data-act="onb" data-step="5">Build my first brief</button></div></div>' : '',
    });
    if (done(4)) h += message('me', 'Priorities set.');
  }
  if (step >= 5) {
    const tasks = ['Reading statements and returns', 'Mapping the year\'s deadlines', 'Matching knowledge packs', 'Checking each deadline against your cash', 'Writing your first brief'];
    if (ui.buildFor !== 5) { ui.buildFor = 5; ui.build = 0; startBuild(tasks.length); }
    const fin = ui.build >= tasks.length;
    h += message('fathom', '<p>' + (fin ? 'Your first brief is ready.' : 'Working on your first brief.') + '</p>', {
      extra: '<div class="t-card t-build">' + bar(ui.build / tasks.length, 't-bar--sm') + '<ul>' + tasks.map((tk, i) =>
        '<li class="' + (i < ui.build ? 'is-done' : i === ui.build ? 'is-run' : '') + '"><span class="t-box">' + (i < ui.build ? ICON.check : '') + '</span>' + esc(tk) + '</li>').join('') + '</ul>' +
        '<div class="t-inline-acts"><button type="button" class="t-btn t-btn--pri" data-act="onb" data-step="6"' + (fin ? '' : ' disabled') + '>Open my brief</button></div></div>',
    });
  } else { ui.buildFor = -1; }

  const steps = '<ol class="t-steps" aria-label="Setup progress">' + STEP_LABELS.map((l, i) =>
    '<li class="' + (i < step ? 'is-done' : i === step ? 'is-on' : '') + '"><button type="button" data-act="onb" data-step="' + i + '"' + (i > step ? ' disabled' : '') + '>' + esc(l) + '</button></li>').join('') + '</ol>';
  return { key: 'onb', count: step, head: '', body: steps + h, scrollEnd: step > 0 };
}

function startBuild(n) {
  const tick = () => {
    if (ui.build >= n) return;
    ui.build += 1;
    render();
    if (ui.build < n) timers.push(setTimeout(tick, 650));
  };
  timers.push(setTimeout(tick, 500));
}

// ------------------------------------------------------------------ shell

function topbar(onb) {
  const v = onb ? null : api.verdict();
  return '<header class="t-top"><button type="button" class="t-brand" data-go="brief" aria-label="Fathom home">' + mark(22) + '<span>Fathom</span></button>' +
    (v ? '<button type="button" class="t-pulse is-' + v.level + '" data-go="brief"><span class="t-pulse-dot"></span>' +
      (v.level === 'clear' ? 'Covered' : plural(v.count, 'thing') + ' need you') + '</button>' : '<span></span>') +
    (onb ? '<span></span>' : '<div class="t-top-r"><button type="button" class="t-textbtn" data-go="plan">Plan</button>' +
      '<button type="button" class="t-iconbtn" data-act="menu" aria-label="Open the drawer">' + ICON.menu + '</button></div>') + '</header>';
}

function composer(view) {
  if (!view.placeholder) return '';
  const engOff = !api.engineOn();
  return '<div class="t-compose"><div class="t-compose-in">' +
    (view.follow ? '<div class="t-follows">' + view.follow + '</div>' : '') +
    (engOff ? '<div class="t-engoff">Engine off. Answers are paused until it is back on.</div>' : '') +
    '<form class="t-form" data-conv="' + esc(view.conv || '') + '"><input type="text" name="q" autocomplete="off" placeholder="' + esc(view.placeholder) + '" value="' + esc(ui.draft) + '" aria-label="Message Fathom">' +
    '<button type="submit" class="t-send" aria-label="Send">' + ICON.send + '</button></form></div></div>';
}

function drawer(route) {
  const open = isDrawer(route) || ui.menu;
  if (!open) return '';
  let panel;
  if (isDrawer(route) && !ui.menu) panel = (PANELS[route.name] || drawerIndex)();
  else panel = drawerIndex();
  const isIndex = !isDrawer(route) || ui.menu;
  return '<div class="t-scrim" data-act="close"></div><aside class="t-drawer" role="dialog" aria-label="' + esc(panel.title) + '">' +
    '<div class="t-drawer-h">' + (isIndex ? '<span></span>' : '<button type="button" class="t-iconbtn" data-act="menu" aria-label="All sections">' + ICON.back + '</button>') +
    '<div class="t-drawer-t"><div>' + esc(panel.title) + '</div>' + (panel.sub ? '<div class="t-muted">' + esc(panel.sub) + '</div>' : '') + '</div>' +
    '<button type="button" class="t-iconbtn" data-act="close" aria-label="Close">' + ICON.close + '</button></div>' +
    '<div class="t-drawer-b">' + panel.body + '</div></aside>';
}

function modal() {
  if (ui.modal !== 'connect') return '';
  const inst = A(S().onboarding && S().onboarding.institutions);
  return '<div class="t-scrim t-scrim--modal" data-act="modal-x"></div><div class="t-modal" role="dialog" aria-modal="true" aria-label="Connect read-only">' +
    '<div class="t-modal-ic">' + ICON.lock + '</div><h2>Read-only access</h2>' +
    '<p>Fathom will see balances and transactions at ' + inst.map(i => T(i.inst)).join(', ') + '.</p>' +
    '<ul class="t-ul"><li>It cannot move money, pay bills or trade.</li><li>It cannot delete or change anything at your bank.</li><li>You can disconnect any account at any time.</li></ul>' +
    '<div class="t-inline-acts"><button type="button" class="t-btn t-btn--pri" data-act="modal-ok">Allow read-only</button><button type="button" class="t-btn t-btn--ghost" data-act="modal-x">Cancel</button></div></div>';
}

function threadFor(r) {
  switch (r.name) {
    case 'rec': return recThread(firstParam(r));
    case 'wargame': return wargameThread(firstParam(r));
    case 'advisor': return advisorThread();
    case 'packs': return packThread(firstParam(r));
    default: return briefThread(r);
  }
}

function render() {
  if (!root || !api) return;
  const route = api.route || { name: 'brief', params: {} };
  syncBriefSet();
  const onb = route.name === 'onboarding' || api.demo() === 'fresh';
  let view, drawerHtml = '';
  if (onb) {
    view = onboarding(Number(firstParam(route)) || 0);
    ui.menu = false;
  } else {
    if (!isDrawer(route)) ui.lastThread = route;
    view = threadFor(isDrawer(route) ? ui.lastThread : route);
    drawerHtml = drawer(route);
  }
  // Capture scroll and focus before replacing the DOM.
  const sc = root.querySelector('.t-scroll');
  const prevTop = sc ? sc.scrollTop : 0;
  const ds = root.querySelector('.t-drawer-b');
  const prevDrawerTop = ds ? ds.scrollTop : 0;
  const active = document.activeElement;
  const hadFocus = active && root.contains(active) && active.name === 'q';
  const sameView = view.key === ui.viewKey;
  const grew = sameView && view.count > ui.count;
  const dKey = drawerHtml ? route.name + (ui.menu ? ':i' : '') : '';
  const sameDrawer = dKey === ui.drawerKey;

  root.innerHTML = '<div class="t-shell' + (drawerHtml ? ' has-drawer' : '') + '">' + topbar(onb) +
    '<main class="t-scroll"><div class="t-col">' + (view.head || '') + '<div class="t-thread">' + view.body + '</div></div></main>' +
    composer(view) + drawerHtml + modal() + '</div>';

  const nsc = root.querySelector('.t-scroll');
  if (nsc) {
    if (sameView && !grew) nsc.scrollTop = prevTop;
    else if (grew || (!sameView && (route.name === 'ask' || view.scrollEnd))) {
      nsc.scrollTop = sameView ? prevTop : 0;
      requestAnimationFrame(() => {
        const last = nsc.querySelector('.t-thread > .t-msg:last-of-type');
        if (grew && last) last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        else nsc.scrollTop = nsc.scrollHeight;
      });
    } else nsc.scrollTop = 0;
  }
  const nds = root.querySelector('.t-drawer-b');
  if (nds && sameDrawer) nds.scrollTop = prevDrawerTop;
  ui.viewKey = view.key;
  ui.count = view.count;
  ui.drawerKey = dKey;
  const input = root.querySelector('.t-form input');
  if (input && (hadFocus || (route.name === 'ask' && !sameView))) {
    input.focus({ preventScroll: true });
    const n = input.value.length;
    try { input.setSelectionRange(n, n); } catch (e) { /* ignore */ }
  }
}

// ------------------------------------------------------------------ events

function onClick(e) {
  const el = e.target.closest('[data-go],[data-act]');
  if (!el || !root.contains(el)) return;
  if (el.hasAttribute('disabled')) return;
  if (el.hasAttribute('data-go')) {
    const name = el.getAttribute('data-go');
    const p = el.getAttribute('data-p') || '';
    ui.menu = false;
    const r = api.route || {};
    if (r.name === name && String(firstParam(r)) === p) { render(); return; }
    api.go(name, p ? p : undefined);
    return;
  }
  const a = el.getAttribute('data-act');
  const rec = el.getAttribute('data-rec');
  switch (a) {
    case 'rec': api.act(rec, el.getAttribute('data-a'), el.getAttribute('data-arg') || undefined); break;
    case 'task': api.act(rec, 'task', Number(el.getAttribute('data-i'))); break;
    case 'ask': api.ask(el.getAttribute('data-q'), 'ask'); if (api.route.name !== 'ask') api.go('ask'); break;
    case 'askrec': api.ask(Number(el.getAttribute('data-i')), rec); break;
    case 'whatif': {
      const id = el.getAttribute('data-pack');
      ui.menu = false;
      api.whatIf(id);
      api.go('packs', id);
      break;
    }
    case 'packtoggle': api.packToggle(el.getAttribute('data-pack')); break;
    case 'pick': api.scenarioPick(el.getAttribute('data-name'), Number(el.getAttribute('data-i'))); break;
    case 'menu': ui.menu = true; render(); break;
    case 'close': closeDrawer(); break;
    case 'onb': {
      const n = Number(el.getAttribute('data-step'));
      if (n === 2) ui.connected = false;
      api.onboard(n);
      break;
    }
    case 'modal': ui.modal = el.getAttribute('data-m'); render(); break;
    case 'modal-x': ui.modal = null; render(); break;
    case 'modal-ok': ui.modal = null; ui.connected = true; render(); break;
    case 'dump': ui.dumpOpen = !ui.dumpOpen; render(); break;
    case 'copy': ui.copied = true; try { navigator.clipboard && navigator.clipboard.writeText(X(S().connect && S().connect.url)).catch(() => {}); } catch (err) { /* ignore */ } render(); break;
    case 'scope': { const s = currentScopes()[Number(el.getAttribute('data-i'))]; if (s) s.on = !s.on; render(); break; }
    case 'export': ui.exported = true; render(); break;
    default: break;
  }
}

function closeDrawer() {
  ui.menu = false;
  if (isDrawer(api.route)) {
    const r = ui.lastThread || { name: 'brief' };
    api.go(r.name, firstParam(r) || undefined);
  } else render();
}

function onSubmit(e) {
  const form = e.target.closest('.t-form');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('input');
  const text = (input.value || '').trim();
  if (!text) return;
  ui.draft = '';
  const route = api.route || {};
  if (route.name === 'rec') api.askFree(text, firstParam(route));
  else if (route.name === 'packs' && firstParam(route)) api.askFree(text, 'pack:' + firstParam(route));
  else {
    api.askFree(text, 'ask');
    if (route.name !== 'ask') api.go('ask');
  }
}

function onInput(e) {
  const t = e.target;
  if (t.name === 'q') { ui.draft = t.value; return; }
  const k = t.getAttribute && t.getAttribute('data-slider');
  if (k) ui.sliders[k] = Number(t.value);
}

function onKey(e) {
  if (e.key === 'Escape') {
    if (ui.modal) { ui.modal = null; render(); return; }
    if (ui.menu || isDrawer(api.route)) closeDrawer();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('g[data-act="pick"]')) {
    e.preventDefault();
    e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
}

function onResize() {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (api && api.route && api.route.name === 'wargame') render(); }, 150);
}

window.Fathom.registerDesign({
  id: ID,
  name: 'Thread',
  blurb: 'Conversation first. The monthly brief, recommendations and what-ifs arrive in one thread; data and settings live in a drawer.',
  mount(el, a) {
    root = el;
    api = a;
    ui.briefSet = null;
    ui.prevMainLen = null;
    ui.viewKey = '';
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('input', onInput);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    unsub = api.on(() => render());
    render();
  },
  unmount() {
    if (unsub) unsub();
    unsub = null;
    timers.forEach(clearTimeout);
    timers = [];
    if (root) {
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('input', onInput);
    }
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    root = null;
  },
});

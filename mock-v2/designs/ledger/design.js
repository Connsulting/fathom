// Ledger: editorial and calm. The brief reads like a short monthly letter.
//
// Contract readings (simplest choice, noted per the contract):
// 1. Domain status on the brief is live: a domain with a needs-you rec reads "Needs you"; a
//    scenario "needs" domain whose recs are all handled reads "Covered".
// 2. Rec follow-ups call api.ask(index, recId); core resolves the index into rec.qa.
// 3. Purely presentational state (connect scope toggles, onboarding connections, slider positions,
//    open menus) lives in this module; everything else goes through api.
// 4. Recs with status 'hidden' are never listed.

const ID = 'ledger';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const NAV = [
  ['brief', 'Brief'], ['plan', 'Plan'], ['ask', 'Ask'], ['wargame', 'War game'],
  ['goals', 'Goals'], ['accounts', 'Accounts'], ['advisor', 'Advisor'], ['packs', 'Packs'], ['yearend', 'Year end'],
];
const MORE = [['connect', 'Connect your AI'], ['engine', 'Engine'], ['email', 'Monthly email']];

const STATUS = {
  proposed: 'New', doing: 'Doing it', waiting: 'Waiting',
  snoozed: 'Snoozed', done: 'Done', dismissed: 'Dismissed',
};
const TRIGGER = { calendar: 'Deadline', income: 'Income change', life: 'Life event', goal: 'Goal', advisor: 'Advisor' };
const VALUE = { tax: 'Tax', timing: 'Timing', retire: 'Retirement', risk: 'Risk', cash: 'Cash', goal: 'Goal' };
const DOMAIN = { covered: 'Covered', changed: 'Changed', needs: 'Needs you', waiting: 'Waiting' };
const ADVISOR = { confirmed: 'Advisor confirmed', pending: 'Awaiting advisor', vetoed: 'Advisor vetoed' };
const KIND = { a: 'Actual, from a mirrored account', p: 'Projected from the plan', e: 'Estimate', m: 'Model output' };
const ACCT_KIND = {
  business: 'Business', checking: 'Checking', cash: 'Cash', taxable: 'Taxable investing',
  retirement: 'Retirement', roth: 'Roth', hsa: 'Health savings', '529': 'Education',
};
const ACCT_ORDER = ['business', 'checking', 'cash', 'taxable', 'retirement', 'roth', 'hsa', '529'];
const HORIZON = [['now', 'Now'], ['1-3y', 'One to three years'], ['3-10y', 'Three to ten years']];

let api = null;
let root = null;
let unsub = null;
let pending = false;
let lastKey = '';
let timers = [];
let onResize = null;
let onDocClick = null;
let ownPop = null;

const ui = {
  menu: false, more: false, modal: null, connected: {}, sliders: {}, scopes: {},
  copied: false, building: 0, buildTimer: null, picks: {},
};

// ---------- helpers ----------

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function T(s) { return s == null ? '' : api.t(String(s)); }
function X(s) { return s == null ? '' : esc(api.txt(String(s))); }
function arr(a) { return Array.isArray(a) ? a : []; }
function money(n, o) { return n == null || Number.isNaN(+n) ? '' : esc(api.money(+n, o)); }
function S() { return api.s || {}; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
function clock() { return parseISO(S().meta?.clock) || new Date(Date.UTC(2026, 10, 5)); }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function yearLen(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365; }
function dayOfYear(d) { return daysBetween(new Date(Date.UTC(d.getUTCFullYear(), 0, 1)), d); }
function nextBrief() {
  const d = clock();
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(d.getUTCDate(), 28)));
  return `${MON[n.getUTCMonth()]} ${n.getUTCDate()}`;
}

function recs() { return arr(api.recs()).filter((r) => r && r.status !== 'hidden'); }
function liveRec(id) { const r = id ? api.rec(id) : null; return r && r.status !== 'hidden' ? r : null; }
function needs() { return arr(api.needsYou()).filter((r) => r && r.status !== 'hidden'); }
function packs() { return typeof api.packs === 'function' ? arr(api.packs()) : arr(S().packs); }
function packById(id) {
  if (!id) return null;
  if (typeof api.pack === 'function') return api.pack(id) || null;
  return packs().find((p) => p.id === id) || null;
}

function statusText(r) {
  if (!r) return '';
  if (r.status === 'waiting') return `Waiting on ${r.waitingOn === 'advisor' ? 'your advisor' : r.waitingOn || 'others'}`;
  if (r.status === 'snoozed') return r.wake ? `Snoozed until ${X(r.wake)}` : 'Snoozed';
  return STATUS[r.status] || esc(r.status);
}
function daysText(r) {
  const d = r?.window?.days;
  if (d == null) return '';
  if (d < 0) return `${-d} days past`;
  if (d === 0) return 'Today';
  return plural(d, 'day');
}

function go(name, id, label, cls) {
  return `<a href="#/${name}${id != null ? '/' + encodeURIComponent(id) : ''}" class="${cls || ''}" data-go="${name}"${id != null ? ` data-id="${esc(id)}"` : ''}>${label}</a>`;
}
function btn(act, label, extra, cls) {
  return `<button type="button" class="lg-btn ${cls || ''}" data-act="${act}" ${extra || ''}>${label}</button>`;
}

function recActions(r, compact) {
  const id = `data-id="${esc(r.id)}"`;
  const b = (a, l, primary) => btn(a, l, id, primary ? 'lg-btn-primary' : '');
  const out = [];
  switch (r.status) {
    case 'proposed': out.push(b('start', 'Doing it', 1), b('complete', 'Done'), b('snooze', 'Later'), b('dismiss', 'Not for us')); break;
    case 'doing': out.push(b('complete', 'Done', 1), b('snooze', 'Later'), b('dismiss', 'Not for us')); break;
    case 'waiting': out.push(b('complete', 'Mark done')); break;
    case 'snoozed': out.push(b('reopen', 'Wake now'), b('complete', 'Mark done')); break;
    case 'done': case 'dismissed': out.push(b('reopen', 'Reopen')); break;
    default: break;
  }
  return `<div class="lg-acts">${out.join('')}</div>`;
}

function askRec(recId, i) {
  return api.ask(i, recId);
}

function convo(entries, opts = {}) {
  const list = arr(entries);
  if (!list.length) return opts.empty ? `<p class="lg-quiet">${opts.empty}</p>` : '';
  const adv = S().advisor?.name;
  return `<ol class="lg-convo">${list.map((m) => {
    const who = m.role === 'me' ? 'You' : m.role === 'advisor' ? (adv ? X(adv) : 'Advisor') : 'Fathom';
    const refs = arr(m.refs).filter((id) => id !== opts.self).map((id) => liveRec(id)).filter(Boolean);
    return `<li class="lg-msg lg-msg-${esc(m.role)}">
      <p class="lg-who">${who}${m.ts ? ` <span class="lg-ts">${X(m.ts)}</span>` : ''}</p>
      <div class="lg-said">${m.html || ''}</div>
      ${refs.length ? `<p class="lg-refs">See ${refs.map((r) => go('rec', r.id, T(r.title))).join(', ')}</p>` : ''}
    </li>`;
  }).join('')}</ol>`;
}

function bar(frac, cls) {
  const f = Math.max(0, Math.min(1, +frac || 0));
  return `<svg class="lg-bar ${cls || ''}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
    <rect class="lg-bar-track" x="0" y="0" width="100" height="4"/>
    <rect class="lg-bar-fill" x="0" y="0" width="${(f * 100).toFixed(2)}" height="4"/></svg>`;
}

function contentWidth() {
  const w = root?.clientWidth || window.innerWidth || 1024;
  return Math.max(280, Math.min(680, w - 40));
}

// ---------- charts ----------

function yearClock() {
  const d = clock();
  const Y = d.getUTCFullYear();
  const len = yearLen(Y);
  const today = dayOfYear(d) / len;
  const size = 300, c = 150, R = 106;
  const ang = (t) => t * 2 * Math.PI - Math.PI / 2;
  const pt = (t, r) => [c + r * Math.cos(ang(t)), c + r * Math.sin(ang(t))];
  const f = (n) => n.toFixed(2);
  const arc = (t0, t1, r) => {
    const [x0, y0] = pt(t0, r), [x1, y1] = pt(t1, r);
    return `M${f(x0)} ${f(y0)} A${r} ${r} 0 ${t1 - t0 > 0.5 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
  };
  const needIds = new Set(needs().map((r) => r.id));
  let g = `<circle class="lg-yc-ring" cx="${c}" cy="${c}" r="${R}"/>`;
  g += `<path class="lg-yc-past" d="${arc(0, Math.max(0.001, today), R)}"/>`;
  for (let m = 0; m < 12; m++) {
    const t = dayOfYear(new Date(Date.UTC(Y, m, 1))) / len;
    const [a1, b1] = pt(t, R - 4), [a2, b2] = pt(t, R + 4);
    g += `<line class="lg-yc-tick" x1="${f(a1)}" y1="${f(b1)}" x2="${f(a2)}" y2="${f(b2)}"/>`;
    const [lx, ly] = pt(dayOfYear(new Date(Date.UTC(Y, m, 15))) / len, R + 22);
    g += `<text class="lg-yc-mon${m === d.getUTCMonth() ? ' is-now' : ''}" x="${f(lx)}" y="${f(ly)}" text-anchor="middle" dominant-baseline="central">${MON[m]}</text>`;
  }
  for (const dl of arr(S().deadlines)) {
    const dd = parseISO(dl.date);
    if (!dd) continue;
    const ny = dd.getUTCFullYear() > Y;
    const past = !ny && dd < d;
    const [x, y] = pt(dayOfYear(dd) / yearLen(dd.getUTCFullYear()), ny ? R - 16 : R);
    const hot = dl.recId && needIds.has(dl.recId);
    const cls = ['lg-yc-dl', dl.hard ? 'is-hard' : 'is-soft', past ? 'is-past' : '', ny ? 'is-next' : '', hot ? 'is-hot' : ''].join(' ');
    g += `<circle class="${cls}" cx="${f(x)}" cy="${f(y)}" r="${dl.hard ? 4 : 3.5}"><title>${X(dl.label)}: ${X(dl.title)}</title></circle>`;
  }
  const [h0x, h0y] = pt(today, R - 30), [h1x, h1y] = pt(today, R + 9);
  g += `<line class="lg-yc-hand" x1="${f(h0x)}" y1="${f(h0y)}" x2="${f(h1x)}" y2="${f(h1y)}"/>`;
  const [tx, ty] = pt(today, R);
  g += `<circle class="lg-yc-today" cx="${f(tx)}" cy="${f(ty)}" r="4.5"/>`;
  const left = len - dayOfYear(d);
  g += `<text class="lg-yc-big" x="${c}" y="${c - 4}" text-anchor="middle">${left}</text>`;
  g += `<text class="lg-yc-small" x="${c}" y="${c + 20}" text-anchor="middle">days left in ${Y}</text>`;
  return `<svg class="lg-yc" viewBox="0 0 ${size} ${size}" role="img" aria-label="The year ${Y}, today marked, with deadlines">${g}</svg>`;
}

function spark(series, w = 200, h = 40) {
  const pts = arr(series?.points);
  if (pts.length < 2) return '';
  const vs = pts.map((p) => +p.v || 0);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi === lo) { hi += 1; lo -= 1; }
  const px = (i) => 2 + (i * (w - 4)) / (pts.length - 1);
  const py = (v) => 3 + (h - 6) * (1 - (v - lo) / (hi - lo));
  const lastA = pts.reduce((k, p, i) => (p.kind === 'p' ? k : i), -1);
  const seg = (a, b) => pts.slice(a, b + 1).map((p, j) => `${j ? 'L' : 'M'}${px(a + j).toFixed(1)} ${py(+p.v).toFixed(1)}`).join(' ');
  let g = '';
  if (lastA > 0) g += `<path class="lg-sp-a" d="${seg(0, lastA)}"/>`;
  if (lastA < pts.length - 1) g += `<path class="lg-sp-p" d="${seg(Math.max(0, lastA), pts.length - 1)}"/>`;
  if (lastA >= 0) g += `<circle class="lg-sp-dot" cx="${px(lastA).toFixed(1)}" cy="${py(+pts[lastA].v).toFixed(1)}" r="2.5"/>`;
  return `<svg class="lg-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${g}</svg>`;
}

function ticks(lo, hi, n) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function salaryChart(wg, sel) {
  const pts = arr(wg.points);
  if (!pts.length) return '';
  const W = contentWidth(), H = W < 480 ? 280 : 340;
  const m = { l: W < 480 ? 50 : 64, r: 16, t: 18, b: 46 };
  const xs = pts.map((p) => +p.x), ys = pts.map((p) => +p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0);
  const px = (x1 - x0) * 0.08 || 1, py = (y1 - y0) * 0.1 || 1;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const X_ = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y_ = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const k = { k: true };
  let g = '';
  for (const t of ticks(y0, y1, W < 480 ? 4 : 6)) {
    g += `<line class="lg-ax-grid${t === 0 ? ' is-zero' : ''}" x1="${m.l}" x2="${W - m.r}" y1="${Y_(t).toFixed(1)}" y2="${Y_(t).toFixed(1)}"/>`;
    g += `<text class="lg-ax-t" x="${m.l - 8}" y="${Y_(t).toFixed(1)}" text-anchor="end" dominant-baseline="central">${money(t, { k: true, sign: t !== 0 })}</text>`;
  }
  for (const t of ticks(x0, x1, W < 480 ? 3 : 5)) {
    g += `<text class="lg-ax-t" x="${X_(t).toFixed(1)}" y="${H - m.b + 18}" text-anchor="middle">${money(t, k)}</text>`;
  }
  g += `<line class="lg-ax-base" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  g += `<text class="lg-ax-l" x="${W - m.r}" y="${H - 6}" text-anchor="end">${X(wg.xLabel)}</text>`;
  g += `<text class="lg-ax-l" x="${m.l}" y="${m.t - 6}" text-anchor="start">${X(wg.yLabel)}</text>`;
  const fr = pts.map((p, i) => ({ p, i })).filter((o) => o.p.frontier).sort((a, b) => a.p.x - b.p.x);
  if (fr.length > 1) g += `<path class="lg-frontier" d="${fr.map((o, j) => `${j ? 'L' : 'M'}${X_(o.p.x).toFixed(1)} ${Y_(o.p.y).toFixed(1)}`).join(' ')}"/>`;
  pts.forEach((p, i) => {
    const cx = X_(p.x).toFixed(1), cy = Y_(p.y).toFixed(1);
    const cls = ['lg-pt', p.frontier ? 'is-front' : 'is-off', p.current ? 'is-cur' : '', i === sel ? 'is-sel' : ''].join(' ');
    g += `<g class="${cls}" data-act="pick" data-name="salary" data-i="${i}" tabindex="0" role="button" aria-label="${X(p.label)}">
      <circle class="lg-hit" cx="${cx}" cy="${cy}" r="16"/>
      ${p.current ? `<circle class="lg-pt-ring" cx="${cx}" cy="${cy}" r="10"/>` : ''}
      <circle class="lg-pt-dot" cx="${cx}" cy="${cy}" r="${i === sel ? 6.5 : 5}"/></g>`;
  });
  const lab = (i, txt, cls) => {
    const p = pts[i]; if (!p) return '';
    const cx = X_(p.x), right = cx > W * 0.6;
    return `<text class="lg-pt-lab ${cls}" x="${(cx + (right ? -14 : 14)).toFixed(1)}" y="${(Y_(p.y) - 12).toFixed(1)}" text-anchor="${right ? 'end' : 'start'}">${txt}</text>`;
  };
  const cur = pts.findIndex((p) => p.current);
  if (cur >= 0 && cur !== sel) g += lab(cur, 'Today', 'is-cur');
  if (sel != null && pts[sel]) g += lab(sel, X(pts[sel].label), 'is-sel');
  return `<svg class="lg-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${X(wg.title)}">${g}</svg>`;
}

function cashBar(opt, scale, W) {
  const H = 30, f = (v) => Math.max(0, (v / scale) * (W - 2));
  const short = +opt.decCash < +opt.need;
  return `<svg class="lg-cash${short ? ' is-short' : ''}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <rect class="lg-cash-track" x="0" y="11" width="${W}" height="8"/>
    <rect class="lg-cash-fill" x="0" y="11" width="${f(+opt.decCash).toFixed(1)}" height="8"/>
    <line class="lg-cash-need" x1="${f(+opt.need).toFixed(1)}" x2="${f(+opt.need).toFixed(1)}" y1="4" y2="26"/></svg>`;
}

// ---------- chrome ----------

function header(r) {
  const fresh = api.demo() === 'fresh' || r.name === 'onboarding';
  const product = X(S().meta?.product || 'Fathom');
  if (fresh) return `<header class="lg-top"><div class="lg-top-in"><span class="lg-mark">${product}</span></div></header>`;
  const n = needs().length;
  const cur = (name) => (r.name === name || (name === 'plan' && r.name === 'rec') ? ' aria-current="page"' : '');
  const link = ([name, label]) => `<a href="#/${name}" data-go="${name}" class="lg-nav-a"${cur(name)}>${label}${name === 'brief' && n ? `<span class="lg-count">${n}</span>` : ''}</a>`;
  const moreCur = MORE.some(([nm]) => nm === r.name);
  return `<header class="lg-top"><div class="lg-top-in">
    <a href="#/brief" data-go="brief" class="lg-mark">${product}</a>
    <nav class="lg-nav${ui.menu ? ' is-open' : ''}" aria-label="Main">
      ${NAV.map(link).join('')}
      <div class="lg-more">
        <button type="button" class="lg-nav-a lg-more-btn" data-act="more" aria-expanded="${ui.more}"${moreCur ? ' aria-current="page"' : ''}>More</button>
        <div class="lg-more-list${ui.more ? ' is-open' : ''}">${MORE.map(link).join('')}</div>
      </div>
    </nav>
    <button type="button" class="lg-menu-btn" data-act="menu" aria-expanded="${ui.menu}">${ui.menu ? 'Close' : 'Menu'}</button>
  </div></header>`;
}

function pageHead(title, lede, eyebrow) {
  return `<header class="lg-head">${eyebrow ? `<p class="lg-eyebrow">${eyebrow}</p>` : ''}<h1 class="lg-h1">${title}</h1>${lede ? `<p class="lg-lede">${lede}</p>` : ''}</header>`;
}

function footer() {
  if (api.demo() === 'fresh') return '';
  const m = S().meta || {};
  return `<footer class="lg-foot"><p>Read-only. ${X(m.product || 'Fathom')} never moves money or files anything.</p>
    <p>Data through ${X(m.dataThrough)}. Underlined figures show their source.</p></footer>`;
}

// ---------- views ----------

function viewBrief() {
  const s = S(), m = s.meta || {};
  const v = api.verdict() || {};
  const list = needs();
  const d = clock();
  const all = recs();
  const count = (st) => all.filter((r) => r.status === st).length;
  const needIds = new Set(list.map((r) => r.id));
  const doing = all.filter((r) => r.status === 'doing' && !needIds.has(r.id)).length;
  const motion = [doing && `${doing} in progress`, count('waiting') && `${count('waiting')} waiting on others`, count('snoozed') && `${count('snoozed')} snoozed`].filter(Boolean);

  const needsHtml = list.length ? `<section class="lg-sec">
      <h2 class="lg-h2">What needs you</h2>
      <ol class="lg-needs">${list.map((r, i) => `<li class="lg-need">
        <span class="lg-num">${i + 1}</span>
        <div class="lg-need-body">
          ${go('rec', r.id, T(r.title), 'lg-need-title')}
          <p class="lg-need-sum">${T(r.summary)}</p>
          <p class="lg-meta">${X(r.triggerText || TRIGGER[r.trigger] || '')}${r.effort ? ` <span class="lg-dot"></span> ${X(r.effort)}` : ''} <span class="lg-dot"></span> ${statusText(r)}</p>
          ${recActions(r, true)}
        </div>
        <p class="lg-need-when"><span class="lg-days">${daysText(r)}</span><span class="lg-until">${X(r.window?.label || '')}</span></p>
      </li>`).join('')}</ol>
    </section>` : `<section class="lg-sec lg-clear">
      <p class="lg-clear-line">Nothing needs you this month. The next brief arrives ${nextBrief()}.</p>
    </section>`;

  const today = clock();
  const upcoming = arr(s.deadlines).map((dl) => ({ dl, d: parseISO(dl.date) })).filter((o) => o.d && o.d >= today).sort((a, b) => a.d - b.d).slice(0, 7);

  const domains = arr(s.domains).map((dm) => {
    const hasNeed = list.some((r) => r.domain === dm.id);
    const st = hasNeed ? 'needs' : dm.status === 'needs' ? 'covered' : dm.status;
    return `<div class="lg-dom is-${esc(st)}">
      <dt><span class="lg-dom-name">${T(dm.name)}</span><span class="lg-dom-st">${DOMAIN[st] || esc(st)}</span></dt>
      <dd><p class="lg-dom-watch">${T(dm.watching)}</p><p class="lg-dom-note">${T(dm.note)}</p></dd>
    </div>`;
  }).join('');

  return `<article class="lg-letter">
    <p class="lg-dateline">${X(m.clockLabel)}<span class="lg-dot"></span>Data through ${X(m.dataThrough)}</p>
    <p class="lg-eyebrow">The ${MONTH[d.getUTCMonth()]} brief${m.household ? ` for ${X(m.household)}` : ''}</p>
    <h1 class="lg-verdict is-${esc(v.level)}">${T(v.headline)}</h1>
    <p class="lg-lede">${T(v.sub)}</p>
    ${api.engineOn() ? '' : `<p class="lg-notice">Proactive checks are paused. This brief reflects the last run.</p>`}
    ${needsHtml}
    ${motion.length ? `<p class="lg-motion">Also in motion: ${motion.join(', ')}. ${go('plan', null, 'See the plan')}</p>` : ''}

    <section class="lg-sec">
      <h2 class="lg-h2">The year</h2>
      <div class="lg-year">
        ${yearClock()}
        <ol class="lg-dls">${upcoming.map(({ dl, d: dd }) => {
          const r = liveRec(dl.recId);
          const ny = dd.getUTCFullYear() > today.getUTCFullYear();
          return `<li class="lg-dl${dl.hard ? ' is-hard' : ''}">
            <span class="lg-dl-date">${X(dl.label)}${ny ? ` ${dd.getUTCFullYear()}` : ''}</span>
            <span class="lg-dl-t">${r ? go('rec', r.id, T(dl.title)) : T(dl.title)}<span class="lg-dl-sub">${plural(daysBetween(today, dd), 'day')}${dl.hard ? ', hard deadline' : ''}</span></span>
          </li>`;
        }).join('') || '<li class="lg-quiet">No dated deadlines ahead.</li>'}</ol>
      </div>
    </section>

    <section class="lg-sec">
      <h2 class="lg-h2">What changed</h2>
      <ul class="lg-events">${arr(s.events).map((e) => `<li class="lg-ev">
        <span class="lg-ev-date">${X(e.date)}</span>
        <div><p class="lg-ev-t">${T(e.title)}</p><p class="lg-ev-b">${T(e.body)}</p></div>
      </li>`).join('') || '<li class="lg-quiet">A quiet month.</li>'}</ul>
    </section>

    <section class="lg-sec">
      <h2 class="lg-h2">What we are watching</h2>
      <dl class="lg-doms">${domains}</dl>
    </section>

    <footer class="lg-signoff">
      <p>Next brief ${nextBrief()}. Until then, ${list.length ? 'the items above are the only ones that need you' : 'there is nothing to do'}.</p>
      <p>${go('email', null, 'Read this month as the email')}</p>
    </footer>
  </article>`;
}

function recRow(r) {
  const vals = arr(r.value).map((v) => VALUE[v.cls] || v.cls).filter((v, i, a) => a.indexOf(v) === i);
  const bits = [X(r.triggerText || TRIGGER[r.trigger] || ''), r.effort && X(r.effort), vals.length && vals.join(', '),
    r.advisor?.verdict && ADVISOR[r.advisor.verdict]].filter(Boolean);
  return `<li class="lg-row is-${esc(r.status)}">
    <div class="lg-row-main">
      ${go('rec', r.id, T(r.title), 'lg-row-t')}
      <p class="lg-row-sum">${T(r.summary)}</p>
      <p class="lg-meta">${bits.join(' <span class="lg-dot"></span> ')}</p>
      ${recActions(r, true)}
    </div>
    <p class="lg-row-when"><span class="lg-days">${X(r.window?.label || '')}</span><span class="lg-until">${r.status === 'done' || r.status === 'dismissed' ? statusText(r) : daysText(r)}</span></p>
  </li>`;
}

function viewPlan() {
  const all = recs().slice().sort((a, b) => (a.window?.days ?? 999) - (b.window?.days ?? 999));
  const groups = [
    ['Needs a decision', (r) => r.status === 'proposed'],
    ['In progress', (r) => r.status === 'doing'],
    ['Waiting on others', (r) => r.status === 'waiting'],
    ['Snoozed', (r) => r.status === 'snoozed'],
    ['Done', (r) => r.status === 'done'],
    ['Dismissed', (r) => r.status === 'dismissed'],
  ];
  const open = all.filter((r) => !['done', 'dismissed'].includes(r.status)).length;
  const done = all.filter((r) => r.status === 'done').length;
  return `${pageHead('Plan', `${plural(open, 'open item')}, ${done} done. Sorted by how soon the window closes.`)}
    ${groups.map(([label, fn]) => {
      const rows = all.filter(fn);
      if (!rows.length) return '';
      return `<section class="lg-sec lg-group"><h2 class="lg-h2">${label}<span class="lg-h2-n">${rows.length}</span></h2>
        <ul class="lg-rows">${rows.map(recRow).join('')}</ul></section>`;
    }).join('') || '<p class="lg-quiet">No recommendations yet.</p>'}`;
}

function viewRec(id) {
  const r = liveRec(id);
  if (!r) return `${pageHead('Not found', 'This recommendation is not in the plan.')}<p>${go('plan', null, 'Back to the plan')}</p>`;
  const conv = api.conversation(r.id);
  const asked = new Set(arr(conv).filter((m) => m.role === 'me').map((m) => (m.html || '').replace(/<[^>]+>/g, '').trim()));
  const wg = r.scenario && S().wargame?.[r.scenario];
  const tasks = arr(r.tasks);
  const doneN = tasks.filter((t) => t.done).length;
  return `<article class="lg-rec">
    <p class="lg-crumb">${go('plan', null, 'Plan')}</p>
    <header class="lg-head">
      <p class="lg-eyebrow">${X(r.triggerText || TRIGGER[r.trigger] || '')}</p>
      <h1 class="lg-h1">${T(r.title)}</h1>
      <p class="lg-lede">${T(r.summary)}</p>
      <dl class="lg-facts">
        <div><dt>Status</dt><dd>${statusText(r)}</dd></div>
        <div><dt>Window</dt><dd>${X(r.window?.label || '')}${r.window?.days != null ? `, ${daysText(r)}` : ''}</dd></div>
        <div><dt>Effort</dt><dd>${X(r.effort || '')}</dd></div>
        <div><dt>Advisor</dt><dd>${r.advisor ? ADVISOR[r.advisor.verdict] || esc(r.advisor.verdict) : 'Not reviewed'}</dd></div>
      </dl>
      ${recActions(r)}
    </header>

    ${arr(r.value).length ? `<section class="lg-sec"><h2 class="lg-h2">What it is worth</h2>
      <dl class="lg-vals">${arr(r.value).map((v) => `<div><dt>${VALUE[v.cls] || esc(v.cls)}</dt><dd>${T(v.text)}</dd></div>`).join('')}</dl></section>` : ''}

    <section class="lg-sec lg-prose"><h2 class="lg-h2">Why this, why now</h2>${arr(r.why).map((p) => `<p>${T(p)}</p>`).join('')}</section>

    ${arr(r.mine).length ? `<section class="lg-sec"><h2 class="lg-h2">From your data</h2>
      <dl class="lg-table">${arr(r.mine).map((x) => `<div><dt>${T(x.label)}</dt><dd>${x.fig ? T(`{f:${x.fig}}`) : ''}</dd></div>`).join('')}</dl></section>` : ''}

    ${arr(r.kb).length ? `<section class="lg-sec"><h2 class="lg-h2">From the knowledge base</h2>
      ${arr(r.kb).map((k) => {
        const p = packById(k.pack);
        return `<blockquote class="lg-kb"><p class="lg-kb-t">${T(k.title)}</p><p>${T(k.body)}</p>
          <footer>${T(k.cite)}${p ? `<span class="lg-dot"></span>${go('packs', p.id, `${T(p.name)} pack`)}` : ''}</footer></blockquote>`;
      }).join('')}</section>` : ''}

    ${arr(r.cross).length ? `<section class="lg-sec lg-prose"><h2 class="lg-h2">What it touches</h2>
      <ul class="lg-list">${arr(r.cross).map((c) => `<li>${T(c)}</li>`).join('')}</ul></section>` : ''}

    ${wg ? `<section class="lg-sec"><p class="lg-wg-link">Weigh the options yourself: ${go('wargame', r.scenario, T(wg.title))}</p></section>` : ''}

    ${tasks.length ? `<section class="lg-sec"><h2 class="lg-h2">Checklist<span class="lg-h2-n">${doneN} of ${tasks.length}</span></h2>
      <ul class="lg-tasks">${tasks.map((t, i) => `<li><button type="button" class="lg-task${t.done ? ' is-done' : ''}" data-act="task" data-id="${esc(r.id)}" data-i="${i}" aria-pressed="${!!t.done}">
        <span class="lg-box" aria-hidden="true"></span><span class="lg-task-t">${T(t.t)}</span></button></li>`).join('')}</ul>
      ${doneN === tasks.length && !['done', 'dismissed'].includes(r.status) ? `<p class="lg-quiet">Every step is checked. Mark it done when you are satisfied.</p>` : ''}
    </section>` : ''}

    ${r.advisor ? `<section class="lg-sec"><h2 class="lg-h2">Advisor</h2>
      <p class="lg-adv"><span class="lg-adv-v is-${esc(r.advisor.verdict)}">${ADVISOR[r.advisor.verdict] || esc(r.advisor.verdict)}</span>${r.advisor.note ? ` ${T(r.advisor.note)}` : ''}</p></section>` : ''}

    <section class="lg-sec"><h2 class="lg-h2">Conversation</h2>
      ${convo(conv, { self: r.id, empty: 'Ask about this recommendation. Answers draw on your snapshot and the cited guidance.' })}
      ${engineNote()}
      ${arr(r.qa).length ? `<ul class="lg-follow">${arr(r.qa).map((q, i) => {
        const was = asked.has(api.txt(q.q).trim());
        return `<li><button type="button" class="lg-q${was ? ' is-asked' : ''}" data-act="askrec" data-id="${esc(r.id)}" data-i="${i}">${T(q.q)}</button></li>`;
      }).join('')}</ul>` : ''}
    </section>
  </article>`;
}

function engineNote() {
  return api.engineOn() ? '' : `<p class="lg-notice">The engine is off. Answers are paused until it is back on.</p>`;
}

function viewAsk() {
  const ask = S().ask || {};
  const conv = api.conversation();
  return `${pageHead('Ask', 'Questions about your money, answered from the snapshot and plan you see here.')}
    ${convo(conv)}
    ${engineNote()}
    <form class="lg-askform" data-form="ask">
      <label class="lg-sr" for="lg-ask-in">Your question</label>
      <input id="lg-ask-in" class="lg-input" name="q" autocomplete="off" placeholder="Ask anything about your finances or goals">
      <button type="submit" class="lg-btn lg-btn-primary">Ask</button>
    </form>
    <section class="lg-sec"><h2 class="lg-h2">${arr(conv).length ? 'You could also ask' : 'Start with'}</h2>
      <ul class="lg-follow">${arr(ask.suggested).map((q) => `<li><button type="button" class="lg-q" data-act="ask" data-id="${esc(q.id)}">${T(q.q)}</button></li>`).join('')}</ul>
    </section>`;
}

function pickOf(name) {
  const st = api.state || {};
  const v = st.picks?.[name] ?? st.wargame?.[name] ?? st.scenarioPick?.[name] ?? st.war?.[name];
  return typeof v === 'number' ? v : ui.picks[name];
}

function viewWargame(name) {
  const wg = S().wargame || {};
  const which = name === 'deferral' ? 'deferral' : 'salary';
  const tabs = ['salary', 'deferral'].filter((k) => wg[k]).map((k) => `<a href="#/wargame/${k}" data-go="wargame" data-id="${k}" class="lg-tab"${k === which ? ' aria-current="page"' : ''}>${T(wg[k].title)}</a>`).join('');
  const w = wg[which];
  if (!w) return pageHead('War game', 'No scenarios to weigh yet.');
  let body = '';
  if (which === 'salary') {
    const pts = arr(w.points);
    let sel = pickOf('salary');
    if (sel == null) sel = Math.max(0, pts.findIndex((p) => p.current));
    const p = pts[sel];
    body = `<figure class="lg-fig">${salaryChart(w, sel)}
        <figcaption class="lg-legend"><span class="lg-lg-front"></span>Best tradeoffs<span class="lg-lg-off"></span>Dominated<span class="lg-lg-cur"></span>Today</figcaption></figure>
      ${p ? `<div class="lg-pick">
        <p class="lg-eyebrow">${p.current ? 'Where you are today' : 'Selected'}</p>
        <h2 class="lg-h3">${T(p.label)}</h2>
        <dl class="lg-facts"><div><dt>${X(w.xLabel)}</dt><dd>${money(p.x)}</dd></div><div><dt>${X(w.yLabel)}</dt><dd>${money(p.y, { sign: true })}</dd></div><div><dt>On the curve</dt><dd>${p.frontier ? 'Yes' : 'No, something else does better'}</dd></div></dl>
        <p>${T(p.note)}</p>${p.warn ? `<p class="lg-warn">${T(p.warn)}</p>` : ''}</div>` : ''}
      <ul class="lg-opts">${pts.map((q, i) => `<li><button type="button" class="lg-opt${i === sel ? ' is-sel' : ''}" data-act="pick" data-name="salary" data-i="${i}" aria-pressed="${i === sel}">
        <span class="lg-opt-l">${T(q.label)}${q.current ? ' <span class="lg-quiet">today</span>' : ''}</span>
        <span class="lg-opt-n">${money(q.x, { k: true })}</span><span class="lg-opt-n">${money(q.y, { k: true, sign: true })}</span></button></li>`).join('')}</ul>`;
  } else {
    const opts = arr(w.options);
    let sel = pickOf('deferral');
    if (sel == null) sel = 0;
    const o = opts[sel];
    const scale = Math.max(1, ...opts.map((x) => Math.max(+x.decCash || 0, +x.need || 0))) * 1.08;
    const W = Math.min(contentWidth(), 680);
    body = `<ul class="lg-defs">${opts.map((x, i) => {
      const short = +x.decCash < +x.need;
      return `<li><button type="button" class="lg-def${i === sel ? ' is-sel' : ''}" data-act="pick" data-name="deferral" data-i="${i}" aria-pressed="${i === sel}">
        <span class="lg-def-head"><span class="lg-def-l">${T(x.label)}</span><span class="lg-def-amt">${+x.amount ? `Moves ${money(x.amount)}` : 'Nothing moved'}</span></span>
        ${cashBar(x, scale, W)}
        <span class="lg-def-cap">December cash ${money(x.decCash)} against ${money(x.need)} payroll need${short ? `, short ${money(+x.need - +x.decCash)}` : ', covered'}. Net tax ${money(x.net, { sign: true })}.</span>
      </button></li>`;
    }).join('')}</ul>
    ${o ? `<div class="lg-pick"><p class="lg-eyebrow">Selected</p><h2 class="lg-h3">${T(o.label)}</h2>
      <dl class="lg-facts"><div><dt>2026 tax change</dt><dd>${money(o.tax2026, { sign: true })}</dd></div><div><dt>2027 tax change</dt><dd>${money(o.tax2027, { sign: true })}</dd></div><div><dt>Net, both years</dt><dd>${money(o.net, { sign: true })}</dd></div><div><dt>December cash</dt><dd>${money(o.decCash)}</dd></div></dl>
      <p>${T(o.note)}</p></div>` : ''}`;
  }
  return `${pageHead('War game', T(w.question))}
    <nav class="lg-tabs" aria-label="Scenarios">${tabs}</nav>
    ${body}
    <section class="lg-sec lg-prose"><h2 class="lg-h2">Takeaway</h2><p>${T(w.takeaway)}</p></section>`;
}

function slider(key, left, right, value, label) {
  const v = ui.sliders[key] ?? value ?? 0.5;
  return `<div class="lg-curve">
    ${label ? `<p class="lg-curve-l">${label}</p>` : ''}
    <input type="range" class="lg-range" min="0" max="100" value="${Math.round(v * 100)}" data-slider="${esc(key)}" aria-label="${esc(api.txt(String(left || '')))} to ${esc(api.txt(String(right || '')))}">
    <p class="lg-curve-ends"><span>${T(left)}</span><span>${T(right)}</span></p>
  </div>`;
}

function viewGoals() {
  const s = S();
  const goals = arr(s.goals);
  return `${pageHead('Goals', 'In your words. The plan works backward from these.')}
    ${HORIZON.map(([h, label]) => {
      const g = goals.filter((x) => x.horizon === h);
      if (!g.length) return '';
      return `<section class="lg-sec"><h2 class="lg-h2">${label}</h2>${g.map((x) => {
        const cur = x.progress && api.fig(x.progress.cur), tgt = x.progress && api.fig(x.progress.target);
        const frac = cur && tgt && tgt.v ? cur.v / tgt.v : null;
        return `<div class="lg-goal">
          <p class="lg-goal-h"><span class="lg-goal-t">${T(x.title)}</span><span class="lg-goal-st is-${esc((x.status || '').replace(/\s+/g, '-'))}">${X(x.status)}</span></p>
          <p class="lg-goal-p">${T(x.prose)}</p>
          ${frac != null ? `<div class="lg-goal-prog">${bar(frac)}<p class="lg-meta">${T(`{f:${x.progress.cur}}`)} of ${T(`{f:${x.progress.target}}`)}, ${Math.round(frac * 100)}%</p></div>` : ''}
        </div>`;
      }).join('')}</section>`;
    }).join('')}
    <section class="lg-sec"><h2 class="lg-h2">Where on the curve</h2>
      <p class="lg-quiet">Each of these is a tradeoff with no single right answer. Set where you want to sit; recommendations respect it.</p>
      ${arr(s.curve).map((c) => `${slider('curve:' + c.id, c.left, c.right, c.value)}${c.note ? `<p class="lg-curve-note">${T(c.note)}</p>` : ''}`).join('')}
    </section>`;
}

function viewAccounts() {
  const s = S();
  const accts = arr(s.accounts);
  const kinds = ACCT_ORDER.filter((k) => accts.some((a) => a.kind === k)).concat([...new Set(accts.map((a) => a.kind))].filter((k) => !ACCT_ORDER.includes(k)));
  const conn = accts.filter((a) => a.mirror === 'connected').length;
  const series = Object.entries(s.series || {});
  return `${pageHead('Accounts', `${conn} of ${accts.length} mirrored read-only. Nothing here can move or delete money.`)}
    ${kinds.map((k) => `<section class="lg-sec"><h2 class="lg-h2">${ACCT_KIND[k] || esc(k)}</h2>
      <ul class="lg-accts">${accts.filter((a) => a.kind === k).map((a) => `<li class="lg-acct is-${esc(a.mirror)}">
        <div class="lg-acct-main"><p class="lg-acct-n">${T(a.name)}</p>
          <p class="lg-meta">${T(a.inst)}${a.owner ? ` <span class="lg-dot"></span> ${T(a.owner)}` : ''} <span class="lg-dot"></span> ${{ connected: 'Mirrored', manual: 'Entered by hand', missing: 'Not connected' }[a.mirror] || esc(a.mirror)}</p>
          ${a.note ? `<p class="lg-acct-note">${T(a.note)}</p>` : ''}</div>
        <p class="lg-acct-v">${a.fig ? T(`{f:${a.fig}}`) : '<span class="lg-quiet">No balance</span>'}</p>
      </li>`).join('')}</ul></section>`).join('')}
    ${series.length ? `<section class="lg-sec"><h2 class="lg-h2">Trends</h2>
      <ul class="lg-trends">${series.map(([, se]) => {
        const pts = arr(se.points), last = pts.filter((p) => p.kind !== 'p').pop() || pts[pts.length - 1];
        return `<li><p class="lg-tr-l">${T(se.label)}</p>${spark(se)}<p class="lg-tr-v">${last ? money(last.v, { k: true }) : ''}<span class="lg-quiet">${last ? ` ${X(last.x)}` : ''}</span></p></li>`;
      }).join('')}</ul><p class="lg-quiet">Solid is actual. Dashed is projected from the plan.</p></section>` : ''}
    <section class="lg-sec"><h2 class="lg-h2">Detected this month</h2>
      <ul class="lg-events">${arr(s.events).map((e) => `<li class="lg-ev"><span class="lg-ev-date">${X(e.date)}</span>
        <div><p class="lg-ev-t">${T(e.title)}</p><p class="lg-ev-b">${T(e.body)}</p></div></li>`).join('')}</ul></section>`;
}

function viewAdvisor() {
  const a = S().advisor || {};
  const pend = arr(a.pending).map((id) => liveRec(id)).filter(Boolean);
  return `${pageHead(`Check-in with ${X(a.name)}`, `${X(a.role)}. Next session ${X(a.next?.when)}${a.next?.length ? `, ${X(a.next.length)}` : ''}.`, 'Quarterly review')}
    <section class="lg-sec lg-prose"><h2 class="lg-h2">Agenda</h2><p>${T(a.agenda)}</p></section>
    <section class="lg-sec"><h2 class="lg-h2">Awaiting a verdict<span class="lg-h2-n">${pend.length}</span></h2>
      <ul class="lg-rows">${pend.map((r) => `<li class="lg-row"><div class="lg-row-main">${go('rec', r.id, T(r.title), 'lg-row-t')}
        <p class="lg-row-sum">${T(r.summary)}</p><p class="lg-meta">${statusText(r)}${r.advisor?.note ? ` <span class="lg-dot"></span> ${T(r.advisor.note)}` : ''}</p></div>
        <p class="lg-row-when"><span class="lg-days">${X(r.window?.label || '')}</span><span class="lg-until">${daysText(r)}</span></p></li>`).join('') || '<li class="lg-quiet">Nothing waiting on the advisor.</li>'}</ul></section>
    <section class="lg-sec"><h2 class="lg-h2">Reviewed since last time</h2>
      <ul class="lg-verdicts">${arr(a.reviewed).map((v) => {
        const r = liveRec(v.recId);
        return `<li><p class="lg-v-h"><span class="lg-adv-v is-${esc(v.verdict)}">${v.verdict === 'vetoed' ? 'Vetoed' : 'Confirmed'}</span>${r ? go('rec', r.id, T(v.title)) : `<span>${T(v.title)}</span>`}</p><p class="lg-v-n">${T(v.note)}</p></li>`;
      }).join('')}</ul></section>
    <section class="lg-sec"><h2 class="lg-h2">Deliberately not on the agenda</h2>
      <dl class="lg-notask">${arr(a.notAsking).map((n) => `<div><dt>${T(n.q)}</dt><dd>${T(n.why)}</dd></div>`).join('')}</dl></section>
    <section class="lg-sec lg-two">
      <div><h2 class="lg-h2">Shared with ${X(a.name)}</h2><ul class="lg-simple">${arr(a.shared).map((x) => `<li><span>${T(x.title)}</span><span class="lg-quiet">${X(x.when)}</span></li>`).join('')}</ul></div>
      <div><h2 class="lg-h2">Specialists</h2><ul class="lg-simple lg-stack">${arr(a.experts).map((x) => `<li><span>${T(x.name)}, ${T(x.role)}</span><span class="lg-quiet">${T(x.when)}</span></li>`).join('')}</ul></div>
    </section>`;
}

function viewYearend() {
  const y = S().yearend || {};
  const docs = arr(y.docs);
  const have = docs.filter((d) => d.status === 'have').length;
  const decs = arr(y.decisions).map((d) => {
    const r = d.recId ? api.rec(d.recId) : null;
    return { ...d, r, isDone: r ? r.status === 'done' : !!d.done };
  });
  const decDone = decs.filter((d) => d.isDone).length;
  const DOC = [['missing', 'Missing'], ['expected', 'Expected'], ['have', 'In hand']];
  return `${pageHead('Year-end packet', 'Everything your accountant needs, gathered as the year goes. Fathom prepares it; it does not file.')}
    <section class="lg-sec lg-two lg-tally">
      <div><p class="lg-tally-n">${have}<span> of ${docs.length}</span></p><p class="lg-meta">documents in hand</p>${bar(docs.length ? have / docs.length : 0)}</div>
      <div><p class="lg-tally-n">${decDone}<span> of ${decs.length}</span></p><p class="lg-meta">decisions settled</p>${bar(decs.length ? decDone / decs.length : 0)}</div>
    </section>
    <section class="lg-sec"><h2 class="lg-h2">Decisions to settle before the packet goes</h2>
      <ul class="lg-decs">${decs.map((d) => `<li class="${d.isDone ? 'is-done' : ''}"><span class="lg-box" aria-hidden="true"></span>
        <span>${d.r && d.r.status !== 'hidden' ? go('rec', d.r.id, T(d.t)) : T(d.t)}</span></li>`).join('')}</ul></section>
    ${DOC.map(([st, label]) => {
      const list = docs.filter((d) => d.status === st);
      if (!list.length) return '';
      return `<section class="lg-sec"><h2 class="lg-h2">${label}<span class="lg-h2-n">${list.length}</span></h2>
        <dl class="lg-table lg-docs">${list.map((d) => `<div><dt>${T(d.t)}<span class="lg-doc-note">${T(d.note)}</span></dt><dd class="lg-quiet">${T(d.src)}</dd></div>`).join('')}</dl></section>`;
    }).join('')}`;
}

function viewConnect() {
  const c = S().connect || {};
  const scopes = arr(c.scopes);
  const on = (sc) => (ui.scopes[sc.id] ?? !!sc.on);
  return `${pageHead('Connect your AI', 'Use your own assistant over MCP. It sees what you allow, with the same read-only limits.')}
    <section class="lg-sec"><h2 class="lg-h2">Server</h2>
      <div class="lg-url"><code>${X(c.url)}</code>${btn('copy', ui.copied ? 'Copied' : 'Copy')}</div></section>
    <section class="lg-sec"><h2 class="lg-h2">What it may see<span class="lg-h2-n">${scopes.filter(on).length} of ${scopes.length} on</span></h2>
      <ul class="lg-scopes">${scopes.map((sc) => `<li><button type="button" class="lg-toggle" data-act="scope" data-id="${esc(sc.id)}" aria-pressed="${on(sc)}">
        <span class="lg-sw" aria-hidden="true"></span><span class="lg-scope-l">${T(sc.label)}</span><span class="lg-quiet">${sc.access === 'write' ? 'Write' : 'Read'}</span></button></li>`).join('')}</ul></section>
    <section class="lg-sec"><h2 class="lg-h2">Tools it gets</h2>
      <dl class="lg-tools">${arr(c.tools).map((t) => `<div><dt><code>${X(t.name)}</code></dt><dd>${T(t.desc)}</dd></div>`).join('')}</dl></section>
    <section class="lg-sec"><h2 class="lg-h2">What it looks like</h2>
      <ol class="lg-tx">${arr(c.transcript).map((m) => `<li class="lg-tx-${esc(m.role)}"><span class="lg-who">${m.role === 'me' ? 'You' : m.role === 'tool' ? 'Tool call' : 'Your AI'}</span><div>${T(m.text)}</div></li>`).join('')}</ol></section>
    <section class="lg-sec"><h2 class="lg-h2">Client config</h2><pre class="lg-pre"><code>${X(c.config)}</code></pre></section>`;
}

function viewEngine() {
  const e = S().engine || {};
  const b = e.budget || {};
  const on = api.engineOn();
  return `${pageHead('Engine', on ? 'Running. Proactive checks wake on deadlines, new data and life events.' : 'Paused. Nothing runs on its own and chat answers are held.')}
    <section class="lg-sec lg-two lg-tally">
      <div><p class="lg-tally-n">${money(b.used)}<span> of ${money(b.monthly)}</span></p><p class="lg-meta">spent this month</p>${bar(b.monthly ? b.used / b.monthly : 0)}</div>
      <div><p class="lg-tally-n lg-tally-s">${on ? 'On' : 'Off'}</p><p><button type="button" class="lg-btn" data-fx-engine>${on ? 'Turn the engine off' : 'Turn the engine on'}</button></p><p class="lg-meta">${T(e.chat?.model)}</p><p class="lg-quiet">${T(e.chat?.note)}</p></div>
    </section>
    <section class="lg-sec"><h2 class="lg-h2">Proactive jobs</h2>
      <ul class="lg-jobs">${arr(e.jobs).map((j) => `<li class="${on ? '' : 'is-paused'}">
        <p class="lg-job-h"><span class="lg-job-n">${T(j.name)}</span><span class="lg-job-c">${money(j.cost)}</span></p>
        <p class="lg-job-d">${T(j.does)}</p>
        <p class="lg-meta">${T(j.cadence)} <span class="lg-dot"></span> Last ${T(j.last)} <span class="lg-dot"></span> ${on ? `Next ${T(j.next)}` : 'Paused'}</p>
      </li>`).join('')}</ul></section>`;
}

function viewEmail() {
  const em = S().email || {};
  const m = S().meta || {};
  return `${pageHead('Monthly email', 'What lands in your inbox once a month. One email, then nothing until the next.')}
    <div class="lg-mail">
      <dl class="lg-mail-h"><div><dt>From</dt><dd>${X(m.product || 'Fathom')}</dd></div><div><dt>Subject</dt><dd>${T(em.subject)}</dd></div></dl>
      <p class="lg-mail-pre">${T(em.preheader)}</p>
      <div class="lg-mail-b">
        <p>${T(em.greeting)}</p>
        ${arr(em.sections).map((sec) => `<h3>${T(sec.heading)}</h3><ul>${arr(sec.items).map((i) => `<li>${T(i)}</li>`).join('')}</ul>`).join('')}
        <p class="lg-mail-f">${T(em.footer)}</p>
      </div>
    </div>
    <p class="lg-signoff">${go('brief', null, 'Open the brief')}</p>`;
}

function packMeta(p) {
  return [p.entries != null && plural(+p.entries, 'curated entry', 'curated entries'), p.curator && `Curated by ${X(p.curator)}`, p.updated && `Updated ${X(p.updated)}`].filter(Boolean).join(' <span class="lg-dot"></span> ');
}
function packRecs(p) {
  return arr(p.recIds).map((id) => liveRec(id)).filter(Boolean);
}

function viewPacks(id) {
  if (id) return viewPack(id);
  const all = packs();
  const active = all.filter((p) => p.status === 'active');
  const sugg = all.filter((p) => p.status === 'suggested' || p.status === 'exploring');
  const avail = all.filter((p) => p.status === 'available');
  const card = (p, live) => {
    const rs = packRecs(p);
    return `<li class="lg-pack">
      <p class="lg-pack-h">${go('packs', p.id, T(p.name), 'lg-pack-n')}${p.status === 'exploring' ? '<span class="lg-quiet">Exploring</span>' : ''}</p>
      <p class="lg-pack-why">${T(p.why)}</p>
      ${arr(p.covers).length ? `<p class="lg-pack-cov">Covers ${arr(p.covers).map((c) => T(c)).join(', ')}</p>` : ''}
      <p class="lg-meta">${packMeta(p)}</p>
      ${live ? (rs.length ? `<p class="lg-pack-recs">Powers ${rs.map((r) => go('rec', r.id, T(r.title))).join(', ')}</p>` : '')
        : `<div class="lg-acts">${btn('whatif', 'What if', `data-id="${esc(p.id)}"`, 'lg-btn-primary')}${btn('packtoggle', 'Turn on', `data-id="${esc(p.id)}"`)}</div>`}
    </li>`;
  };
  const sec = (label, list, live, lede) => list.length ? `<section class="lg-sec"><h2 class="lg-h2">${label}<span class="lg-h2-n">${list.length}</span></h2>
    ${lede ? `<p class="lg-quiet">${lede}</p>` : ''}<ul class="lg-packs">${list.map((p) => card(p, live)).join('')}</ul></section>` : '';
  return `${pageHead('Knowledge packs', 'Curated guidance Fathom reads from. A pack switches on when your facts make it apply.')}
    ${sec('On for you', active, true)}
    ${sec('Might apply', sugg, false, 'Something in your data hints at these. Talk through what would change before turning one on.')}
    ${sec('Available', avail, false, 'Not triggered by anything today. Ask what if, to see what a change would open up.')}`;
}

function viewPack(id) {
  const p = packById(id);
  if (!p) return `${pageHead('Not found', 'No pack by that name.')}<p>${go('packs', null, 'All packs')}</p>`;
  const conv = arr(api.conversation('pack:' + p.id));
  const explored = conv.length > 0 || p.status === 'exploring';
  const rs = packRecs(p);
  const wi = p.whatIf || {};
  const isOn = p.status === 'active';
  const stLabel = { active: 'On', suggested: 'Might apply', available: 'Available', exploring: 'Exploring' }[p.status] || esc(p.status);
  return `<article>
    <p class="lg-crumb">${go('packs', null, 'Knowledge packs')}</p>
    <header class="lg-head"><p class="lg-eyebrow">${stLabel}</p><h1 class="lg-h1">${T(p.name)}</h1><p class="lg-lede">${T(p.why)}</p>
      <p class="lg-meta">${packMeta(p)}</p>
      <div class="lg-acts">${isOn ? btn('packtoggle', 'Turn this pack off', `data-id="${esc(p.id)}"`) : `${explored ? '' : btn('whatif', 'What if', `data-id="${esc(p.id)}"`, 'lg-btn-primary')}${btn('packtoggle', 'Turn this pack on', `data-id="${esc(p.id)}"`, explored ? 'lg-btn-primary' : '')}`}</div>
    </header>
    ${arr(p.covers).length ? `<section class="lg-sec"><h2 class="lg-h2">What it covers</h2><ul class="lg-list">${arr(p.covers).map((c) => `<li>${T(c)}</li>`).join('')}</ul></section>` : ''}
    ${isOn ? `<section class="lg-sec"><h2 class="lg-h2">Recommendations it powers<span class="lg-h2-n">${rs.length}</span></h2>
      <ul class="lg-rows">${rs.map(recRow).join('') || '<li class="lg-quiet">None open right now.</li>'}</ul></section>` : ''}
    <section class="lg-sec"><h2 class="lg-h2">What if</h2>
      ${wi.prompt && !explored ? `<p class="lg-whatif-q">${T(wi.prompt)}</p>` : ''}
      ${explored ? convo(conv) : `<p class="lg-quiet">Talk it through first. Nothing changes until you turn the pack on.</p>${btn('whatif', 'Talk it through', `data-id="${esc(p.id)}"`)}`}
      ${explored ? engineNote() : ''}
    </section>
    ${explored && arr(wi.unlocks).length ? `<section class="lg-sec"><h2 class="lg-h2">What it would add</h2>
      <ul class="lg-unlocks">${arr(wi.unlocks).map((u) => {
        const r = liveRec(u.recId);
        return `<li><p class="lg-unlock-t">${r ? go('rec', r.id, T(u.title)) : T(u.title)}</p><p>${T(u.text)}</p>${r ? `<p class="lg-meta">In your plan: ${statusText(r)}</p>` : ''}</li>`;
      }).join('')}</ul>
      ${isOn ? '' : `<div class="lg-acts">${btn('packtoggle', 'Turn this pack on', `data-id="${esc(p.id)}"`, 'lg-btn-primary')}</div>`}
    </section>` : ''}
  </article>`;
}

// ---------- onboarding ----------

function viewOnboarding(stepParam) {
  const o = S().onboarding || {};
  const step = Math.max(0, Math.min(5, parseInt(stepParam, 10) || 0));
  const next = (label, extra) => `<div class="lg-acts lg-ob-acts">${step > 0 ? btn('obstep', 'Back', `data-i="${step - 1}"`, 'lg-btn-ghost') : ''}${btn('obstep', label, `data-i="${step + 1}" ${extra || ''}`, 'lg-btn-primary')}</div>`;
  const prog = `<div class="lg-ob-prog"><p class="lg-eyebrow">Step ${step + 1} of 6</p>${bar((step + 1) / 6)}</div>`;
  let body = '';
  if (step === 0) {
    body = `<h1 class="lg-verdict">${T(o.welcome?.headline)}</h1><p class="lg-lede">${T(o.welcome?.sub)}</p>
      <form class="lg-signin" data-form="signin">
        <label class="lg-lab" for="lg-email">Email</label>
        <input id="lg-email" class="lg-input" type="email" placeholder="you@example.com" autocomplete="off">
        <button type="submit" class="lg-btn lg-btn-primary">Continue with passkey</button>
      </form>
      <p class="lg-quiet">Read-only from the first click. It never moves money, files taxes or changes an account.</p>`;
  } else if (step === 1) {
    body = `<h1 class="lg-h1">Tell us everything</h1><p class="lg-lede">Write it the way you would tell a friend: who is in the household, how you earn, what is coming, what keeps you up. Attach whatever you have.</p>
      <textarea class="lg-dump" rows="9" aria-label="Everything about your situation">${X(o.dump)}</textarea>
      <ul class="lg-files">${arr(o.files).map((f) => `<li><span>${T(f.name)}</span><span class="lg-quiet">${T(f.status)}</span></li>`).join('')}</ul>
      ${next('Continue')}`;
  } else if (step === 2) {
    const insts = arr(o.institutions);
    const n = insts.filter((_, i) => ui.connected[i]).length;
    body = `<h1 class="lg-h1">Mirror your accounts</h1><p class="lg-lede">Read-only access, so the snapshot stays current without you uploading statements.</p>
      <ul class="lg-insts">${insts.map((x, i) => `<li><div><p class="lg-acct-n">${T(x.inst)}</p><p class="lg-meta">${acctCount(x.accounts)}, read-only</p></div>
        ${ui.connected[i] ? '<span class="lg-ok">Connected, read-only</span>' : btn('obconnect', 'Connect', `data-i="${i}"`)}</li>`).join('')}</ul>
      <p class="lg-quiet">${n} of ${insts.length} connected. You can add the rest later.</p>
      ${next(n ? 'Continue' : 'Skip for now')}`;
  } else if (step === 3) {
    const h = o.heard || {};
    const grp = (label, items) => arr(items).length ? `<div><dt>${label}</dt><dd>${arr(items).map((i) => `<p>${T(i)}</p>`).join('')}</dd></div>` : '';
    body = `<h1 class="lg-h1">Here is what we heard</h1><p class="lg-lede">Correct anything that is off. This becomes the household's facts.</p>
      <dl class="lg-heard">${grp('People', h.people)}${grp('Entities', h.entities)}${grp('Income', h.income)}${grp('Life events', h.lifeEvents)}
        ${h.deadlines != null ? `<div><dt>Deadlines</dt><dd><p>${plural(+h.deadlines, 'dated deadline')} found for the next twelve months</p></dd></div>` : ''}</dl>
      ${arr(h.questions).length ? `<section class="lg-sec"><h2 class="lg-h2">We still need to ask</h2><ul class="lg-list">${arr(h.questions).map((q) => `<li>${T(q)}</li>`).join('')}</ul></section>` : ''}
      ${next('That is right')}`;
  } else if (step === 4) {
    body = `<h1 class="lg-h1">Where on the curve</h1><p class="lg-lede">Most money decisions trade one good thing for another. Tell us where you lean. You can change this any time.</p>
      ${arr(o.priorities).map((p) => slider('prio:' + p.id, 'Matters less', 'Matters most', p.value, T(p.label))).join('')}
      ${next('Build my first brief')}`;
  } else {
    const stages = ['Reading what you wrote', 'Mirroring balances', 'Placing deadlines on the year', 'Checking each domain', 'Writing your first brief'];
    const k = Math.min(ui.building, stages.length);
    body = `<h1 class="lg-h1">${k >= stages.length ? 'Your first brief is ready' : 'Building your first brief'}</h1>
      <p class="lg-lede">${k >= stages.length ? 'From here it writes once a month, and only interrupts you when a window is closing.' : 'This takes a moment. Nothing is shared or moved.'}</p>
      <ol class="lg-stages">${stages.map((s, i) => `<li class="${i < k ? 'is-done' : i === k ? 'is-now' : ''}"><span class="lg-box" aria-hidden="true"></span>${s}</li>`).join('')}</ol>
      <div class="lg-acts lg-ob-acts">${btn('obstep', 'Back', 'data-i="4"', 'lg-btn-ghost')}${btn('obstep', 'Open my brief', 'data-i="6"', 'lg-btn-primary')}</div>`;
    startBuilding(stages.length);
  }
  const modal = ui.modal != null ? (() => {
    const inst = arr(o.institutions)[ui.modal];
    return `<div class="lg-scrim" data-act="obcancel"></div><div class="lg-modal" role="dialog" aria-modal="true" aria-labelledby="lg-modal-h">
      <h2 class="lg-h3" id="lg-modal-h">Connect ${T(inst?.inst)} read-only</h2>
      <p>${X(S().meta?.product || 'Fathom')} will be able to see balances and transactions on ${typeof inst?.accounts === 'number' ? `its ${acctCount(inst.accounts)}` : T(inst?.accounts)}.</p>
      <ul class="lg-list"><li>It cannot move, transfer or withdraw money.</li><li>It cannot delete or change anything at ${T(inst?.inst)}.</li><li>You can revoke access from ${T(inst?.inst)} at any time.</li></ul>
      <div class="lg-acts">${btn('obcancel', 'Cancel', '', 'lg-btn-ghost')}${btn('obconfirm', 'Allow read-only access', `data-i="${ui.modal}"`, 'lg-btn-primary')}</div>
    </div>`;
  })() : '';
  return `<div class="lg-ob">${prog}${body}</div>${modal}`;
}

function acctCount(v) {
  return typeof v === 'number' ? plural(v, 'account') : T(v);
}

function startBuilding(n) {
  if (ui.buildTimer || ui.building >= n) return;
  ui.buildTimer = setInterval(() => {
    ui.building += 1;
    if (ui.building >= n) { clearInterval(ui.buildTimer); ui.buildTimer = null; }
    schedule();
  }, 550);
  timers.push(ui.buildTimer);
}

// ---------- render loop ----------

function view(r) {
  const p = r.params || {};
  const pid = p.id ?? p.step ?? p.name;
  switch (r.name) {
    case 'onboarding': return viewOnboarding(p.step ?? p.id);
    case 'plan': return viewPlan();
    case 'rec': return viewRec(p.id ?? pid);
    case 'ask': return viewAsk();
    case 'wargame': return viewWargame(p.name ?? pid);
    case 'goals': return viewGoals();
    case 'accounts': return viewAccounts();
    case 'advisor': return viewAdvisor();
    case 'yearend': return viewYearend();
    case 'connect': return viewConnect();
    case 'engine': return viewEngine();
    case 'email': return viewEmail();
    case 'packs': return viewPacks(p.id ?? pid);
    default: return viewBrief();
  }
}

function draw() {
  if (!root || !api) return;
  const r = api.route || { name: 'brief', params: {} };
  const key = r.name + ':' + JSON.stringify(r.params || {});
  const moved = key !== lastKey;
  if (moved) {
    ui.menu = false; ui.more = false; ui.modal = null;
    if (r.name !== 'onboarding' && ui.buildTimer) { clearInterval(ui.buildTimer); ui.buildTimer = null; }
    if (r.name === 'onboarding' && String((r.params || {}).step ?? '') !== '5') ui.building = 0;
    closePop();
  }
  const y = window.scrollY;
  let html;
  try { html = view(r); } catch (e) {
    console.error('[ledger]', e);
    html = `${pageHead('Something broke', esc(e.message))}`;
  }
  root.innerHTML = `<div class="lg-page">${header(r)}<main class="lg-main">${html}</main>${footer()}</div>`;
  if (moved) { window.scrollTo(0, 0); lastKey = key; } else { window.scrollTo(0, y); }
}

function schedule() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; draw(); });
}

// ---------- events ----------

function closePop() { if (ownPop) { ownPop.remove(); ownPop = null; } }
function showPop(el) {
  if (typeof api.figPopover === 'function') { api.figPopover(el); return; }
  closePop();
  const f = api.fig(el.dataset.fig) || {};
  const src = S().src?.[f.src] || {};
  const p = document.createElement('div');
  p.className = 'lg-pop';
  p.innerHTML = `<p class="lg-pop-l">${X(f.label)}</p><p class="lg-pop-v">${money(f.v)}</p><p>${KIND[f.kind] || ''}</p><p class="lg-quiet">${X(src.label)}${src.asOf ? `, as of ${X(src.asOf)}` : ''}</p>`;
  root.appendChild(p);
  const b = el.getBoundingClientRect(), rb = root.getBoundingClientRect();
  const w = Math.min(260, rb.width - 24);
  p.style.width = w + 'px';
  p.style.left = Math.max(12, Math.min(b.left - rb.left, rb.width - w - 12)) + 'px';
  p.style.top = (b.bottom - rb.top + 8) + 'px';
  ownPop = p;
}

function onClick(e) {
  const fig = e.target.closest('.fx-fig');
  if (fig && root.contains(fig)) { e.preventDefault(); showPop(fig); return; }
  if (ownPop && !e.target.closest('.lg-pop')) closePop();

  const g = e.target.closest('[data-go]');
  if (g && root.contains(g)) {
    e.preventDefault();
    const name = g.dataset.go, id = g.dataset.id;
    ui.menu = false; ui.more = false;
    if (id == null) api.go(name);
    else if (name === 'wargame') api.go(name, { name: id });
    else api.go(name, { id });
    schedule();
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!a || !root.contains(a)) {
    if (ui.more && !e.target.closest('.lg-more')) { ui.more = false; schedule(); }
    return;
  }
  const act = a.dataset.act, id = a.dataset.id, i = a.dataset.i != null ? +a.dataset.i : null;
  switch (act) {
    case 'menu': ui.menu = !ui.menu; ui.more = ui.menu; break;
    case 'more': ui.more = !ui.more; break;
    case 'start': case 'complete': case 'dismiss': case 'reopen':
      api.act(id, act); break;
    case 'snooze': api.act(id, 'snooze', nextBrief()); break;
    case 'task': api.act(id, 'task', i); break;
    case 'askrec': askRec(id, i); break;
    case 'ask': api.ask(id); break;
    case 'pick': ui.picks[a.dataset.name] = i; api.scenarioPick(a.dataset.name, i); break;
    case 'whatif': {
      api.whatIf(id);
      const r = api.route || {};
      if (!(r.name === 'packs' && (r.params || {}).id === id)) api.go('packs', { id });
      break;
    }
    case 'packtoggle': api.packToggle(id); break;
    case 'scope': {
      const sc = arr(S().connect?.scopes).find((x) => x.id === id);
      ui.scopes[id] = !(ui.scopes[id] ?? !!sc?.on); break;
    }
    case 'copy': {
      try { navigator.clipboard?.writeText(api.txt(String(S().connect?.url || ''))); } catch (_) { /* clipboard is optional */ }
      ui.copied = true;
      timers.push(setTimeout(() => { ui.copied = false; schedule(); }, 1600));
      break;
    }
    case 'obstep': obGo(i); return;
    case 'obconnect': ui.modal = i; break;
    case 'obcancel': ui.modal = null; break;
    case 'obconfirm': ui.connected[i] = true; ui.modal = null; break;
    default: return;
  }
  schedule();
}

function obGo(step) {
  api.onboard(step);
  if (step < 6) {
    const r = api.route || {};
    if (r.name !== 'onboarding' || String((r.params || {}).step) !== String(step)) api.go('onboarding', { step });
  }
  schedule();
}

function onSubmit(e) {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  if (f.dataset.form === 'ask') {
    const q = f.querySelector('input')?.value.trim();
    if (q) { api.askFree(q); schedule(); }
  } else if (f.dataset.form === 'signin') {
    obGo(1);
  }
}

function onInput(e) {
  const s = e.target.closest('[data-slider]');
  if (s) ui.sliders[s.dataset.slider] = +s.value / 100;
}

function onKey(e) {
  if (e.key === 'Escape') {
    if (ui.modal != null || ui.more || ui.menu || ownPop) { ui.modal = null; ui.more = false; ui.menu = false; closePop(); schedule(); }
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('g[data-act]')) { e.preventDefault(); onClick(e); }
}

function loadFonts() {
  if (document.getElementById('lg-fonts')) return;
  const l = document.createElement('link');
  l.id = 'lg-fonts';
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,300..500&family=Inter:wght@400;500;600&display=swap';
  document.head.appendChild(l);
}

function mount(el, theApi) {
  root = el;
  api = theApi;
  loadFonts();
  lastKey = '';
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  onDocClick = (e) => { if (ownPop && !root.contains(e.target)) closePop(); };
  document.addEventListener('click', onDocClick);
  let rt = null;
  onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (['wargame'].includes(api.route?.name)) schedule(); }, 120); };
  window.addEventListener('resize', onResize);
  unsub = api.on(() => schedule());
  draw();
}

function unmount() {
  if (unsub) unsub();
  unsub = null;
  if (root) {
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKey);
    root.innerHTML = '';
  }
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('resize', onResize);
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers = [];
  ui.buildTimer = null;
  closePop();
  root = null;
}

function register() {
  window.Fathom.registerDesign({
    id: ID,
    name: 'Ledger',
    blurb: 'Editorial and calm. The brief reads like a short monthly letter.',
    mount,
    unmount,
    render: () => schedule(),
  });
}

if (window.Fathom?.registerDesign) register();
else window.addEventListener('DOMContentLoaded', () => { if (window.Fathom?.registerDesign) register(); });

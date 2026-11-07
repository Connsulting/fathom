/* Horizon household trend: the one chart Money opens with (net worth over time or one of its parts,
   each on its own scale, range 3M / 1Y / All, hover or tap for the date and every part's value) and the
   compact per-group line on Accounts. Every number comes from the server's scenario.trend and its
   trend.* figures; this file only draws them. A span where any account's balance is carried
   forward (its data stopped) is dashed and shaded, and named under the chart. */

let H = null;

export function bind(kit) { H = kit; }

const RANGES = [['3M', 3], ['1Y', 12], ['All', null]];
const S = { range: '1Y', sel: 'total', idx: null };
// Geometry of the chart last drawn, for the pointer handler.
let G = null;

export function reset() { S.range = '1Y'; S.sel = 'total'; S.idx = null; G = null; }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const monthLabel = (iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const shortDay = (iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

const valueOf = (p, id) => (id === 'total' ? p.total : p.parts[id]);
const carriedOf = (p, id) => (id === 'total' ? p.carried.total : p.carried.parts[id] || 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function view() {
  const t = H.api.s.trend;
  if (!t || !Array.isArray(t.points) || t.points.length < 2) return null;
  const spec = RANGES.find((r) => r[0] === S.range) || RANGES[1];
  let from = 0;
  if (spec[1]) {
    const cut = new Date(`${t.points.at(-1).date}T00:00:00Z`);
    cut.setUTCMonth(cut.getUTCMonth() - spec[1]);
    const iso = cut.toISOString().slice(0, 10);
    from = t.points.findIndex((p) => p.date >= iso);
    if (from < 0) from = 0;
  }
  if (t.points.length - from < 2) from = t.points.length - 2;
  return { t, pts: t.points.slice(from) };
}

const everyLine = (t) => [{ id: 'total', label: 'Net worth' }, ...t.parts];
// The charted line: the chosen part, or net worth when that part is not in this store.
const lines = (t) => { const all = everyLine(t); return [all.find((l) => l.id === S.sel) || all[0]]; };

// Consecutive segments of one style become one polyline. A segment is dashed when its end point
// has a carried balance in it.
function runs(pts, id, sx, sy, cls) {
  const out = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const dashed = carriedOf(pts[i], id) > 0;
    if (!cur || cur.dashed !== dashed) {
      cur = { dashed, xy: [`${sx(i - 1)},${sy(valueOf(pts[i - 1], id))}`] };
      out.push(cur);
    }
    cur.xy.push(`${sx(i)},${sy(valueOf(pts[i], id))}`);
  }
  return out.map((r) => `<polyline class="${cls}${r.dashed ? ' carried' : ''}" points="${r.xy.join(' ')}"/>`).join('');
}

// Tick labels in thousands or millions with the fewest decimals that keep every tick distinct, so a
// narrow range never reads $25K, $25K, $24K.
function tickNames(ticks) {
  const abs = Math.max(...ticks.map(Math.abs));
  const [div, unit] = abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  let out = [];
  for (let d = 0; d <= 3; d++) {
    out = ticks.map((t) => `${t < 0 ? '-' : ''}$${(Math.abs(t) / div).toFixed(d).replace(/\.0+$/, '')}${unit}`);
    if (new Set(out).size === out.length) break;
  }
  return out;
}

function chart(v) {
  const { esc, niceTicks } = H;
  const narrow = window.innerWidth < 700;
  const W = narrow ? 360 : 1000, Ht = narrow ? 230 : 320, L = narrow ? 44 : 62, R = 12, Tp = 12, B = 26;
  const ls = lines(v.t);
  const all = ls.flatMap((l) => v.pts.map((p) => valueOf(p, l.id))).filter(Number.isFinite);
  const yt = niceTicks(Math.min(...all), Math.max(...all), 4);
  const y0 = yt[0], y1 = yt.at(-1);
  const n = v.pts.length;
  const sx = (i) => Math.round((L + (i / (n - 1)) * (W - L - R)) * 10) / 10;
  const sy = (val) => Math.round((Tp + (1 - (val - y0) / ((y1 - y0) || 1)) * (Ht - Tp - B)) * 10) / 10;
  G = { W, L, R, n, sx, sy, ids: ls.map((l) => l.id) };
  let g = `<svg class="tr-svg" viewBox="0 0 ${W} ${Ht}" role="img" aria-label="${esc(`Net worth and parts, ${monthLabel(v.pts[0].date)} to ${monthLabel(v.pts.at(-1).date)}`)}">`;
  const names = tickNames(yt);
  yt.forEach((val, k) => {
    g += `<line class="tr-grid${val === 0 ? ' zero' : ''}" x1="${L}" x2="${W - R}" y1="${sy(val)}" y2="${sy(val)}"/>`;
    g += `<text class="tr-t" x="${L - 7}" y="${sy(val) + 3.5}" text-anchor="end">${esc(names[k])}</text>`;
  });
  const carriedFrom = v.pts.findIndex((p) => ls.some((l) => carriedOf(p, l.id) > 0));
  if (carriedFrom >= 0) {
    const x = sx(Math.max(0, carriedFrom - 1));
    g += `<rect class="tr-carry" x="${x}" y="${Tp}" width="${W - R - x}" height="${Ht - Tp - B}"/>`;
  }
  // Axis labels: first, last and, when there are enough points, the middle one. The ends anchor
  // inward so neither is clipped.
  const day = S.range === '3M';
  const at = n >= 5 ? [0, Math.round((n - 1) / 2), n - 1] : [0, n - 1];
  at.forEach((i) => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    g += `<text class="tr-t tr-x" x="${sx(i)}" y="${Ht - 7}" text-anchor="${anchor}">${esc(day ? shortDay(v.pts[i].date) : monthLabel(v.pts[i].date))}</text>`;
  });
  // Parts first, the total on top.
  [...ls].reverse().forEach((l) => { g += runs(v.pts, l.id, sx, sy, `tr-l tr-c-${esc(l.id)}${l.id === 'total' ? ' total' : ''}`); });
  const cur = clamp(S.idx ?? n - 1, 0, n - 1);
  g += `<line class="tr-guide" data-trend-guide x1="${sx(cur)}" x2="${sx(cur)}" y1="${Tp}" y2="${Ht - B}"/>`;
  ls.forEach((l) => { g += `<circle class="tr-dot tr-c-${esc(l.id)}" data-trend-dot="${esc(l.id)}" cx="${sx(cur)}" cy="${sy(valueOf(v.pts[cur], l.id))}" r="3.5"/>`; });
  g += `<rect class="tr-hit" data-trend-hit tabindex="0" role="group" aria-label="Chart values by date. Move with the arrow keys." x="${L}" y="0" width="${W - L}" height="${Ht - B}"/>`;
  return `${g}</svg>`;
}

function readout(v) {
  const { esc, api } = H;
  const i = clamp(S.idx ?? v.pts.length - 1, 0, v.pts.length - 1);
  const p = v.pts[i];
  const sel = lines(v.t)[0].id;
  const rows = everyLine(v.t).map((l) => `<div class="tr-r${l.id === sel ? ' sel' : ''}"><i class="tr-sw tr-c-${esc(l.id)}"></i><span>${esc(l.label)}</span><b>${esc(api.money(valueOf(p, l.id), { sign: false }))}</b></div>`).join('');
  const carried = p.carried.total;
  const note = carried > 0 ? `<p class="tr-rn">${carried} ${carried === 1 ? 'account is' : 'accounts are'} carried forward here</p>` : '';
  return `<time datetime="${esc(p.date)}">${esc(dayLabel(p.date))}</time>${rows}${note}`;
}

function partRow(v, id, label, figKey) {
  const { esc, figHtml } = H;
  const on = lines(v.t)[0].id === id;
  return `<li class="tr-part" data-part="${esc(id)}"><button type="button" class="tr-tog${on ? ' on' : ''}" data-trend-part="${esc(id)}" aria-pressed="${on}"><i class="tr-sw tr-c-${esc(id)}"></i>${esc(label)}</button><b>${figKey ? figHtml(figKey, { k: true }) : ''}</b></li>`;
}

// The Money trend: headline, range, chart, readout and the parts with their current values.
export function render() {
  const { esc, section, figHtml } = H;
  const v = view();
  if (!v) return '';
  const { t } = v;
  const cur = t.points.at(-1);
  const range = RANGES.map(([r]) => `<button type="button" class="tr-rng${r === S.range ? ' on' : ''}" data-trend-range="${r}" aria-pressed="${r === S.range}">${r}</button>`).join('');
  const parts = [partRow(v, 'total', 'Net worth', t.fig.total), ...t.parts.map((p) => partRow(v, p.id, p.label, t.fig.parts[p.id]))].join('');
  const key = '<div class="tr-key"><span><i class="tr-k solid"></i>Reported balances</span><span><i class="tr-k dash"></i>Includes a carried-forward balance</span></div>';
  const notes = [
    t.note ? `<p class="tr-note" data-trend-note>${esc(t.note.charAt(0).toUpperCase() + t.note.slice(1))}. Its last balance is used until new data arrives.</p>` : '',
    t.pending ? `<p class="tr-note">${t.pending} ${t.pending === 1 ? 'account has' : 'accounts have'} one balance so far and joins the trend with its next upload.</p>` : '',
    '<p class="tr-note">Net worth adds every account, business cash included, with debt subtracted.</p>',
  ].join('');
  const body = `<div class="tr-card" data-trend>
    <div class="tr-top"><div class="tr-head"><span>Net worth</span><b data-trend-total>${figHtml(t.fig.total, { k: true })}</b><small>as of ${esc(dayLabel(cur.date))}</small></div>
    <div class="tr-rngs" role="group" aria-label="Range">${range}</div></div>
    <div class="tr-plot">${chart(v)}</div>${key}
    <div class="tr-read" data-trend-read aria-live="polite">${readout(v)}</div>
    <ul class="tr-parts" aria-label="Show a part of net worth">${parts}</ul>${notes}</div>`;
  return section('Trend', body, 'Month-end balances, summed from your accounts', 'h-trend');
}

// One compact line for an Accounts group heading: its current total and where it has been.
export function groupSpark(group) {
  const { esc, figHtml } = H;
  const t = H.api.s.trend;
  const figKey = t?.fig?.groups?.[group];
  if (!figKey || !Array.isArray(t.points) || t.points.length < 2) return '';
  const pts = t.points.slice(-12);
  const vals = pts.map((p) => p.groups[group] ?? 0);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 240, Ht = 36, P = 3;
  const sx = (i) => P + (i / (pts.length - 1)) * (W - P * 2);
  const sy = (val) => P + (1 - (val - lo) / ((hi - lo) || 1)) * (Ht - P * 2);
  const carried = (p) => (p.carried.groups[group] || 0) > 0;
  const rs = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const dashed = carried(pts[i]);
    if (!cur || cur.dashed !== dashed) { cur = { dashed, xy: [`${sx(i - 1)},${sy(vals[i - 1])}`] }; rs.push(cur); }
    cur.xy.push(`${sx(i)},${sy(vals[i])}`);
  }
  const line = rs.map((r) => `<polyline class="${r.dashed ? 'carried' : ''}" points="${r.xy.join(' ')}"/>`).join('');
  return `<div class="tr-gs" data-group-trend="${esc(group)}"><b>${figHtml(figKey, { k: true })}</b><svg viewBox="0 0 ${W} ${Ht}" preserveAspectRatio="none" role="img" aria-label="${esc(`${group} balance, ${monthLabel(pts[0].date)} to ${monthLabel(pts.at(-1).date)}`)}">${line}<circle cx="${sx(pts.length - 1)}" cy="${sy(vals.at(-1))}" r="2.5"/></svg><span>${esc(monthLabel(pts[0].date))} to ${esc(monthLabel(pts.at(-1).date))}</span></div>`;
}

// Move the cursor without redrawing: the guide, the dots and the readout.
function setIdx(i) {
  const v = view();
  const root = H.root;
  if (!v || !G || !root) return;
  S.idx = clamp(i, 0, v.pts.length - 1);
  const x = G.sx(S.idx);
  const guide = root.querySelector('[data-trend-guide]');
  if (guide) { guide.setAttribute('x1', x); guide.setAttribute('x2', x); }
  root.querySelectorAll('[data-trend-dot]').forEach((d) => {
    d.setAttribute('cx', x);
    d.setAttribute('cy', G.sy(valueOf(v.pts[S.idx], d.getAttribute('data-trend-dot'))));
  });
  const read = root.querySelector('[data-trend-read]');
  if (read) read.innerHTML = readout(v);
}

export function handlePointer(e) {
  if (e.type !== 'pointermove' && e.type !== 'pointerdown') return false;
  const hit = e.target.closest?.('[data-trend-hit]');
  if (!hit || !G) return false;
  const r = hit.ownerSVGElement.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * G.W;
  setIdx(Math.round(((px - G.L) / (G.W - G.L - G.R)) * (G.n - 1)));
  return true;
}

export function onKey(e) {
  if (!e.target.matches?.('[data-trend-hit]') || !G) return false;
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  const cur = S.idx ?? G.n - 1;
  if (step) setIdx(cur + step);
  else if (e.key === 'Home') setIdx(0);
  else if (e.key === 'End') setIdx(G.n - 1);
  else return false;
  e.preventDefault();
  return true;
}

export function onClick(e) {
  const rng = e.target.closest?.('[data-trend-range]');
  if (rng) { S.range = rng.getAttribute('data-trend-range'); S.idx = null; H.draw(); return true; }
  const part = e.target.closest?.('[data-trend-part]');
  if (part) {
    S.sel = part.getAttribute('data-trend-part');
    H.draw();
    return true;
  }
  return false;
}

/* Horizon Ask blocks: the chart renderer (docs/plans/rich-ask-answers.md section 2, Charts and
   Accessibility). Draws a chart snapshot (section 5): line, bar and area over an ordered x (bar and
   area may be stacked), or a scatter of one figure against another with its frontier polyline.

   Every drawn value is a mark carrying its figure's blk: key (.fx-fig, so a click opens the
   provenance popover); a missing point or an unavailable figure leaves a gap in a line and an
   empty bar. Axis ticks are scale marks from niceTicks, formatted by unit, aria-hidden and without
   provenance. The SVG is role="img" with a summary built from the data.

   Keyboard: the plot is one tab stop. Left and Right (Home, End) move the active point, Up and
   Down change series, the readout under the plot is an aria-live="polite" region that names the
   active point and value, Enter or Space opens the popover for the active figure, and Escape
   (handled by the popover) closes it with focus left on the plot. A Table button (aria-pressed)
   swaps the plot for the same figures drawn by the table renderer.

   View state (the shell's blockState): table, at ({ s, i }: the active series and point) and w
   (the plot width bind measured; 560 before that). The plot is 200px tall up to 480px wide and
   16:9 up to 240px above. */

import * as table from './ask-block-table.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const r1 = (n) => Math.round(n * 10) / 10;
const num = (f) => (isObj(f) && typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : null);
const DEFAULT_W = 560;
const DENSE = 24;

// Scale marks for an axis from lo to hi, about n steps of 1, 2, 2.5 or 5 times a power of ten.
// Copied from design.js (B9 removes that copy).
export function niceTicks(lo, hi, n = 5) {
  const raw = (hi - lo) / n || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) || raw;
  const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = t0; v <= t1 + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function plotSize(w) {
  const W = Math.max(200, Math.round(Number(w) || DEFAULT_W));
  return { W, H: W <= 480 ? 200 : Math.min(240, Math.round((W * 9) / 16)) };
}

// The text a figure reads as: its quote, its value by unit, or Unavailable.
const shown = (f, ctx) => (f.value === null || f.value === undefined ? 'Unavailable'
  : typeof f.quote === 'string' && f.quote ? f.quote : ctx.formatByUnit(f.value, f.unit));

const words = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

/* ---------- shared with the timeline renderer ---------- */

export function toggleHtml(ctx) {
  return `<div class="h-blk-tools"><button type="button" class="h-blk-tog" aria-pressed="${ctx.state.table ? 'true' : 'false'}" data-blk-ctl="${ctx.esc(ctx.ctl('table'))}">Table</button></div>`;
}

// The table renderer draws { t: 'fig', fig } cells through ctx.fig(cell); block figures are
// registered by the figure itself, so the cell is mapped to its figure.
export function tableHtml(tsnap, ctx) {
  return table.render(tsnap, { ...ctx, fig: (c) => ctx.fig(isObj(c) && isObj(c.fig) ? c.fig : c) });
}

export function bindToggle(root, tsnap, ctx) {
  table.bind(root, tsnap, ctx);
  root.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button.h-blk-tog');
    if (!b || !root.contains(b)) return;
    e.preventDefault();
    ctx.state.table = !ctx.state.table;
    ctx.redraw();
  });
}

const figCell = (f) => (isObj(f) ? { t: f.value === null ? 'none' : 'fig', fig: f } : { t: 'none' });

/* ---------- the same data as a table ---------- */

// The x column's heading: Month or Year when every x reads as one, otherwise Item.
function xHead(xs) {
  const t = xs.map((x) => String(x.text || ''));
  if (t.length && t.every((s) => /^[A-Z][a-z]{2} \d{4}$/.test(s))) return 'Month';
  if (t.length && t.every((s) => /^\d{4}$/.test(s))) return 'Year';
  return 'Item';
}

export function tableOf(s) {
  if (s.kind === 'scatter') {
    return {
      title: s.title,
      columns: [{ label: 'Point', type: 'text' }, { label: s.xLabel, unit: s.xUnit, type: 'fig' }, { label: s.yLabel, unit: s.yUnit, type: 'fig' }],
      rows: arr(s.points).filter(isObj).map((p) => ({ cells: [{ t: 'text', text: p.label }, figCell(p.x), figCell(p.y)] })),
    };
  }
  const ser = arr(s.series).filter(isObj);
  const xs = arr(s.x);
  return {
    title: s.title,
    columns: [{ label: xHead(xs), type: 'text' }, ...ser.map((se) => ({ label: se.label, unit: se.unit, type: 'fig' }))],
    // The x column sorts in x order (months as months, not alphabetically).
    rows: xs.map((x, i) => ({ cells: [{ t: 'text', text: x.text, sort: i }, ...ser.map((se) => figCell(arr(se.points)[i]))] })),
  };
}

/* ---------- summaries ---------- */

export function summary(s, ctx) {
  if (s.kind === 'scatter') {
    const pts = arr(s.points).filter(isObj);
    const fr = pts.filter((p) => p.frontier).length;
    const cur = pts.find((p) => p.current);
    return `Scatter chart of ${s.yLabel} against ${s.xLabel}, ${pts.length} point${pts.length === 1 ? '' : 's'}`
      + (fr ? `, ${fr} on the frontier` : '') + '.' + (cur ? ` Now: ${cur.label}.` : '');
  }
  const ser = arr(s.series).filter(isObj);
  const xs = arr(s.x);
  const kind = { line: 'Line', bar: 'Bar', area: 'Area' }[s.kind] || 'Line';
  const head = `${s.stacked && s.kind !== 'line' ? `Stacked ${kind.toLowerCase()}` : kind} chart of ${words(ser.map((x) => x.label))}`;
  const span = xs.length ? `, ${xs[0].text} to ${xs.at(-1).text}, ${xs.length} point${xs.length === 1 ? '' : 's'}` : '';
  const ranges = ser.map((se) => {
    const v = arr(se.points).map(num).filter((x) => x !== null);
    if (!v.length) return `${se.label} has no values`;
    return `${se.label} from ${ctx.formatByUnit(Math.min(...v), se.unit)} to ${ctx.formatByUnit(Math.max(...v), se.unit)}`;
  });
  return `${head}${span}. ${ranges.join('; ')}.`;
}

/* ---------- drawing ---------- */

function yScale(lo, hi, top, bottom) {
  if (lo === hi) { lo -= Math.abs(lo) || 1; hi += Math.abs(hi) || 1; }
  const ticks = niceTicks(lo, hi, 4);
  const y0 = ticks[0], y1 = ticks.at(-1);
  return { ticks, sy: (v) => r1(top + (1 - (v - y0) / ((y1 - y0) || 1)) * (bottom - top)), y0, y1 };
}

const tickW = (labels) => Math.min(76, Math.max(28, Math.max(...labels.map((t) => t.length)) * 6.3 + 10));

// One mark's data attributes: its figure key, what the readout says, and where it sits.
function markAttrs(ctx, f, s, i, t, cx, cy) {
  const key = f ? ctx.figKey(f) : '';
  return ` data-s="${s}" data-i="${i}" data-cx="${cx}" data-cy="${cy}" data-t="${ctx.esc(t)}"`
    + (key ? ` data-fig="${ctx.esc(key)}" data-kind="${ctx.esc(f.kind || 'e')}" data-v="${ctx.esc(shown(f, ctx))}"${f.value === null ? ' data-unavailable="1"' : ''}` : '');
}

function seriesSvg(s, ctx, W, H, at) {
  const { esc } = ctx;
  const ser = arr(s.series).filter(isObj);
  const xs = arr(s.x);
  const n = Math.max(1, xs.length);
  const unit = ser[0] ? ser[0].unit : '';
  const bars = s.kind === 'bar';
  const stacked = !!s.stacked && s.kind !== 'line';
  const vals = ser.map((se) => Array.from({ length: n }, (_, i) => num(arr(se.points)[i])));
  const base = ser.map(() => Array(n).fill(0));
  let lo = Infinity, hi = -Infinity;
  if (stacked) {
    for (let i = 0; i < n; i += 1) {
      let pos = 0, neg = 0;
      vals.forEach((row, j) => {
        const v = row[i];
        if (v === null) return;
        if (v >= 0) { base[j][i] = pos; pos += v; } else { base[j][i] = neg; neg += v; }
      });
      lo = Math.min(lo, neg); hi = Math.max(hi, pos);
    }
  } else {
    for (const v of vals.flat()) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (s.kind !== 'line' && lo !== Infinity) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  }
  if (lo === Infinity) { lo = 0; hi = 1; }
  const Tp = 10, B = 24, R = 8;
  const pre = yScale(lo, hi, Tp, H - B);
  const tickText = pre.ticks.map((v) => ctx.formatByUnit(v, unit, { short: true }));
  const L = tickW(tickText);
  const { ticks, sy, y0, y1 } = pre;
  const pw = W - L - R;
  const slot = pw / n;
  const sx = bars ? (i) => r1(L + slot * (i + 0.5)) : (i) => r1(n === 1 ? L + pw / 2 : L + (i * pw) / (n - 1));
  let g = '';
  ticks.forEach((v, k) => {
    if (v !== 0) g += `<line class="h-blk-grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>`;
    g += `<text class="h-blk-tk" x="${L - 7}" y="${r1(sy(v) + 3.5)}" text-anchor="end">${esc(tickText[k])}</text>`;
  });
  // x labels: as many as fit without overlapping. A line shows its first and last label, anchored
  // inward, and drops a middle label that would run into either.
  const lw = Math.max(...xs.map((x) => String(x.text || '').length), 1) * 6.6 + 12;
  const every = Math.max(1, Math.ceil((n * lw) / pw));
  const ends = !bars && n > 1;
  xs.forEach((x, i) => {
    const last = i === n - 1;
    if (i % every !== 0 && !(ends && last)) return;
    if (ends && i > 0 && !last && (sx(i) - sx(0) < 1.5 * lw || sx(n - 1) - sx(i) < 1.5 * lw)) return;
    if (ends && last && i !== 0 && sx(i) - sx(0) < 2 * lw) return;
    const anchor = !ends ? 'middle' : i === 0 ? 'start' : last ? 'end' : 'middle';
    g += `<text class="h-blk-tk" x="${sx(i)}" y="${H - 7}" text-anchor="${anchor}">${esc(x.text)}</text>`;
  });
  if (y0 <= 0 && y1 >= 0) g += `<line class="h-blk-zero" x1="${L}" x2="${W - R}" y1="${sy(0)}" y2="${sy(0)}"/>`;
  const top = (j, i) => (vals[j][i] === null ? null : (stacked ? base[j][i] : 0) + vals[j][i]);
  let marks = '';
  if (bars) {
    const gw = slot * 0.72;
    const bw = stacked ? gw : gw / Math.max(1, ser.length);
    const z = sy(Math.max(y0, Math.min(0, y1)));
    ser.forEach((se, j) => {
      for (let i = 0; i < n; i += 1) {
        const f = arr(se.points)[i];
        const x = r1(sx(i) - gw / 2 + (stacked ? 0 : j * bw));
        const w = r1(Math.max(1, bw - (stacked || ser.length === 1 ? 0 : 1.5)));
        const on = at.s === j && at.i === i ? ' on' : '';
        const t = `${se.label}, ${xs[i] ? xs[i].text : ''}`;
        const v = vals[j][i];
        if (v === null) {
          // An empty bar: a dashed outline at the baseline for an unavailable figure, nothing for a missing point.
          const cls = isObj(f) ? 'h-blk-bar na' : 'h-blk-bar none';
          marks += `<rect class="${cls}${isObj(f) ? ' fx-fig' : ''} c${j + 1}${on}"${markAttrs(ctx, isObj(f) ? f : null, j, i, t, r1(x + w / 2), r1(z - 4))} x="${x}" y="${r1(z - 8)}" width="${w}" height="8" rx="2"/>`;
          continue;
        }
        const b0 = sy(stacked ? base[j][i] : 0), b1 = sy(top(j, i));
        const y = Math.min(b0, b1), h = Math.max(1, Math.abs(b1 - b0));
        marks += `<rect class="h-blk-bar fx-fig c${j + 1}${on}"${markAttrs(ctx, f, j, i, t, r1(x + w / 2), r1(y + h / 2))} x="${x}" y="${r1(y)}" width="${w}" height="${r1(h)}" rx="2"><title>${esc(`${t}: ${shown(f, ctx)}`)}</title></rect>`;
      }
    });
    return { L, R, g: g + marks, area: '' };
  }
  // Line and area: one path per run of values; a missing or unavailable point breaks the run.
  let fills = '', lines = '';
  ser.forEach((se, j) => {
    let d = '', fill = '', run = [];
    const flush = () => {
      if (!run.length) return;
      d += run.map(([i], k) => `${k ? 'L' : 'M'}${sx(i)} ${sy(top(j, i))}`).join(' ') + ' ';
      if (s.kind === 'area') {
        const back = [...run].reverse().map(([i]) => `L${sx(i)} ${sy(stacked ? base[j][i] : Math.max(y0, Math.min(0, y1)))}`).join(' ');
        fill += `${run.map(([i], k) => `${k ? 'L' : 'M'}${sx(i)} ${sy(top(j, i))}`).join(' ')} ${back} Z `;
      }
      run = [];
    };
    for (let i = 0; i < n; i += 1) { if (vals[j][i] === null) flush(); else run.push([i]); }
    flush();
    if (fill) fills += `<path class="h-blk-ar c${j + 1}" d="${fill.trim()}"/>`;
    lines += `<path class="h-blk-ln c${j + 1}" data-s="${j}" d="${d.trim()}"/>`;
  });
  const dense = n > DENSE;
  ser.forEach((se, j) => {
    for (let i = 0; i < n; i += 1) {
      const f = arr(se.points)[i];
      const v = top(j, i);
      const on = at.s === j && at.i === i ? ' on' : '';
      const t = `${se.label}, ${xs[i] ? xs[i].text : ''}`;
      // A point with no value sits on the baseline, invisible, so the keyboard can still land on it.
      const cy = v === null ? sy(Math.max(y0, Math.min(0, y1))) : sy(v);
      const solo = v !== null && (i === 0 || top(j, i - 1) === null) && (i === n - 1 || top(j, i + 1) === null) ? ' solo' : '';
      const cls = v === null ? (isObj(f) ? ' na fx-fig' : ' none') : ' fx-fig';
      marks += `<circle class="h-blk-pt${cls} c${j + 1}${on}${solo}"${markAttrs(ctx, isObj(f) ? f : null, j, i, t, sx(i), cy)} cx="${sx(i)}" cy="${cy}" r="${v === null ? 0 : 3.5}">${isObj(f) ? `<title>${esc(`${t}: ${shown(f, ctx)}`)}</title>` : ''}</circle>`;
    }
  });
  const gx = sx(Math.min(n - 1, Math.max(0, at.i)));
  const guide = `<line class="h-blk-guide" x1="${gx}" x2="${gx}" y1="${Tp}" y2="${H - B}"/>`;
  return { L, R, g: g + fills + guide + lines + marks, dense };
}

function scatterSvg(s, ctx, W, H, at) {
  const { esc } = ctx;
  const pts = arr(s.points).filter(isObj);
  const xv = pts.map((p) => num(p.x)), yv = pts.map((p) => num(p.y));
  const fin = (l) => l.filter((v) => v !== null);
  const Tp = 22, B = 36, R = 10;
  const xsF = fin(xv), ysF = fin(yv);
  const ys = yScale(ysF.length ? Math.min(...ysF) : 0, ysF.length ? Math.max(...ysF) : 1, Tp, H - B);
  const tickText = ys.ticks.map((v) => ctx.formatByUnit(v, s.yUnit, { short: true }));
  const L = tickW(tickText);
  let lo = xsF.length ? Math.min(...xsF) : 0, hi = xsF.length ? Math.max(...xsF) : 1;
  if (lo === hi) { lo -= Math.abs(lo) || 1; hi += Math.abs(hi) || 1; }
  const xt = niceTicks(lo, hi, W < 420 ? 3 : 5);
  const x0 = xt[0], x1 = xt.at(-1);
  const sx = (v) => r1(L + ((v - x0) / ((x1 - x0) || 1)) * (W - L - R));
  const { sy } = ys;
  let g = '';
  ys.ticks.forEach((v, k) => {
    g += `<line class="h-blk-grid${v === 0 ? ' z' : ''}" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>`;
    g += `<text class="h-blk-tk" x="${L - 7}" y="${r1(sy(v) + 3.5)}" text-anchor="end">${esc(tickText[k])}</text>`;
  });
  xt.forEach((v, k) => {
    const anchor = k === 0 ? 'start' : k === xt.length - 1 ? 'end' : 'middle';
    g += `<text class="h-blk-tk" x="${sx(v)}" y="${H - B + 16}" text-anchor="${anchor}">${esc(ctx.formatByUnit(v, s.xUnit, { short: true }))}</text>`;
  });
  g += `<text class="h-blk-ax" x="${L}" y="12">${esc(s.yLabel)}</text>`;
  g += `<text class="h-blk-ax" x="${W - R}" y="${H - 5}" text-anchor="end">${esc(s.xLabel)}</text>`;
  const fr = pts.map((p, i) => [p, i]).filter(([p, i]) => p.frontier && xv[i] !== null && yv[i] !== null).sort((a, b) => xv[a[1]] - xv[b[1]]);
  if (fr.length > 1) g += `<polyline class="h-blk-front" points="${fr.map(([, i]) => `${sx(xv[i])},${sy(yv[i])}`).join(' ')}"/>`;
  const order = pts.map((p, i) => i).sort((a, b) => (xv[a] ?? Infinity) - (xv[b] ?? Infinity) || (yv[a] ?? 0) - (yv[b] ?? 0) || a - b);
  const rank = new Map(order.map((i, r) => [i, r]));
  pts.forEach((p, i) => {
    if (xv[i] === null || yv[i] === null) return;
    const cx = sx(xv[i]), cy = sy(yv[i]);
    if (p.current) g += `<circle class="h-blk-ring" cx="${cx}" cy="${cy}" r="9"/>`;
  });
  pts.forEach((p, i) => {
    const ok = xv[i] !== null && yv[i] !== null;
    const cx = ok ? sx(xv[i]) : L, cy = ok ? sy(yv[i]) : H - B;
    const on = at.i === i ? ' on' : '';
    const kx = isObj(p.x) ? ctx.figKey(p.x) : '';
    const extra = kx ? ` data-o="${rank.get(i)}" data-fig2="${esc(kx)}" data-kind2="${esc(p.x.kind || 'e')}" data-v2="${esc(shown(p.x, ctx))}"${p.x.value === null ? ' data-unavailable2="1"' : ''}` : ` data-o="${rank.get(i)}"`;
    g += `<circle class="h-blk-pt fx-fig c1${p.frontier ? ' fr' : ''}${p.current ? ' cur' : ''}${on}"${markAttrs(ctx, isObj(p.y) ? p.y : null, 0, i, p.label, cx, cy)}${extra} cx="${cx}" cy="${cy}" r="${ok ? 5 : 0}"><title>${esc(`${p.label}${p.current ? ' (now)' : ''}`)}</title></circle>`;
  });
  return { L, R, g };
}

// The active point: the stored one, else the last value of the first series (a scatter's current point).
function activeOf(s, state) {
  if (s.kind === 'scatter') {
    const pts = arr(s.points);
    const i = state.at && Number.isInteger(state.at.i) ? state.at.i : Math.max(0, pts.findIndex((p) => isObj(p) && p.current));
    return { s: 0, i: Math.min(Math.max(0, i), Math.max(0, pts.length - 1)) };
  }
  const ser = arr(s.series).filter(isObj);
  const n = Math.max(1, arr(s.x).length);
  if (state.at && Number.isInteger(state.at.s) && Number.isInteger(state.at.i)) {
    return { s: Math.min(Math.max(0, state.at.s), Math.max(0, ser.length - 1)), i: Math.min(Math.max(0, state.at.i), n - 1) };
  }
  const pts = ser[0] ? arr(ser[0].points) : [];
  let i = n - 1;
  while (i > 0 && num(pts[i]) === null) i -= 1;
  return { s: 0, i };
}

function readHtml(s, ctx, at) {
  const { esc } = ctx;
  if (s.kind === 'scatter') {
    const p = arr(s.points)[at.i];
    if (!isObj(p)) return '';
    return `<span class="h-blk-read-t">${esc(p.label)}</span> ${esc(s.xLabel)} ${isObj(p.x) ? ctx.fig(p.x) : 'no value'}, ${esc(s.yLabel)} ${isObj(p.y) ? ctx.fig(p.y) : 'no value'}`;
  }
  const se = arr(s.series)[at.s];
  if (!isObj(se)) return '';
  const f = arr(se.points)[at.i];
  const x = arr(s.x)[at.i];
  return `<span class="h-blk-read-t">${esc(`${se.label}, ${x ? x.text : ''}`)}</span> ${isObj(f) ? ctx.fig(f) : 'no value'}`;
}

export function render(snapshot, ctx) {
  const s = snapshot;
  const { esc, state } = ctx;
  if (state.table) return toggleHtml(ctx) + tableHtml(tableOf(s), ctx);
  const { W, H } = plotSize(state.w);
  const at = activeOf(s, state);
  const scatter = s.kind === 'scatter';
  const d = scatter ? scatterSvg(s, ctx, W, H, at) : seriesSvg(s, ctx, W, H, at);
  const ser = scatter ? [] : arr(s.series).filter(isObj);
  const legend = ser.length > 1
    ? `<ul class="h-blk-key">${ser.map((se, j) => `<li><i class="c${j + 1}${s.kind === 'bar' ? ' sq' : ''}"></i>${esc(se.label)}</li>`).join('')}</ul>`
    : '';
  return toggleHtml(ctx)
    + `<div class="h-blk-plot${d.dense ? ' dense' : ''}" tabindex="0" role="group" aria-roledescription="chart" aria-label="${esc(s.title || 'Chart')}. Arrow keys move between ${scatter ? 'points' : 'points and series'}, Enter shows the source." data-blk-ctl="${esc(ctx.ctl('plot'))}"${scatter ? ` data-scatter="1" data-xl="${esc(s.xLabel)}" data-yl="${esc(s.yLabel)}"` : ''} data-n="${scatter ? arr(s.points).length : Math.max(1, arr(s.x).length)}" data-ns="${scatter ? 1 : ser.length}">`
    + `<svg class="h-blk-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(summary(s, ctx))}">${d.g}</svg></div>`
    + legend
    + `<p class="h-blk-read" aria-live="polite" aria-atomic="true">${readHtml(s, ctx, at)}</p>`;
}

/* ---------- binding (browser only) ---------- */

function figSpan(key, kind, text, na) {
  const el = document.createElement('span');
  el.className = 'fx-fig';
  el.setAttribute('data-fig', key);
  el.setAttribute('data-kind', kind || 'e');
  if (na) el.setAttribute('data-unavailable', '1');
  el.tabIndex = 0;
  el.textContent = text;
  return el;
}

// The readout for a mark, built from the mark's own data attributes (the same text render writes).
function setRead(root, plot, mk) {
  const p = root.querySelector('.h-blk-read');
  if (!p || !mk) return;
  const t = document.createElement('span');
  t.className = 'h-blk-read-t';
  t.textContent = mk.getAttribute('data-t') || '';
  const parts = [t, ' '];
  const main = () => (mk.hasAttribute('data-fig')
    ? figSpan(mk.getAttribute('data-fig'), mk.getAttribute('data-kind'), mk.getAttribute('data-v'), mk.hasAttribute('data-unavailable'))
    : 'no value');
  if (plot.hasAttribute('data-scatter')) {
    parts.push(`${plot.getAttribute('data-xl')} `);
    parts.push(mk.hasAttribute('data-fig2')
      ? figSpan(mk.getAttribute('data-fig2'), mk.getAttribute('data-kind2'), mk.getAttribute('data-v2'), mk.hasAttribute('data-unavailable2'))
      : 'no value');
    parts.push(`, ${plot.getAttribute('data-yl')} `);
  }
  parts.push(main());
  p.replaceChildren(...parts);
}

export function bind(root, snapshot, ctx) {
  bindToggle(root, tableOf(snapshot), ctx);
  const plot = root.querySelector('.h-blk-plot');
  if (!plot) return;
  const st = ctx.state;
  // Draw at the measured width so text stays at its size; redraw when the column changes width.
  const measure = () => {
    const w = Math.round(plot.clientWidth);
    if (w > 0 && Math.abs(w - plotSize(st.w).W) > 2) { st.w = w; ctx.redraw(); return true; }
    return false;
  };
  if (measure()) return;
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (!root.isConnected || measure()) ro.disconnect(); });
    ro.observe(plot);
  }
  const scatter = plot.hasAttribute('data-scatter');
  const n = Number(plot.getAttribute('data-n')) || 1;
  const ns = Number(plot.getAttribute('data-ns')) || 1;
  const markAt = (s, i) => plot.querySelector(`[data-s="${s}"][data-i="${i}"]`);
  const current = () => {
    const on = plot.querySelector('[data-s][data-i].on');
    return on ? { s: Number(on.getAttribute('data-s')), i: Number(on.getAttribute('data-i')) } : activeOf(snapshot, st);
  };
  const paint = (at) => {
    st.at = at;
    for (const el of plot.querySelectorAll('[data-s][data-i].on')) el.classList.remove('on');
    const mk = markAt(at.s, at.i);
    if (!mk) return;
    mk.classList.add('on');
    const guide = plot.querySelector('.h-blk-guide');
    if (guide) { guide.setAttribute('x1', mk.getAttribute('data-cx')); guide.setAttribute('x2', mk.getAttribute('data-cx')); }
    setRead(root, plot, mk);
  };
  plot.addEventListener('keydown', (e) => {
    if (e.target !== plot || e.altKey || e.ctrlKey || e.metaKey) return;
    const at = current();
    let next = null;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const mk = markAt(at.s, at.i);
      const api = typeof window !== 'undefined' && window.Fathom && window.Fathom.api;
      if (mk && mk.hasAttribute('data-fig') && api && typeof api.figPopover === 'function') api.figPopover(mk);
      return;
    }
    if (scatter) {
      const order = [...plot.querySelectorAll('[data-o]')].sort((a, b) => Number(a.getAttribute('data-o')) - Number(b.getAttribute('data-o')));
      const r = order.findIndex((el) => Number(el.getAttribute('data-i')) === at.i);
      const to = { ArrowLeft: r - 1, ArrowRight: r + 1, Home: 0, End: order.length - 1 }[e.key];
      if (to === undefined && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const el = order[Math.min(Math.max(0, to ?? r), order.length - 1)];
      if (el) next = { s: 0, i: Number(el.getAttribute('data-i')) };
    } else {
      const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], Home: [0, -n], End: [0, n] };
      const mv = moves[e.key];
      if (!mv) return;
      next = { s: Math.min(Math.max(0, at.s + mv[0]), ns - 1), i: Math.min(Math.max(0, at.i + mv[1]), n - 1) };
    }
    e.preventDefault();
    if (next) paint(next);
  });
  // A pointer over the plot makes the nearest drawn value active.
  plot.addEventListener('pointermove', (e) => {
    const svg = plot.querySelector('svg');
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (!box.width || !vb) return;
    const px = ((e.clientX - box.left) * vb.width) / box.width;
    const py = ((e.clientY - box.top) * vb.height) / box.height;
    let best = null, bd = Infinity;
    for (const el of plot.querySelectorAll('[data-s][data-i][data-fig]')) {
      const dx = Number(el.getAttribute('data-cx')) - px, dy = Number(el.getAttribute('data-cy')) - py;
      const dist = scatter || el.tagName.toLowerCase() === 'rect' ? dx * dx + dy * dy : dx * dx * 16 + dy * dy;
      if (dist < bd) { bd = dist; best = el; }
    }
    if (best && !best.classList.contains('on')) paint({ s: Number(best.getAttribute('data-s')), i: Number(best.getAttribute('data-i')) });
  });
}

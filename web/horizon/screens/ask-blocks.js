/* Horizon Ask blocks: the shell that draws a Fathom message's stored blocks (provenance.blocks)
   and block notes (provenance.blockNotes), as docs/plans/rich-ask-answers.md sections 2 and 5 pin.
   A block is drawn only from its stored snapshot, the deterministic render model the server built;
   nothing here reads model text, computes a figure or calls a tool.

   messageBodyHtml(m) is the inner html of a message body: m.html's top level paragraphs with each
   block placed after paragraph `after` (past the end: after the last one, in call order), then the
   notes as muted lines, then provenance.leftOut as a "What this leaves out" note, one line per
   entry with its fix control (gapControl; design.js routes the click). A message with none of these
   keeps m.html as is. Each block is a <figure> with
   its escaped title as the <figcaption>, drawn by the renderer for its op from RENDERERS; an op
   with no renderer draws its dropped note instead. Every value a block draws is a .fx-fig span
   whose figure is registered through api.registerFigures under blk:<messageId>:<blockId>:<n>, n
   the figure's place in the snapshot (stable under sorting), so the figure popover shows its
   value by unit, label, source, as-of date and gaps.

   Renderers export render(snapshot, ctx) -> html and bind(root, snapshot, ctx). ctx carries the
   escaper, fig(cell) for a figure span, figKey(holder) for its blk: key, the block's view state (sort, filter, all) and ctl(name)
   for a control's data-blk-ctl value "<messageId>:<blockId>:<name>", the key the Ask panel's
   focus signature restores focus by. bind wires the block's controls; the shell calls it for each
   drawn block (a MutationObserver finds blocks a screen inserts) and gives it ctx.redraw(), which
   redraws that one block in place from its state and puts focus back on the same control.

   The kit (esc, money, registerFigures) comes from useKit and the only other import is the pure
   gapControl, so the module also runs in Node tests. */

import * as table from './ask-block-table.js';
import * as compare from './ask-block-compare.js';
import * as chart from './ask-block-chart.js';
import * as timeline from './ask-block-timeline.js';
import { gapControl } from '../../core/gap-control.js';

export const RENDERERS = { table, compare, chart, timeline };

const OP_NOUN = { chart: 'A chart', table: 'A table', compare: 'A comparison', timeline: 'A timeline' };
export const dropNote = (op) => `${OP_NOUN[op] || 'A block'} was left out because its data did not check out.`;

let K = { esc: (v) => String(v == null ? '' : v), money: (n) => String(n), registerFigures: () => {} };
export function useKit(kit) { K = { ...K, ...kit }; }

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

/* ---------- formatting ---------- */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONEY = new Set(['usd', 'usd_per_month', 'usd_per_year']);
const PER = { usd_per_month: ' a month', usd_per_year: ' a year' };
const WORD = { months: 'month', years: 'year', days: 'day' };
const sig = (n) => String(Number(Number(n).toPrecision(6)));

// A date figure or label: 2026-03 reads "Mar 2026", 2045-06-01 reads "Jun 1, 2045".
function dateText(v) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(v));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return String(v);
  return m[3] ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : `${MON[Number(m[2]) - 1]} ${m[1]}`;
}

// A value as text for its unit; short writes money as $45K. Null is Unavailable.
export function formatByUnit(value, unit, { short = false } = {}) {
  if (value === null || value === undefined) return 'Unavailable';
  if (unit === 'date') return dateText(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (MONEY.has(unit)) {
    const cents = Math.round(Math.abs(n) * 100) % 100 !== 0;
    return K.money(n, short ? { k: true } : cents ? { cents: true } : undefined) + (PER[unit] || '');
  }
  if (unit === 'ratio') return `${sig(n * 100)}%`;
  if (unit === 'age') return Number.isInteger(n) ? String(n) : `${Math.trunc(n)} and a half`;
  if (WORD[unit]) return `${sig(n)} ${WORD[unit]}${n === 1 ? '' : 's'}`;
  return sig(n);
}

/* ---------- figures ---------- */

// Every drawable figure of a snapshot in a fixed order: [cell or figure, registered entry].
// A row cell's provenance is its row (account, date, description).
function figureList(snapshot) {
  const out = [];
  const add = (holder, f) => out.push([holder, {
    value: f.value ?? null, unit: f.unit, label: f.label || '', kind: f.kind || 'e', asOf: f.asOf || '',
    source: f.source || '', gaps: arr(f.gaps), provenance: isObj(f.provenance) ? f.provenance : {},
    ...(typeof f.quote === 'string' ? { quote: f.quote } : {}),
  }]);
  for (const r of arr(snapshot.rows).concat(arr(snapshot.options))) {
    for (const c of arr(r && r.cells)) {
      if (!isObj(c)) continue;
      if ((c.t === 'fig' || c.t === 'none') && isObj(c.fig)) add(c, c.fig);
      else if (c.t === 'row' && isObj(c.row)) {
        // The readable name labels the figure; the bank's raw text stays one line below it.
        const raw = typeof c.row.description === 'string' && c.row.name && c.row.name !== c.row.description ? c.row.description : '';
        out.push([c, { value: c.value ?? null, unit: c.unit || 'usd', label: c.row.name || c.row.description || '', kind: 'a',
          asOf: c.row.date || '', source: c.row.account || '', gaps: [], provenance: { row: c.row },
          ...(raw ? { detail: [{ k: 'Bank text', v: raw }] } : {}) }]);
      }
    }
  }
  // Chart points (a scatter point's x and y) and timeline values register by the figure itself.
  for (const s of arr(snapshot.series)) for (const p of arr(s && s.points)) if (isObj(p)) add(p, p);
  for (const p of arr(snapshot.points)) for (const f of isObj(p) ? [p.x, p.y] : []) if (isObj(f)) add(f, f);
  for (const e of arr(snapshot.events)) if (isObj(e) && isObj(e.value)) add(e.value, e.value);
  return out;
}

/* ---------- state ---------- */

const STATE = new Map();
export function blockState(messageId, blockId) {
  const k = `${messageId}:${blockId}`;
  if (!STATE.has(k)) STATE.set(k, { sort: null, filter: '', all: false });
  return STATE.get(k);
}

// What bind needs to redraw a block: its message id and stored block, by data-blk key.
const LIVE = new Map();

/* ---------- drawing ---------- */

function ctxFor(messageId, block) {
  const key = `${messageId}:${block.id}`;
  const snap = block.snapshot;
  const figs = figureList(snap);
  const index = new Map(figs.map(([holder], i) => [holder, i]));
  const reg = {};
  figs.forEach(([, entry], i) => { reg[`blk:${key}:${i}`] = { ...entry, stale: blockState(messageId, block.id).status === 'stale' }; });
  K.registerFigures(reg);
  const fig = (holder) => {
    const i = index.get(holder);
    if (i == null) return '';
    const e = figs[i][1];
    const text = e.value === null ? 'Unavailable' : (typeof e.quote === 'string' && e.quote ? e.quote : formatByUnit(e.value, e.unit));
    return `<span class="fx-fig" data-fig="${K.esc(`blk:${key}:${i}`)}" data-kind="${K.esc(e.kind)}"${e.value === null ? ' data-unavailable="1"' : ''} tabindex="0">${K.esc(text)}</span>`;
  };
  return {
    key, esc: K.esc, fig, formatByUnit,
    figKey: (holder) => (index.has(holder) ? `blk:${key}:${index.get(holder)}` : ''),
    builtAt: typeof block.builtAt === 'string' ? block.builtAt : '',
    state: blockState(messageId, block.id),
    ctl: (name) => `${key}:${name}`,
    rowFigure: key => `<span class="fx-fig" data-fig="${K.esc(key)}" tabindex="0">${K.esc(formatByUnit(K.getApi?.()?.fig(key)?.v, 'usd'))}</span>`,
  };
}

function blockHtml(messageId, block) {
  const r = RENDERERS[block.op];
  if (!r || !isObj(block.snapshot)) return `<p class="h-blk-note">${K.esc(dropNote(block.op))}</p>`;
  const ctx = ctxFor(messageId, block);
  LIVE.set(ctx.key, { messageId, block });
  const title = typeof block.snapshot.title === 'string' ? block.snapshot.title : '';
  const status = ctx.state.status;
  const stamp = block.asOf || block.builtAt?.slice(0, 10) || '';
  const note = status === 'stale' ? `<p class="h-blk-note"><strong>Stale</strong> Your data changed after this answer. Values are as of ${K.esc(stamp)}. <button type="button" class="h-btn ghost" data-blk-ctl="${K.esc(ctx.ctl('again'))}">Ask again</button></p>`
    : status === 'unavailable' ? '<p class="h-blk-note">This data is no longer available</p>' : '';
  return `<figure class="h-blk h-blk-${K.esc(block.op)}" data-blk="${K.esc(ctx.key)}">`
    + `<figcaption class="h-blk-t">${K.esc(title)}</figcaption>`
    + note + (status === 'unavailable' ? '<div class="h-blk-unavailable">' : '<div>') + r.render(block.snapshot, ctx) + '</div>'
    + '</figure>';
}

// m.html split into its top level elements (paragraphs, lists), each kept whole.
function topLevel(html) {
  const out = [];
  const re = /<(\/?)(p|ul|ol|div|blockquote|pre|table|h[1-6])\b[^>]*>/gi;
  let depth = 0;
  let start = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) { out.push(html.slice(start, re.lastIndex)); start = re.lastIndex; }
    } else {
      if (depth === 0 && m.index > start && html.slice(start, m.index).trim()) { out.push(html.slice(start, m.index)); start = m.index; }
      else if (depth === 0) start = m.index;
      depth += 1;
    }
  }
  if (html.slice(start).trim()) out.push(html.slice(start));
  return out;
}

// The "What this leaves out" note: truncated reads first, then gaps, each with its fix control.
function leftOutNote(entries) {
  if (!entries.length) return '';
  const ordered = [...entries.filter((e) => e.code === 'truncated'), ...entries.filter((e) => e.code !== 'truncated')];
  const line = (e) => `<p data-left-out-code="${K.esc(e.code)}">${K.esc(e.text)}${e.fix ? ' ' + gapControl(e.fix, K.esc) : ''}</p>`;
  return `<div class="h-leftout" data-left-out role="note"><b>What this leaves out</b>${ordered.map(line).join('')}</div>`;
}

export function messageBodyHtml(m) {
  const html = m && typeof m.html === 'string' ? m.html : '';
  const pv = m && isObj(m.provenance) ? m.provenance : null;
  const blocks = pv ? arr(pv.blocks).filter((b) => isObj(b) && typeof b.id === 'string' && b.id) : [];
  const notes = pv ? arr(pv.blockNotes).filter((n) => isObj(n) && typeof n.text === 'string' && n.text) : [];
  const leftOut = pv ? arr(pv.leftOut).filter((e) => isObj(e) && typeof e.text === 'string' && e.text) : [];
  const leftOutHtml = leftOutNote(leftOut);
  if (!blocks.length && !notes.length) return html + leftOutHtml;
  const parts = topLevel(html);
  const after = new Map();
  for (const b of blocks) {
    const at = Math.min(parts.length, Math.max(0, Number.isInteger(b.after) ? b.after : parts.length));
    if (!after.has(at)) after.set(at, []);
    after.get(at).push(b);
  }
  let out = arr(after.get(0)).map((b) => blockHtml(m.id, b)).join('');
  parts.forEach((p, i) => { out += p + arr(after.get(i + 1)).map((b) => blockHtml(m.id, b)).join(''); });
  return out + notes.map((n) => `<p class="h-blk-note">${K.esc(n.text)}</p>`).join('') + leftOutHtml;
}

/* ---------- binding (browser only) ---------- */

function redraw(root) {
  if (!root || !root.isConnected) return;
  const live = LIVE.get(root.getAttribute('data-blk'));
  if (!live) return;
  const a = document.activeElement;
  const ctl = a && root.contains(a) ? a.getAttribute('data-blk-ctl') : null;
  const heading = a && root.contains(a) && a.hasAttribute('data-blk-drill-heading');
  const sel = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  const tmp = document.createElement('div');
  tmp.innerHTML = blockHtml(live.messageId, live.block);
  const next = tmp.firstElementChild;
  root.replaceWith(next);
  bindRoot(next);
  if (heading) next.querySelector('[data-blk-drill-heading]')?.focus({ preventScroll: true });
  if (!ctl) return;
  const t = next.querySelector(`[data-blk-ctl="${CSS.escape(ctl)}"]`);
  if (!t) return;
  t.focus({ preventScroll: true });
  if (sel && t.matches('input')) try { t.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ }
}

function bindRoot(root) {
  if (!root || root.hasAttribute('data-blk-bound')) return;
  const live = LIVE.get(root.getAttribute('data-blk'));
  const r = live && RENDERERS[live.block.op];
  if (!r || typeof r.bind !== 'function') return;
  const host = root.parentElement;
  root.setAttribute('data-blk-bound', '');
  root.addEventListener('click', async e => {
    const button = e.target.closest?.('[data-blk-ctl$=":again"]');
    if (!button || !root.contains(button)) return;
    const context = conversationFor(live.messageId);
    if (!context?.question) return;
    button.disabled = true;
    await K.askAgain(context.question, context.key);
    if (button.isConnected) button.disabled = false;
  });
  r.bind(root, live.block.snapshot, { ...ctxFor(live.messageId, live.block),
    redraw: () => redraw(host?.querySelector(`[data-blk="${CSS.escape(root.getAttribute('data-blk'))}"]`)),
    rows: drill => drill.route === 'spending' ? K.getApi().spendingRows(drill.query) : K.getApi().pnlRows(drill.query) });
}

function conversationFor(messageId) {
  for (const [key, list] of Object.entries(K.getApi?.()?.s?.live?.conversations || {})) {
    if (!key.startsWith('ask:')) continue;
    const index = list.findIndex(m => m.id === messageId);
    if (index < 0) continue;
    const question = list.slice(0, index).reverse().find(m => m.role === 'me')?.text;
    if (typeof document === 'undefined') return { key, question };
    const text = document.createElement('div'); text.innerHTML = question || '';
    return { key, question: text.textContent };
  }
  return null;
}

let opened = new Set();
let statusQueued = false;
function checkOpened() {
  if (statusQueued || !K.getApi?.()?.blockStatus) return;
  statusQueued = true;
  queueMicrotask(() => {
    statusQueued = false;
    const visible = new Set();
    for (const root of document.querySelectorAll('figure.h-blk[data-blk]')) {
      const live = LIVE.get(root.getAttribute('data-blk'));
      const context = live && conversationFor(live.messageId);
      if (context) visible.add(context.key);
    }
    for (const key of visible) if (!opened.has(key)) {
      K.getApi().blockStatus(key.slice(4)).then(data => {
        for (const b of arr(data?.blocks)) blockState(b.messageId, b.id).status = b.state;
        for (const root of document.querySelectorAll('figure.h-blk[data-blk]')) {
          const live = LIVE.get(root.getAttribute('data-blk'));
          if (live && conversationFor(live.messageId)?.key === key) redraw(root);
        }
      });
    }
    opened = visible;
  });
}

function bindAll(scope) {
  if (!scope || !scope.querySelectorAll) return;
  if (scope.matches && scope.matches('figure.h-blk')) bindRoot(scope);
  for (const el of scope.querySelectorAll('figure.h-blk:not([data-blk-bound])')) bindRoot(el);
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  const watch = () => {
    new MutationObserver((list) => {
      for (const rec of list) for (const n of rec.addedNodes) if (n.nodeType === 1) bindAll(n);
      checkOpened();
    }).observe(document.body, { childList: true, subtree: true });
    bindAll(document.body);
  };
  if (document.body) watch();
  else document.addEventListener('DOMContentLoaded', watch);
}

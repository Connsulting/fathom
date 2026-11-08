/* Horizon Ask blocks: the timeline renderer (docs/plans/rich-ask-answers.md section 2, Timeline).
   A vertical list on a date rail, in the snapshot's order: each event's date (a <time>), its label
   and, when it has one, its value as a registered figure (Unavailable with its gap when null).
   The list carries an aria-label summary built from the data. The Table button swaps in the same
   events as a sortable table (the date column sorts by date). */

import { toggleHtml, tableHtml, bindToggle } from './ask-block-chart.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

// An event's date as an ISO string (a date figure or a plain string).
const dateOf = (e) => String(isObj(e.date) ? e.date.value ?? '' : e.date ?? '');
const events = (s) => arr(s.events).filter(isObj);

export function summary(s, ctx) {
  const ev = events(s);
  if (!ev.length) return 'Timeline with no events';
  const span = ev.length > 1 ? `, ${ctx.formatByUnit(dateOf(ev[0]), 'date')} to ${ctx.formatByUnit(dateOf(ev.at(-1)), 'date')}` : `, ${ctx.formatByUnit(dateOf(ev[0]), 'date')}`;
  return `Timeline of ${ev.length} event${ev.length === 1 ? '' : 's'}${span}`;
}

export function tableOf(s) {
  const ev = events(s);
  const labels = [...new Set(ev.filter((e) => isObj(e.value)).map((e) => e.value.label || ''))];
  return {
    title: s.title,
    columns: [{ label: 'Date', type: 'text' }, { label: 'Event', type: 'text' }, { label: labels.length === 1 && labels[0] ? labels[0] : 'Value', type: 'fig' }],
    rows: ev.map((e) => ({ cells: [
      { t: 'text', text: '', sort: dateOf(e) },
      { t: 'text', text: e.label },
      isObj(e.value) ? { t: e.value.value === null ? 'none' : 'fig', fig: e.value } : { t: 'text', text: '' },
    ] })),
  };
}

export function render(snapshot, ctx) {
  const { esc, state } = ctx;
  if (state.table) {
    const t = tableOf(snapshot);
    t.rows.forEach((r) => { r.cells[0].text = ctx.formatByUnit(r.cells[0].sort, 'date'); });
    return toggleHtml(ctx) + tableHtml(t, ctx);
  }
  const items = events(snapshot).map((e) => {
    const d = dateOf(e);
    const v = isObj(e.value) ? `<span class="h-blk-ev-v">${ctx.fig(e.value)}</span>` : '';
    return `<li class="h-blk-ev"><time datetime="${esc(d)}">${esc(ctx.formatByUnit(d, 'date'))}</time><span class="h-blk-ev-l">${esc(e.label)}</span>${v}</li>`;
  }).join('');
  return toggleHtml(ctx) + `<ol class="h-blk-tl" aria-label="${esc(summary(snapshot, ctx))}">${items}</ol>`;
}

export function bind(root, snapshot, ctx) {
  bindToggle(root, tableOf(snapshot), ctx);
}

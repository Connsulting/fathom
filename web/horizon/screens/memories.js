/* Horizon What Fathom knows screen (#/memories): what Fathom has been told to remember, the
   knowledge packs that are on, and what it decided for you. Memories are calm rows: add at the top,
   a filter once the list is long, edit in place, delete with Undo. Writes go through
   api.preferenceSave, api.preferenceDelete and api.actionUndo; failures show the error toast. The
   packs and the Decided for you log are rendered by their own screens (packs.js, ingest.js). */

import { FILTER_MIN, filterMemories, sourceOf, summaryLine, whenLabel } from './memories-model.js';
import { activeHtml as packsHtml } from './packs.js';

let H = null;

export function bind(kit) { H = kit; }

// add: unsent new text. query: the filter. edit: { id, text } while a row is open for editing.
// undo: { receiptId, index } for the last delete. focus: a selector to focus after the next draw,
// with an optional caret range.
const fresh = () => ({ add: '', query: '', edit: null, undo: null, focus: null });
let S = fresh();

const INTRO = 'What Fathom remembers about your household, the knowledge it answers from and what it settled for you. Change anything here.';
const EMPTY = 'Nothing yet. When you tell Ask to remember something, or add it above, it shows up here.';

const memories = () => H.arr(H.api.s?.preferences);
const sel = (attr, id) => `[${attr}="${CSS.escape(String(id))}"]`;

function sourceHtml(m, threads) {
  const { esc, goA } = H;
  const src = sourceOf(m, threads);
  if (src.kind === 'ask') {
    const name = src.threadId ? goA('ask', esc(src.label), { id: src.threadId }, 'h-mem-src') : esc(src.label);
    return `<span>From ${name}</span>`;
  }
  return `<span>${esc(src.label)}</span>`;
}

function rowHtml(m, threads, now, hidden) {
  const { esc } = H;
  const id = esc(m.id);
  const hide = hidden ? ' hidden' : '';
  if (S.edit && S.edit.id === m.id) {
    return `<li class="h-mem-r editing" data-mem-id="${id}"${hide}><form class="h-mem-edit" data-mem-edit="${id}">
      <input type="text" name="text" aria-label="Edit memory" maxlength="300" required autocomplete="off" data-mem-edit-input="${id}" value="${esc(S.edit.text)}">
      <div class="h-mem-acts"><button type="submit" class="h-btn pri">Save</button><button type="button" class="h-btn" data-mem-cancel="${id}">Cancel</button></div>
    </form></li>`;
  }
  const when = whenLabel(m.createdAt, now);
  return `<li class="h-mem-r" data-mem-id="${id}"${hide}><p class="h-mem-t">${esc(m.text)}</p>
    <div class="h-mem-foot"><p class="h-mem-meta h-mute">${sourceHtml(m, threads)}${when ? `<span>Remembered ${esc(when)}</span>` : ''}</p>
    <div class="h-mem-acts"><button type="button" class="h-mem-b" data-mem-open="${id}">Edit</button><button type="button" class="h-mem-b" data-mem-del="${id}">Delete</button></div></div></li>`;
}

const undoHtml = () => '<li class="h-mem-gone" role="status"><span class="h-mute">Memory deleted.</span><button type="button" class="h-mem-b" data-mem-undo>Undo</button></li>';

// Remember which of this screen's fields has focus and its caret, so a redraw puts both back.
function keepFocus() {
  const a = document.activeElement;
  if (!a || !H.root?.contains(a) || !a.matches?.('[data-mem-new], [data-mem-q], [data-mem-edit-input]')) return;
  const attr = ['data-mem-new', 'data-mem-q', 'data-mem-edit-input'].find((k) => a.hasAttribute(k));
  S.focus = { sel: attr === 'data-mem-edit-input' ? sel(attr, a.getAttribute(attr)) : `[${attr}]`, start: a.selectionStart, end: a.selectionEnd };
}

export function render() {
  const { api, esc, shell, pageHead, section } = H;
  if (!S.focus) keepFocus();
  const list = memories();
  if (S.edit && !list.some((m) => m.id === S.edit.id)) S.edit = null;
  const threads = typeof api.threads === 'function' ? api.threads() : [];
  const now = new Date();
  const shown = new Set(filterMemories(list, S.query).map((m) => m.id));
  const items = list.map((m) => rowHtml(m, threads, now, !shown.has(m.id)));
  if (S.undo) items.splice(Math.min(S.undo.index, items.length), 0, undoHtml());
  const add = `<form class="h-mem-add" data-mem-add><label for="h-mem-new">Add a memory</label>
    <div class="h-mem-line"><input id="h-mem-new" type="text" name="text" maxlength="300" required autocomplete="off" data-mem-new value="${esc(S.add)}">
    <button type="submit" class="h-btn">Add</button></div></form>`;
  // The box stays while a query is active, so a delete that shortens the list never strands a filter.
  const filter = list.length >= FILTER_MIN || S.query ?`<div class="h-mem-filter"><label for="h-mem-q">Search memories</label>
    <input id="h-mem-q" type="search" autocomplete="off" data-mem-q value="${esc(S.query)}"></div>` : '';
  const none = list.length && !shown.size;
  const body = list.length || S.undo
    ? `<p class="h-mem-sum h-mute">${esc(summaryLine(list.length))}</p><ul class="h-mem-list" aria-label="Memories">${items.join('')}</ul>
      <p class="h-mem-none h-mute" data-mem-none${none ? '' : ' hidden'}>No memories match that search.</p>`
    : `<p class="h-mem-empty h-mute">${EMPTY}</p>`;
  const mem = section('Memories', `${add}${filter}${body}`, '', 'h-mem-sec');
  const decided = H.ingest?.decidedSection?.() || '';
  return shell(`<section class="h-mem h-narrow">${pageHead('Settings', 'What Fathom knows', INTRO)}${mem}${packsHtml()}${decided}</section>`);
}

// Called after every draw: on another route the screen forgets its state; here it puts focus back.
export function afterDraw(name) {
  if (name !== 'memories') { if (S.edit || S.undo || S.query || S.add || S.focus) S = fresh(); return; }
  const f = S.focus;
  S.focus = null;
  if (!f) return;
  const el = H.root?.querySelector(f.sel);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (f.start == null || typeof el.setSelectionRange !== 'function') return;
  try { el.setSelectionRange(f.start, f.end ?? f.start); } catch { /* not a text field */ }
}

// Show and hide rows for the filter without redrawing, so the field keeps focus and caret.
function applyFilter() {
  const shown = new Set(filterMemories(memories(), S.query).map((m) => m.id));
  const rows = H.root.querySelectorAll('li.h-mem-r[data-mem-id]');
  rows.forEach((li) => { li.hidden = !shown.has(li.dataset.memId); });
  const none = H.root.querySelector('[data-mem-none]');
  if (none) none.hidden = !(rows.length && !shown.size);
}

function openEdit(id) {
  const m = memories().find((x) => x.id === id);
  if (!m) return;
  S.edit = { id, text: m.text };
  const end = m.text.length;
  S.focus = { sel: sel('data-mem-edit-input', id), start: end, end };
  H.draw();
}

function closeEdit() {
  const id = S.edit?.id;
  S.edit = null;
  if (id) S.focus = { sel: sel('data-mem-open', id) };
  H.draw();
}

function remove(id) {
  const index = memories().findIndex((m) => m.id === id);
  if (index < 0) return;
  H.api.preferenceDelete(id).then((d) => {
    if (!d?.receipt?.id) return;
    if (S.edit?.id === id) S.edit = null;
    S.undo = { receiptId: d.receipt.id, id, index };
    S.focus = { sel: '[data-mem-undo]' };
    H.draw();
  });
}

function undo() {
  const u = S.undo;
  if (!u) return;
  H.api.actionUndo(u.receiptId).then((d) => {
    if (!d) return;
    if (S.undo === u) S.undo = null;
    S.focus = { sel: sel('data-mem-open', u.id) };
    H.draw();
  });
}

/* ---------- events ---------- */

const inside = (el) => el && H.root?.contains(el) && el.closest('.h-mem');

export function onClick(e) {
  const t = e.target;
  if (!t?.closest || !inside(t)) return false;
  const open = t.closest('[data-mem-open]');
  if (open) { e.preventDefault(); openEdit(open.dataset.memOpen); return true; }
  const cancel = t.closest('[data-mem-cancel]');
  if (cancel) { e.preventDefault(); closeEdit(); return true; }
  const del = t.closest('[data-mem-del]');
  if (del) { e.preventDefault(); remove(del.dataset.memDel); return true; }
  if (t.closest('[data-mem-undo]')) { e.preventDefault(); undo(); return true; }
  return false;
}

export function onSubmit(e) {
  const f = e.target;
  if (!f?.matches || !inside(f)) return false;
  if (f.matches('form[data-mem-add]')) {
    e.preventDefault();
    const text = String(f.text?.value ?? '').trim();
    if (!text) return true;
    H.api.preferenceSave('', text).then((d) => {
      if (!d) return;
      S.add = '';
      S.focus = { sel: '[data-mem-new]' };
      H.draw();
    });
    return true;
  }
  if (f.matches('form[data-mem-edit]')) {
    e.preventDefault();
    const id = f.dataset.memEdit;
    const text = String(f.text?.value ?? '').trim();
    if (!text) return true;
    H.api.preferenceSave(id, text).then((d) => {
      if (!d) return;
      if (S.edit?.id === id) S.edit = null;
      S.focus = { sel: sel('data-mem-open', id) };
      H.draw();
    });
    return true;
  }
  return false;
}

export function onInput(e) {
  const t = e.target;
  if (!t?.matches || !inside(t)) return false;
  if (t.matches('[data-mem-new]')) { S.add = t.value; return true; }
  if (t.matches('[data-mem-edit-input]')) { if (S.edit) S.edit.text = t.value; return true; }
  if (t.matches('[data-mem-q]')) { S.query = t.value; applyFilter(); return true; }
  return false;
}

// Escape in the edit field cancels the edit and stops there, so no shortcut also runs.
export function onKey(e) {
  const t = e.target;
  if (e.key !== 'Escape' || !t?.matches?.('[data-mem-edit-input]') || !inside(t)) return false;
  e.preventDefault();
  e.stopPropagation();
  closeEdit();
  return true;
}

export function reset() { S = fresh(); }

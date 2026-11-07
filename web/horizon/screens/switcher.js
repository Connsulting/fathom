/* Horizon keyboard layer, screen side: the Ctrl+K quick switcher, the shortcut sheet, the item
   sources the switcher searches, recents, the list focus ring, and every binding table.
   Binding tables are plain arrays of { keys, label, group, when?, sheetWhen?, action }; a screen
   gets its table by route name in SCREEN_TABLES, so more screens are data, not code.
   Every row is built with esc() from plain strings; highlights wrap escaped single characters.
   Recents keep item keys only (never titles or figures) in localStorage. */

import { normalizeKey, rankItems } from '../keys.js';
import { ASK_KEYS, askNew, newConversation } from './chat.js';
import { deckBindings } from './ingest.js';

let H = null;

export function bind(kit) { H = kit; }

// G sequences: letter, route, label. design.js reads these for its tab and gear hints.
export const GO = [
  ['h', 'home', 'Home'], ['p', 'plan', 'Plan'], ['d', 'wargame', 'Decide'], ['a', 'ask', 'Ask'],
  ['c', 'confirm', 'Confirm'], ['k', 'packs', 'Packs'], ['f', 'add', 'Files'], ['e', 'engine', 'Engine'],
  ['m', 'email', 'Email'], ['n', 'connect', 'Connect'], ['o', 'money', 'Money'], ['s', 'settings', 'Settings']
];
const GO_MORE = [['goals', 'Goals'], ['accounts', 'Accounts'], ['pnl', 'P&L'], ['advisor', 'Advisor'], ['yearend', 'Year end']];

export function goHint(route) {
  const g = GO.find((x) => x[1] === route);
  return g && H?.keys ? H.keys.hintText('g ' + g[0]) : '';
}

const RECENT_KEY = 'fathom.qs.recent';
const KEY_RE = /^[a-z]+:[A-Za-z0-9_.-]+$/;
const RECENT_MAX = 8;
const RECENT_SHOWN = 5;
const MAX_ROWS = 50;
const GROUPS = ['Go to', 'Actions', 'Recommendations', 'Decisions', 'Conversations', 'Accounts', 'Deadlines', 'Packs', 'Files'];
const GROUP_ICON = {
  'Go to': 'arrow', Actions: 'plus', Recommendations: 'check', Decisions: 'fork', Conversations: 'send',
  Accounts: 'lock', Deadlines: 'cal', Packs: 'stack', Files: 'doc'
};
const DEC_STATUS = { open: 'Open', upcoming: 'Coming up', decided: 'Decided', unavailable: 'No longer current' };

const fresh = () => ({
  qs: null, ks: null, input: null, list: null, empty: null,
  items: [], rows: [], sel: 0, ret: null, ksRet: null, inert: null,
  screen: null, offScreen: null, offGlobal: null, ring: {}, mx: null, my: null
});
let S = fresh();

/* ---------- small helpers ---------- */

const plain = (s) => (s == null || s === '' ? '' : H.api.txt(String(s)));
const cap = (s) => { const t = String(s || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; };
const shown = (el) => !el.hidden;
const notOnboarding = () => H.routeNow().name !== 'onboarding';

// statusText() returns escaped HTML; read it back as text through an inert template.
function textOf(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html ?? '');
  return t.content.textContent || '';
}

function readRecents() {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string' && KEY_RE.test(k)) : [];
  } catch (e) {
    return [];
  }
}

function writeRecent(key) {
  if (!KEY_RE.test(key)) return;
  try {
    const next = [key, ...readRecents().filter((k) => k !== key)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch (e) { /* storage unavailable: recents are a convenience */ }
}

/* ---------- item sources ---------- */

function go(route, params) {
  H.api.go(route, params || {});
}

// No match: the text becomes the first question of a new conversation, sent at once.
function askWith(text) {
  askNew(text);
}

function openRec(id, ret) {
  const trigger = ret && H.root?.querySelector('.h-root')?.contains(ret) ? ret : null;
  H.openRec(id, trigger);
}

function openAccount(id, ret) {
  const trigger = ret && H.root?.querySelector('.h-root')?.contains(ret) ? ret : null;
  H.openAccount(id, trigger);
}

const isDialog = (name) => name === 'rec' || name === 'account';

function goSource() {
  const row = (route, label, hint) => ({ key: `go:${route}`, title: label, group: 'Go to', sub: 'Screen', hint, run: () => go(route) });
  return [
    ...GO.map(([k, route, label]) => row(route, label, H.keys.hintText('g ' + k))),
    ...GO_MORE.map(([route, label]) => row(route, label, ''))
  ];
}

function actionSource() {
  return [
    { key: 'act:shortcuts', title: 'Show keyboard shortcuts', group: 'Actions', sub: 'Action', hint: '?', run: () => openSheet() },
    { key: 'act:ask', title: 'Ask a question', group: 'Actions', sub: 'Action', hint: '', run: () => newConversation() },
    { key: 'act:add', title: 'Add files', group: 'Actions', sub: 'Action', hint: '', run: () => go('add') },
    { key: 'act:connect-accounts', title: 'Connect accounts', group: 'Actions', sub: 'SimpleFIN, read-only', hint: '', run: () => go('accounts') },
    { key: 'act:goal', title: 'New goal', group: 'Actions', sub: 'Action', hint: '', run: () => H.newGoal() },
    { key: 'act:tour', title: 'Take the tour', group: 'Actions', sub: 'A short guided walk', hint: '', run: (ret) => H.startTour(ret) },
    ...pendingChecks()
  ];
}

function pendingChecks() {
  const n = Number(H.api.ingest?.().pending) || 0;
  return n > 0 ? [{ key: 'act:confirm', title: 'Start confirming', group: 'Actions', sub: `${n} to check`, hint: H.keys.hintText('g c'), run: () => go('confirm') }] : [];
}

function recSource() {
  return H.arr(H.visibleRecs()).map((r) => {
    const label = plain(r.window?.label);
    return {
      key: `rec:${r.id}`, title: plain(r.title), group: 'Recommendations',
      sub: [textOf(H.statusText(r)), label].filter(Boolean).join(', '), hint: '',
      run: (ret) => openRec(r.id, ret)
    };
  });
}

function decisionSource() {
  return H.arr(H.decisionList()).map((d) => ({
    key: `dec:${d.id}`, title: plain(d.title), group: 'Decisions',
    sub: d.when ? plain(d.when) : DEC_STATUS[d.status] || cap(d.status), hint: '',
    run: (ret) => {
      if (d.wargame) go('wargame', { name: d.wargame });
      else if (d.r) openRec(d.r.id, ret);
      else go('wargame');
    }
  }));
}

// Active conversations (not archived, not in Trash), newest activity first.
function conversationSource() {
  const list = H.arr(H.api.threads ? H.api.threads() : [])
    .filter((t) => t && t.id && !t.archivedAt && !t.trashedAt)
    .sort((a, b) => { const x = String(a.lastAt || ''), y = String(b.lastAt || ''); return x === y ? 0 : x < y ? 1 : -1; });
  return list.map((t) => ({
    key: `conv:${t.id}`, title: typeof t.title === 'string' && t.title ? t.title : 'New conversation',
    group: 'Conversations', sub: 'Conversation', hint: '',
    run: () => go('ask', { id: t.id })
  }));
}

function accountSource() {
  return H.arr(H.api.s.accounts).map((a) => {
    const digits = String(a.mask ?? a.last4 ?? '').replace(/\D/g, '');
    return {
      key: `acc:${a.id}`, title: a.imported === false ? plain(a.name) : String(a.name ?? ''), group: 'Accounts',
      sub: digits ? `ending ${digits.slice(-4)}` : 'Account', hint: '',
      run: (ret) => openAccount(a.id, ret)
    };
  });
}

function deadlineSource() {
  return H.arr(H.api.s.deadlines).map((d, i) => ({
    key: `dl:${i}`, title: plain(d.title), group: 'Deadlines', sub: plain(d.label) || String(d.date ?? ''), hint: '',
    run: (ret) => { if (d.recId && H.recById(d.recId)) openRec(d.recId, ret); else go('plan'); }
  }));
}

function packSource() {
  return H.arr(H.api.packs()).map((p) => ({
    key: `pack:${p.id}`, title: plain(p.name || p.label || p.id), group: 'Packs', sub: cap(p.status), hint: '',
    run: () => go('packs', { id: p.id })
  }));
}

function fileSource() {
  const g = H.api.ingest ? H.api.ingest() : null;
  return H.arr(g?.files).map((f) => ({
    key: `file:${f.id}`, title: String(f.name ?? ''), group: 'Files', sub: cap(f.status), hint: '',
    run: () => go('add')
  }));
}

function buildItems() {
  const out = [];
  const sources = [goSource, actionSource, recSource, decisionSource, conversationSource, accountSource, deadlineSource, packSource, fileSource];
  for (const src of sources) {
    try { out.push(...src()); } catch (e) { console.error(e); }
  }
  return out.filter((it) => it.title);
}

/* ---------- overlays: shared ---------- */

// The page, the dialog and the Ask panel with its launcher all sit under the switcher and the sheet.
function lockInert() {
  const els = [H.root.querySelector('.h-root'), H.root.querySelector('.h-dlg-host'), H.root.querySelector('.h-askp-host')].filter(Boolean);
  if (!S.inert) S.inert = els.map((el) => [el, el.inert]);
  els.forEach((el) => { el.inert = true; });
}

function unlockInert() {
  if (!S.inert) return;
  S.inert.forEach(([el, v]) => { el.inert = v; });
  S.inert = null;
}

function restoreFocus(el) {
  if (el && el.isConnected && el !== document.body && typeof el.focus === 'function') el.focus({ preventScroll: true });
}

const anyOpen = () => !!((S.qs && shown(S.qs)) || (S.ks && shown(S.ks)));
export const isOpen = () => !!(S.qs && shown(S.qs));

// The global dispatcher leaves events inside an open overlay to the overlay, except the switcher chord.
export function captures(e) {
  if (!anyOpen()) return false;
  const t = e.target;
  const inside = (S.qs && S.qs.contains(t)) || (S.ks && S.ks.contains(t));
  return !!inside && normalizeKey(e) !== 'mod+k';
}

/* ---------- quick switcher ---------- */

function highlight(title, hits) {
  if (!hits || !hits.length) return H.esc(title);
  const on = new Set(hits);
  let out = '';
  for (let i = 0; i < title.length; i++) out += on.has(i) ? `<mark>${H.esc(title[i])}</mark>` : H.esc(title[i]);
  return out;
}

function optionHtml(item, hits, i) {
  const icon = H.icon(GROUP_ICON[item.group] || 'arrow');
  return `<li class="h-qs-o" role="option" id="h-qs-o-${i}" data-qs-key="${H.esc(item.key)}" data-i="${i}" aria-selected="${i === S.sel}">`
    + `<span class="h-qs-ic">${icon}</span>`
    + `<span class="h-qs-x"><span class="h-qs-t">${highlight(item.title, hits)}</span><span class="h-qs-s">${H.esc(item.sub || '')}</span></span>`
    + (item.hint ? `<kbd class="h-qs-k">${H.esc(item.hint)}</kbd>` : '')
    + '</li>';
}

function renderList() {
  const q = S.input.value;
  const recents = readRecents();
  let html = '';
  S.rows = [];
  if (!q.trim()) {
    const byKey = new Map(S.items.map((it) => [it.key, it]));
    const recent = recents.filter((k) => byKey.has(k)).slice(0, RECENT_SHOWN).map((k) => byKey.get(k));
    const seen = new Set(recent.map((it) => it.key));
    const groups = [['Recent', recent], ...GROUPS.map((g) => [g, S.items.filter((it) => it.group === g && !seen.has(it.key))])];
    for (const [name, list] of groups) {
      if (!list.length) continue;
      html += `<li class="h-qs-g" role="presentation">${H.esc(name)}</li>`;
      for (const item of list) { html += optionHtml(item, [], S.rows.length); S.rows.push(item); }
    }
  } else {
    for (const r of rankItems(S.items, q, recents).slice(0, MAX_ROWS)) { html += optionHtml(r.item, r.hits, S.rows.length); S.rows.push(r.item); }
  }
  S.list.innerHTML = html;
  S.list.hidden = !S.rows.length;
  const none = !S.rows.length && q.trim();
  S.empty.hidden = !none;
  S.empty.textContent = none ? `No matches. Press Enter to ask "${q.trim()}".` : '';
  select(0, false);
  S.list.scrollTop = 0;
}

function select(i, scroll) {
  const n = S.rows.length;
  if (!n) { S.sel = 0; S.input.removeAttribute('aria-activedescendant'); return; }
  S.sel = ((i % n) + n) % n;
  S.list.querySelectorAll('li.h-qs-o[aria-selected="true"]').forEach((el) => el.setAttribute('aria-selected', 'false'));
  const el = S.list.querySelector(`#h-qs-o-${S.sel}`);
  if (!el) return;
  el.setAttribute('aria-selected', 'true');
  S.input.setAttribute('aria-activedescendant', el.id);
  if (scroll) el.scrollIntoView({ block: 'nearest' });
}

export function open() {
  if (!H || !S.qs || isOpen() || !notOnboarding()) return;
  let ret = document.activeElement;
  if (S.ks && shown(S.ks)) ret = closeSheet(false);
  S.ret = ret;
  S.items = buildItems();
  lockInert();
  S.qs.hidden = false;
  S.input.value = '';
  S.mx = null; S.my = null;
  renderList();
  S.input.focus();
}

// Returns the element focus was remembered from, so a follow-up overlay can return there.
export function close(restore = true) {
  if (!S.qs || !isOpen()) return null;
  const ret = S.ret;
  S.qs.hidden = true;
  S.list.innerHTML = '';
  S.rows = [];
  S.items = [];
  S.ret = null;
  if (!(S.ks && shown(S.ks))) unlockInert();
  if (restore) restoreFocus(ret);
  return ret;
}

export function toggle() { if (isOpen()) close(); else open(); }

function openRow(item) {
  if (!item) return;
  writeRecent(item.key);
  const ret = close(true);
  try { item.run(ret); } catch (e) { console.error(e); }
}

function onQsKey(e) {
  const k = normalizeKey(e);
  if (e.isComposing) return;
  if (k === 'escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (k === 'arrowdown' || k === 'arrowup') {
    e.preventDefault(); e.stopPropagation();
    select(S.sel + (k === 'arrowdown' ? 1 : -1), true);
    return;
  }
  if (k === 'enter') {
    e.preventDefault(); e.stopPropagation();
    if (S.rows.length) openRow(S.rows[S.sel]);
    else if (S.input.value.trim()) { const text = S.input.value.trim(); close(false); askWith(text); }
    return;
  }
  if (k === 'tab') { e.preventDefault(); e.stopPropagation(); S.input.focus(); }
}

function onQsInput(e) {
  e.stopPropagation();
  renderList();
}

function onQsClick(e) {
  e.stopPropagation();
  if (e.target.closest('[data-qs="close"]')) { e.preventDefault(); close(); return; }
  const li = e.target.closest('li.h-qs-o');
  if (li && S.list.contains(li)) { e.preventDefault(); openRow(S.rows[Number(li.dataset.i)]); return; }
  if (!e.target.closest('input')) S.input.focus();
}

function onQsMove(e) {
  // Only a real pointer move selects; a list scrolled under a still pointer does not.
  if (e.clientX === S.mx && e.clientY === S.my) return;
  S.mx = e.clientX; S.my = e.clientY;
  const li = e.target.closest('li.h-qs-o');
  if (li && S.list.contains(li)) {
    const i = Number(li.dataset.i);
    if (i !== S.sel) select(i, false);
  }
}

/* ---------- shortcut sheet ---------- */

function sheetHtml() {
  const list = H.keys.active({ forSheet: true });
  const order = ['Global', 'Go to'];
  list.forEach((b) => { if (!order.includes(b.group)) order.push(b.group); });
  return order.map((g) => {
    const rows = list.filter((b) => b.group === g);
    if (!rows.length) return '';
    return `<section class="h-ks-g"><h3>${H.esc(g)}</h3><ul>${rows.map((b) => `<li class="h-ks-r"><span class="h-ks-l">${H.esc(b.label)}</span><span class="h-ks-ks">${b.keys.map((k) => `<kbd>${H.esc(H.keys.hintText(k))}</kbd>`).join('')}</span></li>`).join('')}</ul></section>`;
  }).join('');
}

export function openSheet() {
  if (!H || !S.ks || shown(S.ks) || !notOnboarding()) return;
  let ret = document.activeElement;
  if (isOpen()) ret = close(false);
  S.ksRet = ret;
  S.ks.querySelector('.h-ks-body').innerHTML = sheetHtml();
  lockInert();
  S.ks.hidden = false;
  S.ks.querySelector('.h-ks').focus();
}

function closeSheet(restore = true) {
  if (!S.ks || !shown(S.ks)) return null;
  const ret = S.ksRet;
  S.ks.hidden = true;
  S.ks.querySelector('.h-ks-body').innerHTML = '';
  S.ksRet = null;
  if (!isOpen()) unlockInert();
  if (restore) restoreFocus(ret);
  return ret;
}

function onKsKey(e) {
  const k = normalizeKey(e);
  if (k === 'escape' || k === '?') { e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
  if (k === 'tab') {
    e.preventDefault(); e.stopPropagation();
    const dlg = S.ks.querySelector('.h-ks');
    const x = S.ks.querySelector('.h-ks-x');
    (document.activeElement === x ? dlg : x).focus();
  }
}

function onKsClick(e) {
  e.stopPropagation();
  if (e.target.closest('[data-ks="close"]')) { e.preventDefault(); closeSheet(); }
}

/* ---------- list focus ring ---------- */

const LISTS = {
  plan: {
    sel: 'article.h-row',
    focus: (el) => el.querySelector('a[data-go="rec"]'),
    enter: (el) => el.querySelector('a[data-go="rec"]')
  },
  wargame: {
    sel: 'article.h-dec',
    focus: (el) => el.querySelector('a.h-dec-t') || el.querySelector('a[data-go]'),
    enter: (el) => el.querySelector('a.h-dec-t') || el.querySelector('a[data-go]')
  },
  add: {
    sel: '.h-ing-files > li, .h-srcs > li',
    focus: (el) => el.querySelector('a[data-go]'),
    enter: (el) => el.querySelector('a[data-go]') || el.querySelector('button')
  }
};

function ringItems() {
  const spec = LISTS[S.screen];
  const page = H.root?.querySelector('.h-root');
  if (!spec || !page) return [];
  return [...page.querySelectorAll(spec.sel)].filter((el) => el.getClientRects().length > 0);
}

const ringIdx = () => (S.ring[S.screen] ?? -1);

function ringEl() {
  const i = ringIdx();
  if (i < 0) return null;
  const list = ringItems();
  return list.length ? list[Math.min(i, list.length - 1)] : null;
}

function ringTarget(el) {
  const f = LISTS[S.screen]?.focus(el);
  if (f) return f;
  el.setAttribute('tabindex', '-1');
  return el;
}

function applyRing(focus) {
  const page = H.root?.querySelector('.h-root');
  if (!page) return;
  page.querySelectorAll('.h-kfocus').forEach((el) => el.classList.remove('h-kfocus'));
  const el = ringEl();
  if (!el) return;
  el.classList.add('h-kfocus');
  const t = ringTarget(el);
  if (focus) {
    t.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }
}

function move(d) {
  const list = ringItems();
  if (!list.length) return;
  const cur = ringIdx();
  const i = cur < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, Math.min(cur, list.length - 1) + d));
  S.ring[S.screen] = i;
  applyRing(true);
}

function clearRing() {
  S.ring[S.screen] = -1;
  applyRing(false);
}

// Enter belongs to the ring only while focus sits on the ringed row (or nowhere); a focused button
// keeps its own Enter.
function enterOk() {
  const el = ringEl();
  if (!el) return false;
  const a = document.activeElement;
  return !a || a === document.body || a === el || a === ringTarget(el);
}

function enterRow() {
  const el = ringEl();
  const t = el && LISTS[S.screen]?.enter(el);
  if (t) t.click();
}

/* ---------- binding tables ---------- */

const REC_ACTS = [['d', 'Doing it', 'start'], ['e', 'Done', 'complete'], ['l', 'Later', 'snooze'], ['shift+x', 'Not for us', 'dismiss']];

function clickAct(scopeEl, act) {
  const b = scopeEl?.querySelector(`[data-act="${act}"]`);
  if (b) b.click();
}

const listTable = () => [
  { keys: ['j', 'arrowdown'], label: 'Next item', group: 'List', when: () => ringItems().length > 0, action: () => move(1) },
  { keys: ['k', 'arrowup'], label: 'Previous item', group: 'List', when: () => ringItems().length > 0, action: () => move(-1) },
  { keys: ['enter'], label: 'Open the focused item', group: 'List', when: enterOk, sheetWhen: () => ringItems().length > 0, action: () => enterRow() }
];

const SCREEN_TABLES = {
  plan: () => [
    ...listTable(),
    ...REC_ACTS.map(([k, label, act]) => ({
      keys: [k], label, group: 'Recommendation', when: () => !!ringEl(), sheetWhen: () => true,
      action: () => clickAct(ringEl(), act)
    }))
  ],
  wargame: listTable,
  goals: () => [{ keys: ['n'], label: 'New goal', group: 'Goals', action: () => H.newGoal() }],
  add: listTable,
  ask: () => ASK_KEYS,
  confirm: () => deckBindings((name, e) => H.ingest.deckAction(name, e)),
  rec: () => REC_ACTS.map(([k, label, act]) => ({
    keys: [k], label, group: 'Recommendation',
    action: () => clickAct(H.root?.querySelector('.h-dlg-host .h-dlg .h-acts'), act)
  }))
};

function onEscape() {
  if (isDialog(H.api.route?.name)) { H.closeRec(); return; }
  if (ringIdx() >= 0) clearRing();
}

const globalTable = () => [
  { keys: ['mod+k'], label: 'Open the quick switcher', group: 'Global', when: notOnboarding, action: () => toggle() },
  { keys: ['mod+i'], label: 'Open or close the Ask panel', group: 'Global', action: () => H.askPanelToggle() },
  { keys: ['?'], label: 'Show keyboard shortcuts', group: 'Global', when: notOnboarding, action: () => openSheet() },
  { keys: ['escape'], label: 'Close or go back', group: 'Global', when: notOnboarding, action: () => onEscape() },
  ...GO.map(([k, route, label]) => ({ keys: [`g ${k}`], label, group: 'Go to', when: notOnboarding, action: () => go(route) }))
];

/* ---------- lifecycle ---------- */

export function mount() {
  S = fresh();
  const root = H.root;
  const qs = document.createElement('div');
  qs.className = 'h-qs-host';
  qs.hidden = true;
  qs.innerHTML = `<div class="h-qs-back" data-qs="close"></div>`
    + `<div class="h-qs" role="dialog" aria-modal="true" aria-label="Quick switcher">`
    + `<div class="h-qs-bar">${H.icon('search')}<input class="h-qs-in" type="text" placeholder="Go to, ask, or run anything" role="combobox" aria-label="Search" aria-expanded="true" aria-controls="h-qs-list" aria-autocomplete="list" autocomplete="off" spellcheck="false"></div>`
    + `<ul id="h-qs-list" class="h-qs-list" role="listbox" aria-label="Results"></ul>`
    + `<div class="h-qs-empty" hidden></div>`
    + `<div class="h-qs-foot"><span><kbd>Up</kbd><kbd>Down</kbd>Move</span><span><kbd>Enter</kbd>Open</span><span><kbd>Esc</kbd>Close</span></div>`
    + `</div>`;
  const ks = document.createElement('div');
  ks.className = 'h-ks-host';
  ks.hidden = true;
  ks.innerHTML = `<div class="h-ks-back" data-ks="close"></div>`
    + `<div class="h-ks" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabindex="-1">`
    + `<div class="h-ks-bar"><h2>Keyboard shortcuts</h2><button type="button" class="h-ks-x" data-ks="close" aria-label="Close">${H.icon('x')}</button></div>`
    + `<div class="h-ks-body"></div></div>`;
  root.appendChild(qs);
  root.appendChild(ks);
  S.qs = qs; S.ks = ks;
  S.input = qs.querySelector('input.h-qs-in');
  S.list = qs.querySelector('#h-qs-list');
  S.empty = qs.querySelector('.h-qs-empty');
  S.input.addEventListener('keydown', onQsKey);
  S.input.addEventListener('input', onQsInput);
  qs.addEventListener('click', onQsClick);
  qs.addEventListener('mousemove', onQsMove);
  ks.addEventListener('keydown', onKsKey);
  ks.addEventListener('click', onKsClick);
  S.offGlobal = H.keys.register('global', globalTable());
}

export function unmount() {
  if (S.offScreen) S.offScreen();
  if (S.offGlobal) S.offGlobal();
  if (S.input) {
    S.input.removeEventListener('keydown', onQsKey);
    S.input.removeEventListener('input', onQsInput);
  }
  if (S.qs) { S.qs.removeEventListener('click', onQsClick); S.qs.removeEventListener('mousemove', onQsMove); S.qs.remove(); }
  if (S.ks) { S.ks.removeEventListener('keydown', onKsKey); S.ks.removeEventListener('click', onKsClick); S.ks.remove(); }
  S = fresh();
}

// Called after every draw with the screen name ('rec' while the rec modal is open). Registers the
// screen's table on enter, drops it on leave, and puts the ring back on the redrawn list.
export function afterDraw(name) {
  if (!H || !H.keys || !S.qs) return;
  if (name !== S.screen) {
    const from = S.screen;
    if (S.offScreen) { S.offScreen(); S.offScreen = null; }
    // Opening and closing the rec modal keeps the page's ring; arriving from another page starts fresh.
    if (!isDialog(from) && !isDialog(name)) S.ring[name] = -1;
    S.screen = name;
    const table = SCREEN_TABLES[name];
    if (table) S.offScreen = H.keys.register(name, table());
    H.keys.setScreen(name);
  }
  if (ringIdx() >= 0) {
    const a = document.activeElement;
    applyRing(!anyOpen() && (!a || a === document.body));
  }
  if (S.inert) {
    // draw() may have opened or closed the rec modal or a modal Ask panel under the overlay:
    // remember each layer's new resting state, then keep them all inert while the overlay is up.
    const page = H.root.querySelector('.h-root');
    const dlg = H.root.querySelector('.h-dlg-host');
    const modal = !!(H.askModal && H.askModal());
    S.inert = [[page, !!(dlg && !dlg.hidden) || modal], [dlg, modal], [H.root.querySelector('.h-askp-host'), false]].filter((x) => x[0]);
    S.inert.forEach(([el]) => { el.inert = true; });
  }
}

// The header search button.
export function onClick(e) {
  const b = e.target.closest?.('[data-keys="switcher"]');
  if (!b || !H.root?.contains(b)) return false;
  e.preventDefault();
  open();
  return true;
}

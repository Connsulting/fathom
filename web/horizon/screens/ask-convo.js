/* Ask panel conversations, the pure rule: a conversation belongs to the page it started on. An add
   or a question on another page starts a new conversation for that page (the old thread stays
   readable until then), the Ask page never does, New conversation drops the added items, and a
   conversation reopened from the list or from the Ask page gets its own context back.
   Every function works on the plain state object it is given (ask-panel.js passes its own) and
   changes nothing else: no DOM, no storage, no globals. State fields:
     page      the page key the conversation belongs to; null (legacy stored state, or one started
               on the Ask page) adopts the next page it is used on and is never stale
     threadId  the conversation's thread, or null for a new one
     chips     the added items [{ kind, id, label, q }]
     gen       bumped on every new or reopened conversation
     ctx       threadId -> { origin, chips }: the page chip a thread started on and its items,
               the CTX_MAX most recently written
     pageOff   refKeys of removed page chips
     asking    { gen, origin, chips } for a question that is starting a new thread, or null */

import { MAX_REFS, refKey } from './ask-context.js';

export const CTX_MAX = 40;

const isAskKey = (key) => typeof key === 'string' && (key === 'ask' || key.startsWith('ask/'));
const copy = (c) => ({ kind: c.kind, id: c.id, label: typeof c.label === 'string' ? c.label : '', q: typeof c.q === 'string' ? c.q : '' });

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => c && !seen.has(refKey(c)) && seen.add(refKey(c)));
}

// The design.js draw() key of a route (pass the page under any dialog).
export function pageKeyOf(route) {
  const p = (route && route.params) || {};
  return `${route && route.name}/${p.id ?? p.name ?? p.step ?? ''}`;
}

export function freshConvo() {
  return { page: null, threadId: null, chips: [], gen: 0, ctx: {}, pageOff: new Set(), asking: null };
}

export function isStale(s, pageKey) {
  return !isAskKey(pageKey) && s.page != null && pageKey !== s.page;
}

// A conversation with no page takes the first real page it is used on.
export function adoptPage(s, pageKey) {
  if (s.page == null && typeof pageKey === 'string' && !isAskKey(pageKey)) s.page = pageKey;
}

// A question still in flight keeps its asking record: its older gen stops adoptThread taking it.
export function newConversation(s, pageKey) {
  s.threadId = null;
  s.chips = [];
  s.pageOff.clear();
  s.page = isAskKey(pageKey) ? null : pageKey;
  s.gen += 1;
  return s;
}

// The newest write goes last; the oldest beyond CTX_MAX are dropped.
export function rememberCtx(s, threadId, entry) {
  if (typeof threadId !== 'string' || !threadId) return;
  delete s.ctx[threadId];
  s.ctx[threadId] = { origin: entry && entry.origin ? copy(entry.origin) : null, chips: (entry && Array.isArray(entry.chips) ? entry.chips : []).map(copy) };
  const ids = Object.keys(s.ctx);
  for (const id of ids.slice(0, Math.max(0, ids.length - CTX_MAX))) delete s.ctx[id];
}

// Chips changed while a thread is current: its remembered items follow.
function touch(s) {
  if (!s.threadId) return;
  const had = s.ctx[s.threadId];
  rememberCtx(s, s.threadId, { origin: had ? had.origin : null, chips: s.chips });
}

export function beginAdd(s, pageKey, chip) {
  const started = isStale(s, pageKey);
  if (started) newConversation(s, pageKey);
  adoptPage(s, pageKey);
  if (chip && !s.chips.some((x) => refKey(x) === refKey(chip))) {
    s.chips.push(copy(chip));
    if (s.chips.length > MAX_REFS) s.chips.splice(0, s.chips.length - MAX_REFS);
  }
  touch(s);
  return started;
}

// Before a panel question is sent. chat.js sends one question at a time, so the record is reset.
export function beginAsk(s, pageKey, pageChip) {
  const started = isStale(s, pageKey);
  if (started) newConversation(s, pageKey);
  adoptPage(s, pageKey);
  s.asking = s.threadId ? null : { gen: s.gen, origin: pageChip ? copy(pageChip) : null, chips: s.chips.map(copy) };
  return started;
}

// A new thread asked from the panel landed: remember what it was asked with, and make it the
// panel's thread unless a newer conversation has started since.
export function adoptThread(s, threadId, pageChip) {
  if (typeof threadId !== 'string' || !threadId) return false;
  const a = s.asking;
  rememberCtx(s, threadId, a ? { origin: a.origin, chips: a.chips } : { origin: pageChip || null, chips: s.chips });
  s.asking = null;
  if (a && a.gen !== s.gen) return false;
  s.threadId = threadId;
  return true;
}

// Reopening a thread (the panel list, or Open in panel from the Ask page): its origin page chip
// (unless it is the current page's) and its items come back, and it belongs to pageKey now.
export function restoreCtx(s, threadId, pageKey, pageChip) {
  const c = threadId ? s.ctx[threadId] : null;
  const origin = c && c.origin && !(pageChip && refKey(c.origin) === refKey(pageChip)) ? [c.origin] : [];
  s.threadId = threadId || null;
  s.chips = dedupe([...origin, ...(c ? c.chips : [])]).slice(0, MAX_REFS).map(copy);
  s.page = isAskKey(pageKey) ? null : pageKey;
  s.gen += 1;
  return s;
}

export function removeChip(s, key, isPage) {
  if (isPage) { s.pageOff.add(key); return; }
  s.chips = s.chips.filter((c) => refKey(c) !== key);
  touch(s);
}

// The chip row: the page chip (unless removed or already added), then the added chips. When
// stale, the page chip alone: the old items are not shown and not sent.
export function visibleChips(s, pageKey, pageChip) {
  const pc = pageChip ? { ...copy(pageChip), page: true } : null;
  if (isStale(s, pageKey)) return pc && !s.pageOff.has(refKey(pc)) ? [pc] : [];
  const added = new Set(s.chips.map(refKey));
  const page = pc && !s.pageOff.has(refKey(pc)) && !added.has(refKey(pc)) ? [pc] : [];
  return [...page, ...s.chips];
}

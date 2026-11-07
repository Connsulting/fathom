// Ask context v2, the conversation-per-page rule (web/horizon/screens/ask-convo.js): a conversation
// belongs to the page it started on, so an add or a question on another page starts a new one,
// the Ask page never does, New conversation drops the added items, and a reopened conversation
// gets its own context back. Synthetic data only; no DOM.
//
// The module's API. Every function works on a plain state object; it reads and changes only that
// object (no DOM, no storage, no globals) and imports only from ./ask-context.js.
//   CTX_MAX                        40, the number of remembered thread contexts kept.
//   pageKeyOf(route)               `${name}/${params.id ?? params.name ?? params.step ?? ''}`, the
//                                  design.js draw() key; the route passed is the page under any dialog.
//   freshConvo()                   { page: null, threadId: null, chips: [], gen: 0, ctx: {},
//                                  pageOff: new Set(), asking: null }.
//   isStale(state, pageKey)        true when pageKey is not the Ask page, state.page is not null and
//                                  pageKey !== state.page.
//   adoptPage(state, pageKey)      a legacy null page adopts pageKey (never the Ask page).
//   newConversation(state, pageKey) threadId null, chips [], pageOff cleared, page = pageKey,
//                                  gen + 1. asking is left as is: a question still in flight keeps
//                                  its older gen, so its late answer is not adopted (clearing it
//                                  would let adoptThread take the late thread).
//   beginAdd(state, pageKey, chip) starts a new conversation first when stale, then adds the chip
//                                  (dedupe by refKey, newest MAX_REFS kept) and, with a current
//                                  thread, writes its ctx. Returns true when it started a new one.
//   beginAsk(state, pageKey, pageChip) starts a new conversation first when stale; when the
//                                  question will start a new thread (threadId null) records
//                                  asking = { gen, origin: pageChip, chips: copy }, else sets
//                                  asking null (chat.js sends one question at a time). Returns
//                                  true when it just started a new conversation.
//   adoptThread(state, thread id, pageChip) remembers ctx[id] from asking (fallback: pageChip and
//                                  chips), adopts the thread only when !asking or asking.gen === gen,
//                                  clears asking. Returns true when adopted.
//   restoreCtx(state, threadId, pageKey, pageChip) reopens a thread with its own context: chips =
//                                  dedupe([origin unless it is the current page chip, ...stored]),
//                                  capped at MAX_REFS; page = pageKey. No stored ctx: chips [].
//   rememberCtx(state, threadId, entry) writes ctx[threadId] = { origin, chips } as the newest
//                                  entry and keeps the CTX_MAX newest.
//   removeChip(state, key, isPage) a page chip goes into pageOff; an added chip is removed and,
//                                  with a current thread, its ctx is updated.
//   visibleChips(state, pageKey, pageChip) the chip row: the page chip (unless removed or already
//                                  added, marked page: true) then the added chips; when stale only
//                                  the page chip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REFS, refKey } from '../web/horizon/screens/ask-context.js';
import {
  CTX_MAX, pageKeyOf, freshConvo, isStale, adoptPage, newConversation, beginAdd, beginAsk,
  adoptThread, restoreCtx, rememberCtx, removeChip, visibleChips
} from '../web/horizon/screens/ask-convo.js';

const HOME = 'home/';
const MONEY = 'money/';
const ASK = 'ask/';
const ASK_T = 'ask/0123456789ab';

const homeChip = { kind: 'page', id: 'home', label: 'Home', q: '' };
const moneyChip = { kind: 'money', id: 'overview', label: 'Money > Overview, last year', q: 'range=1Y' };
const pnlChip = { kind: 'page', id: 'pnl', label: 'Money > P&L, March 2026', q: 'month=2026-03' };
const goal = { kind: 'goal', id: 'g_synth', label: 'Synthetic reserve', q: '' };
const acct = { kind: 'account', id: 'a_synth', label: 'Synthetic checking', q: '' };
const acct2 = { kind: 'account', id: 'a_synth2', label: 'Synthetic savings', q: '' };

const keys = (list) => list.map(refKey);

// A conversation on Home with a thread and one added goal.
function onHome() {
  const s = freshConvo();
  newConversation(s, HOME);
  beginAdd(s, HOME, goal);
  beginAsk(s, HOME, homeChip);
  adoptThread(s, 't_home', homeChip);
  return s;
}

/* ---------- shape and keys ---------- */

test('freshConvo is an empty conversation with no page, gen 0 and empty ctx', () => {
  const s = freshConvo();
  assert.equal(s.page, null);
  assert.equal(s.threadId, null);
  assert.deepEqual(s.chips, []);
  assert.equal(s.gen, 0);
  assert.deepEqual(s.ctx, {});
  assert.ok(s.pageOff instanceof Set && s.pageOff.size === 0);
  assert.equal(s.asking, null);
  assert.notEqual(freshConvo().chips, s.chips, 'each call is a new object');
  assert.equal(CTX_MAX, 40);
});

test('pageKeyOf uses the design.js draw key: id, else name, else step, else empty', () => {
  assert.equal(pageKeyOf({ name: 'home', params: {} }), 'home/');
  assert.equal(pageKeyOf({ name: 'money' }), 'money/');
  assert.equal(pageKeyOf({ name: 'account', params: { id: 'a_synth' } }), 'account/a_synth');
  assert.equal(pageKeyOf({ name: 'wargame', params: { name: 'salary' } }), 'wargame/salary');
  assert.equal(pageKeyOf({ name: 'onboarding', params: { step: 2 } }), 'onboarding/2');
  assert.equal(pageKeyOf({ name: 'packs', params: { id: 'pk_1', name: 'x' } }), 'packs/pk_1');
  assert.equal(pageKeyOf({ name: 'ask', params: { id: '0123456789ab' } }), ASK_T);
});

/* ---------- staleness ---------- */

test('isStale: same page is not stale, a different page is', () => {
  const s = onHome();
  assert.equal(isStale(s, HOME), false);
  assert.equal(isStale(s, MONEY), true);
  assert.equal(isStale(s, 'account/a_synth'), true);
});

test('isStale: the Ask page is never stale, with or without a thread id', () => {
  const s = onHome();
  assert.equal(isStale(s, ASK), false);
  assert.equal(isStale(s, ASK_T), false);
  assert.equal(beginAdd(s, ASK_T, acct), false, 'an add on the Ask page keeps the conversation');
  assert.equal(s.threadId, 't_home');
  assert.deepEqual(keys(s.chips), ['goal:g_synth', 'account:a_synth']);
  assert.equal(s.page, HOME, 'the Ask page never becomes the conversation page');
  assert.equal(beginAsk(s, ASK_T, null), false);
  assert.equal(s.threadId, 't_home');
});

test('isStale: a legacy null page is never stale and adopts the current page lazily', () => {
  const s = freshConvo();
  s.threadId = 't_legacy';
  s.chips = [{ ...goal }];
  assert.equal(isStale(s, MONEY), false);
  assert.equal(isStale(s, HOME), false);
  adoptPage(s, ASK_T);
  assert.equal(s.page, null, 'the Ask page is never adopted');
  assert.equal(beginAdd(s, MONEY, acct), false, 'a legacy conversation keeps its thread and items');
  assert.equal(s.threadId, 't_legacy');
  assert.deepEqual(keys(s.chips), ['goal:g_synth', 'account:a_synth']);
  assert.equal(s.page, MONEY, 'and now belongs to the page it was used on');
  assert.equal(isStale(s, HOME), true);
  const t = freshConvo();
  adoptPage(t, HOME);
  assert.equal(t.page, HOME);
  adoptPage(t, MONEY);
  assert.equal(t.page, HOME, 'an adopted page is kept');
});

/* ---------- "+" ---------- */

test('beginAdd on the same page adds to the current chat', () => {
  const s = onHome();
  const gen = s.gen;
  assert.equal(beginAdd(s, HOME, acct), false);
  assert.equal(s.threadId, 't_home');
  assert.equal(s.gen, gen);
  assert.deepEqual(keys(s.chips), ['goal:g_synth', 'account:a_synth']);
  assert.equal(beginAdd(s, HOME, { ...acct, label: 'Again' }), false);
  assert.deepEqual(keys(s.chips), ['goal:g_synth', 'account:a_synth'], 'an item already added is not added twice');
});

test('beginAdd on a different page starts a new conversation with that page context and no old items', () => {
  const s = onHome();
  s.pageOff.add(refKey(homeChip));
  const gen = s.gen;
  assert.equal(beginAdd(s, MONEY, acct), true);
  assert.equal(s.threadId, null);
  assert.equal(s.page, MONEY);
  assert.equal(s.gen, gen + 1);
  assert.equal(s.pageOff.size, 0, 'the removed page chip set is cleared');
  assert.deepEqual(keys(s.chips), ['account:a_synth'], 'the Home goal is gone');
  const row = visibleChips(s, MONEY, moneyChip);
  assert.deepEqual(keys(row), ['money:overview', 'account:a_synth']);
  assert.equal(row[0].page, true);
  assert.equal(row[0].q, 'range=1Y', 'the page chip keeps its qualifier');
  assert.ok(!row[1].page);
  assert.equal(isStale(s, MONEY), false);
  assert.equal(beginAdd(s, MONEY, acct2), false, 'a second add on the new page stacks');
  assert.deepEqual(keys(s.chips), ['account:a_synth', 'account:a_synth2']);
});

test('beginAdd keeps the newest MAX_REFS items', () => {
  const s = freshConvo();
  newConversation(s, HOME);
  for (let i = 0; i < MAX_REFS + 3; i++) beginAdd(s, HOME, { kind: 'transaction', id: `t${i}`, label: `Row ${i}` });
  assert.equal(s.chips.length, MAX_REFS);
  assert.deepEqual(s.chips.map((c) => c.id), Array.from({ length: MAX_REFS }, (_, i) => `t${i + 3}`));
});

test('beginAdd with a current thread writes that thread context, keeping its origin', () => {
  const s = onHome();
  assert.deepEqual(s.ctx.t_home.origin, homeChip);
  beginAdd(s, HOME, acct);
  assert.deepEqual(s.ctx.t_home.origin, homeChip);
  assert.deepEqual(keys(s.ctx.t_home.chips), ['goal:g_synth', 'account:a_synth']);
  assert.notEqual(s.ctx.t_home.chips, s.chips, 'ctx holds a copy');
});

/* ---------- a question ---------- */

test('beginAsk when stale starts a new thread with only the current page chip as context', () => {
  const s = onHome();
  const gen = s.gen;
  assert.equal(beginAsk(s, MONEY, moneyChip), true);
  assert.equal(s.threadId, null, 'the question goes as a new thread');
  assert.deepEqual(s.chips, []);
  assert.equal(s.page, MONEY);
  assert.equal(s.gen, gen + 1);
  assert.deepEqual(s.asking, { gen: gen + 1, origin: moneyChip, chips: [] });
  assert.deepEqual(keys(visibleChips(s, MONEY, moneyChip)), ['money:overview']);
});

test('beginAsk on the same page keeps the thread; a new chat records what it was asked with', () => {
  const s = onHome();
  assert.equal(beginAsk(s, HOME, homeChip), false);
  assert.equal(s.threadId, 't_home');
  assert.equal(s.asking, null, 'a question into an existing thread records nothing');

  const t = freshConvo();
  newConversation(t, HOME);
  beginAdd(t, HOME, goal);
  assert.equal(beginAsk(t, HOME, homeChip), false);
  assert.deepEqual(t.asking, { gen: t.gen, origin: homeChip, chips: [goal] });
  assert.notEqual(t.asking.chips, t.chips, 'asking holds a copy');
});

test('while stale on an old thread the chip row shows only the current page chip', () => {
  const s = onHome();
  beginAdd(s, HOME, acct);
  assert.deepEqual(keys(visibleChips(s, HOME, homeChip)), ['page:home', 'goal:g_synth', 'account:a_synth']);
  const row = visibleChips(s, MONEY, moneyChip);
  assert.deepEqual(keys(row), ['money:overview']);
  assert.equal(row[0].page, true);
  assert.equal(s.threadId, 't_home', 'looking does not change the conversation');
  assert.deepEqual(keys(s.chips), ['goal:g_synth', 'account:a_synth']);
});

test('visibleChips drops a removed page chip and a page chip already added', () => {
  const s = freshConvo();
  newConversation(s, HOME);
  assert.deepEqual(keys(visibleChips(s, HOME, homeChip)), ['page:home']);
  removeChip(s, refKey(homeChip), true);
  assert.deepEqual(visibleChips(s, HOME, homeChip), []);
  const t = freshConvo();
  newConversation(t, 'pnl/');
  beginAdd(t, 'pnl/', { ...pnlChip });
  const row = visibleChips(t, 'pnl/', pnlChip);
  assert.deepEqual(keys(row), ['page:pnl']);
  assert.ok(!row[0].page, 'the added copy, not the page chip');
  assert.deepEqual(visibleChips(freshConvo(), ASK_T, null), [], 'the Ask page has no page chip');
});

/* ---------- thread adoption ---------- */

test('adoptThread remembers the asked-with context and adopts the thread', () => {
  const s = freshConvo();
  newConversation(s, HOME);
  beginAdd(s, HOME, goal);
  beginAsk(s, HOME, homeChip);
  assert.equal(adoptThread(s, 't_new', homeChip), true);
  assert.equal(s.threadId, 't_new');
  assert.equal(s.asking, null);
  assert.deepEqual(s.ctx.t_new, { origin: homeChip, chips: [goal] });
});

test('adoptThread without a recorded question falls back to the page chip and the chips', () => {
  const s = freshConvo();
  newConversation(s, MONEY);
  beginAdd(s, MONEY, acct);
  assert.equal(adoptThread(s, 't_handed', moneyChip), true);
  assert.equal(s.threadId, 't_handed');
  assert.deepEqual(s.ctx.t_handed, { origin: moneyChip, chips: [acct] });
});

test('an answer landing after a newer conversation started does not adopt its thread', () => {
  const s = freshConvo();
  newConversation(s, HOME);
  beginAdd(s, HOME, goal);
  beginAsk(s, HOME, homeChip);
  // The owner moves on and adds on Money before the first answer lands.
  assert.equal(beginAdd(s, MONEY, acct), true);
  assert.equal(adoptThread(s, 't_late', moneyChip), false);
  assert.equal(s.threadId, null, 'the new conversation is not hijacked');
  assert.deepEqual(keys(s.chips), ['account:a_synth']);
  assert.equal(s.asking, null);
  assert.deepEqual(s.ctx.t_late, { origin: homeChip, chips: [goal] }, 'the late thread keeps the context it was asked with');

  const t = freshConvo();
  newConversation(t, HOME);
  beginAsk(t, HOME, homeChip);
  newConversation(t, HOME);
  assert.equal(adoptThread(t, 't_late2', homeChip), false, 'New conversation also wins over a late answer');
  assert.equal(t.threadId, null);
});

/* ---------- New conversation ---------- */

test('New conversation clears the items added in the old chat and the removed page chip, and bumps gen', () => {
  const s = onHome();
  beginAdd(s, HOME, acct);
  s.pageOff.add(refKey(homeChip));
  const gen = s.gen;
  newConversation(s, HOME);
  assert.equal(s.threadId, null);
  assert.deepEqual(s.chips, [], 'the goal and the account added in the old chat are gone');
  assert.equal(s.pageOff.size, 0);
  assert.equal(s.page, HOME);
  assert.equal(s.gen, gen + 1);
  assert.deepEqual(keys(visibleChips(s, HOME, homeChip)), ['page:home'], 'only the current page chip remains');
  assert.deepEqual(keys(s.ctx.t_home.chips), ['goal:g_synth', 'account:a_synth'], 'the old thread keeps its own context');
  // The next question in the new chat is a new thread asked with the page chip alone.
  assert.equal(beginAsk(s, HOME, homeChip), false);
  assert.deepEqual(s.asking, { gen: gen + 1, origin: homeChip, chips: [] });
});

test('New conversation on another page belongs to that page', () => {
  const s = onHome();
  newConversation(s, MONEY);
  assert.equal(s.page, MONEY);
  assert.equal(isStale(s, MONEY), false);
  assert.equal(isStale(s, HOME), true);
});

/* ---------- reopening ---------- */

test('reopening a conversation restores its origin and chips and adopts the current page', () => {
  const s = onHome();
  beginAdd(s, HOME, acct);
  newConversation(s, MONEY);
  restoreCtx(s, 't_home', MONEY, moneyChip);
  assert.equal(s.threadId, 't_home');
  assert.equal(s.page, MONEY);
  assert.deepEqual(keys(s.chips), ['page:home', 'goal:g_synth', 'account:a_synth'], 'the Home page chip comes back as an item');
  assert.equal(isStale(s, MONEY), false);
  assert.equal(isStale(s, HOME), true);
  assert.deepEqual(keys(visibleChips(s, MONEY, moneyChip)), ['money:overview', 'page:home', 'goal:g_synth', 'account:a_synth']);
});

test('reopening on the page it started on does not repeat the page chip', () => {
  const s = onHome();
  newConversation(s, HOME);
  restoreCtx(s, 't_home', HOME, homeChip);
  assert.deepEqual(keys(s.chips), ['goal:g_synth']);
  // The origin matches by refKey: a different qualifier is still the same page.
  const t = freshConvo();
  rememberCtx(t, 't_pnl', { origin: { ...pnlChip, q: 'month=2026-02' }, chips: [] });
  restoreCtx(t, 't_pnl', 'pnl/', pnlChip);
  assert.deepEqual(t.chips, []);
});

test('reopening dedupes and caps at MAX_REFS; a thread with no stored context restores with no chips', () => {
  const s = freshConvo();
  const many = Array.from({ length: MAX_REFS + 2 }, (_, i) => ({ kind: 'transaction', id: `t${i}`, label: `Row ${i}`, q: '' }));
  rememberCtx(s, 't_many', { origin: homeChip, chips: [many[0], ...many, { ...homeChip }] });
  restoreCtx(s, 't_many', MONEY, moneyChip);
  assert.equal(s.chips.length, MAX_REFS);
  assert.deepEqual(keys(s.chips), ['page:home', ...many.slice(0, MAX_REFS - 1).map(refKey)]);

  const t = onHome();
  restoreCtx(t, 't_unknown', MONEY, moneyChip);
  assert.equal(t.threadId, 't_unknown');
  assert.deepEqual(t.chips, []);
  assert.equal(t.page, MONEY);
});

/* ---------- removal and the ctx cap ---------- */

test('removing an added chip while a thread is current updates that thread context', () => {
  const s = onHome();
  beginAdd(s, HOME, acct);
  removeChip(s, refKey(goal), false);
  assert.deepEqual(keys(s.chips), ['account:a_synth']);
  assert.deepEqual(keys(s.ctx.t_home.chips), ['account:a_synth']);
  assert.deepEqual(s.ctx.t_home.origin, homeChip);
  removeChip(s, refKey(homeChip), true);
  assert.ok(s.pageOff.has('page:home'));
  assert.deepEqual(keys(s.chips), ['account:a_synth'], 'removing the page chip leaves the items');
});

test('the remembered contexts are capped at the 40 most recently written', () => {
  const s = freshConvo();
  for (let i = 0; i < CTX_MAX + 5; i++) rememberCtx(s, `th${i}`, { origin: null, chips: [] });
  assert.equal(Object.keys(s.ctx).length, CTX_MAX);
  assert.ok(!('th0' in s.ctx) && !('th4' in s.ctx), 'the oldest are dropped');
  assert.ok('th5' in s.ctx && `th${CTX_MAX + 4}` in s.ctx);
  // Writing an old entry again makes it the newest.
  rememberCtx(s, 'th5', { origin: homeChip, chips: [] });
  rememberCtx(s, 'th_new', { origin: null, chips: [] });
  assert.equal(Object.keys(s.ctx).length, CTX_MAX);
  assert.ok('th5' in s.ctx, 'rewritten, so kept');
  assert.ok(!('th6' in s.ctx), 'now the oldest, so dropped');
  assert.deepEqual(s.ctx.th5.origin, homeChip);
});

test('adoptThread counts toward the ctx cap', () => {
  const s = freshConvo();
  newConversation(s, HOME);
  for (let i = 0; i < CTX_MAX; i++) rememberCtx(s, `old${i}`, { origin: null, chips: [] });
  beginAsk(s, HOME, homeChip);
  adoptThread(s, 't_fresh', homeChip);
  assert.equal(Object.keys(s.ctx).length, CTX_MAX);
  assert.ok('t_fresh' in s.ctx && !('old0' in s.ctx));
});

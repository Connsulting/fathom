import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { setSetting } from '../src/store/db.mjs';
import { guessCategories } from '../src/categories/guess.mjs';
import { categoryOptions, loadCategoryInputs, setTransactionCategory } from '../src/categories/store.mjs';
import { resolveCategories } from '../src/categories/resolve.mjs';
import { ask, answerItem, pendingItems, autoInfo, reopenItem, getItem } from '../src/ingest/confirm.mjs';
import { ingestState } from '../src/ingest/freshness.mjs';
import { planRun } from './helpers/plan.mjs';
import { ingestScreens } from '../web/horizon/screens/ingest.js';

const off = { isOn: () => false, stats: () => ({ costUsd: 0 }) };
const clock = '2026-11-01';
async function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-investment-'));
  const s = await createInstance(dir, { mode: 'real' });
  t.after(async () => { await s.db.close(); await s.platform.close(); rmSync(dir, { recursive: true, force: true }); });
  await setSetting(s.db, 'clock', clock);
  for (const [id, kind] of [['a','taxable'],['b','taxable'],['c','taxable'],['d','taxable'],['card','card'],['work','business']]) await account(s.db, id, kind);
  return s.db;
}
async function account(db, id, kind) {
  await db.prepare('INSERT INTO accounts (id,kind,name) VALUES (?,?,?)').run(id, kind, 'Synthetic ' + id);
}
async function row(db, accountId, description, { guess = 'Investment', date = '2026-10-15', amount = -127 } = {}) {
  const id = Number((await db.prepare('INSERT INTO transactions (account_id,date,description,amount,parser) VALUES (?,?,?,?,?)')
    .run(accountId, date, description, amount, 'simplefin')).lastInsertRowid);
  if (guess) await db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)')
    .run(id, JSON.stringify({ category: guess, confidence: .85 }), 'jev-1.14.0', clock);
  const item = await ask(db, { kind: 'transaction_category', subject: String(id), question: 'Check this transaction category',
    options: categoryOptions(await loadCategoryInputs(db)), context: { transactionId: id, description, amount, date, account: 'Synthetic ' + accountId, guess }, now: clock });
  return { id, item: item.id };
}
async function label(db, accountId, description, category, options = {}) {
  const t = await row(db, accountId, description, { ...options, date: options.date ?? '2026-01-15' });
  await setTransactionCategory(db, t.id, category);
  return t;
}
const resolved = async db => resolveCategories(await loadCategoryInputs(db));

test('AC1 AC4 AC5: one pass moves 46 investment questions out of a 59-item deck with unique reasons and Undo', async t => {
  const db = await store(t), investments = [];
  for (let i = 0; i < 46; i++) investments.push(await row(db, ['a','b','c','d'][i % 4], ['Bought synthetic fund','Dividend synthetic fund','Reinvestment synthetic fund'][i % 3], { amount: (i % 3 === 1 ? 1 : -1) * (127 + i) }));
  for (let i = 0; i < 13; i++) await row(db, i % 2 ? 'card' : 'work', 'Synthetic merchant ' + String.fromCharCode(65 + i), { guess: i % 2 ? 'Shopping' : 'Business' });
  assert.equal((await pendingItems(db)).length, 59);
  const out = await guessCategories(db, off);
  assert.equal(out.stopped, undefined);
  assert.equal(out.applied, 46);
  assert.equal((await pendingItems(db)).filter(i => i.kind === 'transaction_category').length, 13);
  await guessCategories(db, off);
  const state = await ingestState(db, { clock });
  assert.equal(state.decided.length, 46);
  assert.equal(new Set(state.decided.map(d => d.id)).size, 46);
  for (const d of state.decided) {
    assert.equal(d.answer, 'Investment');
    assert.equal(d.evidence, 'Investment account activity');
    assert.equal(d.final, null);
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const html = ingestScreens({ api: { ingest: () => ({ ...state, decided: state.decided.slice(0, 1) }) }, esc,
    section: (_, body) => body, btn: (text, attrs) => `<button ${attrs}>${text}</button>` }).decidedSection();
  assert.equal((html.match(/Investment account activity/g) ?? []).length, 1);
  assert.equal((html.match(/Fathom&#39;s categorization/g) ?? []).length, 1);
  assert.match(html, /data-decided-undo=/);
  assert.equal((await resolved(db)).get(investments[0].id).category, 'Investment');
});

test('investment patterns work without a model guess and HSA cash activity stays pending', async t => {
  const db = await store(t), expected = [];
  for (const kind of ['brokerage','retirement','ira','roth','529']) {
    await account(db, kind, kind);
    expected.push(await row(db, kind, 'Contribution synthetic fund', { guess: null }));
  }
  for (const text of ['Bought synthetic shares','Sold synthetic shares','Dividend synthetic shares','Interest payment','Reinvestment synthetic shares','Management fee']) expected.push(await row(db, 'a', text, { guess: null }));
  await account(db, 'hsa-cash', 'hsa'); await account(db, 'hsa-invest', 'hsa');
  await db.prepare('INSERT INTO positions (account_id,as_of,symbol,value) VALUES (?,?,?,?)').run('hsa-invest', clock, 'SYN', 500);
  expected.push(await row(db, 'hsa-invest', 'Synthetic holding activity'));
  const cash = await row(db, 'hsa-cash', 'Synthetic medical purchase');
  const unrelated = await row(db, 'a', 'Synthetic unknown posting', { guess: 'Shopping' });
  await guessCategories(db, off);
  for (const x of expected) assert.equal((await autoInfo(db, x.item))?.evidence.text, 'Investment account activity');
  for (const x of [cash, unrelated]) assert.equal((await getItem(db, x.item))?.status, 'pending');
});

test('income-like investment activity preserves consistent owner history and transfers keep their handling', async t => {
  const db = await store(t);
  await label(db, 'a', 'Dividend synthetic alpha', 'Income', { amount: 31 });
  await label(db, 'b', 'Interest synthetic cash', 'Income', { amount: 12 });
  const dividend = await row(db, 'c', 'Dividend synthetic beta', { amount: 41 });
  const interest = await row(db, 'd', 'Interest synthetic balance', { amount: 19 });
  const reinvest = await row(db, 'a', 'Dividend reinvestment synthetic alpha');
  for (let i = 0; i < 3; i++) await label(db, 'a', 'Contribution transfer', 'Investment', { amount: -431 - i });
  const outgoing = await row(db, 'a', 'Contribution transfer', { amount: -431 });
  const incoming = await row(db, 'b', 'Contribution transfer', { amount: 431 });
  await guessCategories(db, off);
  for (const x of [dividend, interest]) assert.equal((await resolved(db)).get(x.id).category, 'Income');
  assert.equal((await resolved(db)).get(reinvest.id).category, 'Investment');
  for (const x of [outgoing, incoming]) assert.equal((await resolved(db)).get(x.id).category, 'Internal Transfers');
});

test('AC2: three consistent owner labels in the same account kind decide only a matching guess', async t => {
  const db = await store(t);
  await account(db, 'other-card', 'card'); await account(db, 'cash', 'checking');
  for (let i = 0; i < 3; i++) await label(db, 'card', `POS Cobalt Market #${100 + i}`, 'Groceries', { amount: -20 - i });
  const match = await row(db, 'other-card', 'POS Cobalt Market #900', { guess: 'Groceries', amount: -2500 });
  const wrongGuess = await row(db, 'other-card', 'Cobalt Market', { guess: 'Shopping' });
  const sameAccountWrongGuess = await row(db, 'card', 'Cobalt Market', { guess: 'Shopping' });
  const wrongKind = await row(db, 'cash', 'Cobalt Market', { guess: 'Groceries' });
  for (let i = 0; i < 8; i++) await label(db, 'card', 'Conflicted Market', i === 0 ? 'Shopping' : 'Groceries');
  const conflict = await row(db, 'other-card', 'Conflicted Market', { guess: 'Groceries' });
  const sameAccountConflict = await row(db, 'card', 'Conflicted Market', { guess: 'Groceries' });
  for (let i = 0; i < 2; i++) await label(db, 'card', 'Rare Market', 'Groceries');
  const insufficient = await row(db, 'other-card', 'Rare Market', { guess: 'Groceries' });
  await guessCategories(db, off);
  assert.equal((await autoInfo(db, match.item))?.evidence.text, 'Matches how you categorized Cobalt Market');
  assert.equal((await resolved(db)).get(match.id).category, 'Groceries');
  for (const x of [wrongGuess, sameAccountWrongGuess, wrongKind, conflict, sameAccountConflict, insufficient]) assert.equal((await getItem(db, x.item))?.status, 'pending');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM category_merchant_rules').get()).n, 0);
});

test('AC3: Undo reopens investment and history decisions permanently while owner answers win', async t => {
  const db = await store(t);
  await account(db, 'other-card', 'card');
  for (let i = 0; i < 3; i++) await label(db, 'card', 'Cobalt Market', 'Groceries');
  const investment = await row(db, 'a', 'Bought synthetic fund');
  const history = await row(db, 'other-card', 'Cobalt Market', { guess: 'Groceries' });
  const owner = await row(db, 'b', 'Sold synthetic fund');
  await answerItem(db, owner.item, 'Ignore');
  await guessCategories(db, off);
  for (const x of [investment, history]) { assert.ok(await autoInfo(db, x.item)); reopenItem(db, x.item); }
  await guessCategories(db, off);
  for (const x of [investment, history]) {
    assert.equal((await getItem(db, x.item)).status, 'pending');
    assert.equal(await autoInfo(db, x.item), null);
    assert.equal((await resolved(db)).get(x.id).layer, 'uncategorized');
  }
  assert.equal((await resolved(db)).get(owner.id).category, 'Ignore');
  assert.equal(await autoInfo(db, owner.item), null);
});

test('the next planner run drains eligible pending questions without a migration or provider', async t => {
  const db = await store(t), x = await row(db, 'a', 'Synthetic holding activity');
  await db.prepare('DELETE FROM transaction_category_guesses WHERE transaction_id=?').run(x.id);
  await planRun(db, { now: clock });
  assert.equal((await autoInfo(db, x.item))?.evidence.text, 'Investment account activity');
  assert.equal((await getItem(db, x.item)).status, 'answered');
});

test('new model guesses for investment accounts use the account reason in the same pass', async t => {
  const db = await store(t);
  await label(db, 'card', 'Synthetic historical food', 'Groceries');
  await label(db, 'work', 'Synthetic historical work', 'Business');
  const xs = [await row(db, 'a', 'Synthetic holding alpha', { guess: null }), await row(db, 'b', 'Synthetic holding beta', { guess: null })];
  const provider = { isOn: () => true, stats: () => ({ costUsd: 0 }), choose: async qs => qs.map((_, i) => ({ choice: 'Investment', confidence: i ? .99 : .85 })) };
  const out = await guessCategories(db, provider);
  assert.equal(out.stopped, undefined);
  assert.equal(out.applied, 2);
  for (const x of xs) assert.equal((await autoInfo(db, x.item))?.evidence.text, 'Investment account activity');
});

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
function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-investment-'));
  const s = createInstance(dir, { mode: 'real' });
  t.after(() => { s.db.close(); s.platform.close(); rmSync(dir, { recursive: true, force: true }); });
  setSetting(s.db, 'clock', clock);
  for (const [id, kind] of [['a','taxable'],['b','taxable'],['c','taxable'],['d','taxable'],['card','card'],['work','business']]) account(s.db, id, kind);
  return s.db;
}
function account(db, id, kind) {
  db.prepare('INSERT INTO accounts (id,kind,name) VALUES (?,?,?)').run(id, kind, 'Synthetic ' + id);
}
function row(db, accountId, description, { guess = 'Investment', date = '2026-10-15', amount = -127 } = {}) {
  const id = Number(db.prepare('INSERT INTO transactions (account_id,date,description,amount,parser) VALUES (?,?,?,?,?)')
    .run(accountId, date, description, amount, 'simplefin').lastInsertRowid);
  if (guess) db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)')
    .run(id, JSON.stringify({ category: guess, confidence: .85 }), 'jev-1.14.0', clock);
  const item = ask(db, { kind: 'transaction_category', subject: String(id), question: 'Check this transaction category',
    options: categoryOptions(loadCategoryInputs(db)), context: { transactionId: id, description, amount, date, account: 'Synthetic ' + accountId, guess }, now: clock });
  return { id, item: item.id };
}
function label(db, accountId, description, category, options = {}) {
  const t = row(db, accountId, description, { ...options, date: options.date ?? '2026-01-15' });
  setTransactionCategory(db, t.id, category);
  return t;
}
const resolved = db => resolveCategories(loadCategoryInputs(db));

test('AC1 AC4 AC5: one pass moves 46 investment questions out of a 59-item deck with unique reasons and Undo', async t => {
  const db = store(t), investments = [];
  for (let i = 0; i < 46; i++) investments.push(row(db, ['a','b','c','d'][i % 4], ['Bought synthetic fund','Dividend synthetic fund','Reinvestment synthetic fund'][i % 3], { amount: -127 - i }));
  for (let i = 0; i < 13; i++) row(db, i % 2 ? 'card' : 'work', 'Synthetic merchant ' + String.fromCharCode(65 + i), { guess: i % 2 ? 'Shopping' : 'Business' });
  assert.equal(pendingItems(db).length, 59);
  const out = await guessCategories(db, off);
  assert.equal(out.stopped, undefined);
  assert.equal(out.applied, 46);
  assert.equal(pendingItems(db).filter(i => i.kind === 'transaction_category').length, 13);
  await guessCategories(db, off);
  const state = ingestState(db, { clock });
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
  assert.equal(resolved(db).get(investments[0].id).category, 'Investment');
});

test('investment patterns work without a model guess and HSA cash activity stays pending', async t => {
  const db = store(t), expected = [];
  for (const kind of ['brokerage','retirement','ira','roth','529']) {
    account(db, kind, kind);
    expected.push(row(db, kind, 'Contribution synthetic fund', { guess: null }));
  }
  for (const text of ['Bought synthetic shares','Sold synthetic shares','Dividend synthetic shares','Interest payment','Reinvestment synthetic shares','Management fee']) expected.push(row(db, 'a', text, { guess: null }));
  account(db, 'hsa-cash', 'hsa'); account(db, 'hsa-invest', 'hsa');
  db.prepare('INSERT INTO positions (account_id,as_of,symbol,value) VALUES (?,?,?,?)').run('hsa-invest', clock, 'SYN', 500);
  expected.push(row(db, 'hsa-invest', 'Synthetic holding activity'));
  const cash = row(db, 'hsa-cash', 'Synthetic medical purchase');
  const unrelated = row(db, 'a', 'Synthetic unknown posting', { guess: 'Shopping' });
  await guessCategories(db, off);
  for (const x of expected) assert.equal(autoInfo(db, x.item)?.evidence.text, 'Investment account activity');
  for (const x of [cash, unrelated]) assert.equal(getItem(db, x.item)?.status, 'pending');
});

test('income-like investment activity preserves consistent owner history and transfers keep their handling', async t => {
  const db = store(t);
  label(db, 'a', 'Dividend synthetic alpha', 'Income', { amount: 31 });
  label(db, 'b', 'Interest synthetic cash', 'Income', { amount: 12 });
  const dividend = row(db, 'c', 'Dividend synthetic beta', { amount: 41 });
  const interest = row(db, 'd', 'Interest synthetic balance', { amount: 19 });
  const reinvest = row(db, 'a', 'Dividend reinvestment synthetic alpha');
  const outgoing = row(db, 'a', 'Contribution transfer', { amount: -431 });
  const incoming = row(db, 'b', 'Contribution transfer', { amount: 431 });
  await guessCategories(db, off);
  for (const x of [dividend, interest]) assert.equal(resolved(db).get(x.id).category, 'Income');
  assert.equal(resolved(db).get(reinvest.id).category, 'Investment');
  for (const x of [outgoing, incoming]) assert.equal(resolved(db).get(x.id).category, 'Internal Transfers');
});

test('AC2: three consistent owner labels in the same account kind decide only a matching guess', async t => {
  const db = store(t);
  account(db, 'other-card', 'card'); account(db, 'cash', 'checking');
  for (let i = 0; i < 3; i++) label(db, 'card', `POS Cobalt Market #${100 + i}`, 'Groceries', { amount: -20 - i });
  const match = row(db, 'other-card', 'POS Cobalt Market #900', { guess: 'Groceries', amount: -2500 });
  const wrongGuess = row(db, 'other-card', 'Cobalt Market', { guess: 'Shopping' });
  const wrongKind = row(db, 'cash', 'Cobalt Market', { guess: 'Groceries' });
  for (let i = 0; i < 8; i++) label(db, 'card', 'Conflicted Market', i === 0 ? 'Shopping' : 'Groceries');
  const conflict = row(db, 'other-card', 'Conflicted Market', { guess: 'Groceries' });
  for (let i = 0; i < 2; i++) label(db, 'card', 'Rare Market', 'Groceries');
  const insufficient = row(db, 'other-card', 'Rare Market', { guess: 'Groceries' });
  await guessCategories(db, off);
  assert.equal(autoInfo(db, match.item)?.evidence.text, 'Matches how you categorized Cobalt Market');
  assert.equal(resolved(db).get(match.id).category, 'Groceries');
  for (const x of [wrongGuess, wrongKind, conflict, insufficient]) assert.equal(getItem(db, x.item)?.status, 'pending');
  assert.equal(db.prepare('SELECT count(*) AS n FROM category_merchant_rules').get().n, 0);
});

test('AC3: Undo reopens investment and history decisions permanently while owner answers win', async t => {
  const db = store(t);
  account(db, 'other-card', 'card');
  for (let i = 0; i < 3; i++) label(db, 'card', 'Cobalt Market', 'Groceries');
  const investment = row(db, 'a', 'Bought synthetic fund');
  const history = row(db, 'other-card', 'Cobalt Market', { guess: 'Groceries' });
  const owner = row(db, 'b', 'Sold synthetic fund');
  answerItem(db, owner.item, 'Ignore');
  await guessCategories(db, off);
  for (const x of [investment, history]) { assert.ok(autoInfo(db, x.item)); reopenItem(db, x.item); }
  await guessCategories(db, off);
  for (const x of [investment, history]) {
    assert.equal(getItem(db, x.item).status, 'pending');
    assert.equal(autoInfo(db, x.item), null);
    assert.equal(resolved(db).get(x.id).layer, 'uncategorized');
  }
  assert.equal(resolved(db).get(owner.id).category, 'Ignore');
  assert.equal(autoInfo(db, owner.item), null);
});

test('the next planner run drains eligible pending questions without a migration or provider', async t => {
  const db = store(t), x = row(db, 'a', 'Synthetic holding activity');
  await planRun(db, { now: clock });
  assert.equal(autoInfo(db, x.item)?.evidence.text, 'Investment account activity');
  assert.equal(getItem(db, x.item).status, 'answered');
});

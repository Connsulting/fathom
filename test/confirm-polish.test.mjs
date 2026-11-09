// Confirm polish: one stable category order on every card, the best guess highlighted in place and
// taken by Enter, a clean merchant name with the raw bank text behind a toggle, existing formatters
// for amounts and dates, "Fathom's categorization" instead of a vendor or a percentage, and a calm
// collapsed "Decided for you" list. The screen module is plain ESM, so node renders its HTML here
// with the same helper shapes design.js passes in. Every string is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestScreens, visibleOptions, CATEGORY_ORDER, DECIDED_VISIBLE } from '../web/horizon/screens/ingest.js';
import { DEFAULT_CATEGORY } from '../src/categories/resolve.mjs';
import { plainEvidence } from '../src/categories/display.mjs';
import { createInstance } from '../src/platform/db.mjs';
import { setSetting } from '../src/store/db.mjs';
import { guessCategories } from '../src/categories/guess.mjs';
import { ingestState } from '../src/ingest/freshness.mjs';

const VENDOR = /jev|typesafe/i;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function harness(items, decided = []) {
  const answers = [];
  const api = {
    s: {}, route: { name: 'confirm' }, demo: () => true, go() {},
    ingest: () => ({ pending: items.length, items, decided, files: [], waiting: [], sources: [], accounts: {}, staleNotes: [], formats: [] }),
    answer: (id, opt) => { answers.push([String(id), String(opt)]); return Promise.resolve({}); },
    reviseAnswer: () => Promise.resolve({}), reopenAnswer: () => Promise.resolve({}),
  };
  const h = {
    api, esc, draw() {}, getUi: () => ({}), addBtn: () => '', icon: () => '',
    shell: (inner) => inner,
    section: (title, body, aside = '', cls = '') => `<section class="h-sec ${cls}"><div class="h-sec-h"><h2>${title}</h2>${aside ? `<div class="h-sec-aside">${aside}</div>` : ''}</div>${body}</section>`,
    pageHead: (k, t, s = '') => `<div class="h-ph"><div>${k}</div><h1>${t}</h1><p>${s}</p></div>`,
    btn: (label, attrs, cls = '') => `<button type="button" class="h-btn ${cls}" ${attrs}>${label}</button>`,
  };
  return { screens: ingestScreens(h), answers };
}

const settle = () => new Promise((r) => setImmediate(r));
const CLEAN = 'This merchant was Groceries in your past purchases.';

// The stored options as the server writes them: the guess first, then the standing categories.
function categoryItem(id, guess, patch = {}) {
  const names = [...new Set([guess, ...Object.values(DEFAULT_CATEGORY)].filter(Boolean))];
  const options = names.flatMap((c) => [{ id: c, label: c }, { id: `always:${c}`, label: c }]);
  return {
    id, kind: 'transaction_category', status: 'pending', question: 'Check this transaction category', options,
    context: { kind: 'transaction_category', merchant: 'sample coffee', description: 'SQ *SAMPLE COFFEE #0412', amount: -25, date: '2026-10-02', account: 'Everyday Checking', category: 'Uncategorized', guess },
    txn: { name: 'Sample Coffee', raw: 'SQ *SAMPLE COFFEE #0412', amount: -25, date: '2026-10-02', account: 'Everyday Checking' },
    detail: { type: 'values', values: [{ label: 'Transaction', value: 'SQ *SAMPLE COFFEE #0412' }, { label: 'Amount', value: -25 }, { label: 'Date', value: '2026-10-02' }] },
    guess: guess ? { option: guess, label: guess, reason: CLEAN, evidence: CLEAN, source: 'engine' } : null,
    fileName: null, rank: 1, group: null, ...patch,
  };
}
const decidedRow = (id, patch = {}) => ({
  id, kind: 'transaction_category', question: 'Check this transaction category', answer: 'Groceries', answerLabel: 'Groceries',
  rule: 'category_guess', evidence: CLEAN, final: null,
  txn: { name: `Sample Shop ${id}`, raw: `SAMPLE SHOP #${id}`, amount: -10 - id, date: '2026-10-03', account: 'Everyday Checking' }, ...patch,
});
const optionOrder = (html) => [...html.matchAll(/data-answer="[^"]*" data-option="([^"]*)"/g)].map((m) => m[1]);

test('the fixed category order is the standing category list, in the standing order', () => {
  assert.deepEqual(CATEGORY_ORDER, Object.values(DEFAULT_CATEGORY));
});

test('every card lists its categories in one order whatever the best guess is', () => {
  const guesses = [null, 'Business', 'Ignore', 'Groceries', 'Dining & Drinks', 'Income'];
  const lists = guesses.map((g, i) => visibleOptions(categoryItem(i + 1, g)).map((o) => o.id));
  for (const [i, ids] of lists.entries()) {
    assert.deepEqual(ids.slice(0, CATEGORY_ORDER.length), CATEGORY_ORDER, `standing categories on the card with guess ${guesses[i]}`);
    if (!CATEGORY_ORDER.includes(guesses[i]) && guesses[i]) assert.deepEqual(ids.slice(CATEGORY_ORDER.length), [guesses[i]], 'a guess outside the standing list comes last');
    else assert.equal(ids.length, CATEGORY_ORDER.length);
  }
  for (let n = 0; n < CATEGORY_ORDER.length; n++) assert.equal(new Set(lists.map((ids) => ids[n])).size, 1, `key ${n + 1} names one category on every card`);
});

test('number keys mean the same category on every card', async () => {
  const items = [categoryItem(1, 'Groceries'), categoryItem(2, null), categoryItem(3, 'Income'), categoryItem(4, 'Business')];
  const { screens, answers } = harness(items);
  screens.confirmPage(true);
  for (let i = 0; i < items.length; i++) {
    assert.equal(screens.deckAction('pick', { key: '2' }), true);
    await settle();
    assert.deepEqual(answers[i], [String(items[i].id), 'always:' + CATEGORY_ORDER[1]], `card ${i + 1}`);
  }
});

test('the best guess is highlighted where it belongs, not moved to the front', () => {
  for (const guess of ['Income', 'Investment', 'Groceries']) {
    const { screens } = harness([categoryItem(1, guess)]);
    const html = screens.confirmPage(true);
    const order = optionOrder(html);
    assert.deepEqual(order, visibleOptions(categoryItem(1, guess)).map((o) => o.id));
    const at = order.indexOf(guess);
    assert.ok(at >= 0);
    if (CATEGORY_ORDER.includes(guess)) assert.equal(at, CATEGORY_ORDER.indexOf(guess), `${guess} keeps its own place`);
    if (guess === 'Income') assert.notEqual(at, 0);
    const button = html.match(new RegExp(`<button[^>]*data-option="${guess}"[^>]*>`))[0];
    assert.match(button, /data-guess="1"/);
    assert.match(html.match(new RegExp(`<button[^>]*data-option="${guess}"[^>]*>[\\s\\S]*?</button>`))[0], new RegExp(`h-deck-n">${at + 1}<`));
    assert.equal((html.match(/data-guess="1"/g) || []).length, 1, 'one highlighted option');
  }
});

test('Enter takes the highlighted guess, wherever it sits in the list', async () => {
  const { screens, answers } = harness([categoryItem(1, 'Taxes')]);
  screens.confirmPage(true);
  assert.equal(screens.deckAction('guess', { key: 'Enter' }), true);
  await settle();
  assert.deepEqual(answers, [['1', 'always:Taxes']]);
});

test('a category card shows the clean merchant name, a signed amount and a short date, with the raw text behind Bank details', () => {
  const { screens } = harness([categoryItem(1, 'Groceries')]);
  const html = screens.confirmPage(true);
  const plain = text(html.replace(/<details[\s\S]*?<\/details>/g, ' '));
  assert.match(plain, /Sample Coffee/);
  assert.match(plain, /-\$25(?!\.)/);
  assert.match(plain, /Oct 2, 2026/);
  assert.doesNotMatch(plain, /2026-10-02/);
  assert.doesNotMatch(plain, /SQ \*|#0412/);
  const details = html.match(/<details[^>]*data-bank-details[^>]*>[\s\S]*?<\/details>/);
  assert.ok(details, 'a Bank details toggle');
  assert.doesNotMatch(details[0], /^<details[^>]* open/);
  assert.match(details[0], /Bank details/);
  assert.match(details[0], /SQ \*SAMPLE COFFEE #0412/);
  assert.equal((html.match(/SQ \*SAMPLE COFFEE #0412/g) || []).length, 1, 'the raw text appears once, inside the toggle');
  assert.doesNotMatch(html, /data-field="file"|<dt>Amount<\/dt>|<dt>Date<\/dt>/, 'the raw values list is gone');
});

test('a machine guess is labelled Fathom\'s categorization with the server evidence, and a person sees no vendor or percentage', () => {
  const items = [categoryItem(1, 'Groceries'), categoryItem(2, null)];
  const decided = [decidedRow(11), decidedRow(12, { evidence: '' })];
  const { screens } = harness(items, decided);
  const page = text(screens.confirmPage(true));
  assert.match(page, /Fathom's categorization/);
  assert.ok(page.includes(CLEAN));
  assert.doesNotMatch(page, VENDOR);
  assert.doesNotMatch(page, /%/);
  assert.doesNotMatch(page, /confiden/i);
});

test('Decided for you is one calm row per decision and collapses past a handful', () => {
  const list = Array.from({ length: DECIDED_VISIBLE + 4 }, (_, i) => decidedRow(i + 1));
  const { screens } = harness([], list);
  let html = screens.confirmPage(true);
  const rows = html.match(/<li [^>]*data-decided="\d+"/g) || [];
  assert.equal(rows.length, DECIDED_VISIBLE, 'only the first few rows show');
  assert.match(html, new RegExp(`Show all ${list.length}`));
  const first = html.match(/<li [^>]*data-decided="1"[\s\S]*?<\/li>/)[0];
  const row = text(first);
  assert.match(row, /Sample Shop 1/);
  assert.match(row, /-\$11(?!\.)/);
  assert.match(row, /Oct 3, 2026/);
  assert.match(row, /Groceries/);
  assert.match(row, /Fathom's categorization/);
  assert.ok(row.includes(CLEAN));
  assert.doesNotMatch(row, /2026-10-03|SAMPLE SHOP/);
  assert.match(first, /data-decided-undo="1"/);
  assert.doesNotMatch(text(html), /Check this transaction category/);

  const click = (dataset) => screens.handleClick({ target: { closest: () => ({ tagName: 'BUTTON', dataset }) }, preventDefault() {} });
  assert.equal(click({ decidedMore: '1' }), true);
  html = screens.confirmPage(false);
  assert.equal((html.match(/<li [^>]*data-decided="\d+"/g) || []).length, list.length, 'Show all reveals every row');
  assert.match(html, /Show fewer/);
});

for (const evidence of ["Fathom's categorization", "Fathom's categorization.", { text: " Fathom's categorization " }]) {
  test(`a decided categorization shows its source once for ${JSON.stringify(evidence)}`, () => {
    const { screens } = harness([], [decidedRow(1, { evidence })]);
    const row = text(screens.decidedSection());
    assert.equal((row.match(/Fathom's categorization/g) || []).length, 1);
  });
}

for (const [evidence, expected] of [
  ["Fathom's categorization: your last 3 from Sample Shop were Groceries.", "Your last 3 from Sample Shop were Groceries."],
  ["Fathom's categorization: a payment on your card or a matching transfer between your accounts is not spending.", "A payment on your card or a matching transfer between your accounts is not spending."],
  ["fathom's CATEGORIZATION. a payment processor or payroll deposit into your business account is income.", "A payment processor or payroll deposit into your business account is income."],
  ['this distinct evidence keeps its original wording.', 'this distinct evidence keeps its original wording.'],
]) {
  test(`a decided categorization preserves its reason without a repeated source: ${evidence}`, () => {
    const { screens } = harness([], [decidedRow(1, { evidence })]);
    const row = text(screens.decidedSection());
    assert.equal((row.match(/Fathom's categorization/gi) || []).length, 1);
    assert.ok(row.includes(`Fathom's categorization. ${expected}`));
  });
}

test('a short Decided for you list shows every row and no toggle', () => {
  const { screens } = harness([], [decidedRow(1), decidedRow(2)]);
  const html = screens.confirmPage(true);
  assert.equal((html.match(/<li [^>]*data-decided="\d+"/g) || []).length, 2);
  assert.doesNotMatch(html, /data-decided-more/);
});

test('a decision that is not a categorization keeps its question and its evidence', () => {
  const dup = { id: 7, kind: 'near_duplicate', question: 'Is this the same transaction?', answer: 'same', answerLabel: 'Same transaction', rule: 'cross_format_duplicate', evidence: 'Both rows are dated Oct 3, 2026 for $12.00; the descriptions match too.', final: null };
  const { screens } = harness([], [dup]);
  const row = text(screens.confirmPage(true).match(/<li [^>]*data-decided="7"[\s\S]*?<\/li>/)[0]);
  assert.match(row, /Is this the same transaction\?/);
  assert.match(row, /Same transaction/);
  assert.match(row, /the descriptions match too/);
  assert.doesNotMatch(row, /Fathom's categorization/);
});

// The whole server path: a model-made categorization, one applied and one left for review, through
// ingestState into the screen. The text a person reads names no vendor and shows no percentage.
test('real server state renders without a vendor name or a percentage', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-polish-'));
  const s = await createInstance(dir, { mode: 'real' });
  t.after(async () => { await s.db.close(); await s.platform.close(); rmSync(dir, { recursive: true, force: true }); });
  const db = s.db;
  await db.applySchema("INSERT INTO accounts (id,kind,name,mask) VALUES ('a','checking','Everyday','3456')");
  await setSetting(db, 'clock', '2032-11-05');
  const tx = async (description, patch = {}) => Number((await db.prepare('INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES (?,?,?,?,?,?) RETURNING id')
    .get('a', patch.date ?? '2032-10-03', patch.amount ?? -20, description, patch.category ?? null, patch.parser ?? 'simplefin')).id);
  await tx('Different historical merchant', { category: 'Groceries', parser: 'aggregator' });
  await tx('Historical service', { category: 'Business', parser: 'aggregator' });
  const review = await tx('SQ *SAMPLE COFFEE #0412', { amount: -25 });
  const applied = await tx('ACH DEBIT EXAMPLE UTILITY CO 8837261', { amount: -61.5, date: '2032-10-04' });
  assert.ok(review && applied);
  const jev = {
    isOn: () => true, stats: () => ({ costUsd: 0 }),
    choose: async (qs) => qs.map((q) => ({ choice: 'Groceries', confidence: q.state.amount === -25 ? .9 : .99, probabilities: { Groceries: .9, Business: .1 } })),
  };
  await guessCategories(db, jev, { policy: { autoApply: .95, review: .7 } });
  const state = await ingestState(db, { clock: '2032-11-05' });

  const card = state.items.find((i) => i.kind === 'transaction_category');
  assert.ok(card, 'a category check is pending');
  assert.equal(card.txn.name, 'Sample Coffee');
  assert.equal(card.txn.raw, 'SQ *SAMPLE COFFEE #0412');
  const done = state.decided.find((d) => d.kind === 'transaction_category');
  assert.ok(done, 'an applied categorization is decided');
  assert.equal(done.txn.name, 'Example Utility Co');
  assert.equal(done.evidence, "Fathom's categorization", 'the server sends the source once');
  for (const g of [card.guess?.evidence, card.guess?.reason, done.evidence]) {
    assert.doesNotMatch(String(g ?? ''), VENDOR);
    assert.doesNotMatch(String(g ?? ''), /%/);
  }

  const { screens } = harness(state.items, state.decided);
  const page = text(screens.confirmPage(true));
  const decided = text(screens.decidedSection().match(new RegExp(`<li [^>]*data-decided="${done.id}"[\\s\\S]*?<\\/li>`))[0]);
  assert.equal((decided.match(/Fathom's categorization/g) || []).length, 1);
  assert.match(page, /Fathom's categorization/);
  assert.match(page, /Example Utility Co/);
  assert.doesNotMatch(page, VENDOR);
  assert.doesNotMatch(page, /%/);
  assert.equal(plainEvidence(done.evidence), done.evidence);
});

test('merchant-wide answers are checked by default, named plainly, and can be limited to one transaction', async () => {
  const { screens, answers } = harness([categoryItem(1, 'Shopping')]);
  const html = screens.confirmPage(true);
  assert.match(html, /data-category-always="1" checked/);
  assert.match(text(html), /Apply to all from Sample Coffee/);
  screens.handleChange({ type: 'change', target: { matches: s => s === 'input[data-category-always]',
    dataset: { categoryAlways: '1' }, checked: false } });
  screens.deckAction('guess', { key: 'Enter' });
  await settle();
  assert.deepEqual(answers, [['1', 'Shopping']]);
});

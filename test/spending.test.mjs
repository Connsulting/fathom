// Household spending (src/pnl): trailing twelve months of categorized spending on household
// accounts, with housing and taxes toggles, left-out buckets, data gaps, figure provenance and the
// rows behind a cell. Tags: pl-ac2 household behavior, pl-ac3 provenance and rows, pl-ac4 HTTP,
// pnl2-ac2 the rows sum equals the cell it opens from, pnl2-ac3 a month bounds the rows.
//
// Synthetic store, clock 2032-11-05. Everyday checking pays a mortgage (1,500), groceries (200) and
// receives pay on the 1st, 5th and 10th of every month Dec 2031..Oct 2032, plus one Nov 2032 row in
// the clock month and one after the clock. Nov 2031 has no spending-account row at all. An old
// checking account stopped in May 2032; a spare checking account never had a row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { setSetting } from '../src/store/db.mjs';
import { ask, recordAutoAnswer } from '../src/ingest/confirm.mjs';
import { JEV_MODEL } from '../src/categories/jev.mjs';
import { resolveCategories } from '../src/categories/resolve.mjs';
import { loadCategoryInputs } from '../src/categories/store.mjs';
import { serveAppFixture, tempDb } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { householdSpending, householdSpendingRows, PnlError } from '../src/pnl/index.mjs';
import { ITEM_LIMIT } from '../src/pnl/shared.mjs';

const CLOCK = '2032-11-05';
const r2 = (x) => Math.round(x * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const RANGE = ['2031-11', '2031-12', ...Array.from({ length: 10 }, (_, i) => `2032-${pad(i + 1)}`)];
const TOTAL = 19658.83; // Groceries 2160 + Mortgage 16500 + Dining 95.5 + Bills 450 + Uncategorized 333.33 + Shopping 120
const TAX = 2400;
const HOUSING = 16500;

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fathom-spending-'));
  const s = createInstance(dir, { mode: 'real' });
  setSetting(s.db, 'clock', CLOCK);
  t.after(() => { s.db.close(); s.platform.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...s, dir };
}

function account(db, id, kind, name, extra = {}) {
  db.prepare('INSERT INTO accounts (id, kind, inst, name, mask, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, kind, extra.inst ?? 'Example Bank', name, extra.mask ?? null, extra.sort ?? 0);
}

let dedupe = 0;
function txn(db, account_id, date, amount, description, category = null) {
  const q = db.prepare('INSERT INTO transactions (account_id, date, amount, description, category, parser, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(account_id, date, amount, description, category, 'aggregator', `spend-test:${++dedupe}`);
  return Number(q.lastInsertRowid);
}

function household(db) {
  const ids = {};
  account(db, 'chk', 'checking', 'Everyday checking', { sort: 1 });
  account(db, 'card', 'card', 'Rewards card', { inst: 'Example Card', mask: '5678', sort: 2 });
  account(db, 'sav', 'savings', 'Reserve savings', { sort: 3 });
  account(db, 'old', 'checking', 'Old checking', { sort: 4 });
  account(db, 'empty', 'checking', 'Spare checking', { sort: 5 });
  account(db, 'brk', 'taxable', 'Taxable brokerage', { sort: 6 });
  account(db, 'biz', 'business', 'Business checking', { sort: 7 });

  for (const [y, m] of [[2031, 12], ...Array.from({ length: 10 }, (_, i) => [2032, i + 1])]) {
    const p = `${y}-${pad(m)}`;
    txn(db, 'chk', `${p}-01`, -1500, 'Example Home Loan', 'Mortgage');
    txn(db, 'chk', `${p}-05`, -200, 'Example Market', 'Groceries');
    txn(db, 'chk', `${p}-10`, 5000, 'Payroll deposit', 'Income');
  }
  ids.taxes = ['01', '04', '06', '09'].map((m) => txn(db, 'chk', `2032-${m}-15`, -600, 'State tax payment', 'Taxes'));
  ids.refund = txn(db, 'chk', '2032-03-08', 40, 'Example Market refund', 'Groceries');
  // A structural transfer between household accounts and a card payment found by its words.
  ids.toSavings = txn(db, 'chk', '2032-04-20', -1000, 'Move to savings');
  ids.fromChecking = txn(db, 'sav', '2032-04-21', 1000, 'Transfer in');
  ids.cardPayment = txn(db, 'chk', '2032-05-25', -800, 'Example Card PAYMENT 5678');
  ids.cardCredit = txn(db, 'card', '2032-06-15', 800, 'PAYMENT THANK YOU');
  ids.cafe = [txn(db, 'card', '2032-06-03', -75.5, 'Example Cafe', 'Dining & Drinks'), txn(db, 'card', '2032-10-04', -20, 'Example Cafe', 'Dining & Drinks')];
  ids.lunch = txn(db, 'chk', '2032-07-09', -300, 'Client lunch', 'Business');
  ids.saving = txn(db, 'chk', '2032-08-03', -2000, 'Brokerage contribution', 'Investment');
  ids.excluded = txn(db, 'chk', '2032-08-12', -55, 'Ignored adjustment', 'Ignore');
  ids.uncat = txn(db, 'chk', '2032-09-14', -333.33, 'Unknown shop');
  ids.guess = txn(db, 'chk', '2032-10-11', -120, 'Mystery merchant');
  const proposal={category:'Shopping',confidence:.99,probabilities:{Shopping:.99,Groceries:.01}};
  db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)').run(ids.guess,JSON.stringify(proposal),JEV_MODEL,'2032-10-12T00:00:00Z');
  const item=ask(db,{kind:'transaction_category',subject:String(ids.guess),question:'Check this transaction category',
    options:[{id:'Shopping',label:'Shopping'},{id:'Groceries',label:'Groceries'}],context:{transactionId:ids.guess,guess:'Shopping',jev:proposal}});
  recordAutoAnswer(db,item.id,'Shopping',{rule:'jev_category',evidence:{text:'Jev guess, 99% confident',refs:{confidence:.99,model:JEV_MODEL}}});
  txn(db, 'sav', '2032-10-31', 1.23, 'Interest', 'Income');
  ids.old = [1, 2, 3, 4, 5].map((m) => txn(db, 'old', `2032-${pad(m)}-20`, -90, 'Old account fee', 'Bills & Utilities'));
  // Never household spending: a brokerage fee and a business account's purchases.
  txn(db, 'brk', '2032-06-10', -50, 'Fund fee', 'Fees');
  ids.bizShopping = txn(db, 'biz', '2032-06-06', -999, 'Office chairs', 'Shopping');
  txn(db, 'biz', '2032-07-07', -450, 'Supplies', 'Business');
  // The clock month and after the clock.
  txn(db, 'chk', '2032-11-02', -200, 'Example Market', 'Groceries');
  txn(db, 'chk', '2032-11-20', -5555, 'Example Market', 'Groceries');
  return ids;
}

const fig = (p, key) => {
  assert.ok(key, 'figure key present');
  const f = p.figures[key];
  assert.ok(f, `figure ${key} is in figures`);
  return f;
};
const val = (p, key) => (key == null ? null : r2(fig(p, key).v));
const bucketOf = (p, b) => p.buckets.find((x) => x.bucket === b);
const catOf = (p, b, name) => {
  const c = bucketOf(p, b)?.categories.find((x) => x.category === name);
  assert.ok(c, `${b} category ${name}`);
  return c;
};
const leftOf = (p) => Object.fromEntries(p.leftOut.map((l) => [l.key, l]));
// The contract names both the month list and the per-month total map `months`. Accept either
// resolution: `months` is the list and the map is another top-level object keyed by exactly those
// months, or `months` is the map itself.
const monthList = (p) => (Array.isArray(p.months) ? p.months : Object.keys(p.months));
function monthMap(p) {
  if (!Array.isArray(p.months)) return p.months;
  const list = p.months.join();
  for (const [k, v] of Object.entries(p)) {
    if (k === 'figures' || k === 'sources' || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (Object.keys(v).join() === list) return v;
  }
  assert.fail('no per-month total map keyed by the range months');
}
const prov = (f, table) => f.provenance.rows.find((r) => r.table === table);
const near = (a, b) => Math.abs(a - b) < 1e-6;
function code(fn) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof PnlError, `expected PnlError, got ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    return e.code;
  }
  return 'ok';
}
function figKeysOf(payload) {
  const out = new Set();
  const walk = (x, top) => {
    if (typeof x === 'string') { if (/^(pnl|spend)\./.test(x)) out.add(x); return; }
    if (Array.isArray(x)) { for (const v of x) walk(v, false); return; }
    if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (top && (k === 'figures' || k === 'sources')) continue; walk(v, false); }
  };
  walk(payload, true);
  return [...out];
}
function checkFigure(p, key) {
  const f = fig(p, key);
  assert.ok(/^spend\./.test(key), `household figure key ${key} starts with spend.`);
  assert.match(key, /^[^\s&"'<>]+$/, `key ${key} is encoded`);
  assert.equal(typeof f.v, 'number', key);
  assert.equal(r2(f.v), f.v, `${key} is cents-rounded`);
  assert.equal(f.kind, 'a', key);
  assert.ok(typeof f.label === 'string' && f.label.length > 0, key);
  assert.equal(f.src, 'spend:transactions', key);
  assert.ok(Array.isArray(f.notes) && f.notes.length <= 5, key);
  assert.ok(Array.isArray(f.detail) && f.detail.length > 0 && f.detail.every((d) => typeof d.k === 'string' && typeof d.v === 'string'), `${key} detail`);
  const pv = f.provenance;
  assert.equal(pv.source, 'transactions', key);
  assert.ok(Array.isArray(pv.accounts) && pv.accounts.every((a) => typeof a.id === 'string' && typeof a.label === 'string'), key);
  assert.ok(Array.isArray(pv.months) && pv.months.every((m) => /^\d{4}-\d{2}$/.test(m)), key);
  assert.ok(Array.isArray(pv.rows) && pv.rows.length > 0, key);
  for (const r of pv.rows) {
    assert.equal(r.table, 'transactions', key);
    assert.ok(Array.isArray(r.ids) && r.ids.length <= 50 && Number.isInteger(r.count) && r.count >= r.ids.length, key);
  }
  assert.ok(Array.isArray(pv.files), key);
  if (f.sums) for (const s of f.sums) assert.equal(s.asOf, 'transactions', key);
  return f;
}

/* ---------------------------------------------------------------- pl-ac2 */

test('pl-ac2 only household spending counts: transfers, card payments, business, tax, saving and excluded are left out; refunds lower a category; business accounts never count', (t) => {
  const { db } = store(t);
  const ids = household(db);
  const p = householdSpending({ db });
  assert.equal(val(p, p.total), TOTAL);
  assert.deepEqual(p.buckets.map((b) => b.bucket), ['household']);
  const want = { Groceries: 2160, Mortgage: HOUSING, 'Dining & Drinks': 95.5, 'Bills & Utilities': 450, Uncategorized: 333.33, Shopping: 120 };
  const got = Object.fromEntries(bucketOf(p, 'household').categories.map((c) => [c.category, val(p, c.total)]));
  assert.deepEqual(got, want);
  assert.equal(catOf(p, 'household', 'Mortgage').housing, true);
  assert.equal(catOf(p, 'household', 'Groceries').housing, false);
  const groceries = catOf(p, 'household', 'Groceries');
  assert.equal(val(p, groceries.months['2032-03']), 160, 'the refund lowers Groceries in its month');
  assert.equal(val(p, groceries.months['2032-04']), 200);

  const left = leftOf(p);
  for (const k of ['transfer', 'business', 'tax', 'saving', 'excluded']) assert.ok(left[k], `left out ${k}`);
  assert.ok(!left.housing, 'housing is included by default');
  const transferIds = prov(fig(p, left.transfer.amount), 'transactions').ids;
  for (const id of [ids.toSavings, ids.cardPayment]) assert.ok(transferIds.includes(id), `transfer ${id} is left out`);
  assert.equal(left.tax.rows, 4);
  assert.equal(Math.abs(val(p, left.tax.amount)), TAX);
  assert.equal(left.saving.rows, 1);
  assert.equal(Math.abs(val(p, left.saving.amount)), 2000);
  assert.equal(left.excluded.rows, 1);
  assert.equal(Math.abs(val(p, left.excluded.amount)), 55);
  assert.ok(prov(fig(p, left.business.amount), 'transactions').ids.includes(ids.lunch), 'the business-bucket row on checking is left out');
  const totalIds = prov(fig(p, p.total), 'transactions').ids;
  assert.ok(!totalIds.includes(ids.bizShopping), 'a business account row never counts, even in a household category');
  assert.ok(!fig(p, p.total).provenance.accounts.some((a) => ['biz', 'brk'].includes(a.id)));
});

test('pl-ac2 toggles: include tax adds a tax bucket; exclude housing removes Mortgage and lists it as left out', (t) => {
  const { db } = store(t);
  household(db);
  const tax = householdSpending({ db, include: ['tax'] });
  assert.deepEqual(tax.include, ['tax']);
  assert.deepEqual(tax.buckets.map((b) => b.bucket).sort(), ['household', 'tax']);
  assert.equal(val(tax, bucketOf(tax, 'tax').total), TAX);
  assert.equal(val(tax, catOf(tax, 'tax', 'Taxes').total), TAX);
  assert.equal(val(tax, tax.total), r2(TOTAL + TAX));
  assert.ok(!leftOf(tax).tax, 'included tax is not left out');

  const noHousing = householdSpending({ db, exclude: ['housing'] });
  assert.deepEqual(noHousing.exclude, ['housing']);
  assert.ok(!bucketOf(noHousing, 'household').categories.some((c) => c.category === 'Mortgage'));
  assert.equal(val(noHousing, noHousing.total), r2(TOTAL - HOUSING));
  const housing = leftOf(noHousing).housing;
  assert.ok(housing, 'housing is listed as left out');
  assert.equal(housing.rows, 11);
  assert.equal(Math.abs(val(noHousing, housing.amount)), HOUSING);

  const elective = householdSpending({ db, include: ['tax'], exclude: ['housing'] });
  assert.equal(val(elective, elective.total), r2(TOTAL - HOUSING + TAX));
});

test('pl-ac2 default range is the trailing twelve months ending at the latest complete month, with a monthly average', (t) => {
  const { db } = store(t);
  household(db);
  const p = householdSpending({ db });
  assert.equal(p.to, '2032-10', 'the latest row is in the clock month, so the range ends the month before');
  assert.equal(p.from, '2031-11');
  assert.deepEqual(monthList(p), RANGE);
  assert.deepEqual(p.include, []);
  assert.deepEqual(p.exclude, []);
  assert.equal(val(p, p.monthlyAverage), r2(TOTAL / 11), 'average over the 11 months that have a spending-account row');
  const byMonth = monthMap(p);
  assert.equal(byMonth['2031-11'], null, 'a month with no spending-account row has no figure');
  assert.equal(val(p, byMonth['2032-03']), 1750);
  assert.equal(r2(RANGE.reduce((a, m) => a + (val(p, byMonth[m]) ?? 0), 0)), TOTAL, 'the total is the sum of months');
  assert.ok(!JSON.stringify(p).includes('5555'), 'the after-clock row never counts');

  const q = householdSpending({ db, from: '2032-01', to: '2032-03' });
  assert.deepEqual(monthList(q), ['2032-01', '2032-02', '2032-03']);
  assert.equal(val(q, q.total), r2(3 * 1700 + 3 * 90 - 40));
  assert.equal(val(q, q.monthlyAverage), r2((3 * 1790 - 40) / 3));
  // Each category has its own monthly average over the same months as the total's.
  for (const b of q.buckets) for (const c of b.categories) {
    assert.equal(val(q, c.average), r2(val(q, c.total) / 3), `${c.category} average`);
    assert.equal(q.figures[c.average].provenance.rows[0].count, q.figures[c.total].provenance.rows[0].count, `${c.category} average counts the same rows`);
  }
  const groceries = p.buckets.flatMap((b) => b.categories).find((c) => c.category === 'Groceries');
  assert.equal(val(p, groceries.average), r2(val(p, groceries.total) / 11), 'the default range averages over its 11 active months');

  // An explicit clock: its own month is never the end of the default range.
  const early = householdSpending({ db, clock: '2032-10-20' });
  assert.equal(early.to, '2032-09');
  assert.equal(early.from, '2031-10');
  // The latest month is used as is when it is before the clock's month.
  const later = householdSpending({ db, clock: '2032-12-15' });
  assert.equal(later.to, '2032-11');
  assert.equal(later.from, '2031-12');
});

test('pl-ac2 gaps: a stopped feed with its last month, an account with no rows, empty months, uncategorized and guessed shares', (t) => {
  const { db } = store(t);
  household(db);
  const p = householdSpending({ db });
  const gaps = Object.fromEntries(p.gaps.accounts.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(gaps).sort(), ['empty', 'old']);
  assert.equal(gaps.old.state, 'stopped');
  assert.equal(gaps.old.lastMonth, '2032-05');
  assert.equal(gaps.empty.state, 'none');
  assert.equal(gaps.empty.lastMonth, null);
  assert.ok(gaps.old.label && gaps.empty.label);
  assert.deepEqual(p.gaps.emptyMonths, ['2031-11']);
  assert.equal(p.gaps.uncategorized.rows, 1);
  assert.equal(val(p, p.gaps.uncategorized.amount), 333.33);
  assert.ok(near(p.gaps.uncategorized.share, 333.33 / TOTAL));
  assert.equal(p.gaps.guessed.rows, 1);
  assert.equal(val(p, p.gaps.guessed.amount), 120);
  assert.ok(near(p.gaps.guessed.share, 120 / TOTAL));

  // A range before the feed stopped has no stopped account.
  const spring = householdSpending({ db, from: '2032-01', to: '2032-05' });
  assert.ok(!spring.gaps.accounts.some((a) => a.id === 'old'));
  assert.deepEqual(spring.gaps.emptyMonths, []);
  assert.equal(spring.gaps.uncategorized.rows, 0);
  assert.equal(spring.gaps.uncategorized.share, 0);
});

test('pl-ac2 bad include or exclude is bad_option; the allowed options and a bad range are handled', (t) => {
  const { db } = store(t);
  household(db);
  assert.equal(code(() => householdSpending({ db, include: ['rent'] })), 'bad_option');
  assert.equal(code(() => householdSpending({ db, include: ['tax'] })), 'ok');
  assert.equal(code(() => householdSpending({ db, exclude: ['tax'] })), 'bad_option');
  assert.equal(code(() => householdSpending({ db, exclude: ['housing'] })), 'ok');
  assert.equal(code(() => householdSpending({ db, include: ['housing'] })), 'bad_option');
  assert.equal(code(() => householdSpendingRows({ db, include: ['rent'], bucket: 'household', category: 'Groceries' })), 'bad_option');
  assert.equal(code(() => householdSpending({ db, from: '2032-05', to: '2032-04' })), 'bad_range');
  assert.equal(code(() => householdSpending({ db, from: '2022-10', to: '2032-10' })), 'bad_range', '121 months');
  assert.equal(code(() => householdSpending({ db, from: '2022-11', to: '2032-10' })), 'ok', '120 months');
  assert.equal(code(() => householdSpending({ db, from: '2032-1', to: '2032-10' })), 'bad_range');
});

test('pl-ac2 demo seed: estimated tax payments resolve to the tax bucket and including taxes raises the total by their sum', async (t) => {
  const s = await tempDb();
  t.after(() => s.close());
  seedDemo(s.db);
  const rows = s.db.prepare("SELECT * FROM transactions WHERE description = 'Estimated tax payment' ORDER BY date").all();
  assert.ok(rows.length > 0, 'the demo has estimated tax payment rows');
  const resolved = resolveCategories(loadCategoryInputs(s.db));
  for (const r of rows) {
    assert.equal(r.category, 'taxes');
    assert.ok(r.amount < 0);
    assert.equal(resolved.get(r.id).bucket, 'tax', `row ${r.id}`);
  }
  const base = householdSpending({ db: s.db });
  const withTax = householdSpending({ db: s.db, include: ['tax'] });
  assert.equal(withTax.from, base.from);
  assert.equal(withTax.to, base.to);
  const end = `${base.to}-31`;
  const inRange = rows.filter((r) => r.date >= `${base.from}-01` && r.date <= end);
  assert.ok(inRange.length > 0, 'some payments fall in the default range');
  const sum = r2(inRange.reduce((a, r) => a - r.amount, 0));
  assert.equal(r2(val(withTax, withTax.total) - val(base, base.total)), sum);
  assert.equal(val(withTax, bucketOf(withTax, 'tax').total), sum);
});

/* ---------------------------------------------------------------- pl-ac3 */

test('pl-ac3 every household figure resolves with source, detail and provenance', (t) => {
  const { db } = store(t);
  household(db);
  for (const opts of [{}, { include: ['tax'] }, { exclude: ['housing'] }, { from: '2032-01', to: '2032-03' }]) {
    const p = householdSpending({ db, ...opts });
    assert.deepEqual(Object.keys(p.sources), ['spend:transactions'], JSON.stringify(opts));
    assert.equal(p.sources['spend:transactions'].label, 'Categorized household transactions');
    assert.match(p.sources['spend:transactions'].asOf, /^\d{4}-\d{2}-\d{2}$/);
    const keys = figKeysOf(p);
    assert.ok(keys.length > 10, JSON.stringify(opts));
    for (const k of keys) checkFigure(p, k);
  }
  const p = householdSpending({ db });
  assert.equal(p.sources['spend:transactions'].asOf, '2032-10-11', 'newest counted row');
  const total = checkFigure(p, p.total);
  assert.deepEqual(total.provenance.accounts.map((a) => a.id).sort(), ['card', 'chk', 'old']);
  assert.equal(prov(total, 'transactions').count, 32);
  assert.ok(Array.isArray(total.sums) && total.sums.length > 1, 'a multi-month total lists its months');
  assert.equal(r2(total.sums.reduce((a, s) => a + s.v, 0)), r2(total.v));
  const cell = checkFigure(p, catOf(p, 'household', 'Groceries').months['2032-03']);
  assert.deepEqual(cell.provenance.months, ['2032-03']);
  assert.equal(prov(cell, 'transactions').count, 2);
});

test('pl-ac3 householdSpendingRows lists exactly the rows behind a cell, and their amounts sum to it', (t) => {
  const { db } = store(t);
  const ids = household(db);
  const p = householdSpending({ db, include: ['tax'] });
  const check = (opts, cell, count) => {
    const r = householdSpendingRows({ db, include: ['tax'], ...opts });
    assert.equal(r.total, count, JSON.stringify(opts));
    assert.equal(r.items.length, count);
    assert.ok(r.items.every((i) => i.kind === 'transaction'));
    assert.equal(r2(-r.items.reduce((a, i) => a + i.amount, 0)), val(p, cell), `rows sum to the cell ${JSON.stringify(opts)}`);
    assert.equal(val(r, r.sum), val(p, cell), `the sum figure is the cell ${JSON.stringify(opts)}`);
    const dates = r.items.map((i) => i.date);
    assert.deepEqual(dates, dates.toSorted().reverse(), 'newest first');
    for (const i of r.items) {
      assert.ok(r.figures[i.fig], `item figure ${i.fig}`);
      assert.equal(r2(i.value), r2(-i.amount), 'the counted value is the amount negated');
      assert.equal(r2(r.figures[i.fig].v), r2(i.value), 'the item figure is the counted value');
      assert.ok(r.sources[r.figures[i.fig].src]);
      assert.equal(typeof i.account, 'string');
    }
    return r;
  };
  const g = check({ bucket: 'household', category: 'Groceries' }, catOf(p, 'household', 'Groceries').total, 12);
  assert.ok(g.items.some((i) => i.id === ids.refund));
  const mar = check({ bucket: 'household', category: 'Groceries', month: '2032-03' }, catOf(p, 'household', 'Groceries').months['2032-03'], 2);
  assert.equal(mar.items[0].id, ids.refund, 'Mar 8 refund is newer than the Mar 5 purchase');
  const taxes = check({ bucket: 'tax', category: 'Taxes' }, catOf(p, 'tax', 'Taxes').total, 4);
  assert.deepEqual(taxes.items.map((i) => i.id).sort((a, b) => a - b), ids.taxes);
  const shop = check({ bucket: 'household', category: 'Shopping' }, catOf(p, 'household', 'Shopping').total, 1);
  assert.deepEqual(shop.items.map((i) => i.id), [ids.guess], 'the business account purchase is not behind the cell');
  check({ bucket: 'household', category: 'Uncategorized' }, catOf(p, 'household', 'Uncategorized').total, 1);
  check({ bucket: 'household', category: 'Dining & Drinks' }, catOf(p, 'household', 'Dining & Drinks').total, 2);
});

/* ---------------------------------------------------------------- pnl2-ac2, pnl2-ac3 */

// For every category of every bucket of one spending read: the rows for each month with a cell sum
// (the response's `sum` figure) to that cell and list only that month; the rows for the range sum to
// the category total; uncapped items add up to the sum; each item's figure is its counted value, the
// amount negated. Returns how many cells it checked.
function checkRowsMatchCells(db, p) {
  let cells = 0;
  const base = { db, from: p.from, to: p.to, include: p.include, exclude: p.exclude };
  const items = (r, where) => {
    for (const i of r.items) {
      const f = r.figures[i.fig];
      assert.ok(f, `${where}: item figure ${i.fig}`);
      assert.equal(typeof i.value, 'number', `${where}: item ${i.id} has a value`);
      assert.equal(r2(i.value), r2(-i.amount), `${where}: item ${i.id} counted value is the amount negated`);
      assert.equal(r2(f.v), r2(i.value), `${where}: item ${i.id} figure is its counted value`);
    }
    if (r.total <= ITEM_LIMIT) {
      assert.equal(r.items.length, r.total, `${where}: uncapped`);
      assert.equal(r2(r.items.reduce((a, i) => a + i.value, 0)), val(r, r.sum), `${where}: the items add up to the sum`);
    }
  };
  for (const b of p.buckets) {
    for (const c of b.categories) {
      for (const m of monthList(p)) {
        if (!c.months[m]) continue;
        const where = `${b.bucket} ${c.category} ${m}`;
        const r = householdSpendingRows({ ...base, bucket: b.bucket, category: c.category, month: m });
        assert.ok(r.sum, `${where}: the response has a sum figure`);
        assert.equal(val(r, r.sum), val(p, c.months[m]), `${where}: sum equals the cell`);
        assert.ok(r.items.length > 0, `${where}: a cell has rows`);
        for (const i of r.items) assert.equal(String(i.date).slice(0, 7), m, `${where}: item ${i.id} date ${i.date} is in the month`);
        items(r, where);
        cells++;
      }
      const where = `${b.bucket} ${c.category} range`;
      const r = householdSpendingRows({ ...base, bucket: b.bucket, category: c.category });
      assert.ok(r.sum, `${where}: the response has a sum figure`);
      assert.equal(val(r, r.sum), val(p, c.total), `${where}: sum equals the category total`);
      for (const i of r.items) assert.ok(String(i.date).slice(0, 7) >= p.from && String(i.date).slice(0, 7) <= p.to, `${where}: item ${i.id} is in the range`);
      items(r, where);
    }
  }
  return cells;
}

test('pnl2-ac2 pnl2-ac3 household rows: for every category and every month cell the rows sum to the cell, only that month, items carry their counted value', (t) => {
  const { db } = store(t);
  const ids = household(db);
  let cells = 0;
  for (const opts of [{}, { include: ['tax'] }, { exclude: ['housing'] }, { include: ['tax'], exclude: ['housing'], from: '2032-02', to: '2032-07' }]) {
    cells += checkRowsMatchCells(db, householdSpending({ db, ...opts }));
  }
  assert.ok(cells > 40, `checked ${cells} cells`);

  // A refund is a negative spending value and lowers the month's sum.
  const mar = householdSpendingRows({ db, bucket: 'household', category: 'Groceries', month: '2032-03' });
  const refund = mar.items.find((i) => i.id === ids.refund);
  assert.equal(refund.amount, 40);
  assert.equal(refund.value, -40);
  assert.equal(val(mar, mar.sum), 160);

  // A month inside the range with no rows for a real category: no items and a zero sum.
  const none = householdSpendingRows({ db, bucket: 'household', category: 'Dining & Drinks', month: '2032-03' });
  assert.deepEqual(none.items, []);
  assert.equal(none.total, 0);
  assert.equal(val(none, none.sum), 0);
});

test('pnl2-ac2 household rows on the demo store: every month cell and every total matches its rows sum', async (t) => {
  const s = await tempDb();
  t.after(() => s.close());
  seedDemo(s.db);
  const cells = checkRowsMatchCells(s.db, householdSpending({ db: s.db }));
  assert.ok(cells > 0, 'the demo has month cells');
});

test('pnl2-ac2 a capped household rows read still sums every matching row, not just the listed items', (t) => {
  const { db } = store(t);
  account(db, 'chk', 'checking', 'Everyday checking', { sort: 1 });
  const n = ITEM_LIMIT + 25;
  for (let i = 0; i < n; i++) txn(db, 'chk', `2032-05-${pad((i % 28) + 1)}`, -(1 + (i % 7)), `Synthetic market ${i}`, 'Groceries');
  const p = householdSpending({ db });
  const c = catOf(p, 'household', 'Groceries');
  const r = householdSpendingRows({ db, bucket: 'household', category: 'Groceries', month: '2032-05' });
  assert.equal(r.total, n);
  assert.equal(r.items.length, ITEM_LIMIT, 'items are capped');
  assert.equal(val(r, r.sum), val(p, c.months['2032-05']), 'the sum counts every row');
  assert.notEqual(r2(r.items.reduce((a, i) => a + i.value, 0)), val(r, r.sum), 'the listed items alone fall short');
  const all = householdSpendingRows({ db, bucket: 'household', category: 'Groceries' });
  assert.equal(val(all, all.sum), val(p, c.total));
});

/* ---------------------------------------------------------------- pl-ac4 */

test('pl-ac4 household reads never write, and the HTTP routes return the same values with 400 for bad options', async (t) => {
  const { db, dir } = store(t);
  household(db);
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const direct = householdSpending({ db });
  const elective = householdSpending({ db, include: ['tax'], exclude: ['housing'] });
  const rows = householdSpendingRows({ db, bucket: 'household', category: 'Groceries' });
  code(() => householdSpending({ db, include: ['rent'] }));
  assert.equal(changes(), before, 'household reads never write the store');

  const srv = await serveAppFixture({ authenticated: true, db, config: { clock: CLOCK, dataDir: dir }, answerer: null });
  t.after(() => srv.close());
  const get = async (path, status = 200) => {
    const r = await srv.request({ path });
    assert.equal(r.status, status, `${path}: ${r.text.slice(0, 300)}`);
    if (status !== 200) assert.equal(typeof r.json?.error, 'string', 'error body is { error }');
    return r.json;
  };
  const def = await get('/api/spending');
  assert.equal(def.spending.from, direct.from);
  assert.equal(def.spending.to, direct.to);
  assert.equal(def.figures[def.spending.total].v, val(direct, direct.total));
  for (const [k, f] of Object.entries(direct.figures)) assert.equal(def.figures[k]?.v, f.v, k);
  assert.deepEqual(def.sources, JSON.parse(JSON.stringify(direct.sources)));

  const both = await get('/api/spending?include=tax&exclude=housing');
  assert.deepEqual(both.spending.include, ['tax']);
  assert.deepEqual(both.spending.exclude, ['housing']);
  assert.equal(both.figures[both.spending.total].v, val(elective, elective.total));

  const r = await get(`/api/spending/rows?bucket=household&category=${encodeURIComponent('Groceries')}`);
  assert.equal(r.total, rows.total);
  assert.deepEqual(r.items.map((i) => i.id), rows.items.map((i) => i.id));
  const m = await get(`/api/spending/rows?bucket=household&category=Groceries&month=2032-03`);
  assert.equal(m.total, 2);

  await get('/api/spending?include=rent', 400);
  await get('/api/spending?exclude=tax', 400);
  await get('/api/spending?from=2032-06&to=2032-05', 400);
  await get('/api/spending?from=2029-11&to=2032-10', 200);
  await get('/api/spending/rows?include=rent&bucket=household&category=Groceries', 400);
  await get('/api/spending/rows?bucket=household&category=Groceries&month=2032-13', 400);

  // The household's business account is tied to no business name, so it is its own P&L.
  const own = await get('/api/pnl');
  assert.deepEqual(own.entities.map((e) => [e.key, e.kind]), [['account:biz', 'account']]);
  assert.equal(own.pnl.entity.key, 'account:biz');
  assert.equal(changes(), before, 'the HTTP reads never write the store');
});

test('pl-ac4 a household with no business account or workbook gets no entities and a null P&L, not an error', async (t) => {
  const { db, dir } = store(t);
  account(db, 'chk', 'checking', 'Everyday checking', { sort: 1 });
  txn(db, 'chk', '2032-06-10', -200, 'Grocery store', 'Groceries');
  const srv = await serveAppFixture({ authenticated: true, db, config: { clock: CLOCK, dataDir: dir }, answerer: null });
  t.after(() => srv.close());
  const r = await srv.request({ path: '/api/pnl' });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(r.json.entities, []);
  assert.equal(r.json.pnl, null);
  const s = await srv.request({ path: '/api/spending' });
  assert.equal(s.status, 200, s.text.slice(0, 300));
  // The range is still checked with no business data, and a valid one is still accepted.
  for (const q of ['from=2032-13', 'to=2032-1', 'from=2032-06&to=2032-05', 'from=2022-01&to=2032-01']) {
    const bad = await srv.request({ path: `/api/pnl?${q}` });
    assert.equal(bad.status, 400, `${q}: ${bad.text.slice(0, 200)}`);
  }
  const ok = await srv.request({ path: '/api/pnl?from=2032-01&to=2032-06' });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal(ok.json.pnl, null);
});

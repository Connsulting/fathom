// Business P&L (src/pnl): per-entity income, expenses and net by month from the imported workbook or
// the entity's categorized business-account transactions, never both for one month; left-out
// buckets, Uncategorized share, prior-year comparison, figure provenance and the rows behind a cell.
// Tags: pl-ac1 business behavior, pl-ac3 provenance and rows, pl-ac4 module and HTTP surface.
//
// Synthetic store, clock 2032-11-05. Three business names: Example Studio (workbook 2031-01..06 and
// 2032-01..06, plus a stated-entity checking account with transactions 2032-01..08), Sample Works
// (workbook 2032-01..03, one line under an alias), Idle Venture (named only, no data). The unassigned
// business account `biz` (kind business) is its own P&L because there is more than one name.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { callTool } from '../src/tools/index.mjs';
import { setSetting } from '../src/store/db.mjs';
import { accountLabel } from '../src/shared/account-label.mjs';
import { serveAppFixture, tempDb } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import * as PNL from '../src/pnl/index.mjs';
import { pnlEntities, businessPnl, businessPnlRows, PnlError } from '../src/pnl/index.mjs';

const CLOCK = '2032-11-05';
const r2 = (x) => Math.round(x * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const STUDIO = 'entity:examplestudio';
const WORKS = 'entity:sampleworks';
const BIZ = 'account:biz';
const WB_FILE = { id: 'f_wb', name: 'Example studio workbook.xlsx' };

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fathom-pnl-'));
  const s = createInstance(dir, { mode: 'real' });
  setSetting(s.db, 'clock', CLOCK);
  t.after(() => { s.db.close(); s.platform.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...s, dir };
}

function fact(db, key, value) {
  db.prepare(`INSERT INTO facts (key, value, src, confirmed, updated_at) VALUES (?, ?, 'you', 1, '2032-01-01T00:00:00Z')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

function account(db, id, kind, name, extra = {}) {
  db.prepare('INSERT INTO accounts (id, kind, inst, name, owner, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, kind, extra.inst ?? 'Example Bank', name, extra.owner ?? null, extra.sort ?? 0);
}

let dedupe = 0;
function txn(db, account_id, date, amount, description, category = null) {
  const q = db.prepare('INSERT INTO transactions (account_id, date, amount, description, category, parser, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(account_id, date, amount, description, category, 'aggregator', `pnl-test:${++dedupe}`);
  return Number(q.lastInsertRowid);
}

function file(db, f = WB_FILE) {
  db.prepare("INSERT INTO files (id, name, uploaded_at, status) VALUES (?, ?, '2032-07-02T00:00:00Z', 'imported')").run(f.id, f.name);
}

function line(db, entity, period, category, amount, fileId = WB_FILE.id) {
  const q = db.prepare("INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, 'pnl-workbook', ?)")
    .run(entity, period, category, amount, fileId, `sheet:${period}:${category}`);
  return Number(q.lastInsertRowid);
}

// The shared business fixture. Returns ids the tests need.
function business(db) {
  const ids = { lines: {}, txns: {} };
  file(db);
  fact(db, 'business.entities', [{ name: 'Example Studio', type: 'llc' }, { name: 'Sample Works', type: 'sole_prop' }, { name: 'Idle Venture', type: 'llc' }]);
  fact(db, 'accounts.businessEntity', { studio_chk: 'Example Studio' });
  account(db, 'studio_chk', 'checking', 'Studio checking', { sort: 1 });
  account(db, 'biz', 'business', 'Business checking', { sort: 2 });
  account(db, 'home', 'checking', 'Everyday checking', { sort: 3 });

  // Example Studio workbook, 2032-01..06.
  const revenue = { 1: 10000, 2: 12000, 3: 9000, 4: 11000, 5: 10500, 6: 9500 };
  for (let m = 1; m <= 6; m++) {
    const p = `2032-${pad(m)}`;
    ids.lines[`rev:${m}`] = line(db, 'Example Studio', p, 'Consulting revenue', revenue[m]);
    line(db, 'Example Studio', p, 'Software', -300);
    line(db, 'Example Studio', p, 'Rent & Office', -1200);
  }
  ids.lines['rev:3b'] = line(db, 'Example Studio', '2032-03', 'Consulting revenue', -500); // a chargeback stays income
  ids.lines['fees:1'] = line(db, 'Example Studio', '2032-01', 'Refunds and fees', 50);     // category sum is negative: expense
  ids.lines['fees:2'] = line(db, 'Example Studio', '2032-02', 'Refunds and fees', -200);
  // Prior year 2031-01..06.
  for (let m = 1; m <= 6; m++) {
    line(db, 'Example Studio', `2031-${pad(m)}`, 'Consulting revenue', 8000);
    line(db, 'Example Studio', `2031-${pad(m)}`, 'Software', -250);
  }
  // After the clock: never counts.
  line(db, 'Example Studio', '2032-12', 'Consulting revenue', 77777);

  // Example Studio's stated account: Jan..Aug income and tools; Jan..Jun are covered by the workbook.
  for (let m = 1; m <= 8; m++) {
    ids.txns[`in:${m}`] = txn(db, 'studio_chk', `2032-${pad(m)}-12`, 3000, `Studio client payment ${m}`, 'Income');
    ids.txns[`tools:${m}`] = txn(db, 'studio_chk', `2032-${pad(m)}-20`, -400, `Studio tools ${m}`, 'Business');
  }
  txn(db, 'studio_chk', '2032-11-20', 9999, 'Studio client payment late', 'Income'); // after the clock

  // Sample Works workbook 2032-01..03; one Feb line under an alias of the entity.
  db.prepare("INSERT INTO entity_aliases (alias, entity, created_at) VALUES ('sampleworksllc', 'Sample Works', '2032-01-01T00:00:00Z')").run();
  for (const [m, fee, cost] of [[1, 4000, -1000], [2, 4500, -1100], [3, 5000, -1200]]) {
    line(db, 'Sample Works', `2032-${pad(m)}`, 'Design fees', fee);
    line(db, 'Sample Works', `2032-${pad(m)}`, 'Contractors', cost);
    line(db, 'Sample Works', `2032-${pad(m)}`, 'Fees & "Charges"', -25);
  }
  line(db, 'Sample Works LLC', '2032-02', 'Design fees', 500);

  // The unassigned business account: income, business costs with a refund, left-out buckets and an
  // uncategorized outflow larger than the Business category.
  ids.txns.invoiceA = txn(db, 'biz', '2032-03-03', 5000, 'Client invoice A', 'Income');
  ids.txns.invoiceB = txn(db, 'biz', '2032-04-03', 4000, 'Client invoice B', 'Income');
  ids.txns.hosting = txn(db, 'biz', '2032-03-09', -700, 'Hosting service', 'Business');
  ids.txns.refund = txn(db, 'biz', '2032-04-11', 100, 'Hosting refund', 'Business');
  ids.txns.transfer = txn(db, 'biz', '2032-05-02', -1000, 'Owner draw', 'Internal Transfers');
  ids.txns.tax = txn(db, 'biz', '2032-05-14', -1500, 'Quarterly estimate', 'Taxes');
  ids.txns.saving = txn(db, 'biz', '2032-05-20', -2000, 'Retirement plan deposit', 'Investment');
  ids.txns.excluded = txn(db, 'biz', '2032-06-01', -77, 'Ignored adjustment', 'Ignore');
  ids.txns.personal = txn(db, 'biz', '2032-06-04', -123.45, 'Weekend groceries', 'Groceries');
  ids.txns.uncat = txn(db, 'biz', '2032-06-18', -650, 'Unknown vendor', null);

  // Household rows never reach a business P&L.
  txn(db, 'home', '2032-03-05', -88, 'Corner market', 'Groceries');
  return ids;
}

const fig = (p, key) => {
  assert.ok(key, 'figure key present');
  const f = p.figures[key];
  assert.ok(f, `figure ${key} is in figures`);
  return f;
};
const val = (p, key) => (key == null ? null : r2(fig(p, key).v));
const cat = (section, name) => {
  const c = section.categories.find((x) => x.category === name);
  assert.ok(c, `category ${name}`);
  return c;
};
const months = (from, to) => {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
};
function code(fn) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof PnlError, `expected PnlError, got ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    assert.ok(e instanceof Error);
    return e.code;
  }
  return 'ok';
}

// Every string in the payload (outside figures and sources) that names a figure.
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

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function checkFigure(p, key) {
  const f = fig(p, key);
  assert.ok(/^pnl\./.test(key), `business figure key ${key} starts with pnl.`);
  assert.match(key, /^[^\s&"'<>]+$/, `key ${key} is encoded`);
  assert.equal(typeof f.v, 'number', key);
  assert.ok(Number.isFinite(f.v), key);
  assert.equal(r2(f.v), f.v, `${key} is cents-rounded`);
  assert.equal(f.kind, 'a', key);
  assert.equal(typeof f.label, 'string', key);
  assert.ok(f.label.length > 0, key);
  assert.ok(p.sources[f.src], `${key} src ${f.src} is in sources`);
  assert.ok(Array.isArray(f.notes) && f.notes.length <= 5 && f.notes.every((n) => typeof n === 'string'), `${key} notes`);
  assert.ok(Array.isArray(f.detail) && f.detail.length > 0, `${key} has detail rows`);
  for (const d of f.detail) { assert.equal(typeof d.k, 'string', key); assert.equal(typeof d.v, 'string', key); }
  const pv = f.provenance;
  assert.ok(pv && typeof pv === 'object', `${key} provenance`);
  assert.ok(['workbook', 'transactions', 'workbook and transactions'].includes(pv.source), `${key} provenance.source ${pv.source}`);
  assert.ok(Array.isArray(pv.accounts) && pv.accounts.every((a) => typeof a.id === 'string' && typeof a.label === 'string'), `${key} accounts`);
  assert.ok(Array.isArray(pv.months) && pv.months.every((m) => /^\d{4}-\d{2}$/.test(m)), `${key} months`);
  assert.ok(Array.isArray(pv.rows) && pv.rows.length > 0, `${key} rows`);
  for (const r of pv.rows) {
    assert.ok(['pnl_lines', 'transactions'].includes(r.table), `${key} rows table`);
    assert.ok(Array.isArray(r.ids) && r.ids.length <= 50 && r.ids.every(Number.isInteger), `${key} rows ids`);
    assert.ok(Number.isInteger(r.count) && r.count >= r.ids.length, `${key} rows count`);
  }
  assert.ok(Array.isArray(pv.files), `${key} files`);
  if (f.sums) for (const s of f.sums) {
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.v, 'number');
    assert.ok(['workbook', 'transactions'].includes(s.asOf));
  }
  return f;
}
function checkSources(p) {
  for (const [id, s] of Object.entries(p.sources)) {
    assert.ok(['pnl:workbook', 'pnl:transactions', 'pnl:mixed'].includes(id), `source id ${id}`);
    assert.equal(typeof s.label, 'string');
    assert.match(s.asOf, ISO, `${id} asOf`);
  }
}
const prov = (f, table) => f.provenance.rows.find((r) => r.table === table);
const sumItems = (items) => r2(items.reduce((s, i) => s + i.amount, 0));

/* ---------------------------------------------------------------- pl-ac1 */

test('pl-ac1 entities: every business name with data plus the unassigned business account, aliases merged, ordered', (t) => {
  const { db } = store(t);
  business(db);
  const list = pnlEntities({ db });
  assert.deepEqual(list.map((e) => e.key), [STUDIO, WORKS, BIZ], 'Idle Venture has no data and is not listed; the alias is not its own entity');
  const [studio, works, biz] = list;
  assert.equal(studio.kind, 'entity');
  assert.equal(studio.label, 'Example Studio');
  const studioRow = db.prepare("SELECT * FROM accounts WHERE id='studio_chk'").get();
  assert.deepEqual(studio.accounts, [{ id: 'studio_chk', label: accountLabel(studioRow) }]);
  assert.equal(studio.workbook.from, '2031-01');
  assert.equal(studio.workbook.to, '2032-06', 'the after-clock workbook line is not counted');
  assert.equal(studio.workbook.lines, 33);
  assert.equal(studio.transactions.rows, 16, 'the after-clock transaction is not counted');
  assert.ok(String(studio.transactions.to).startsWith('2032-08'));
  assert.equal(works.label, 'Sample Works');
  assert.equal(works.kind, 'entity');
  assert.deepEqual(works.accounts, []);
  assert.equal(works.transactions, null);
  assert.equal(works.workbook.lines, 10);
  assert.equal(biz.kind, 'account');
  assert.deepEqual(biz.accounts.map((a) => a.id), ['biz']);
  assert.equal(biz.workbook, null);
  assert.equal(biz.transactions.rows, 10);
  assert.ok(!list.some((e) => e.accounts.some((a) => a.id === 'home')), 'household accounts are never a P&L');
});

test('pl-ac1 workbook-only entity: categories, monthly income, positive expenses and net; totals are the sum of months; category sign rule', (t) => {
  const { db } = store(t);
  business(db);
  const p = businessPnl({ db, entity: WORKS });
  assert.equal(p.entity.key, WORKS);
  assert.equal(p.from, '2032-01');
  assert.equal(p.to, '2032-03');
  assert.deepEqual(p.months, ['2032-01', '2032-02', '2032-03']);
  assert.deepEqual(p.monthSources.map((m) => m.source), ['workbook', 'workbook', 'workbook']);
  assert.deepEqual(p.income.categories.map((c) => c.category), ['Design fees']);
  assert.deepEqual(p.expenses.categories.map((c) => c.category), ['Contractors', 'Fees & "Charges"']);
  const fees = cat(p.income, 'Design fees');
  assert.deepEqual(p.months.map((m) => val(p, fees.months[m])), [4000, 5000, 5000], 'the alias line counts under Sample Works');
  const contractors = cat(p.expenses, 'Contractors');
  assert.deepEqual(p.months.map((m) => val(p, contractors.months[m])), [1000, 1100, 1200], 'expenses are positive');
  assert.equal(val(p, cat(p.expenses, 'Fees & "Charges"').total), 75);
  assert.equal(val(p, p.income.total), 14000);
  assert.equal(val(p, p.expenses.total), 3375);
  assert.equal(val(p, p.net.total), 10625);
  assert.deepEqual(p.months.map((m) => val(p, p.net.months[m])), [2975, 3875, 3775]);
  for (const s of ['income', 'expenses', 'net']) {
    assert.equal(r2(p.months.reduce((a, m) => a + val(p, p[s].months[m]), 0)), val(p, p[s].total), `${s} total is the sum of months`);
  }
  assert.equal(p.prior, null, 'no 2031 data for Sample Works');
  assert.deepEqual(p.leftOut, []);

  // Sign rule: a category is income when its lines sum positive, else expense, whatever one line's sign.
  const s = businessPnl({ db, entity: STUDIO, from: '2032-01', to: '2032-06' });
  const rev = cat(s.income, 'Consulting revenue');
  assert.equal(val(s, rev.months['2032-03']), 8500, 'a negative line inside an income category lowers it');
  assert.ok(!s.income.categories.some((c) => c.category === 'Refunds and fees'));
  const refunds = cat(s.expenses, 'Refunds and fees');
  assert.equal(val(s, refunds.months['2032-01']), -50, 'a positive line in an expense category is a negative expense');
  assert.equal(val(s, refunds.months['2032-02']), 200);
  assert.equal(refunds.months['2032-03'], null);
  assert.equal(val(s, refunds.total), 150);
});

test('pl-ac1 transactions-only unassigned business account: buckets map to income and expenses, the rest is left out, Uncategorized is an expense with its share', (t) => {
  const { db } = store(t);
  business(db);
  const p = businessPnl({ db, entity: BIZ });
  assert.equal(p.entity.kind, 'account');
  assert.equal(p.from, '2032-01');
  assert.equal(p.to, '2032-06');
  const bySource = Object.fromEntries(p.monthSources.map((m) => [m.month, m.source]));
  assert.equal(bySource['2032-01'], 'none');
  assert.equal(bySource['2032-02'], 'none');
  assert.equal(bySource['2032-03'], 'transactions');
  assert.equal(bySource['2032-06'], 'transactions');
  assert.deepEqual(p.income.categories.map((c) => c.category), ['Income']);
  assert.equal(val(p, p.income.total), 9000);
  assert.deepEqual(p.expenses.categories.map((c) => c.category), ['Business', 'Uncategorized'], 'Uncategorized is last even when larger');
  assert.equal(val(p, cat(p.expenses, 'Business').total), 600, 'the refund lowers Business');
  assert.equal(val(p, cat(p.expenses, 'Business').months['2032-04']), -100);
  assert.equal(val(p, cat(p.expenses, 'Uncategorized').total), 650);
  assert.equal(val(p, p.expenses.total), 1250);
  assert.equal(val(p, p.net.total), 7750);
  assert.equal(p.income.months['2032-01'], null);

  const left = Object.fromEntries(p.leftOut.map((l) => [l.key, l]));
  assert.deepEqual(Object.keys(left).sort(), ['excluded', 'personal', 'saving', 'tax', 'transfer']);
  for (const [k, amount] of [['transfer', 1000], ['tax', 1500], ['saving', 2000], ['excluded', 77], ['personal', 123.45]]) {
    assert.equal(left[k].rows, 1, k);
    assert.equal(Math.abs(val(p, left[k].amount)), amount, k);
    assert.equal(typeof left[k].label, 'string');
  }
  assert.equal(p.uncategorized.rows, 1);
  assert.equal(val(p, p.uncategorized.amount), 650);
  assert.ok(Math.abs(p.uncategorized.share - 650 / 1250) < 1e-6, 'share of expenses');
});

test('pl-ac1 precedence: workbook months use the workbook, other months use transactions, never both; covered rows reported', (t) => {
  const { db } = store(t);
  business(db);
  const p = businessPnl({ db, entity: STUDIO });
  assert.equal(p.from, '2032-01');
  assert.equal(p.to, '2032-08');
  assert.deepEqual(p.months, months('2032-01', '2032-08'));
  const ms = Object.fromEntries(p.monthSources.map((m) => [m.month, m]));
  for (let m = 1; m <= 6; m++) {
    const s = ms[`2032-${pad(m)}`];
    assert.equal(s.source, 'workbook', s.month);
    assert.ok(s.workbookLines >= 3, s.month);
    assert.equal(s.covered.rows, 2, `${s.month} covered transactions`);
    const cf = checkFigure(p, s.covered.amount);
    assert.equal(prov(cf, 'transactions').count, 2);
  }
  for (const m of ['2032-07', '2032-08']) {
    assert.equal(ms[m].source, 'transactions', m);
    assert.equal(ms[m].transactionRows, 2, m);
    assert.equal(ms[m].covered.rows, 0, m);
    assert.equal(ms[m].covered.amount, null, m);
  }
  assert.ok(p.notes.some((n) => /Jan to Jun 2032/.test(n) && /not counted/.test(n)), `notes: ${JSON.stringify(p.notes)}`);

  // Exactly workbook Jan..Jun plus transactions Jul..Aug.
  assert.equal(val(p, p.income.total), 61500 + 6000);
  assert.equal(val(p, p.expenses.total), 1800 + 7200 + 150 + 800);
  assert.equal(val(p, p.net.total), 57550);
  assert.deepEqual(p.months.map((m) => val(p, p.income.months[m])), [10000, 12000, 8500, 11000, 10500, 9500, 3000, 3000]);
  assert.deepEqual(p.months.map((m) => val(p, p.net.months[m])), [8550, 10300, 7000, 9500, 9000, 8000, 2600, 2600]);
  assert.deepEqual(p.income.categories.map((c) => c.category), ['Consulting revenue', 'Income']);
  assert.deepEqual(p.expenses.categories.map((c) => c.category), ['Rent & Office', 'Software', 'Business', 'Refunds and fees']);
  const inc = cat(p.income, 'Income');
  assert.equal(inc.months['2032-01'], null, 'a covered transaction month has no transaction cell');
  assert.equal(val(p, inc.total), 6000);
  assert.equal(val(p, cat(p.expenses, 'Business').total), 800);

  // Plain names match by normalized name.
  assert.equal(val(p, businessPnl({ db, entity: '  example STUDIO ' }).net.total), 57550);
});

test('pl-ac1 a single business name takes the kind business account; a second name makes it its own P&L', (t) => {
  const { db } = store(t);
  fact(db, 'business.entities', [{ name: 'Solo Example Co', type: 'llc' }]);
  account(db, 'solo', 'business', 'Operating account');
  txn(db, 'solo', '2032-02-10', 2000, 'Retainer', 'Income');
  txn(db, 'solo', '2032-02-15', -300, 'Tools subscription', 'Business');
  const one = pnlEntities({ db });
  assert.deepEqual(one.map((e) => [e.key, e.kind]), [['entity:soloexampleco', 'entity']]);
  assert.deepEqual(one[0].accounts.map((a) => a.id), ['solo']);
  assert.equal(one[0].workbook, null);
  const p = businessPnl({ db, entity: 'entity:soloexampleco' });
  assert.equal(val(p, p.income.total), 2000);
  assert.equal(val(p, p.expenses.total), 300);
  assert.equal(p.monthSources.find((m) => m.month === '2032-02').source, 'transactions');

  fact(db, 'business.entities', [{ name: 'Solo Example Co', type: 'llc' }, { name: 'Second Example Co', type: 'llc' }]);
  assert.deepEqual(pnlEntities({ db }).map((e) => [e.key, e.kind]), [['account:solo', 'account']]);
});

test('pl-ac1 prior year present when it has data and null otherwise; default range is January to the latest data month; rows after the clock ignored', (t) => {
  const { db } = store(t);
  business(db);
  const p = businessPnl({ db, entity: STUDIO });
  assert.ok(p.prior, 'Example Studio has 2031 lines');
  assert.equal(p.prior.from, '2031-01');
  assert.equal(p.prior.to, '2031-08');
  assert.equal(val(p, p.prior.income), 48000);
  assert.equal(val(p, p.prior.expenses), 1500);
  assert.equal(val(p, p.prior.net), 46500);
  assert.equal(val(p, p.prior.categories.income['Consulting revenue']), 48000);
  assert.equal(val(p, p.prior.categories.expenses.Software), 1500);
  assert.deepEqual(p.prior.monthSources.map((m) => m.source), ['workbook', 'workbook', 'workbook', 'workbook', 'workbook', 'workbook', 'none', 'none']);
  assert.ok(!JSON.stringify(p).includes('77777'), 'the 2032-12 workbook line is after the clock');
  assert.equal(val(p, p.income.total), 67500, 'the 2032-11-20 transaction is after the clock');

  const narrow = businessPnl({ db, entity: STUDIO, from: '2032-02', to: '2032-03' });
  assert.equal(narrow.prior.from, '2031-02');
  assert.equal(narrow.prior.to, '2031-03');
  assert.equal(val(narrow, narrow.prior.income), 16000);
  assert.equal(businessPnl({ db, entity: BIZ }).prior, null);
  assert.equal(businessPnl({ db, entity: WORKS }).prior, null);

  // An explicit clock moves the default range and drops later rows.
  const early = businessPnl({ db, entity: STUDIO, clock: '2032-07-15' });
  assert.equal(early.to, '2032-07');
  assert.equal(val(early, early.income.months['2032-07']), 3000);
  assert.equal(val(early, early.expenses.total), 9150, 'the Jul 20 cost is after that clock');
});

test('pl-ac1 errors: unknown entity, from after to, more than 36 months, malformed months; nearby valid input is accepted', (t) => {
  const { db } = store(t);
  business(db);
  assert.equal(code(() => businessPnl({ db, entity: 'entity:nosuchname' })), 'unknown_entity');
  assert.equal(code(() => businessPnl({ db, entity: 'No Such Name' })), 'unknown_entity');
  assert.equal(code(() => businessPnl({ db, entity: 'Idle Venture' })), 'unknown_entity', 'a name with no data is not a P&L');
  assert.equal(code(() => businessPnl({ db, entity: 'Example Studio' })), 'ok');
  assert.equal(code(() => businessPnl({ db, entity: STUDIO, from: '2032-05', to: '2032-04' })), 'bad_range');
  assert.equal(code(() => businessPnl({ db, entity: STUDIO, from: '2032-04', to: '2032-04' })), 'ok');
  assert.equal(code(() => businessPnl({ db, entity: STUDIO, from: '2029-08', to: '2032-08' })), 'bad_range', '37 months');
  assert.equal(code(() => businessPnl({ db, entity: STUDIO, from: '2029-09', to: '2032-08' })), 'ok', '36 months');
  for (const bad of ['2032-13', '2032-1', '2032/01', 'soon', '2032-00']) {
    assert.equal(code(() => businessPnl({ db, entity: STUDIO, from: bad, to: '2032-08' })), 'bad_range', bad);
    assert.equal(code(() => businessPnl({ db, entity: STUDIO, from: '2032-01', to: bad })), 'bad_range', bad);
  }
  assert.equal(code(() => businessPnlRows({ db, entity: 'entity:nosuchname', section: 'income', category: 'Income' })), 'unknown_entity');
  assert.equal(code(() => businessPnlRows({ db, entity: STUDIO, section: 'income', category: 'Income', from: '2032-13' })), 'bad_range');
});

test('pl-ac1 demo store: two workbook entities and the unassigned business checking account', async (t) => {
  const s = await tempDb();
  t.after(() => s.close());
  seedDemo(s.db);
  const list = pnlEntities({ db: s.db });
  const ents = list.filter((e) => e.kind === 'entity');
  assert.equal(ents.length, 2);
  for (const e of ents) assert.ok(e.workbook && e.workbook.lines > 0, e.key);
  const own = list.find((e) => e.key === 'account:a_biz');
  assert.ok(own, 'a_biz is its own P&L');
  assert.equal(own.kind, 'account');
  assert.ok(own.transactions.rows > 0);
  for (const e of list) {
    const p = businessPnl({ db: s.db, entity: e.key });
    assert.ok(p.income.total || p.expenses.total, e.key);
    for (const a of p.entity.accounts) assert.ok(!/[{}]/.test(a.label), `demo tokens resolved in ${a.label}`);
  }
});

/* ---------------------------------------------------------------- pl-ac3 */

test('pl-ac3 every business figure resolves with source, detail and provenance; workbook cells name pnl_lines; a mixed total uses pnl:mixed with monthly sums', (t) => {
  const { db } = store(t);
  const ids = business(db);
  for (const entity of [STUDIO, WORKS, BIZ]) {
    const p = businessPnl({ db, entity });
    checkSources(p);
    const keys = figKeysOf(p);
    assert.ok(keys.length > 10, entity);
    for (const k of keys) checkFigure(p, k);
  }
  const p = businessPnl({ db, entity: STUDIO });

  const wb = checkFigure(p, cat(p.income, 'Consulting revenue').months['2032-01']);
  assert.equal(wb.src, 'pnl:workbook');
  assert.equal(wb.provenance.source, 'workbook');
  assert.deepEqual(wb.provenance.months, ['2032-01']);
  assert.deepEqual(prov(wb, 'pnl_lines'), { table: 'pnl_lines', ids: [ids.lines['rev:1']], count: 1 });
  assert.deepEqual(wb.provenance.files, [WB_FILE]);
  assert.equal(p.sources['pnl:workbook'].label, 'Imported P&L workbook');
  assert.equal(p.sources['pnl:workbook'].asOf, '2032-06-30');

  const tx = checkFigure(p, cat(p.income, 'Income').months['2032-07']);
  assert.equal(tx.src, 'pnl:transactions');
  assert.equal(tx.provenance.source, 'transactions');
  assert.deepEqual(tx.provenance.accounts.map((a) => a.id), ['studio_chk']);
  assert.equal(prov(tx, 'transactions').count, 1);
  assert.equal(p.sources['pnl:transactions'].label, 'Categorized business transactions');
  assert.equal(p.sources['pnl:transactions'].asOf, '2032-08-20');

  const total = checkFigure(p, p.income.total);
  assert.equal(total.src, 'pnl:mixed');
  assert.equal(total.provenance.source, 'workbook and transactions');
  assert.equal(p.sources['pnl:mixed'].label, 'P&L workbook and categorized transactions');
  assert.ok(prov(total, 'pnl_lines') && prov(total, 'transactions'));
  assert.equal(prov(total, 'transactions').count, 2, 'only the counted Jul and Aug income rows');
  assert.deepEqual(total.provenance.months, months('2032-01', '2032-08'));
  assert.equal(total.sums.length, 8);
  assert.equal(total.sums[0].label, 'Jan 2032');
  assert.deepEqual(total.sums.map((s) => s.asOf), ['workbook', 'workbook', 'workbook', 'workbook', 'workbook', 'workbook', 'transactions', 'transactions']);
  assert.equal(r2(total.sums.reduce((a, s) => a + s.v, 0)), r2(total.v));

  const biz = businessPnl({ db, entity: BIZ });
  const unc = checkFigure(biz, biz.uncategorized.amount);
  assert.deepEqual(prov(unc, 'transactions').ids, [ids.txns.uncat]);
  const left = checkFigure(biz, biz.leftOut.find((l) => l.key === 'tax').amount);
  assert.equal(prov(left, 'transactions').count, 1);
});

test('pl-ac3 businessPnlRows lists exactly the rows behind a cell, and their amounts sum to it', (t) => {
  const { db } = store(t);
  const ids = business(db);
  const p = businessPnl({ db, entity: STUDIO });
  const check = (opts, cell, expect) => {
    const r = businessPnlRows({ db, entity: STUDIO, ...opts });
    assert.equal(r.total, expect.count, JSON.stringify(opts));
    assert.equal(r.items.length, expect.count);
    const sum = sumItems(r.items);
    assert.equal(opts.section === 'expenses' ? r2(-sum) : sum, val(p, cell), `rows sum to the cell ${JSON.stringify(opts)}`);
    const dates = r.items.map((i) => i.date);
    assert.deepEqual(dates, dates.toSorted().reverse(), 'newest first');
    for (const i of r.items) {
      const f = r.figures[i.fig];
      assert.ok(f, `item figure ${i.fig}`);
      assert.equal(r2(f.v), r2(i.amount));
      assert.ok(r.sources[f.src], `item source ${f.src}`);
      assert.equal(typeof i.account, 'string');
    }
    return r;
  };
  const wb = check({ section: 'income', category: 'Consulting revenue' }, cat(p.income, 'Consulting revenue').total, { count: 7 });
  assert.ok(wb.items.every((i) => i.kind === 'workbook' && i.description === 'Workbook line' && /^\d{4}-\d{2}$/.test(i.date)));
  assert.equal(wb.items[0].account, WB_FILE.name);
  assert.ok(wb.items.some((i) => i.id === ids.lines['rev:3b']));
  const mar = check({ section: 'income', category: 'Consulting revenue', month: '2032-03' }, cat(p.income, 'Consulting revenue').months['2032-03'], { count: 2 });
  assert.deepEqual(mar.items.map((i) => i.id).sort((a, b) => a - b), [ids.lines['rev:3'], ids.lines['rev:3b']].sort((a, b) => a - b));
  check({ section: 'expenses', category: 'Refunds and fees' }, cat(p.expenses, 'Refunds and fees').total, { count: 2 });
  const tools = check({ section: 'expenses', category: 'Business' }, cat(p.expenses, 'Business').total, { count: 2 });
  assert.deepEqual(tools.items.map((i) => i.id), [ids.txns['tools:8'], ids.txns['tools:7']], 'covered Jan..Jun rows are not behind the cell');
  assert.ok(tools.items.every((i) => i.kind === 'transaction'));
  check({ section: 'income', category: 'Income', month: '2032-07' }, cat(p.income, 'Income').months['2032-07'], { count: 1 });

  const b = businessPnl({ db, entity: BIZ });
  const bizRows = (opts) => businessPnlRows({ db, entity: BIZ, ...opts });
  const unc = bizRows({ section: 'expenses', category: 'Uncategorized' });
  assert.deepEqual(unc.items.map((i) => i.id), [ids.txns.uncat]);
  assert.equal(r2(-sumItems(unc.items)), val(b, cat(b.expenses, 'Uncategorized').total));
  const biz = bizRows({ section: 'expenses', category: 'Business' });
  assert.deepEqual(biz.items.map((i) => i.id), [ids.txns.refund, ids.txns.hosting]);
  assert.equal(r2(-sumItems(biz.items)), 600);
  assert.deepEqual(bizRows({ section: 'income', category: 'Business' }).items, [], 'a category in the other section has no rows');
});

/* ---------------------------------------------------------------- pl-ac4 */

test('pl-ac4 the module exports the contract, takes one object, never writes, and the HTTP routes return the same values', async (t) => {
  const { db, dir } = store(t);
  business(db);
  for (const name of ['pnlEntities', 'businessPnl', 'businessPnlRows', 'householdSpending', 'householdSpendingRows', 'PnlError']) {
    assert.equal(typeof PNL[name], 'function', name);
  }
  for (const name of ['pnlEntities', 'businessPnl', 'businessPnlRows', 'householdSpending', 'householdSpendingRows']) {
    assert.ok(PNL[name].length <= 1, `${name} takes one object`);
  }
  const e = new PnlError('bad_range', 'Synthetic message');
  assert.equal(e.code, 'bad_range');
  assert.ok(e instanceof Error);

  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const list = pnlEntities({ db });
  const direct = businessPnl({ db, entity: STUDIO });
  const directRows = businessPnlRows({ db, entity: STUDIO, section: 'income', category: 'Consulting revenue' });
  businessPnl({ db, entity: BIZ, from: '2032-01', to: '2032-12' });
  PNL.householdSpending({ db });
  code(() => businessPnl({ db, entity: 'entity:nosuchname' }));
  assert.equal(changes(), before, 'P&L reads never write the store');

  const srv = await serveAppFixture({ authenticated: true, db, config: { clock: CLOCK, dataDir: dir }, answerer: null });
  t.after(() => srv.close());
  const get = async (path, status = 200) => {
    const r = await srv.request({ path });
    assert.equal(r.status, status, `${path}: ${r.text.slice(0, 300)}`);
    if (status !== 200) assert.equal(typeof r.json?.error, 'string', 'error body is { error }');
    return r.json;
  };
  const json = (x) => JSON.parse(JSON.stringify(x));

  const def = await get('/api/pnl');
  assert.deepEqual(def.entities, json(list));
  assert.equal(def.pnl.entity.key, STUDIO, 'defaults to the first entity');
  assert.deepEqual(def.pnl.months, direct.months);
  assert.deepEqual(def.pnl.monthSources, json(direct.monthSources));
  for (const [k, f] of Object.entries(direct.figures)) assert.equal(def.figures[k]?.v, f.v, k);
  assert.deepEqual(def.sources, json(direct.sources));

  const biz = await get(`/api/pnl?entity=${encodeURIComponent(BIZ)}&from=2032-03&to=2032-06`);
  assert.equal(biz.pnl.entity.key, BIZ);
  assert.equal(biz.figures[biz.pnl.income.total].v, 9000);

  const rows = await get(`/api/pnl/rows?entity=${encodeURIComponent(STUDIO)}&section=income&category=${encodeURIComponent('Consulting revenue')}`);
  assert.equal(rows.total, directRows.total);
  assert.deepEqual(rows.items.map((i) => i.id), directRows.items.map((i) => i.id));
  const month = await get(`/api/pnl/rows?entity=${encodeURIComponent(STUDIO)}&section=income&category=${encodeURIComponent('Consulting revenue')}&month=2032-03`);
  assert.equal(month.total, 2);

  await get(`/api/pnl?entity=${encodeURIComponent('entity:nosuchname')}`, 404);
  await get(`/api/pnl?entity=${encodeURIComponent(STUDIO)}&from=2032-13`, 400);
  await get(`/api/pnl?entity=${encodeURIComponent(STUDIO)}&from=2032-06&to=2032-05`, 400);
  await get(`/api/pnl?entity=${encodeURIComponent(STUDIO)}&from=2029-08&to=2032-08`, 400);
  await get(`/api/pnl?entity=${encodeURIComponent(STUDIO)}&from=2029-09&to=2032-08`, 200);
  await get(`/api/pnl/rows?entity=${encodeURIComponent('entity:nosuchname')}&section=income&category=Income`, 404);
  await get(`/api/pnl/rows?entity=${encodeURIComponent(STUDIO)}&section=sideways&category=Income`, 400);
  await get(`/api/pnl/rows?entity=${encodeURIComponent(STUDIO)}&section=income&category=Income&month=2032-7`, 400);
  assert.equal(changes(), before, 'the HTTP reads never write the store');
});


test('PN1: P&L lists spending ledgers separately and restores original tab names from locators', async t => {
  const { db } = store(t);
  file(db);
  const id = line(db, 'Asters', '2032-03', 'Medical', -120);
  db.prepare('UPDATE pnl_lines SET locator = ? WHERE id = ?').run(JSON.stringify({ sheet: "Aster's - (Actual Expenses)", cells: ['D2'] }), id);
  line(db, 'Example Studio', '2032-03', 'Income', 500);
  fact(db, 'pnl.ledgers', { "Aster's": { kind: 'spending' } });
  const entities = pnlEntities({ db, clock: CLOCK });
  assert.equal(entities.find(e => e.key === 'entity:asters').label, "Aster's");
  assert.equal(entities.find(e => e.key === 'entity:asters').kind, 'spending');
  assert.equal(entities.find(e => e.key === STUDIO).kind, 'entity');
  const p = businessPnl({ db, entity: "Aster's", clock: CLOCK });
  assert.equal(p.entity.kind, 'spending');
  assert.equal(p.entity.label, "Aster's");
  assert.equal(p.figures[p.expenses.total].v, 120);
  const tool = await callTool('pnl_by_month', { entity: p.entity.label }, { db });
  assert.deepEqual(tool.rows, [{ period: '2032-03', category: 'Medical', amount: -120 }]);
});

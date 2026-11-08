import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, textFile } from '../helpers/ingest.mjs';
import { connectSimplefin, syncSimplefin, createFakeSimplefin, fakeToken, fakeAccountSet } from '../../src/ingest/simplefin.mjs';
import { ingestFile } from '../../src/ingest/pipeline.mjs';
import { answer, pendingItems, autoInfo, reopenItem, finalReason, getItem } from '../../src/ingest/confirm.mjs';
import { loadCategoryInputs } from '../../src/categories/store.mjs';
import { resolveCategories } from '../../src/categories/resolve.mjs';
import { stepEnvOf, recFromRow } from '../../src/scenario/build.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { computeFigures } from '../../src/jobs/planner/figures.mjs';
import { deriveSteps } from '../../src/shared/rec-steps.mjs';

const NOW = '2026-09-20T12:00:00.000Z';
const CLOCK = NOW.slice(0, 10);
const epoch = date => Date.parse(date + 'T12:00:00Z') / 1000;
const posting = (id, date, amount, description) => ({ id, posted: epoch(date), amount: String(amount), description });
const postings = () => [
  posting('fed-q2', '2026-06-15', -1200, 'IRS ESTIMATED TAX 2026 Q2'),
  posting('fed-q3', '2026-09-15', -1800, 'IRS USATAXPYMT ESTIMATED TAX 2026 Q3'),
  posting('state-q3', '2026-09-16', -650, 'VIRGINIA TAX ESTIMATED PAYMENT 2026 Q3'),
  posting('unclear', '2026-09-17', -85, 'IRS PAYMENT'),
  posting('transfer-out', '2026-09-18', -475, 'Transfer to savings'),
];

async function fixture(fn, rows = postings()) {
  const s = await realStore();
  try {
    const base = createFakeSimplefin({ today: () => CLOCK });
    const body = fakeAccountSet(CLOCK);
    body.accounts = body.accounts.slice(0, 2);
    body.accounts[0].transactions = rows;
    body.accounts[1].transactions = [posting('transfer-in', '2026-09-18', 475, 'Transfer from checking')];
    const opts = { household: s.household, config: s.config, now: NOW, clock: CLOCK,
      fetch: (url, init) => new URL(url).pathname.endsWith('/accounts')
        ? Promise.resolve(new Response(JSON.stringify(body), { status: 200 })) : base(url, init) };
    await connectSimplefin(s.db, fakeToken(), opts);
    await fn(s, opts, body);
  } finally { s.close(); }
}

async function uploadLog(s, date = '2026-06-12', amount = 1200) {
  const parser = { id: 'synthetic-payment-log', sourceKind: 'tax_payments', label: 'Payment log',
    parse: () => ({ rows: [{ kind: 'tax_payment', jurisdiction: 'federal', taxYear: 2026, date, amount,
      paymentKind: 'estimate', payer: 'owner', recipient: 'owner', datePrecision: 'day', taxYearBasis: 'confirmed_tax_year',
      locator: { row: 2 } }], period: { from: date, to: date }, warnings: [] }) };
  return ingestFile(s.db, textFile(`payments-${date}.csv`, `Date,Amount\n${date},${amount}\n`), s.opts(null, { parser, now: NOW }));
}

const payments = db => db.prepare('SELECT * FROM tax_payments ORDER BY date,id').all();
const paymentItems = db => db.prepare("SELECT * FROM confirm_items WHERE kind='transaction_payment' ORDER BY id").all();
const taxTask = (extra = {}) => ({ t: 'Pay the third-quarter federal estimate', kind: 'payment',
  payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 3, amount: 1800 }, ...extra });

test('connected payments count once beside an uploaded log, with provenance, one question, and transfer recognition', () => fixture(async (s, opts) => {
  await uploadLog(s);
  const result = await syncSimplefin(s.db, opts);
  assert.equal(result.status, 'ok');
  assert.equal(payments(s.db).length, 3);
  assert.equal(payments(s.db).filter(r => r.parser === 'synthetic-payment-log').length, 1, 'the upload wins at the inclusive three-day boundary');
  const detected = payments(s.db).filter(r => r.parser === 'transaction-payment');
  assert.equal(detected.length, 2);
  for (const row of detected) {
    const locator = JSON.parse(row.locator);
    const transaction = s.db.prepare('SELECT * FROM transactions WHERE id=?').get(locator.transaction.id);
    assert.equal(locator.transaction.dedupeKey, transaction.dedupe_key);
    assert.equal(row.file_id, transaction.file_id);
    assert.ok(autoInfo(s.db, locator.confirmId)?.evidence.refs.some(ref => ref.table === 'transactions' && ref.id === transaction.id));
    assert.equal(finalReason(s.db, getItem(s.db, locator.confirmId)), null);
  }
  const questions = pendingItems(s.db).filter(i => i.kind === 'transaction_payment');
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /estimated tax/i);
  assert.match(questions[0].question, /IRS PAYMENT/);
  const input = loadCategoryInputs(s.db), categories = resolveCategories(input);
  for (const t of input.transactions.filter(t => /Transfer/.test(t.description))) assert.equal(categories.get(t.id).bucket, 'transfer');
  await syncSimplefin(s.db, opts);
  assert.equal(payments(s.db).length, 3);
  assert.equal(paymentItems(s.db).length, 4, 'resync never asks again');
}));

test('a later upload replaces the detected duplicate and undo cannot delete the uploaded payment', () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const item = paymentItems(s.db).find(i => JSON.parse(i.context).transaction.external_id === 'fed-q2');
  assert.ok(item);
  await uploadLog(s);
  assert.equal(payments(s.db).length, 3);
  assert.equal(payments(s.db).filter(r => r.parser === 'synthetic-payment-log').length, 1);
  const before = payments(s.db);
  try { reopenItem(s.db, item.id, { now: NOW }); } catch (e) { assert.equal(e.code, 'final'); }
  assert.ok(payments(s.db).some(r => r.parser === 'synthetic-payment-log'));
  assert.equal(before.find(r => r.parser === 'synthetic-payment-log').amount, 1200);
}));

test('Undo removes a detected payment and its rec evidence, survives resync, and a Confirm answer restores it', () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const row = payments(s.db).find(r => r.amount === 1800);
  assert.ok(row);
  const id = JSON.parse(row.locator).confirmId;
  assert.equal(deriveSteps([taxTask()], [], stepEnvOf(s.db))[0].done, true);
  reopenItem(s.db, id, { now: NOW });
  assert.equal(payments(s.db).some(r => r.amount === 1800), false);
  assert.equal(deriveSteps([taxTask()], [true], stepEnvOf(s.db))[0].done, false);
  await syncSimplefin(s.db, opts);
  assert.equal(payments(s.db).some(r => r.amount === 1800), false, 'respect an undone inference');
  answer(s.db, id, 'estimate', { now: NOW });
  assert.equal(payments(s.db).some(r => r.amount === 1800), true);
}));

test('a recommendation pay and log step completes from the matching quarter, amount and transaction evidence', () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const tasks = [taxTask(), taxTask({ t: 'Log the third-quarter federal payment' }),
    taxTask({ payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 2, amount: 1800 } }),
    taxTask({ payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 3, amount: 1900 } })];
  const rec = recFromRow({ id: 'federal-q3', def: JSON.stringify({ tasks }), tasks_done: '[]', goal_kinds: '[]' }, CLOCK, stepEnvOf(s.db));
  assert.deepEqual(rec.tasks.map(t => t.done), [true, true, false, false]);
  assert.equal(rec.tasks[0].auto, true);
  assert.equal(rec.tasks[0].evidence.table, 'transactions');
  assert.ok(rec.tasks[0].evidence.id);
  assert.equal(rec.tasks[0].doneAt, '2026-09-15');
}));

test('the real projection includes observed estimates and carries no missing-payment gap', () => fixture(async (s, opts) => {
  await uploadLog(s);
  await syncSimplefin(s.db, opts);
  const facts = { 'household.filingStatus': 'mfj', 'household.state': 'VA' };
  const data = loadPlanningData(s.db, CLOCK);
  const entities = resolveEntities(data, facts);
  const out = computeFigures(data, facts, { clock: CLOCK, entities, owner: facts });
  assert.equal(out.fig['tax.fed.paid'].v, 3000);
  assert.equal(out.fig['tax.va.paid'].v, 650);
  assert.ok(!out.info.gaps.some(g => /payment/.test(g.code)));
}));

test('uncertain payees need one answer and a non-estimate never enters the estimate totals', () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const item = pendingItems(s.db).find(i => i.kind === 'transaction_payment');
  assert.ok(item);
  answer(s.db, item.id, 'not_estimate', { now: NOW });
  await syncSimplefin(s.db, opts);
  assert.equal(payments(s.db).length, 3);
  assert.equal(pendingItems(s.db).filter(i => i.kind === 'transaction_payment').length, 0);
}));

test('January without a tax year asks before writing; refunds and payroll taxes never become estimates', () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  assert.equal(payments(s.db).length, 0);
  const items = pendingItems(s.db).filter(i => i.kind === 'transaction_payment');
  assert.equal(items.length, 1);
  assert.ok(items[0].options.some(o => o.id === 'estimate:2025'));
  answer(s.db, items[0].id, 'estimate:2025', { now: NOW });
  assert.equal(payments(s.db)[0].tax_year, 2025);
}, [posting('january', '2026-01-15', -125, 'IRS ESTIMATED TAX'),
  posting('refund', '2026-09-01', 125, 'IRS TAX REFUND'),
  posting('payroll', '2026-09-02', -125, 'IRS EFTPS FORM 941 PAYROLL TAX')]));

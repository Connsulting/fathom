import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, textFile } from '../helpers/ingest.mjs';
import { connectSimplefin, syncSimplefin, createFakeSimplefin, fakeToken, fakeAccountSet } from '../../src/ingest/simplefin.mjs';
import { ingestFile, persistImport } from '../../src/ingest/pipeline.mjs';
import { actionTx } from '../../src/store/db.mjs';
import { answer, pendingItems, autoInfo, reopenItem, finalReason, getItem } from '../../src/ingest/confirm.mjs';
import { loadCategoryInputs } from '../../src/categories/store.mjs';
import { resolveCategories } from '../../src/categories/resolve.mjs';
import { stepEnvOf, recFromRow } from '../../src/scenario/build.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { computeFigures } from '../../src/jobs/planner/figures.mjs';
import { deriveSteps } from '../../src/shared/rec-steps.mjs';
import { build as buildFederal } from '../../src/jobs/triggers/fed-q4-estimate.mjs';
import { applyRecs } from '../../src/jobs/planner/recs.mjs';
import { removeFile } from '../../src/accounts/sources.mjs';
import { undoAction } from '../../src/actions/receipts.mjs';
import { gapControl } from '../../web/core/gap-control.js';
import { actionTxWith } from '../../src/store/db.mjs';

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
      fetch: async (url, init) => new URL(url).pathname.endsWith('/accounts')
        ? Promise.resolve(new Response(JSON.stringify(body), { status: 200 })) : base(url, init) };
    await connectSimplefin(s.db, fakeToken(), opts);
    await fn(s, opts, body);
  } finally { await s.close(); }
}

async function uploadLog(s, date = '2026-06-12', amount = 1200, payer = 'owner') {
  const parser = { id: 'synthetic-payment-log', sourceKind: 'tax_payments', label: 'Payment log',
    parse: () => ({ rows: [{ kind: 'tax_payment', jurisdiction: 'federal', taxYear: 2026, date, amount,
      paymentKind: 'estimate', payer, recipient: payer, datePrecision: 'day', taxYearBasis: 'confirmed_tax_year',
      locator: { row: 2 } }], period: { from: date, to: date }, warnings: [] }) };
  return ingestFile(s.db, textFile(`payments-${date}.csv`, `Date,Amount\n${date},${amount}\n`), s.opts(null, { parser, now: NOW }));
}

const payments = async db => await db.prepare('SELECT * FROM tax_payments ORDER BY date,id').all();
const paymentItems = async db => await db.prepare("SELECT * FROM confirm_items WHERE kind='transaction_payment' ORDER BY id").all();
const taxTask = (extra = {}) => ({ t: 'Pay the third-quarter federal estimate', kind: 'payment',
  payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 3, amount: 1800 }, ...extra });
const projectedFederalPaid = async db => {
  const facts = { 'household.filingStatus': 'mfj', 'household.state': 'VA' };
  const data = await loadPlanningData(db, CLOCK);
  return computeFigures(data, facts, { clock: CLOCK, entities: resolveEntities(data, facts), owner: facts }).figures['tax.fed.paid'].v;
};

test('connected payments count once beside an uploaded log, with provenance, one question, and transfer recognition', async () => fixture(async (s, opts) => {
  await uploadLog(s);
  const result = await syncSimplefin(s.db, opts);
  assert.equal(result.status, 'ok');
  assert.equal((await payments(s.db)).length, 3);
  assert.equal((await payments(s.db)).filter(r => r.parser === 'synthetic-payment-log').length, 1, 'the upload wins at the inclusive three-day boundary');
  const detected = (await payments(s.db)).filter(r => r.parser === 'transaction-payment');
  assert.equal(detected.length, 2);
  for (const row of detected) {
    const locator = JSON.parse(row.locator);
    const transaction = await s.db.prepare('SELECT * FROM transactions WHERE id=?').get(locator.transaction.id);
    assert.equal(locator.transaction.dedupeKey, transaction.dedupe_key);
    assert.equal(row.file_id, transaction.file_id);
    assert.ok((await autoInfo(s.db, locator.confirmId))?.evidence.refs.some(ref => ref.table === 'transactions' && ref.id === transaction.id));
    assert.equal(await finalReason(s.db, await getItem(s.db, locator.confirmId)), null);
  }
  const questions = (await pendingItems(s.db)).filter(i => i.kind === 'transaction_payment');
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /estimated tax/i);
  assert.match(questions[0].question, /IRS PAYMENT/);
  const input = await loadCategoryInputs(s.db), categories = resolveCategories(input);
  for (const t of input.transactions.filter(t => /Transfer/.test(t.description))) assert.equal(categories.get(t.id).bucket, 'transfer');
  await syncSimplefin(s.db, opts);
  assert.equal((await payments(s.db)).length, 3);
  assert.equal((await paymentItems(s.db)).length, 4, 'resync never asks again');
}));

test('a later upload replaces the detected duplicate and undo cannot delete the uploaded payment', async () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const item = (await paymentItems(s.db)).find(i => JSON.parse(i.context).transaction.external_id === 'fed-q2');
  assert.ok(item);
  await uploadLog(s);
  assert.equal((await payments(s.db)).length, 3);
  assert.equal((await payments(s.db)).filter(r => r.parser === 'synthetic-payment-log').length, 1);
  const before = await payments(s.db);
  try { await reopenItem(s.db, item.id, { now: NOW }); } catch (e) { assert.equal(e.code, 'final'); }
  assert.ok((await payments(s.db)).some(r => r.parser === 'synthetic-payment-log'));
  assert.equal(before.find(r => r.parser === 'synthetic-payment-log').amount, 1200);
}));

test('removing and restoring a payment log keeps observed payments counted with working Undo', async () => fixture(async (s, opts) => {
  const log = await uploadLog(s);
  await syncSimplefin(s.db, opts);
  const ctx = { db: s.db, actorId: 'synthetic-owner', now: NOW };
  const item = (await paymentItems(s.db)).find(i => JSON.parse(i.context).transaction.external_id === 'fed-q2');
  assert.equal(await projectedFederalPaid(s.db), 3000);
  const removed = await removeFile(ctx, log.fileId);
  assert.equal(await projectedFederalPaid(s.db), 3000);
  assert.equal((await payments(s.db)).filter(r => r.parser === 'transaction-payment').length, 3);
  assert.equal(deriveSteps([taxTask({ payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 2, amount: 1200 } })], [], await stepEnvOf(s.db))[0].done, true);
  await undoAction(ctx, removed.receipt.id, 'write:sources');
  assert.equal(await projectedFederalPaid(s.db), 3000);
  assert.equal((await payments(s.db)).filter(r => r.parser === 'synthetic-payment-log').length, 1);
  assert.equal((await payments(s.db)).length, 3);
  await reopenItem(s.db, item.id, { now: NOW });
  assert.equal(await projectedFederalPaid(s.db), 3000, 'Undo of the inference leaves the restored uploaded log alone');
  await answer(s.db, item.id, 'estimate', { now: NOW });
  await removeFile(ctx, log.fileId);
  await reopenItem(s.db, item.id, { now: NOW });
  assert.equal(await projectedFederalPaid(s.db), 1800, 'Undo removes the restored inference');
  await syncSimplefin(s.db, opts);
  assert.equal(await projectedFederalPaid(s.db), 1800, 'resync respects the undone inference');
}));

test('recovery and source Undo work when the removed log had the only tax payment row', async () => fixture(async (s, opts) => {
  const log = await uploadLog(s);
  await syncSimplefin(s.db, opts);
  const ctx = { db: s.db, actorId: 'synthetic-owner', now: NOW };
  const removed = await removeFile(ctx, log.fileId);
  assert.equal(await projectedFederalPaid(s.db), 1200);
  await undoAction(ctx, removed.receipt.id, 'write:sources');
  assert.equal(await projectedFederalPaid(s.db), 1200);
  assert.equal((await payments(s.db)).length, 1);
  assert.equal((await payments(s.db))[0].parser, 'synthetic-payment-log');
}, [postings()[0]]));

test('a revised payment log no longer suppresses an observed payment of a different amount', async () => fixture(async (s, opts) => {
  await uploadLog(s);
  await syncSimplefin(s.db, opts);
  await uploadLog(s, '2026-06-12', 1300);
  assert.equal(await projectedFederalPaid(s.db), 4300);
  assert.ok((await payments(s.db)).some(r => r.parser === 'transaction-payment' && r.amount === 1200));
}));

test('a complete log snapshot omitting a payment restores the connected payment', async () => fixture(async (s, opts) => {
  const log = await uploadLog(s);
  const old = (await payments(s.db))[0];
  await syncSimplefin(s.db, opts);
  const parser = { id: 'synthetic-payment-log', sourceKind: 'tax_payments', label: 'Payment log',
    parse: () => ({ rows: [], warnings: [], period: { from: '2026-06-01', to: '2026-06-30' } }) };
  const file = textFile('complete-log.csv', 'No estimated tax payments in June');
  const next = await ingestFile(s.db, file, s.opts(null, { parser, now: NOW }));
  await actionTxWith(s, async (s) => await persistImport(s.db, next.fileId, file, { status: 'imported', parser: parser.id, sourceKind: parser.sourceKind,
    label: parser.label, parsed: parser.parse(), coverage: [{ table: 'tax_payments', slot: old.source_slot, period: '2026-06', complete: true, authority: '2026-06-30' }] }, { now: NOW }));
  assert.equal((await payments(s.db)).filter(r => r.file_id === log.fileId).length, 0);
  assert.equal(await projectedFederalPaid(s.db), 3000);
  assert.ok((await payments(s.db)).some(r => r.parser === 'transaction-payment' && r.amount === 1200));
}));

test('a logged-match answer recovers its own payment after every matching log is removed', async () => fixture(async (s, opts) => {
  const first = await uploadLog(s, '2026-06-12');
  const second = await uploadLog(s, '2026-06-14', 1200, 'spouse');
  await syncSimplefin(s.db, opts);
  const item = (await pendingItems(s.db)).find(i => i.kind === 'transaction_payment');
  await answer(s.db, item.id, item.options.find(o => o.id.startsWith('logged:')).id, { now: NOW });
  const ctx = { db: s.db, actorId: 'synthetic-owner', now: NOW };
  await removeFile(ctx, first.fileId);
  await removeFile(ctx, second.fileId);
  assert.equal(await projectedFederalPaid(s.db), 1200);
  await reopenItem(s.db, item.id, { now: NOW });
  assert.equal((await payments(s.db)).length, 0);
}, [postings()[0]]));

test('Undo removes a detected payment and its rec evidence, survives resync, and a Confirm answer restores it', async () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const row = (await payments(s.db)).find(r => r.amount === 1800);
  assert.ok(row);
  const id = JSON.parse(row.locator).confirmId;
  assert.equal(deriveSteps([taxTask()], [], await stepEnvOf(s.db))[0].done, true);
  await reopenItem(s.db, id, { now: NOW });
  assert.equal((await payments(s.db)).some(r => r.amount === 1800), false);
  assert.equal(deriveSteps([taxTask()], [], await stepEnvOf(s.db))[0].done, false);
  await syncSimplefin(s.db, opts);
  assert.equal((await payments(s.db)).some(r => r.amount === 1800), false, 'respect an undone inference');
  await answer(s.db, id, 'estimate', { now: NOW });
  assert.equal((await payments(s.db)).some(r => r.amount === 1800), true);
}));

test('a recommendation pay and log step completes from the matching quarter, amount and transaction evidence', async () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const tasks = [taxTask(), taxTask({ t: 'Log the third-quarter federal payment' }),
    taxTask({ payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 2, amount: 1800 } }),
    taxTask({ payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 3, amount: 1900 } }),
    taxTask({ payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 3, amount: 1799.37 } })];
  const rec = recFromRow({ id: 'federal-q3', def: JSON.stringify({ tasks }), tasks_done: '[]', goal_kinds: '[]' }, CLOCK, await stepEnvOf(s.db));
  assert.deepEqual(rec.tasks.map(t => t.done), [true, true, false, false, true]);
  assert.equal(rec.tasks[0].auto, true);
  assert.equal(rec.tasks[0].evidence.table, 'transactions');
  assert.ok(rec.tasks[0].evidence.id);
  assert.equal(rec.tasks[0].doneAt, '2026-09-15');
}));

test('the real projection includes observed estimates and carries no missing-payment gap', async () => fixture(async (s, opts) => {
  await uploadLog(s);
  await syncSimplefin(s.db, opts);
  const facts = { 'household.filingStatus': 'mfj', 'household.state': 'VA' };
  const data = await loadPlanningData(s.db, CLOCK);
  const entities = resolveEntities(data, facts);
  const out = computeFigures(data, facts, { clock: CLOCK, entities, owner: facts });
  assert.equal(out.figures['tax.fed.paid'].v, 3000);
  assert.equal(out.figures['tax.va.paid'].v, 650);
  assert.ok(!out.info.gaps.some(g => /payment/.test(g.code)));
}));

test('a single filer sees a payer gap until the connected account owner is known', async () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const facts = { 'household.filingStatus': 'single', 'household.state': 'VA' };
  const compute = async () => {
    const data = await loadPlanningData(s.db, CLOCK);
    return computeFigures(data, facts, { clock: CLOCK, entities: resolveEntities(data, facts), owner: facts });
  };
  assert.ok((await compute()).info.gaps.some(g => g.code === 'estimated_payer_unknown'));
  const transaction = await s.db.prepare("SELECT * FROM transactions WHERE external_id='fed-q2'").get();
  const question = (await pendingItems(s.db)).find(i => i.kind === 'account_owner' && i.subject === transaction.account_id);
  assert.ok(question);
  const gap = (await compute()).info.gaps.find(g => g.code === 'estimated_payer_unknown');
  assert.deepEqual(gap.action, { screen: 'confirm', id: question.id, label: 'Name the account owner' });
  const html = gapControl(gap.action, String);
  assert.match(html, new RegExp(`href="#/confirm/${question.id}"`));
  assert.match(html, /data-go="confirm"/);
  assert.doesNotMatch(html, /upload/i);
  await answer(s.db, question.id, 'owner', { now: NOW });
  assert.equal((await compute()).figures['tax.fed.paid'].v, 1200);
  assert.ok(!(await compute()).info.gaps.some(g => g.code === 'estimated_payer_unknown'));
}, [postings()[0]]));

test('uncertain payees need one answer and a non-estimate never enters the estimate totals', async () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  const item = (await pendingItems(s.db)).find(i => i.kind === 'transaction_payment');
  assert.ok(item);
  await answer(s.db, item.id, 'not_estimate', { now: NOW });
  await syncSimplefin(s.db, opts);
  assert.equal((await payments(s.db)).length, 3);
  assert.equal((await pendingItems(s.db)).filter(i => i.kind === 'transaction_payment').length, 0);
}));

test('January estimates infer the prior tax year; refunds and payroll taxes never become estimates', async () => fixture(async (s, opts) => {
  await syncSimplefin(s.db, opts);
  assert.equal((await payments(s.db)).length, 1);
  assert.equal((await pendingItems(s.db)).filter(i => i.kind === 'transaction_payment').length, 0);
  assert.equal((await payments(s.db))[0].tax_year, 2025);
  const id = JSON.parse((await payments(s.db))[0].locator).confirmId;
  assert.ok(await autoInfo(s.db, id));
  await reopenItem(s.db, id, { now: NOW });
  assert.equal((await payments(s.db)).length, 0);
}, [posting('january', '2026-01-15', -125, 'IRS ESTIMATED TAX'),
  posting('refund', '2026-09-01', 125, 'IRS TAX REFUND'),
  posting('payroll', '2026-09-02', -125, 'IRS EFTPS FORM 941 PAYROLL TAX')]));

test('a changed connected posting invalidates the old inference and its pending answer', async () => fixture(async (s, opts, body) => {
  await syncSimplefin(s.db, opts);
  const pending = (await pendingItems(s.db)).find(i => i.kind === 'transaction_payment');
  body.accounts[0].transactions.find(t => t.id === 'fed-q3').description = 'IRS RETURN BALANCE 2025';
  body.accounts[0].transactions.find(t => t.id === 'unclear').description = 'IRS RETURN BALANCE 2025';
  await syncSimplefin(s.db, opts);
  assert.equal((await payments(s.db)).some(r => r.amount === 1800), false);
  assert.equal(deriveSteps([taxTask()], [], await stepEnvOf(s.db))[0].done, false);
  await assert.rejects(async () => await answer(s.db, pending.id, 'estimate', { now: NOW }), e => ['stale','answered'].includes(e.code));
}));

test('a four-day separation and a different jurisdiction do not suppress real estimates', async () => fixture(async (s, opts) => {
  await uploadLog(s, '2026-06-11');
  await syncSimplefin(s.db, opts);
  assert.equal((await payments(s.db)).length, 4);
  assert.equal((await payments(s.db)).filter(r => r.amount === 1200).length, 2);
}));

test('multiple log candidates ask one plain question and write nothing until answered', async () => fixture(async (s, opts) => {
  await uploadLog(s, '2026-06-12');
  await uploadLog(s, '2026-06-14', 1200, 'spouse');
  await syncSimplefin(s.db, opts);
  const pending = (await pendingItems(s.db)).filter(i => i.kind === 'transaction_payment');
  assert.equal(pending.length, 1);
  assert.equal((await payments(s.db)).length, 2);
  const option = pending[0].options.find(o => o.id.startsWith('logged:'));
  assert.ok(option);
  await answer(s.db, pending[0].id, option.id, { now: NOW });
  assert.equal((await payments(s.db)).length, 2);
}, [postings()[0]]));

test('confirming a separate payment preserves it beside log candidates on resync', async () => fixture(async (s, opts) => {
  await uploadLog(s, '2026-06-12');
  await uploadLog(s, '2026-06-14', 1200, 'spouse');
  await syncSimplefin(s.db, opts);
  const item = (await pendingItems(s.db)).find(i => i.kind === 'transaction_payment');
  await answer(s.db, item.id, 'separate', { now: NOW });
  assert.equal((await payments(s.db)).length, 3);
  await syncSimplefin(s.db, opts);
  assert.equal((await payments(s.db)).length, 3);
  assert.equal(await finalReason(s.db, await getItem(s.db, item.id)), null);
  await reopenItem(s.db, item.id, { now: NOW });
  assert.equal((await payments(s.db)).length, 2);
}, [postings()[0]]));

test('the existing federal trigger emits payment metadata and retains its completed target across planning updates', async () => fixture(async (s, opts) => {
  const task = buildFederal({ year: 2026, facts: {}, fig: { 'sh.fed.remaining': { v: 1800 } } }, { basis: 'current', grounding: [] }).tasks[1];
  assert.deepEqual(task.payment, { jurisdiction: 'federal', taxYear: 2026, quarter: 4, amount: 1800 });
  await syncSimplefin(s.db, opts);
  await s.db.prepare("INSERT INTO jobs(id,name) VALUES ('plan','Plan')").run();
  const run = Number((await s.db.prepare("INSERT INTO job_runs(job_id,started_at,status) VALUES ('plan',?,'running') RETURNING id").get(NOW)).id);
  const hit = amount => ({ state: 'hit', trigger: { id: 'test-q3', domain: 'tax' }, hit: { packId: null, rec: {
    id: 'test-q3', title: 'Pay the federal estimate', domain: 'tax', owner: 'you', goalKinds: ['tax'],
    tasks: [taxTask({ payment: { jurisdiction: 'federal', taxYear: 2026, quarter: 3, amount } })], mine: [], cross: [], kb: [], value: [] } } });
  const ctx = { clock: CLOCK, now: NOW, runId: run, prose: { 'test-q3': { fields: { summary: 'Pay the estimate', why: [], qa: [] }, hash: 'synthetic', src: 'template' } },
    packOverride: () => null, warn() {}, prefs: {}, stepEnv: await stepEnvOf(s.db) };
  await applyRecs(s.db, [hit(1800)], ctx);
  await applyRecs(s.db, [hit(600)], ctx);
  const row = await s.db.prepare("SELECT * FROM recs WHERE id='test-q3'").get();
  const rec = recFromRow(row, CLOCK, await stepEnvOf(s.db));
  assert.equal(rec.tasks.length, 1);
  assert.equal(rec.tasks[0].payment.amount, 1800);
  assert.equal(rec.tasks[0].done, true);
}));

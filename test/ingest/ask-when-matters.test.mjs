import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, textFile } from '../helpers/ingest.mjs';
import { importProposedRows } from '../helpers/import-proposal-fixture.mjs';
import { planRun } from '../helpers/plan.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import { ingestFile } from '../../src/ingest/pipeline.mjs';
import { ingestState } from '../../src/ingest/freshness.mjs';
import { sourceStates } from '../../src/ingest/coverage.mjs';
import { removeFile } from '../../src/accounts/sources.mjs';
import { pendingItems, autoInfo, reopenItem } from '../../src/ingest/confirm.mjs';
import { reconcileTransactionPayments } from '../../src/ingest/transaction-payments.mjs';
import { autoResolve } from '../../src/ingest/auto.mjs';
import { ask, taxYearOptions, getItem } from '../../src/ingest/confirm.mjs';
import { setSetting } from '../../src/store/db.mjs';
import { upsertFact } from '../../src/store/facts.mjs';

const NOW = '2026-11-05T12:00:00.000Z';
const CLOCK = NOW.slice(0, 10);
async function store(t) {
  const s = await realStore();
  t.after(() => s.close());
  setSetting(s.db, 'clock', CLOCK);
  for (const [key, value] of Object.entries({ 'household.filingStatus': 'single', 'household.state': 'VA',
    'household.birthYears': { owner: 1985 }, 'income.sCorp': false, 'income.selfEmployed': false, 'income.partnership': false })) {
    upsertFact(s.db, { key, value, src: 'you', confirmed: true, now: NOW });
  }
  return s;
}
function account(db, id, { connected = false, date = '2026-11-04', kind = 'cash' } = {}) {
  const source = `ing:synthetic:${id}`;
  db.prepare("INSERT INTO sources(id,label,kind,as_of) VALUES (?,?,'balances',?)").run(source, 'Example Bank', date);
  db.prepare("INSERT INTO accounts(id,inst,name,kind,owner,source_id,mirror) VALUES (?,'Example Bank',?,?,'You',?,?)")
    .run(id, id === 'checking' ? 'Everyday Checking' : 'Emergency Savings', kind, source, connected ? 'connected' : 'imported');
  db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,1000)').run(id, date);
  if (connected) {
    db.prepare("INSERT OR IGNORE INTO simplefin_connection(id,access_blob,connected_at) VALUES (1,'synthetic',?)").run(NOW);
    db.prepare("INSERT INTO simplefin_accounts(sf_key,account_id,status,name,created_at) VALUES (?,?,'mapped',?,?)")
      .run(id, id, id, NOW);
  }
}
const tasks = db => buildScenario(db, { clock: CLOCK }).recs.find(r => r.id === 'missing-data')?.tasks.filter(t => !t.done) ?? [];

test('AC1: fresh connected balances cover an absent transaction export and an old CSV source', async t => {
  const s = await store(t), db = s.db;
  account(db, 'checking', { connected: true });
  db.prepare("INSERT INTO sources(id,label,kind,as_of) VALUES ('ing:old-csv','Old CSV','bank_csv','2026-01-31')").run();
  db.prepare("INSERT INTO files(id,name,status,source_id,uploaded_at) VALUES ('old','Old CSV.csv','imported','ing:old-csv',?)").run(NOW);
  db.prepare("INSERT INTO balances(account_id,date,amount,file_id) VALUES ('checking','2026-01-31',800,'old')").run();
  assert.equal(sourceStates(db, CLOCK).sources.get('ing:old-csv').state, 'history');
  await planRun(db, { now: CLOCK });
  assert.ok(!tasks(db).some(t => ['balances', 'transactions'].includes(t.code) || t.accountIds?.length), JSON.stringify(tasks(db)));
});

test('AC3: one needed upload names both accounts at an institution, and drops connected accounts', async t => {
  const { db } = await store(t);
  account(db, 'checking', { date: '2026-06-30' });
  account(db, 'savings', { date: '2026-06-30' });
  await planRun(db, { now: CLOCK });
  const uploads = tasks(db).filter(t => t.kind === 'upload' && t.accountIds?.length);
  assert.equal(uploads.length, 1, JSON.stringify(uploads));
  assert.deepEqual(uploads[0].accountIds.sort(), ['checking', 'savings']);
  assert.match(uploads[0].t, /Example Bank/);
  assert.match(uploads[0].t, /Everyday Checking/);
  assert.match(uploads[0].t, /Emergency Savings/);
  db.prepare("INSERT INTO simplefin_connection(id,access_blob,connected_at) VALUES (1,'synthetic',?)").run(NOW);
  db.prepare("INSERT INTO simplefin_accounts(sf_key,account_id,status,name,created_at) VALUES ('checking','checking','mapped','Checking',?)").run(NOW);
  await planRun(db, { now: CLOCK });
  const remaining = tasks(db).filter(t => t.kind === 'upload' && t.accountIds?.length);
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0].accountIds, ['savings']);
});

test('unused empty accounts do not create upload work', async t => {
  const { db } = await store(t);
  account(db, 'unused', { date: '2026-06-30', kind: 'unknown' });
  db.prepare("DELETE FROM balances WHERE account_id='unused'").run();
  await planRun(db, { now: CLOCK });
  assert.ok(!tasks(db).some(t => t.accountIds?.includes('unused')));
});

test('AC2: recurring connected payroll covers an old paystub, but other deposits and stopped payroll do not', async t => {
  const { db } = await store(t);
  account(db, 'checking', { connected: true });
  db.prepare("INSERT INTO sources(id,label,kind,as_of) VALUES ('ing:paystub','Example Studio payroll','paystub','2026-08-01')").run();
  db.prepare("INSERT INTO files(id,name,status,source_id,uploaded_at) VALUES ('stub','Paystub.pdf','imported','ing:paystub',?)").run(NOW);
  db.prepare("INSERT INTO documents(doc_type,tax_year,fields,file_id) VALUES ('paystub',2026,?,'stub')")
    .run(JSON.stringify({ employerName: 'Example Studio', payDate: '2026-08-01', gross: 3000, ytdGross: 24000 }));
  for (const date of ['2026-09-01', '2026-10-01', '2026-11-01']) db.prepare("INSERT INTO transactions(account_id,date,amount,description,parser) VALUES ('checking',?,2500,'Example Studio','simplefin')").run(date);
  assert.equal(sourceStates(db, CLOCK).sources.get('ing:paystub').state, 'fresh');
  assert.ok(!ingestState(db, { clock: CLOCK }).staleNotes.some(n => /payroll|Paystub/i.test(n.text)));
  db.prepare("UPDATE transactions SET description='Unrelated Employer PAYROLL'").run();
  assert.equal(sourceStates(db, CLOCK).sources.get('ing:paystub').state, 'stale');
  db.prepare("UPDATE transactions SET description='Example Studio'").run();
  db.prepare("DELETE FROM transactions WHERE date>'2026-09-01'").run();
  assert.equal(sourceStates(db, CLOCK).sources.get('ing:paystub').state, 'stale');
});

test('AC4: January Q4 estimate is inferred to the prior tax year with evidence and working Undo', async t => {
  const { db } = await store(t);
  account(db, 'checking', { connected: true });
  db.prepare("INSERT INTO transactions(account_id,date,amount,description,parser,dedupe_key) VALUES ('checking','2026-01-15',-700,'IRS ESTIMATED TAX Q4','simplefin','january-q4')").run();
  reconcileTransactionPayments(db, { now: NOW });
  const payment = db.prepare("SELECT * FROM tax_payments WHERE parser='transaction-payment'").get();
  assert.equal(payment?.tax_year, 2025);
  const id = JSON.parse(payment.locator).confirmId;
  assert.ok(autoInfo(db, id)?.evidence.text);
  assert.equal(pendingItems(db).filter(i => i.kind === 'transaction_payment').length, 0);
  reopenItem(db, id, { now: NOW });
  assert.equal(db.prepare('SELECT count(*) n FROM tax_payments').get().n, 0);
  reconcileTransactionPayments(db, { now: NOW });
  assert.equal(pendingItems(db).filter(i => i.kind === 'transaction_payment').length, 1, 'Undo is never silently inferred again');
});

test('AC5: identical bytes restore a removed file through its removal receipt', async t => {
  const s = await store(t), db = s.db;
  const file = textFile('synthetic-balances.csv', 'Account,Date,Balance\nChecking,2026-11-04,1000\n');
  const parser = { id: 'synthetic-balances', sourceKind: 'balances', label: 'Synthetic balances', parse: () => ({
    rows: [{ kind: 'balance', accountId: 'checking', account: { inst: 'Example Bank', name: 'Checking', kind: 'cash' }, date: '2026-11-04', amount: 1000, locator: { row: 2 } }],
    period: { from: '2026-11-04', to: '2026-11-04' }, warnings: [],
  }) };
  const opts = s.opts(null, { parser, actorId: 'synthetic-owner', now: NOW });
  const imported = await ingestFile(db, file, opts);
  assert.equal(imported.status, 'imported');
  const removed = removeFile({ db, actorId: 'synthetic-owner', now: NOW }, imported.fileId);
  assert.equal(db.prepare('SELECT count(*) n FROM balances').get().n, 0);
  const restored = await ingestFile(db, file, opts);
  assert.equal(restored.fileId, imported.fileId);
  assert.equal(restored.status, 'imported');
  assert.equal(restored.restored, true);
  assert.equal(db.prepare('SELECT removed_at FROM files WHERE id=?').get(imported.fileId).removed_at, null);
  assert.equal(db.prepare('SELECT count(*) n FROM balances').get().n, 1);
  assert.ok(db.prepare('SELECT undone_at FROM action_receipts WHERE id=?').get(removed.receipt.id).undone_at);
  assert.equal((await ingestFile(db, file, opts)).status, 'duplicate', 'an active identical file is still a duplicate');
});

test('uploaded estimates infer date-based years once, preserve explicit years, and Undo restores the unresolved year', async t => {
  const { db } = await store(t);
  for (const [date, amount] of [['2026-01-31', 300], ['2026-06-15', 500]]) {
    db.prepare(`INSERT INTO tax_payments(jurisdiction,tax_year,date,amount,kind,tax_year_basis,date_precision,source_slot)
      VALUES ('federal',2026,?,?,'estimate','sheet_label','month',?)`).run(date, amount, `tax:2026:federal:owner:${date}`);
  }
  const item = ask(db, { kind: 'tax_year', subject: 'tax:2026', question: 'Which year?', options: taxYearOptions(2026), context: { sheetYear: 2026 }, now: NOW });
  autoResolve(db, { now: NOW });
  assert.equal(getItem(db, item.id).status, 'answered');
  assert.ok(autoInfo(db, item.id));
  assert.deepEqual(db.prepare('SELECT tax_year FROM tax_payments ORDER BY date').all().map(r => r.tax_year), [2025, 2026]);
  reopenItem(db, item.id, { now: NOW });
  autoResolve(db, { now: NOW });
  assert.equal(getItem(db, item.id).status, 'pending');
  assert.deepEqual(db.prepare('SELECT tax_year_basis FROM tax_payments').all().map(r => r.tax_year_basis), ['sheet_label', 'sheet_label']);
});

test('unknown state schedules keep one tax-year question instead of guessing', async t => {
  const { db } = await store(t);
  db.prepare("INSERT INTO tax_payments(jurisdiction,tax_year,date,amount,kind,tax_year_basis,source_slot) VALUES ('CA',2026,'2026-01-15',300,'estimate','sheet_label','tax:2026:CA:owner')").run();
  const item = ask(db, { kind: 'tax_year', subject: 'tax:2026', question: 'Which year?', options: taxYearOptions(2026), context: { sheetYear: 2026 }, now: NOW });
  autoResolve(db, { now: NOW });
  assert.equal(getItem(db, item.id).status, 'pending');
});

test('a pending January question from an earlier run is inferred on planning', async t => {
  const { db } = await store(t);
  account(db, 'checking', { connected: true });
  db.prepare("INSERT INTO transactions(account_id,date,amount,description,parser,dedupe_key) VALUES ('checking','2026-01-15',-700,'IRS ESTIMATED TAX Q4','simplefin','existing-q4')").run();
  reconcileTransactionPayments(db, { now: NOW });
  const payment = db.prepare('SELECT * FROM tax_payments').get(), id = JSON.parse(payment.locator).confirmId;
  db.prepare('DELETE FROM tax_payments').run();
  for (const table of ['confirm_auto', 'confirm_undo']) db.prepare(`DELETE FROM ${table} WHERE item_id=?`).run(id);
  const old = JSON.parse(db.prepare('SELECT context FROM confirm_items WHERE id=?').get(id).context);
  old.taxYear = null; old.sure = false;
  db.prepare("UPDATE confirm_items SET status='pending',answer=NULL,context=?,options=? WHERE id=?")
    .run(JSON.stringify(old), JSON.stringify([{ id: 'estimate:2025', label: 'Prior year' }, { id: 'estimate:2026', label: 'Current year' }, { id: 'not_estimate', label: 'Not an estimate' }]), id);
  await planRun(db, { now: CLOCK });
  assert.equal(db.prepare('SELECT tax_year FROM tax_payments').get().tax_year, 2025);
  assert.ok(autoInfo(db, id));
  assert.equal(pendingItems(db).some(i => i.id === id), false);
});

test('the payment workbook import and planning boundaries infer years and preserve explicit years with Undo', async t => {
  const s = await store(t);
  const result = await importProposedRows(s, [
    { target: 'tax_payment', kind: 'estimate', status: 'paid', datePrecision: 'day', fields: {
      jurisdiction: 'federal', payer: 'owner', recipient: 'you', amount: 300, taxYear: 2026, taxYearBasis: 'sheet_label', paymentDate: '2026-01-15' } },
    { target: 'tax_payment', kind: 'estimate', status: 'paid', datePrecision: 'day', fields: {
      jurisdiction: 'VA', payer: 'owner', recipient: 'you', amount: 500, taxYear: 2026, taxYearBasis: 'confirmed_tax_year', paymentDate: '2026-01-16' } },
  ], { name: 'synthetic-tax-payments.xlsx', now: NOW });
  assert.equal(result.status, 'imported');
  await planRun(s.db, { now: CLOCK });
  const row = s.db.prepare("SELECT id FROM confirm_items WHERE kind='tax_year'").get();
  assert.ok(autoInfo(s.db, row.id));
  assert.equal(pendingItems(s.db).some(i => i.kind === 'tax_year'), false);
  assert.deepEqual(s.db.prepare('SELECT tax_year,tax_year_basis FROM tax_payments ORDER BY date').all().map(r => [r.tax_year,r.tax_year_basis]),
    [[2025, 'inferred_payment_year'], [2026, 'confirmed_tax_year']]);
  reopenItem(s.db, row.id, { now: NOW });
  assert.ok(pendingItems(s.db).some(i => i.id === row.id));
});

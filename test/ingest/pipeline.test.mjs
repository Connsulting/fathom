// AC3: ingestFile routes each file to its parser, stores it encrypted, persists rows with
// provenance, upserts accounts by institution and mask, deduplicates overlapping exports, and
// supersedes revised or removed workbook rows. Expected numbers come from the synthetic fixtures.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { src } from '../helpers/server.mjs';
import {
  fixture, textFile, aggregatorFile, studioRemovalFile, activityFile, coveragePnlFile, coverageTaxFile, positionsFile, unreadablePnlFile, unreadableTaxFile,
  realStore, fakeEngine, offEngine, all, one, count, items, sha256, fileIdOf,
} from '../helpers/ingest.mjs';

let P;
let V;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  V = await src('src/ingest/vault.mjs');
});

const inserted = (result, kind) => (result.counts && result.counts.rows && result.counts.rows[kind]) || 0;

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

// Every text value in every user table, for privacy scans.
function storeText(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

describe('routing and persistence per fixture', () => {
  test('aggregator.csv: two transactions with provenance, one account, counts stored on the file', () => withStore(async (s) => {
    const file = fixture('aggregator.csv', 'text/csv');
    const r = await P.ingestFile(s.db, file, s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'aggregator');
    assert.equal(r.sourceKind, 'aggregator_csv');
    assert.equal(r.name, 'aggregator.csv');
    assert.equal(r.fileId, fileIdOf(file.bytes));
    assert.equal(inserted(r, 'transaction'), 2);
    assert.equal(r.counts.duplicates, 0);
    assert.equal(r.counts.warnings, 2);
    assert.deepEqual(r.counts.warningCodes, { invalid_transaction: 2 });
    assert.equal(r.counts.queued, 1, 'one owner question; Checking maps to a known kind');

    const f = one(s.db, 'SELECT * FROM files WHERE id = ?', r.fileId);
    assert.equal(f.status, 'imported');
    assert.equal(f.parser, 'aggregator');
    assert.equal(f.source_kind, 'aggregator_csv');
    assert.equal(f.sha256, sha256(file.bytes));
    assert.equal(f.size, file.bytes.length);
    assert.equal(f.stored_path, `files/${r.fileId}.bin`);
    assert.deepEqual(JSON.parse(f.counts), r.counts);
    assert.match(f.source_id, /^ing:aggregator:/);

    const blob = readFileSync(join(s.dataDir, f.stored_path));
    assert.ok(!blob.includes(Buffer.from('EXAMPLE SHOP')), 'stored bytes are encrypted');
    const back = await V.readStoredFile({ dataDir: s.dataDir, key: s.key, id: r.fileId, storedPath: f.stored_path });
    assert.ok(Buffer.from(back).equals(Buffer.from(file.bytes)));

    const tx = all(s.db, 'SELECT * FROM transactions ORDER BY date');
    assert.deepEqual(tx.map((t) => t.amount), [-42.35, 900.5]);
    assert.deepEqual(tx.map((t) => t.occurrence), [1, 1]);
    for (const t of tx) {
      assert.equal(t.file_id, r.fileId);
      assert.equal(t.parser, 'aggregator');
      assert.match(t.dedupe_key, /^transaction:[0-9a-f]{64}$/);
    }
    assert.deepEqual(JSON.parse(tx[0].locator), { row: 2 });
    assert.deepEqual(JSON.parse(tx[1].locator), { row: 3 });

    const accts = all(s.db, 'SELECT * FROM accounts');
    assert.equal(accts.length, 1);
    const a = accts[0];
    assert.match(a.id, /^acct-[0-9a-f]{16}$/);
    assert.equal(a.inst, 'Chase');
    assert.equal(a.mask, '7766');
    assert.equal(a.name, 'Daily account');
    assert.equal(a.mirror, 'manual');
    assert.equal(a.owner, null);
    assert.equal(a.kind, 'cash');
    assert.equal(a.file_id, r.fileId);
    assert.ok(a.identity, 'identity recorded');
    assert.equal(f.source_id, `ing:aggregator:${a.id}`, 'single-account file names the account in its source id');
    assert.ok(tx.every((t) => t.account_id === a.id));
    assert.ok(!storeText(s.db).includes('9911227766'), 'the full account number is stored nowhere');
  }));

  test('bank activity CSV: transactions, running balances, Chase plus mask account, balance figure', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'chase-activity');
    assert.equal(r.sourceKind, 'bank_csv');
    assert.equal(inserted(r, 'transaction'), 3);
    assert.equal(inserted(r, 'balance'), 2);
    assert.equal(r.counts.queued, 2, 'owner and kind questions');
    const a = one(s.db, 'SELECT * FROM accounts');
    assert.equal(a.inst, 'Chase');
    assert.equal(a.mask, '7766');
    assert.equal(a.name, 'Chase 7766');
    assert.equal(a.kind, null);
    assert.deepEqual(all(s.db, 'SELECT amount FROM transactions ORDER BY date').map((t) => t.amount), [-42.35, 900.5, -10]);
    const bal = all(s.db, 'SELECT * FROM balances ORDER BY date');
    assert.deepEqual(bal.map((b) => [b.date, b.amount]), [['2032-02-29', 1400.25], ['2032-03-01', 2300.75]]);
    assert.ok(bal.every((b) => b.file_id === r.fileId && b.parser === 'chase-activity' && b.dedupe_key));
    assert.equal(a.fig_key, `acct.${a.id}.balance`);
    const fig = one(s.db, 'SELECT * FROM figures WHERE key = ?', a.fig_key);
    assert.equal(fig.v, 2300.75, 'latest balance');
    assert.equal(fig.kind, 'a');
    assert.equal(fig.src, `ing:chase-activity:${a.id}`);
    assert.equal(one(s.db, 'SELECT * FROM sources WHERE id = ?', fig.src).kind, 'bank_csv');
    assert.deepEqual(items(s.db, 'account_owner').map((i) => i.subject), [a.id]);
    assert.deepEqual(items(s.db, 'account_kind').map((i) => i.subject), [a.id]);
  }));

  test('positions.csv: two positions on a masked account and a holdings total figure', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('positions.csv', 'text/csv'), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'brokerage-positions');
    assert.equal(inserted(r, 'position'), 2);
    assert.deepEqual(r.counts.warningCodes, { pending_activity: 1, invalid_position: 1 });
    const a = one(s.db, 'SELECT * FROM accounts');
    assert.equal(a.mask, '5544');
    assert.equal(a.name, 'Long term');
    const pos = all(s.db, 'SELECT * FROM positions ORDER BY symbol');
    assert.deepEqual(pos.map((p) => [p.symbol, p.as_of, p.quantity, p.price, p.value]), [['CASH', '2032-03-05', 125.75, 1, 125.75], ['DEMO', '2032-03-05', 3.125, 24, 75]]);
    assert.equal(pos.find((p) => p.symbol === 'DEMO').cost_basis, 65.25);
    assert.ok(pos.every((p) => p.account_id === a.id && p.file_id === r.fileId && p.dedupe_key));
    const fig = one(s.db, 'SELECT * FROM figures WHERE key = ?', `acct.${a.id}.balance`);
    assert.equal(fig.v, 200.75, 'positions total at the latest as-of');
    assert.ok(!storeText(s.db).includes('8877665544'), 'no full brokerage account number');
  }));

  test('month-end balances and the account map import; notes with the engine off keep their document and wait', () => withStore(async (s) => {
    const off = await offEngine();
    const b = await P.ingestFile(s.db, fixture('month-end-balances.csv', 'text/csv'), s.opts(off));
    assert.equal(b.status, 'imported');
    assert.equal(inserted(b, 'balance'), 2);
    const acct = one(s.db, 'SELECT * FROM accounts');
    assert.equal(acct.name, 'daily');
    assert.equal(acct.mask, null);
    assert.deepEqual(all(s.db, 'SELECT date, amount FROM balances ORDER BY date').map((x) => [x.date, x.amount]), [['2032-02-29', 1400.25], ['2032-03-31', 2300.75]]);

    const m = await P.ingestFile(s.db, fixture('account-map.csv', 'text/csv'), s.opts(off));
    assert.equal(m.status, 'imported');
    assert.equal(inserted(m, 'document'), 2);
    assert.deepEqual(all(s.db, "SELECT doc_type FROM documents WHERE file_id = ?", m.fileId).map((d) => d.doc_type), ['account_metadata', 'account_metadata']);

    const n = await P.ingestFile(s.db, fixture('notes.md'), s.opts(off));
    assert.equal(n.status, 'needs_extraction', 'R7: notes wait for the engine');
    assert.equal(one(s.db, 'SELECT status FROM files WHERE id = ?', n.fileId).status, 'needs_extraction');
    const notes = all(s.db, 'SELECT * FROM documents WHERE file_id = ?', n.fileId);
    assert.equal(notes.length, 1, 'the notes parser document is still written');
    assert.equal(notes[0].doc_type, 'notes');
    assert.equal(count(s.db, 'confirm_items', 'file_id = ?', n.fileId), 0);
  }));

  test('business-pnl.xlsx: grouped P&L lines with slots and cell locators', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('business-pnl.xlsx'), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'pnl-workbook');
    assert.equal(inserted(r, 'pnl_line'), 3);
    const lines = all(s.db, 'SELECT * FROM pnl_lines ORDER BY entity, period, category');
    assert.deepEqual(lines.map((l) => [l.entity, l.period, l.category, l.amount]), [
      ['Example Shop', '2032-03', 'Income', 175.25],
      ['Example Studio', '2032-02', 'Income', 400],
      ['Example Studio', '2032-02', 'Office supplies', -35],
    ]);
    for (const l of lines) {
      assert.match(l.source_slot, /^pnl:.+:2032$/);
      assert.match(l.dedupe_key, /^pnl_line:/);
      assert.equal(l.file_id, r.fileId);
    }
    assert.equal(lines[1].source_slot, lines[2].source_slot, 'one slot per entity and year');
    assert.notEqual(lines[0].source_slot, lines[1].source_slot);
    assert.deepEqual(JSON.parse(lines[2].locator), { sheet: 'Example Studio', cells: ['I2', 'I3', 'I4'] });
  }));

  test('tax-payments.xlsx: payment kind lands in kind, with payer, precision, basis and slots', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('tax-payments.xlsx'), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'tax-payments');
    assert.equal(inserted(r, 'tax_payment'), 10);
    const rows = all(s.db, 'SELECT * FROM tax_payments ORDER BY id');
    assert.equal(rows.length, 10);
    assert.ok(rows.every((t) => t.kind === 'paid' && t.date_precision === 'month' && t.tax_year_basis === 'sheet_label'));
    assert.deepEqual([...new Set(rows.map((t) => t.payer))].sort(), ['Owner', 'Spouse']);
    assert.equal(rows.filter((t) => t.tax_year === 2032).length, 8);
    assert.equal(rows.filter((t) => t.tax_year === 2031).length, 2);
    // R4: slot = tax:<sheetYear>:<jurisdiction>:<payer>, normalized.
    assert.deepEqual([...new Set(rows.map((t) => t.source_slot))].sort(), [
      'tax:2031:federal:spouse', 'tax:2031:state:spouse',
      'tax:2032:federal:owner', 'tax:2032:federal:spouse', 'tax:2032:state:owner', 'tax:2032:state:spouse',
    ]);
    assert.equal(Math.round(rows.reduce((sum, t) => sum + t.amount, 0) * 100) / 100, 1320);
    const years = new Set(items(s.db, 'tax_year').map((q) => (/(?:^|:)(203[12])(?::|$)/.exec(q.subject) || [])[1]));
    assert.deepEqual([...years].sort(), ['2031', '2032'], 'tax-year questions cover both sheet years');
  }));
});

describe('identity, occurrence and source scope', () => {
  test('an unnamed, unmasked account is scoped by locator.source; masks keep at most 4 digits', () => withStore(async (s) => {
    const file = aggregatorFile('unnamed.csv', [
      { date: '2032-03-04', account: '', number: '', amount: '12.00', description: 'Synthetic unnamed row' },
    ]);
    const r = await P.ingestFile(s.db, file, s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    const t = one(s.db, 'SELECT * FROM transactions');
    const loc = JSON.parse(t.locator);
    assert.equal(loc.row, 2);
    assert.match(loc.source, /^[0-9a-f]{64}$/);
    const a = one(s.db, 'SELECT * FROM accounts');
    assert.equal(a.mask, null);
    for (const acct of all(s.db, 'SELECT mask FROM accounts')) assert.ok(acct.mask === null || /^\d{4}$/.test(acct.mask));
  }));

  test('repeated identical postings in one export keep distinct occurrences', () => withStore(async (s) => {
    const row = { date: '2032-03-06', amount: '3.50', description: 'Synthetic coffee' };
    const r = await P.ingestFile(s.db, aggregatorFile('repeats.csv', [row, row, { ...row, date: '2032-03-07' }]), s.opts(await offEngine()));
    assert.equal(inserted(r, 'transaction'), 3);
    assert.equal(r.counts.duplicates, 0);
    assert.deepEqual(all(s.db, 'SELECT occurrence FROM transactions ORDER BY date, occurrence').map((t) => t.occurrence), [1, 2, 1]);
  }));
});

describe('deduplication', () => {
  const rowsA = [
    { date: '2032-03-02', amount: '11.01', description: 'Synthetic row one' },
    { date: '2032-03-03', amount: '22.02', description: 'Synthetic row two' },
    { date: '2032-03-04', amount: '33.03', description: 'Synthetic row three' },
    { date: '2032-03-05', amount: '44.04', description: 'Synthetic row four' },
  ];
  const rowsB = [
    rowsA[2], rowsA[3],
    { date: '2032-03-06', amount: '55.05', description: 'Synthetic row five' },
    { date: '2032-03-07', amount: '66.06', description: 'Synthetic row six' },
  ];

  test('overlapping aggregator dumps: second import counts the overlap as duplicates', () => withStore(async (s) => {
    const off = await offEngine();
    const a = await P.ingestFile(s.db, aggregatorFile('dump-a.csv', rowsA), s.opts(off));
    assert.equal(inserted(a, 'transaction'), 4);
    const b = await P.ingestFile(s.db, aggregatorFile('dump-b.csv', rowsB), s.opts(off));
    assert.equal(b.status, 'imported');
    assert.equal(inserted(b, 'transaction'), 2);
    assert.equal(b.counts.duplicates, 2, 'duplicates equal the overlap');
    assert.equal(count(s.db, 'transactions'), 6);
    assert.equal(count(s.db, 'accounts'), 1);
    assert.equal(items(s.db, 'near_duplicate').length, 0);

    const again = await P.ingestFile(s.db, aggregatorFile('dump-b.csv', rowsB), s.opts(off));
    assert.equal(again.status, 'duplicate');
    assert.equal(again.duplicateOf, b.fileId);
    assert.equal(count(s.db, 'transactions'), 6, 'totals unchanged');
    assert.equal(count(s.db, 'files'), 2);
  }));

  test('the same postings from the bank export and the aggregator dedupe across formats', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(off));
    const r = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
    assert.equal(r.status, 'imported');
    assert.equal(inserted(r, 'transaction'), 0);
    assert.equal(r.counts.duplicates, 2);
    assert.equal(count(s.db, 'transactions'), 3);
    assert.equal(count(s.db, 'accounts'), 1, 'accounts upsert by institution and mask');
  }));

  test('one request: same bytes twice is a duplicate; same name with different bytes stores both', () => withStore(async (s) => {
    const first = aggregatorFile('export.csv', [{ date: '2032-03-02', amount: '7.25', description: 'Synthetic first' }]);
    const other = aggregatorFile('export.csv', [{ date: '2032-03-03', amount: '8.75', description: 'Synthetic second' }]);
    const { results } = await P.ingestFiles(s.db, [first, { ...first }, other], s.opts(await offEngine()));
    assert.deepEqual(results.map((x) => x.status), ['imported', 'duplicate', 'imported']);
    assert.equal(results[1].duplicateOf, results[0].fileId);
    assert.notEqual(results[2].fileId, results[0].fileId);
    assert.equal(count(s.db, 'files'), 2);
    assert.equal(count(s.db, 'transactions'), 2);
  }));
});

describe('unsupported inputs', () => {
  test('an empty file, non UTF-8 text and a corrupt workbook are unsupported; a valid CSV beside them imports', () => withStore(async (s) => {
    const eng = await fakeEngine([]);
    const empty = await P.ingestFile(s.db, { name: 'empty.csv', bytes: new Uint8Array(0) }, s.opts(eng));
    assert.equal(empty.status, 'unsupported');
    const binary = await P.ingestFile(s.db, { name: 'scan.txt', bytes: new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x81, 0xc3]) }, s.opts(eng));
    assert.equal(binary.status, 'unsupported');
    const corrupt = await P.ingestFile(s.db, fixture('corrupt-archive.xlsx'), s.opts(eng));
    assert.equal(corrupt.status, 'unsupported');
    assert.equal(one(s.db, 'SELECT status FROM files WHERE id = ?', corrupt.fileId).status, 'unsupported');
    const ok = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(eng));
    assert.equal(ok.status, 'imported');
  }));
});

describe('supersede', () => {
  test('business-pnl then the revised workbook: revised amount replaces the old one; a recut removes a slot row', () => withStore(async (s) => {
    const off = await offEngine();
    const first = await P.ingestFile(s.db, fixture('business-pnl.xlsx'), s.opts(off));
    const revised = await P.ingestFile(s.db, fixture('business-pnl-revised.xlsx'), s.opts(off));
    assert.equal(revised.status, 'imported');
    assert.equal(revised.counts.revised, 1);
    assert.equal(revised.counts.duplicates, 2);
    assert.equal(revised.counts.superseded, 0);
    assert.equal(count(s.db, 'pnl_lines'), 3);
    assert.equal(one(s.db, "SELECT amount FROM pnl_lines WHERE category = 'Office supplies'").amount, -50);
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'pnl_lines' ORDER BY id");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'revised');
    assert.equal(sup[0].file_id, first.fileId);
    assert.equal(sup[0].superseded_by, revised.fileId);
    assert.equal(JSON.parse(sup[0].row).amount, -35);

    const recut = await P.ingestFile(s.db, studioRemovalFile(), s.opts(off));
    assert.equal(recut.status, 'imported');
    assert.equal(inserted(recut, 'pnl_line'), 1, 'the new Software line');
    assert.equal(recut.counts.duplicates, 1, 'the unchanged income line');
    assert.equal(recut.counts.superseded, 1, 'the Office supplies slot row is gone from the later file');
    const lines = all(s.db, 'SELECT entity, period, category, amount FROM pnl_lines ORDER BY entity, category');
    assert.deepEqual(lines.map((l) => [l.entity, l.category, l.amount]), [
      ['Example Shop', 'Income', 175.25],
      ['Example Studio', 'Income', 400],
      ['Example Studio', 'Software', -20],
    ], 'other slots (Example Shop) are untouched');
    const removed = all(s.db, "SELECT * FROM superseded_rows WHERE reason = 'removed'");
    assert.equal(removed.length, 1);
    assert.equal(JSON.parse(removed[0].row).amount, -50);
    assert.equal(removed[0].superseded_by, recut.fileId);
  }));

  test('tax-payments then the revised workbook: one revised payment, nothing else changes', () => withStore(async (s) => {
    const off = await offEngine();
    const first = await P.ingestFile(s.db, fixture('tax-payments.xlsx'), s.opts(off));
    const revised = await P.ingestFile(s.db, fixture('tax-payments-revised.xlsx'), s.opts(off));
    assert.equal(revised.status, 'imported');
    assert.equal(revised.counts.revised, 1);
    assert.equal(revised.counts.duplicates, 9);
    assert.equal(revised.counts.superseded, 0);
    assert.equal(count(s.db, 'tax_payments'), 10);
    const feb = one(s.db, "SELECT * FROM tax_payments WHERE jurisdiction = 'federal' AND payer = 'Owner' AND date = '2032-02-29'");
    assert.equal(feb.amount, 250);
    assert.equal(feb.kind, 'paid');
    assert.equal(Math.round(all(s.db, 'SELECT amount FROM tax_payments').reduce((sum, t) => sum + t.amount, 0) * 100) / 100, 1345);
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'revised');
    assert.equal(sup[0].file_id, first.fileId);
    assert.equal(JSON.parse(sup[0].row).amount, 225);
  }));
});

test('stored uploads exist only as encrypted blobs under files/', () => withStore(async (s) => {
  const r = await P.ingestFile(s.db, fixture('positions.csv', 'text/csv'), s.opts(await offEngine()));
  const path = join(s.dataDir, 'files', `${r.fileId}.bin`);
  assert.ok(existsSync(path));
  const blob = readFileSync(path);
  assert.equal(blob.subarray(0, 5).toString('latin1'), 'FTHM1');
  assert.ok(!blob.includes(Buffer.from('Example Fund')));
}));

// R3: two overlapping activity exports disagree on the 2032-03-05 closing balance. The export whose
// period ends later (2032-03-06) wins in either import order.
describe('balance revisions', () => {
  const older = () => activityFile('Chase4321_Activity_20320305.csv', [
    { date: '03/01/2032', amount: '-10.00', balance: '990.00', description: 'Synthetic fee' },
    { date: '03/05/2032', amount: '-20.00', balance: '970.00', description: 'Synthetic card' },
  ]);
  const newer = () => activityFile('Chase4321_Activity_20320306.csv', [
    { date: '03/05/2032', amount: '-20.00', balance: '965.00', description: 'Synthetic card' },
    { date: '03/06/2032', amount: '-5.00', balance: '', description: 'Synthetic transfer' },
  ]);

  async function figureValue(db) {
    const { buildScenario } = await src('src/scenario/build.mjs');
    const sc = buildScenario(db, { clock: '2032-03-10' });
    const acct = sc.accounts.find((a) => a.mask === '4321');
    assert.ok(acct && acct.fig, 'account has a balance figure');
    return sc.fig[acct.fig].v;
  }

  test('older then newer: the newer period revises the day and archives the old value', () => withStore(async (s) => {
    const off = await offEngine();
    const a = await P.ingestFile(s.db, older(), s.opts(off));
    const b = await P.ingestFile(s.db, newer(), s.opts(off));
    assert.equal(b.counts.revised, 1);
    assert.deepEqual([one(s.db, 'SELECT period_from, period_to FROM files WHERE id = ?', b.fileId)].map((f) => [f.period_from, f.period_to]), [['2032-03-05', '2032-03-06']]);
    assert.deepEqual(all(s.db, 'SELECT date, amount FROM balances ORDER BY date').map((x) => [x.date, x.amount]), [['2032-03-01', 990], ['2032-03-05', 965]]);
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'balances'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'revised');
    assert.equal(sup[0].file_id, a.fileId);
    assert.equal(JSON.parse(sup[0].row).amount, 970);
    assert.equal(one(s.db, "SELECT file_id FROM balances WHERE date = '2032-03-05'").file_id, b.fileId, 'provenance follows the revision');
    assert.equal(await figureValue(s.db), 965);
  }));

  test('newer then older: the stored newer value stays and the older snapshot is archived', () => withStore(async (s) => {
    const off = await offEngine();
    const b = await P.ingestFile(s.db, newer(), s.opts(off));
    const a = await P.ingestFile(s.db, older(), s.opts(off));
    assert.equal(a.counts.revised, 0);
    assert.ok(a.counts.duplicates >= 2, 'the shared transaction and the older balance count as duplicates');
    assert.deepEqual(all(s.db, 'SELECT date, amount FROM balances ORDER BY date').map((x) => [x.date, x.amount]), [['2032-03-01', 990], ['2032-03-05', 965]]);
    assert.equal(one(s.db, "SELECT file_id FROM balances WHERE date = '2032-03-05'").file_id, b.fileId);
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'balances'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'older_snapshot');
    assert.equal(JSON.parse(sup[0].row).amount, 970);
    assert.equal(await figureValue(s.db), 965);
  }));

  test('the same balance again is a plain duplicate', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, older(), s.opts(off));
    const again = await P.ingestFile(s.db, activityFile('Chase4321_Activity_copy.csv', [{ date: '03/05/2032', amount: '-20.00', balance: '970.00', description: 'Synthetic card' }]), s.opts(off));
    assert.equal(again.counts.revised, 0);
    assert.equal(again.counts.duplicates, 2);
    assert.equal(count(s.db, 'superseded_rows'), 0);
  }));
});

// R4: workbook coverage decides which stored rows a later workbook replaces.
describe('workbook coverage', () => {
  const removed = (db, table) => all(db, `SELECT * FROM superseded_rows WHERE table_name = '${table}' AND reason = 'removed' ORDER BY id`);

  test('P&L: a deleted row is archived and removed', () => withStore(async (s) => {
    const off = await offEngine();
    const base = await P.ingestFile(s.db, coveragePnlFile('base'), s.opts(off));
    assert.equal((base.counts.rows || {}).pnl_line, 4);
    const r = await P.ingestFile(s.db, coveragePnlFile('deleteRow'), s.opts(off));
    assert.equal(r.counts.superseded, 1);
    const gone = removed(s.db, 'pnl_lines');
    assert.deepEqual(gone.map((x) => [JSON.parse(x.row).category, JSON.parse(x.row).amount]), [['Travel', -50]]);
    assert.equal(gone[0].file_id, base.fileId);
    assert.equal(gone[0].superseded_by, r.fileId);
    assert.equal(count(s.db, 'pnl_lines', "category = 'Travel'"), 0);
    assert.equal(count(s.db, 'pnl_lines'), 3);
  }));

  test('P&L: sheets kept with headers but no data empty the slot; every active row of it is removed', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coveragePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coveragePnlFile('emptySlot'), s.opts(off));
    assert.equal(r.counts.superseded, 3);
    assert.deepEqual(removed(s.db, 'pnl_lines').map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [-50, -30, 400]);
    assert.deepEqual(all(s.db, 'SELECT entity, amount FROM pnl_lines').map((x) => [x.entity, x.amount]), [['Example Shop', 175.25]]);
  }));

  test('P&L: a workbook without the entity sheets covers nothing for it; its rows stay', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coveragePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coveragePnlFile('sheetGone'), s.opts(off));
    assert.equal(r.counts.superseded, 0);
    assert.equal(count(s.db, 'pnl_lines'), 4);
    assert.equal(count(s.db, 'superseded_rows'), 0);
  }));

  test('tax: a deleted month row is archived and removed', () => withStore(async (s) => {
    const off = await offEngine();
    const base = await P.ingestFile(s.db, coverageTaxFile('base'), s.opts(off));
    assert.equal((base.counts.rows || {}).tax_payment, 8);
    const r = await P.ingestFile(s.db, coverageTaxFile('deleteRow'), s.opts(off));
    assert.equal(r.counts.superseded, 2);
    assert.deepEqual(removed(s.db, 'tax_payments').map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [60, 120]);
    assert.equal(count(s.db, 'tax_payments', "date = '2032-03-31'"), 0);
    assert.equal(count(s.db, 'tax_payments'), 6);
  }));

  test('tax: payer columns kept but emptied cover their slots; those rows are removed', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coverageTaxFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coverageTaxFile('emptySlot'), s.opts(off));
    assert.equal(r.counts.superseded, 3);
    assert.deepEqual(removed(s.db, 'tax_payments').map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [20, 50, 60]);
    assert.equal(count(s.db, 'tax_payments', "payer = 'Spouse'"), 0);
    assert.deepEqual([...new Set(all(s.db, 'SELECT source_slot FROM tax_payments').map((x) => x.source_slot))].sort(), ['tax:2032:federal:owner', 'tax:2032:state:owner']);
    const cov = JSON.parse(one(s.db, 'SELECT coverage FROM files WHERE id = ?', r.fileId).coverage);
    assert.ok(JSON.stringify(cov).includes('tax:2032:federal:spouse'), 'coverage comes from the header, not the emitted rows');
  }));

  test('tax: a workbook without the 2032 sheet leaves the 2032 rows alone', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coverageTaxFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coverageTaxFile('sheetGone'), s.opts(off));
    assert.equal(r.counts.superseded, 0);
    assert.equal(count(s.db, 'tax_payments', "date LIKE '2032-%'"), 8);
    assert.equal(count(s.db, 'tax_payments'), 10);
  }));
});

// R11: P&L coverage is per entity and the years of its own rows; header-only sheets cover a year
// only when the whole file is single-year; a file with no P&L rows covers nothing.
describe('P&L coverage per entity and year', () => {
  test('entities covering different years do not delete each other\'s history', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coveragePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coveragePnlFile('otherYear'), s.opts(off));
    assert.equal(r.counts.superseded, 0, 'Studio 2031 rows do not cover Studio 2032');
    assert.equal(count(s.db, 'pnl_lines', "entity = 'Example Studio' AND period LIKE '2032-%'"), 3);
    assert.equal(count(s.db, 'pnl_lines', "entity = 'Example Studio' AND period = '2031-11'"), 1);
    assert.equal(count(s.db, 'superseded_rows'), 0);
  }));

  test('a header-only revision with no rows anywhere supersedes nothing and warns empty_workbook', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coveragePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coveragePnlFile('allEmpty'), s.opts(off));
    assert.equal(r.counts.superseded, 0);
    assert.ok((r.counts.warningCodes || {}).empty_workbook >= 1);
    assert.equal(count(s.db, 'pnl_lines'), 4);
    assert.equal(count(s.db, 'superseded_rows'), 0);
  }));

  test('a header-only sheet in a single-year workbook removes that entity\'s rows for the year', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coveragePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coveragePnlFile('emptySlot'), s.opts(off));
    assert.equal(r.counts.superseded, 3);
    assert.equal(count(s.db, 'pnl_lines', "entity = 'Example Studio'"), 0);
  }));

  test('a header-only sheet in a multi-year workbook covers nothing', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, coveragePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, coveragePnlFile('emptyMultiYear'), s.opts(off));
    assert.equal(r.counts.superseded, 0);
    assert.equal(count(s.db, 'pnl_lines', "entity = 'Example Studio'"), 3);
  }));
});

// R12: authority advances on equal values. A (100, period to 03-05), C (200, to 03-06),
// B (100, to 03-07): every order ends with 100 from B.
describe('balance authority across three exports', () => {
  const A = () => activityFile('Chase4321_Activity_A.csv', [{ date: '03/05/2032', amount: '-20.00', balance: '100.00' }]);
  const Cx = () => activityFile('Chase4321_Activity_C.csv', [
    { date: '03/05/2032', amount: '-20.00', balance: '200.00' }, { date: '03/06/2032', amount: '-1.00', balance: '' },
  ]);
  const Bx = () => activityFile('Chase4321_Activity_B.csv', [
    { date: '03/05/2032', amount: '-20.00', balance: '100.00' }, { date: '03/06/2032', amount: '-1.00', balance: '' },
    { date: '03/07/2032', amount: '-2.00', balance: '' },
  ]);
  const orders = { ABC: [A, Bx, Cx], CAB: [Cx, A, Bx], ACB: [A, Cx, Bx] };

  for (const [label, files] of Object.entries(orders)) {
    test(`order ${label}: stored value is 100 from B`, () => withStore(async (s) => {
      const off = await offEngine();
      const ids = {};
      for (const make of files) {
        const f = make();
        const r = await P.ingestFile(s.db, f, s.opts(off));
        assert.equal(r.status, 'imported');
        ids[f.name.slice(-5, -4)] = r.fileId;
      }
      const bal = all(s.db, "SELECT * FROM balances WHERE date = '2032-03-05'");
      assert.equal(bal.length, 1);
      assert.equal(bal[0].amount, 100);
      assert.equal(bal[0].file_id, ids.B, 'authority sits with the newest period');
      assert.ok(all(s.db, "SELECT row FROM superseded_rows WHERE table_name = 'balances'").every((x) => [100, 200].includes(JSON.parse(x.row).amount)));
    }));
  }
});

// R13: positions follow the balance slot policy (slot = account, as_of, symbol).
describe('position revisions', () => {
  const rowsA = [{ symbol: 'EXMPL', quantity: '10', price: '20.00', value: '200.00' }, { symbol: 'OTHR', quantity: '5', price: '10.00', value: '50.00' }];
  const rowsB = [{ symbol: 'EXMPL', quantity: '10', price: '21.00', value: '210.00' }, { symbol: 'OTHR', quantity: '5', price: '10.00', value: '50.00' }];

  test('a corrected positions CSV for the same day revises the changed holding', () => withStore(async (s) => {
    const off = await offEngine();
    const a = await P.ingestFile(s.db, positionsFile('positions-a.csv', rowsA), s.opts(off));
    const b = await P.ingestFile(s.db, positionsFile('positions-corrected.csv', rowsB), s.opts(off));
    assert.equal(b.counts.revised, 1);
    assert.equal(b.counts.duplicates, 1);
    assert.equal(count(s.db, 'positions'), 2);
    const ex = one(s.db, "SELECT * FROM positions WHERE symbol = 'EXMPL'");
    assert.deepEqual([ex.price, ex.value, ex.file_id], [21, 210, b.fileId]);
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'positions'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'revised');
    assert.equal(sup[0].file_id, a.fileId);
    assert.equal(JSON.parse(sup[0].row).value, 200);
    const acct = one(s.db, "SELECT * FROM accounts WHERE mask = '2222'");
    assert.equal(one(s.db, 'SELECT v FROM figures WHERE key = ?', `acct.${acct.id}.balance`).v, 260, 'holdings total follows the revision');
  }));

  test('an extracted statement with changed holdings revises the position', () => withStore(async (s) => {
    const statement = (value) => ({
      institution: 'Example Bank', accountLast4: '4321', accountKind: 'brokerage', periodEnd: '2032-03-31', endingBalance: value,
      holdings: [{ symbol: 'EXMPL', name: 'Example Index Fund', quantity: 10, value }], confidence: 0.9,
    });
    const pdf = (tag) => ({ name: `statement-${tag}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n% synthetic statement ${tag}\n%%EOF\n`), mime: 'application/pdf' });
    const eng = (value) => fakeEngine([[{ docType: 'statement', confidence: 0.9 }], [statement(value)]]);
    const a = await P.ingestFile(s.db, pdf('first'), s.opts(await eng(1234.5)));
    const b = await P.ingestFile(s.db, pdf('corrected'), s.opts(await eng(1300)));
    assert.equal(a.status, 'imported');
    assert.equal(b.status, 'imported');
    const pos = all(s.db, 'SELECT * FROM positions');
    assert.equal(pos.length, 1);
    assert.deepEqual([pos[0].value, pos[0].price, pos[0].file_id], [1300, 130, b.fileId]);
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'positions'");
    assert.deepEqual(sup.map((x) => [x.reason, JSON.parse(x.row).value, x.file_id]), [['revised', 1234.5, a.fileId]]);
  }));
});

// Review finding F1: an unreadable amount cell (formula without a cached value, or text) must not
// remove or partially overwrite the active rows of its slot. A readable revision still removes.
describe('partly unreadable workbooks', () => {
  const removedFrom = (db, table) => all(db, `SELECT * FROM superseded_rows WHERE table_name = '${table}' AND reason = 'removed'`);

  test('P&L: unreadable cells keep the stored Software total and the Travel row', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, unreadablePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, unreadablePnlFile('unreadable'), s.opts(off));
    assert.equal(r.counts.warningCodes.formula_without_cache, 1);
    assert.equal(r.counts.warningCodes.invalid_pnl_row, 1);
    const lines = all(s.db, 'SELECT category, period, amount FROM pnl_lines ORDER BY period, category');
    assert.deepEqual(lines.map((l) => [l.category, l.period, l.amount]), [
      ['Income', '2032-02', 400], ['Software', '2032-02', -50], ['Travel', '2032-03', -50],
    ], 'no partial aggregate replaces the complete one and nothing is removed');
    assert.deepEqual(removedFrom(s.db, 'pnl_lines'), []);
    assert.equal(count(s.db, 'superseded_rows', "table_name = 'pnl_lines'"), 0);
  }));

  test('P&L liveness: the same revision without unreadable cells removes the Travel row', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, unreadablePnlFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, unreadablePnlFile('travelGone'), s.opts(off));
    assert.equal(r.counts.superseded, 1);
    assert.deepEqual(removedFrom(s.db, 'pnl_lines').map((x) => JSON.parse(x.row).amount), [-50]);
    assert.equal(count(s.db, 'pnl_lines', "category = 'Travel'"), 0);
  }));

  test('tax: unreadable Paid cells keep the stored payments of their slots', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, unreadableTaxFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, unreadableTaxFile('unreadable'), s.opts(off));
    assert.equal(r.counts.warningCodes.formula_without_cache, 1);
    assert.equal(r.counts.warningCodes.invalid_tax_payment, 1);
    const owner = (j, date) => all(s.db, 'SELECT amount FROM tax_payments WHERE jurisdiction = ? AND payer = ? AND date = ?', j, 'Owner', date).map((t) => t.amount);
    assert.deepEqual(owner('federal', '2032-03-31'), [120], 'the March federal payment stays');
    assert.deepEqual(owner('state', '2032-02-29'), [35], 'the February state payment stays');
    assert.equal(count(s.db, 'tax_payments'), 8);
    assert.deepEqual(removedFrom(s.db, 'tax_payments'), []);
  }));

  test('tax liveness: the same revision without unreadable cells removes the March payments', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, unreadableTaxFile('base'), s.opts(off));
    const r = await P.ingestFile(s.db, unreadableTaxFile('marchGone'), s.opts(off));
    assert.equal(r.counts.superseded, 2);
    assert.deepEqual(removedFrom(s.db, 'tax_payments').map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [60, 120]);
  }));
});

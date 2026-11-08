// AC3: ingestFile routes each file to its parser, stores it encrypted, persists rows with
// provenance, upserts accounts by institution and mask, deduplicates overlapping exports, and
// supersedes revised or removed workbook rows. Expected numbers come from the synthetic fixtures.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { src } from '../helpers/server.mjs';
import { writeXlsx } from '../helpers/xlsx.mjs';
import { importProposedRows } from '../helpers/import-proposal-fixture.mjs';
import { imagePdf } from '../helpers/pdf.mjs';
import {
  fixture, textFile, aggregatorFile, studioRemovalFile, activityFile, coveragePnlFile, coverageTaxFile, positionsFile, unreadablePnlFile, unreadableTaxFile,
  realStore, fakeEngine, recordingEngine, offEngine, all, one, count, items, sha256, fileIdOf, NOW,
} from '../helpers/ingest.mjs';
import { mapSeries } from '../../src/shared/series.mjs';

let P;
let V;
let C;
let Bld;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  V = await src('src/ingest/vault.mjs');
  C = await src('src/ingest/confirm.mjs');
  Bld = await src('src/scenario/build.mjs');
});

const inserted = (result, kind) => (result.counts && result.counts.rows && result.counts.rows[kind]) || 0;

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

// Every text value in every user table, for privacy scans.
async function storeText(db) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()).map((r) => r.name);
  return (await mapSeries(tables, async (t) => JSON.stringify(await db.prepare(`SELECT * FROM "${t}"`).all()))).join('\n');
}

describe('routing and persistence per fixture', () => {
  test('aggregator.csv: two transactions with provenance, one account, counts stored on the file', async () => withStore(async (s) => {
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

    const f = await one(s.db, 'SELECT * FROM files WHERE id = ?', r.fileId);
    assert.equal(f.status, 'imported');
    assert.equal(f.parser, 'aggregator');
    assert.equal(f.source_kind, 'aggregator_csv');
    assert.equal(f.sha256, sha256(file.bytes));
    assert.equal(f.size, file.bytes.length);
    assert.equal(f.stored_path, `files/${r.fileId}.bin`);
    assert.deepEqual(JSON.parse(f.counts), r.counts);
    assert.match(f.source_id, /^ing:aggregator:/);

    const blob = readFileSync(join(s.root, f.stored_path));
    assert.ok(!blob.includes(Buffer.from('EXAMPLE SHOP')), 'stored bytes are encrypted');
    const back = await V.readStoredFile({ vault: await s.household.vault(), id: r.fileId, storedPath: f.stored_path, purpose: 'upload' });
    assert.ok(Buffer.from(back).equals(Buffer.from(file.bytes)));

    const tx = await all(s.db, 'SELECT * FROM transactions ORDER BY date');
    assert.deepEqual(tx.map((t) => t.amount), [-42.35, 900.5]);
    assert.deepEqual(tx.map((t) => t.occurrence), [1, 1]);
    for (const t of tx) {
      assert.equal(t.file_id, r.fileId);
      assert.equal(t.parser, 'aggregator');
      assert.match(t.dedupe_key, /^transaction:[0-9a-f]{64}$/);
    }
    assert.deepEqual(JSON.parse(tx[0].locator), { row: 2 });
    assert.deepEqual(JSON.parse(tx[1].locator), { row: 3 });

    const accts = await all(s.db, 'SELECT * FROM accounts');
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
    assert.ok(!(await storeText(s.db)).includes('9911227766'), 'the full account number is stored nowhere');
  }));

  test('bank activity CSV: transactions, running balances, Chase plus mask account, balance figure', async () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'chase-activity');
    assert.equal(r.sourceKind, 'bank_csv');
    assert.equal(inserted(r, 'transaction'), 3);
    assert.equal(inserted(r, 'balance'), 2);
    assert.equal(r.counts.queued, 2, 'owner and kind questions');
    const a = await one(s.db, 'SELECT * FROM accounts');
    assert.equal(a.inst, 'Chase');
    assert.equal(a.mask, '7766');
    assert.equal(a.name, 'Chase 7766');
    assert.equal(a.kind, null);
    assert.deepEqual((await all(s.db, 'SELECT amount FROM transactions ORDER BY date')).map((t) => t.amount), [-42.35, 900.5, -10]);
    const bal = await all(s.db, 'SELECT * FROM balances ORDER BY date');
    assert.deepEqual(bal.map((b) => [b.date, b.amount]), [['2032-02-29', 1400.25], ['2032-03-01', 2300.75]]);
    assert.ok(bal.every((b) => b.file_id === r.fileId && b.parser === 'chase-activity' && b.dedupe_key));
    assert.equal(a.fig_key, `acct.${a.id}.balance`);
    const fig = await one(s.db, 'SELECT * FROM figures WHERE key = ?', a.fig_key);
    assert.equal(fig.v, 2300.75, 'latest balance');
    assert.equal(fig.kind, 'a');
    assert.equal(fig.src, `ing:chase-activity:${a.id}`);
    assert.equal((await one(s.db, 'SELECT * FROM sources WHERE id = ?', fig.src)).kind, 'bank_csv');
    assert.deepEqual((await items(s.db, 'account_owner')).map((i) => i.subject), [a.id]);
    assert.deepEqual((await items(s.db, 'account_kind')).map((i) => i.subject), [a.id]);
  }));

  test('positions.csv: two positions on a masked account and a holdings total figure', async () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('positions.csv', 'text/csv'), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'brokerage-positions');
    assert.equal(inserted(r, 'position'), 2);
    assert.deepEqual(r.counts.warningCodes, { pending_activity: 1, invalid_position: 1 });
    const a = await one(s.db, 'SELECT * FROM accounts');
    assert.equal(a.mask, '5544');
    assert.equal(a.name, 'Long term');
    const pos = await all(s.db, 'SELECT * FROM positions ORDER BY symbol');
    assert.deepEqual(pos.map((p) => [p.symbol, p.as_of, p.quantity, p.price, p.value]), [['CASH', '2032-03-05', 125.75, 1, 125.75], ['DEMO', '2032-03-05', 3.125, 24, 75]]);
    assert.equal(pos.find((p) => p.symbol === 'DEMO').cost_basis, 65.25);
    assert.ok(pos.every((p) => p.account_id === a.id && p.file_id === r.fileId && p.dedupe_key));
    const fig = await one(s.db, 'SELECT * FROM figures WHERE key = ?', `acct.${a.id}.balance`);
    assert.equal(fig.v, 200.75, 'positions total at the latest as-of');
    assert.ok(!(await storeText(s.db)).includes('8877665544'), 'no full brokerage account number');
  }));






});

describe('identity, occurrence and source scope', () => {
  test('an unnamed, unmasked account is scoped by locator.source; masks keep at most 4 digits', async () => withStore(async (s) => {
    const file = aggregatorFile('unnamed.csv', [
      { date: '2032-03-04', account: '', number: '', amount: '12.00', description: 'Synthetic unnamed row' },
    ]);
    const r = await P.ingestFile(s.db, file, s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    const t = await one(s.db, 'SELECT * FROM transactions');
    const loc = JSON.parse(t.locator);
    assert.equal(loc.row, 2);
    assert.match(loc.source, /^[0-9a-f]{64}$/);
    const a = await one(s.db, 'SELECT * FROM accounts');
    assert.equal(a.mask, null);
    for (const acct of await all(s.db, 'SELECT mask FROM accounts')) assert.ok(acct.mask === null || /^\d{4}$/.test(acct.mask));
  }));

  test('repeated identical postings in one export keep distinct occurrences', async () => withStore(async (s) => {
    const row = { date: '2032-03-06', amount: '3.50', description: 'Synthetic coffee' };
    const r = await P.ingestFile(s.db, aggregatorFile('repeats.csv', [row, row, { ...row, date: '2032-03-07' }]), s.opts(await offEngine()));
    assert.equal(inserted(r, 'transaction'), 3);
    assert.equal(r.counts.duplicates, 0);
    assert.deepEqual((await all(s.db, 'SELECT occurrence FROM transactions ORDER BY date, occurrence')).map((t) => t.occurrence), [1, 2, 1]);
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

  test('overlapping aggregator dumps: second import counts the overlap as duplicates', async () => withStore(async (s) => {
    const off = await offEngine();
    const a = await P.ingestFile(s.db, aggregatorFile('dump-a.csv', rowsA), s.opts(off));
    assert.equal(inserted(a, 'transaction'), 4);
    const b = await P.ingestFile(s.db, aggregatorFile('dump-b.csv', rowsB), s.opts(off));
    assert.equal(b.status, 'imported');
    assert.equal(inserted(b, 'transaction'), 2);
    assert.equal(b.counts.duplicates, 2, 'duplicates equal the overlap');
    assert.equal(await count(s.db, 'transactions'), 6);
    assert.equal(await count(s.db, 'accounts'), 1);
    assert.equal((await items(s.db, 'near_duplicate')).length, 0);

    const again = await P.ingestFile(s.db, aggregatorFile('dump-b.csv', rowsB), s.opts(off));
    assert.equal(again.status, 'duplicate');
    assert.equal(again.duplicateOf, b.fileId);
    assert.equal(await count(s.db, 'transactions'), 6, 'totals unchanged');
    assert.equal(await count(s.db, 'files'), 2);
  }));

  test('the same postings from the bank export and the aggregator dedupe across formats', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(off));
    const r = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
    assert.equal(r.status, 'imported');
    assert.equal(inserted(r, 'transaction'), 0);
    assert.equal(r.counts.duplicates, 2);
    assert.equal(await count(s.db, 'transactions'), 3);
    assert.equal(await count(s.db, 'accounts'), 1, 'accounts upsert by institution and mask');
  }));

  test('one request: same bytes twice is a duplicate; same name with different bytes stores both', async () => withStore(async (s) => {
    const first = aggregatorFile('export.csv', [{ date: '2032-03-02', amount: '7.25', description: 'Synthetic first' }]);
    const other = aggregatorFile('export.csv', [{ date: '2032-03-03', amount: '8.75', description: 'Synthetic second' }]);
    const { results } = await P.ingestFiles(s.db, [first, { ...first }, other], s.opts(await offEngine()));
    assert.deepEqual(results.map((x) => x.status), ['imported', 'duplicate', 'imported']);
    assert.equal(results[1].duplicateOf, results[0].fileId);
    assert.notEqual(results[2].fileId, results[0].fileId);
    assert.equal(await count(s.db, 'files'), 2);
    assert.equal(await count(s.db, 'transactions'), 2);
  }));
});

describe('unsupported inputs', () => {
  test('an empty file, non UTF-8 text and a corrupt workbook are unsupported; a valid CSV beside them imports', async () => withStore(async (s) => {
    const eng = await fakeEngine([]);
    const empty = await P.ingestFile(s.db, { name: 'empty.csv', bytes: new Uint8Array(0) }, s.opts(eng));
    assert.equal(empty.status, 'unsupported');
    const binary = await P.ingestFile(s.db, { name: 'scan.txt', bytes: new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x81, 0xc3]) }, s.opts(eng));
    assert.equal(binary.status, 'unsupported');
    const corrupt = await P.ingestFile(s.db, fixture('corrupt-archive.xlsx'), s.opts(eng));
    assert.equal(corrupt.status, 'unsupported');
    assert.equal((await one(s.db, 'SELECT status FROM files WHERE id = ?', corrupt.fileId)).status, 'unsupported');
    const ok = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(eng));
    assert.equal(ok.status, 'imported');
  }));
});

describe('interrupted ingest', () => {
  const csv = () => aggregatorFile('export.csv', [
    { date: '2032-03-02', amount: '7.25', description: 'Synthetic first' },
    { date: '2032-03-03', amount: '8.75', description: 'Synthetic second' },
  ]);

  // The state a restart mid-parse leaves: the encrypted bytes and a 'pending' files row, no rows.
  async function interrupted(s, file) {
    const hash = sha256(file.bytes);
    const fileId = fileIdOf(file.bytes);
    const storedPath = await V.storeFile({ vault: await s.household.vault(), id: fileId, bytes: file.bytes, purpose: 'upload' });
    await s.db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(fileId, file.name, file.mime ?? null, file.bytes.length, hash, NOW, storedPath);
    return fileId;
  }

  test('re-uploading the same bytes of a pending file that is not in flight re-routes it and imports its rows', async () => withStore(async (s) => {
    const file = csv();
    const fileId = await interrupted(s, file);
    assert.equal(await count(s.db, 'transactions'), 0);
    const r = await P.ingestFile(s.db, { ...file }, s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.fileId, fileId);
    assert.equal(inserted(r, 'transaction'), 2);
    assert.equal(await count(s.db, 'transactions'), 2);
    assert.equal(await count(s.db, 'files'), 1);
    assert.equal((await one(s.db, 'SELECT status FROM files WHERE id = ?', fileId)).status, 'imported');
  }));

  test('retryFile accepts a pending file that is not in flight and imports it', async () => withStore(async (s) => {
    const file = csv();
    const fileId = await interrupted(s, file);
    const r = await P.retryFile(s.db, fileId, s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    assert.equal(r.fileId, fileId);
    assert.equal(await count(s.db, 'transactions'), 2);
    assert.equal((await one(s.db, 'SELECT status FROM files WHERE id = ?', fileId)).status, 'imported');
  }));

  test('two concurrent uploads of identical bytes import once and the other is a duplicate', async () => withStore(async (s) => {
    const file = csv();
    const eng = await offEngine();
    const results = await Promise.all([
      P.ingestFile(s.db, { ...file }, s.opts(eng)),
      P.ingestFile(s.db, { ...file }, s.opts(eng)),
    ]);
    assert.deepEqual(results.map((x) => x.status).sort(), ['duplicate', 'imported']);
    assert.equal(await count(s.db, 'files'), 1);
    assert.equal(await count(s.db, 'transactions'), 2);
  }));
});

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
    const sc = await buildScenario(db, { clock: '2032-03-10' });
    const acct = sc.accounts.find((a) => a.mask === '4321');
    assert.ok(acct && acct.fig, 'account has a balance figure');
    return sc.fig[acct.fig].v;
  }

  test('older then newer: the newer period revises the day and archives the old value', async () => withStore(async (s) => {
    const off = await offEngine();
    const a = await P.ingestFile(s.db, older(), s.opts(off));
    const b = await P.ingestFile(s.db, newer(), s.opts(off));
    assert.equal(b.counts.revised, 1);
    assert.deepEqual([await one(s.db, 'SELECT period_from, period_to FROM files WHERE id = ?', b.fileId)].map((f) => [f.period_from, f.period_to]), [['2032-03-05', '2032-03-06']]);
    assert.deepEqual((await all(s.db, 'SELECT date, amount FROM balances ORDER BY date')).map((x) => [x.date, x.amount]), [['2032-03-01', 990], ['2032-03-05', 965]]);
    const sup = await all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'balances'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'revised');
    assert.equal(sup[0].file_id, a.fileId);
    assert.equal(JSON.parse(sup[0].row).amount, 970);
    assert.equal((await one(s.db, "SELECT file_id FROM balances WHERE date = '2032-03-05'")).file_id, b.fileId, 'provenance follows the revision');
    assert.equal(await figureValue(s.db), 965);
  }));

  test('newer then older: the stored newer value stays and the older snapshot is archived', async () => withStore(async (s) => {
    const off = await offEngine();
    const b = await P.ingestFile(s.db, newer(), s.opts(off));
    const a = await P.ingestFile(s.db, older(), s.opts(off));
    assert.equal(a.counts.revised, 0);
    assert.ok(a.counts.duplicates >= 2, 'the shared transaction and the older balance count as duplicates');
    assert.deepEqual((await all(s.db, 'SELECT date, amount FROM balances ORDER BY date')).map((x) => [x.date, x.amount]), [['2032-03-01', 990], ['2032-03-05', 965]]);
    assert.equal((await one(s.db, "SELECT file_id FROM balances WHERE date = '2032-03-05'")).file_id, b.fileId);
    const sup = await all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'balances'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'older_snapshot');
    assert.equal(JSON.parse(sup[0].row).amount, 970);
    assert.equal(await figureValue(s.db), 965);
  }));

  test('the same balance again is a plain duplicate', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, older(), s.opts(off));
    const again = await P.ingestFile(s.db, activityFile('Chase4321_Activity_copy.csv', [{ date: '03/05/2032', amount: '-20.00', balance: '970.00', description: 'Synthetic card' }]), s.opts(off));
    assert.equal(again.counts.revised, 0);
    assert.equal(again.counts.duplicates, 2);
    assert.equal(await count(s.db, 'superseded_rows', "reason != 'duplicate_cross_format'"), 0);
  }));
});

// R4: workbook coverage decides which stored rows a later workbook replaces.
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
    test(`order ${label}: stored value is 100 from B`, async () => withStore(async (s) => {
      const off = await offEngine();
      const ids = {};
      for (const make of files) {
        const f = make();
        const r = await P.ingestFile(s.db, f, s.opts(off));
        assert.equal(r.status, 'imported');
        ids[f.name.slice(-5, -4)] = r.fileId;
      }
      const bal = await all(s.db, "SELECT * FROM balances WHERE date = '2032-03-05'");
      assert.equal(bal.length, 1);
      assert.equal(bal[0].amount, 100);
      assert.equal(bal[0].file_id, ids.B, 'authority sits with the newest period');
      assert.ok((await all(s.db, "SELECT row FROM superseded_rows WHERE table_name = 'balances'")).every((x) => [100, 200].includes(JSON.parse(x.row).amount)));
    }));
  }
});

// R13: positions follow the balance slot policy (slot = account, as_of, symbol).
describe('position revisions', () => {
  const rowsA = [{ symbol: 'EXMPL', quantity: '10', price: '20.00', value: '200.00' }, { symbol: 'OTHR', quantity: '5', price: '10.00', value: '50.00' }];
  const rowsB = [{ symbol: 'EXMPL', quantity: '10', price: '21.00', value: '210.00' }, { symbol: 'OTHR', quantity: '5', price: '10.00', value: '50.00' }];

  test('a corrected positions CSV for the same day revises the changed holding', async () => withStore(async (s) => {
    const off = await offEngine();
    const a = await P.ingestFile(s.db, positionsFile('positions-a.csv', rowsA), s.opts(off));
    const b = await P.ingestFile(s.db, positionsFile('positions-corrected.csv', rowsB), s.opts(off));
    assert.equal(b.counts.revised, 1);
    assert.equal(b.counts.duplicates, 1);
    assert.equal(await count(s.db, 'positions'), 2);
    const ex = await one(s.db, "SELECT * FROM positions WHERE symbol = 'EXMPL'");
    assert.deepEqual([ex.price, ex.value, ex.file_id], [21, 210, b.fileId]);
    const sup = await all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'positions'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].reason, 'revised');
    assert.equal(sup[0].file_id, a.fileId);
    assert.equal(JSON.parse(sup[0].row).value, 200);
    const acct = await one(s.db, "SELECT * FROM accounts WHERE mask = '2222'");
    assert.equal((await one(s.db, 'SELECT v FROM figures WHERE key = ?', `acct.${acct.id}.balance`)).v, 260, 'holdings total follows the revision');
  }));


});

// Review finding F1: an unreadable amount cell (formula without a cached value, or text) must not
// remove or partially overwrite the active rows of its slot. A readable revision still removes.
describe('bounded parsing (D1)', () => {
  let FM;
  let CHASE;
  before(async () => {
    FM = await src('src/ingest/format.mjs');
    CHASE = await src('src/ingest/parsers/chase-activity.mjs');
  });

  const REQUIRED = ['details', 'posting date', 'description', 'amount', 'type', 'balance', 'check or slip #'];
  // About 3 MB of single-character cells in three columns: 500000 rows, past the row limit.
  const wideCsv = () => textFile('single-char-export.csv', 'a,b,c\n' + 'x,y,z\n'.repeat(500000), 'text/csv');
  const isLimit = (e) => e instanceof FM.LimitError && e.code === 'limit_exceeded';

  async function assertTooLarge(s, file, r) {
    assert.equal(r.status, 'too_large');
    assert.equal(r.counts.warnings, 1);
    assert.deepEqual(r.counts.warningCodes, { limit_exceeded: 1 });
    const f = await one(s.db, 'SELECT * FROM files WHERE id = ?', r.fileId);
    assert.equal(f.status, 'too_large');
    assert.equal(f.note, 'limit_exceeded');
    assert.deepEqual(JSON.parse(f.counts).warningCodes, { limit_exceeded: 1 });
    const back = await V.readStoredFile({ vault: await s.household.vault(), id: r.fileId, storedPath: f.stored_path, purpose: 'upload' });
    assert.ok(Buffer.from(back).equals(Buffer.from(file.bytes)), 'the encrypted bytes are kept');
    for (const table of ['transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents']) assert.equal(await count(s.db, table), 0, `${table} untouched`);
  }

  test('LIMITS, LimitError and too_large are exported with the planned values', () => {
    assert.deepEqual({ ...FM.LIMITS }, { rows: 200000, columns: 512, cells: 2000000, cellChars: 32768 });
    const e = new FM.LimitError('synthetic');
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'limit_exceeded');
    assert.ok(P.STATUSES.includes('too_large'));
  });

  test('XLSX_LIMITS is exported as a lower cell budget for xlsx', () => {
    assert.deepEqual({ ...FM.XLSX_LIMITS }, { cells: 250000 });
  });

  test('csv() throws LimitError past the row limit and chase parse lets it propagate', () => {
    const file = wideCsv();
    assert.throws(() => FM.csv(file), isLimit);
    const bank = textFile('Chase4321_Activity_big.csv', `${REQUIRED.join(',')}\n` + 'x,x,x,x,x,x,x\n'.repeat(200001), 'text/csv');
    assert.throws(() => CHASE.parse(bank), isLimit, 'not swallowed into malformed_csv');
  });

  test('csvHeader and csvScore read only the header: a body malformed beyond 64 KiB still scores 0.98', () => {
    const head = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n';
    const body = 'DEBIT,03/01/2032,Synthetic header-only row,-1.00,OTHER,,\n'.repeat(100000);
    const bytes = Buffer.concat([Buffer.from(head + body), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('\n')]);
    const file = { name: 'Chase4321_Activity_huge.csv', bytes: new Uint8Array(bytes), mime: 'text/csv' };
    assert.deepEqual(FM.csvHeader(file), REQUIRED);
    const started = Date.now();
    assert.equal(FM.csvScore(file, REQUIRED), 0.98, 'sniffing never decodes or parses the body');
    assert.equal(CHASE.sniff(file), 0.98);
    assert.ok(Date.now() - started < 1000, 'sniffing a 6 MB file is header-only');
  });

  test('a 3 MB CSV of single-character cells is too_large; a normal fixture still imports after it', async () => withStore(async (s) => {
    const off = await offEngine();
    const file = wideCsv();
    const r = await P.ingestFile(s.db, file, s.opts(off));
    await assertTooLarge(s, file, r);
    const ok = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
    assert.equal(ok.status, 'imported');
    assert.equal(inserted(ok, 'transaction'), 2);
  }));

  test('a bank-format CSV past the row limit is too_large through its parser, not imported with warnings', async () => withStore(async (s) => {
    const file = textFile('Chase4321_Activity_rows.csv', `${REQUIRED.join(',')}\n` + 'x,x,x,x,x,x,x\n'.repeat(200001), 'text/csv');
    const r = await P.ingestFile(s.db, file, s.opts(await offEngine()));
    await assertTooLarge(s, file, r);
  }));

  test('a header wider than the column limit is too_large at sniff', async () => withStore(async (s) => {
    const cols = Array.from({ length: 600 }, (_, i) => `c${i}`);
    const file = textFile('wide-header.csv', `${cols.join(',')}\n${cols.map(() => 'x').join(',')}\n`, 'text/csv');
    const r = await P.ingestFile(s.db, file, s.opts(await offEngine()));
    await assertTooLarge(s, file, r);
  }));

  test('an xlsx whose single sheet holds more cells than the cell limit is too_large', async () => withStore(async (s) => {
    const empty = { empty: true };
    const row = new Array(512).fill(empty);
    const rows = Array.from({ length: 3907 }, () => row); // 2000384 cells, 512 columns, 3907 rows
    const file = { name: 'many-cells.xlsx', bytes: new Uint8Array(writeXlsx([{ name: 'Cells', rows }])) };
    const r = await P.ingestFile(s.db, file, s.opts(await offEngine()));
    await assertTooLarge(s, file, r);
  }));

  // G3: the bounded sniff on a valid body: the header comes back without reading the rest.
  test('csvHeader returns the header of a file whose valid body exceeds the cell limit, without throwing', () => {
    const head = `${REQUIRED.join(',')}\n`;
    const body = 'DEBIT,03/01/2032,Synthetic row,-1.00,OTHER,,\n'.repeat(300000); // 2100000 cells
    const file = textFile('Chase4321_Activity_valid_huge.csv', head + body, 'text/csv');
    assert.deepEqual(FM.csvHeader(file), REQUIRED);
    assert.equal(FM.csvScore(file, REQUIRED), 0.98);
    assert.throws(() => FM.csv(file), isLimit, 'the whole file is still past the limit');
  });
});

// D2: the notes document row never holds the note text; extraction reads it from the vault.
describe('no silently dropped transactions (D3)', () => {
  const normalize = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const row = (description, extra = {}) => ({ date: '03/09/2032', amount: '-54.21', balance: '', description, ...extra });

  test('two uploads of one bank format, same day and amount, different descriptions: both rows and one question', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, activityFile('Chase4321_Activity_A.csv', [row('SYNTH GROCERY NORTH')]), s.opts(off));
    const b = await P.ingestFile(s.db, activityFile('Chase4321_Activity_B.csv', [row('SYNTH PHARMACY SOUTH')]), s.opts(off));
    assert.equal(inserted(b, 'transaction'), 1);
    assert.equal(b.counts.duplicates, 0);
    const tx = await all(s.db, 'SELECT * FROM transactions ORDER BY id');
    assert.deepEqual(tx.map((t) => [t.date, t.amount, t.description]), [['2032-03-09', -54.21, 'SYNTH GROCERY NORTH'], ['2032-03-09', -54.21, 'SYNTH PHARMACY SOUTH']]);
    assert.equal(tx[1].dedupe_key, `${tx[0].dedupe_key}:d:${sha256(normalize('SYNTH PHARMACY SOUTH')).slice(0, 16)}`);
    const q = await items(s.db, 'near_duplicate');
    assert.equal(q.length, 1);
    assert.equal(q[0].subject, tx.map((t) => t.dedupe_key).sort().join('|'));
  }));

  test('identical descriptions in two uploads of one format are deduped', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, activityFile('Chase4321_Activity_A.csv', [row('SYNTH GROCERY NORTH')]), s.opts(off));
    const b = await P.ingestFile(s.db, activityFile('Chase4321_Activity_B.csv', [row('Synth Grocery  North')]), s.opts(off));
    assert.equal(inserted(b, 'transaction'), 0);
    assert.equal(b.counts.duplicates, 1);
    assert.equal(await count(s.db, 'transactions'), 1);
    assert.equal((await items(s.db, 'near_duplicate')).length, 0);
  }));

  test('aggregator plus bank overlap still dedupes and counts the differing description as crossFormat', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(off));
    const r = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
    assert.equal(inserted(r, 'transaction'), 0);
    assert.equal(r.counts.duplicates, 2);
    assert.equal(r.counts.crossFormat, 1, 'EXAMPLE SHOP CARD 9988 against EXAMPLE SHOP, PURCHASE');
    assert.equal(await count(s.db, 'transactions'), 3);
    assert.equal((await items(s.db, 'near_duplicate')).length, 0);
  }));

  test('bank rows with a check number dedupe by it even when the posting date differs', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, activityFile('Chase4321_Activity_A.csv', [row('CHECK 1042', { date: '03/01/2032', amount: '-125.00', check: '1042' })]), s.opts(off));
    const b = await P.ingestFile(s.db, activityFile('Chase4321_Activity_B.csv', [row('CHECK 1042', { date: '03/04/2032', amount: '-125.00', check: '1042' })]), s.opts(off));
    assert.equal(inserted(b, 'transaction'), 0);
    assert.equal(b.counts.duplicates, 1);
    const tx = await all(s.db, 'SELECT * FROM transactions');
    assert.deepEqual(tx.map((t) => [t.date, t.amount, t.external_id]), [['2032-03-01', -125, '1042']]);
    assert.equal((await items(s.db, 'near_duplicate')).length, 0);
  }));

  // G1: across formats a key collision is a duplicate only with evidence: equal normalized
  // descriptions, or a shared distinctive word (3 or more letters, minus the stoplist).
  const bankFile = (name, description) => activityFile(name, [row(description)]);
  const aggFile = (name, description) => aggregatorFile(name, [{ date: '2032-03-09', amount: '54.21', description, number: '9999994321', inst: 'Chase', account: 'Synthetic checking' }]);
  const unrelatedPairs = [
    ['no shared word', 'NORTHSIDE GROCERY', 'Riverside Pharmacy'],
    ['only stoplist words shared', 'DEBIT CARD PURCHASE NORTHSIDE GROCERY', 'Card purchase from Riverside Pharmacy'],
  ];
  for (const [what, bankDesc, aggDesc] of unrelatedPairs) {
    for (const order of ['bank first', 'aggregator first']) {
      test(`G1: unrelated same-day same-amount bank and aggregator rows (${what}, ${order}) are both kept with one question`, async () => withStore(async (s) => {
        const off = await offEngine();
        const files = [bankFile('Chase4321_Activity_G1.csv', bankDesc), aggFile('aggregator-g1.csv', aggDesc)];
        if (order === 'aggregator first') files.reverse();
        await P.ingestFile(s.db, files[0], s.opts(off));
        const second = await P.ingestFile(s.db, files[1], s.opts(off));
        assert.equal(await count(s.db, 'accounts'), 1, 'one account for both formats');
        assert.equal(second.counts.duplicates, 0);
        assert.equal(inserted(second, 'transaction'), 1);
        const tx = await all(s.db, 'SELECT * FROM transactions ORDER BY id');
        assert.deepEqual(tx.map((t) => [t.date, t.amount]), [['2032-03-09', -54.21], ['2032-03-09', -54.21]]);
        assert.equal(tx[1].dedupe_key, `${tx[0].dedupe_key}:d:${sha256(normalize(tx[1].description)).slice(0, 16)}`, 'kept under its alt key');
        const q = await items(s.db, 'near_duplicate');
        assert.equal(q.length, 1);
        assert.equal(q[0].subject, tx.map((t) => t.dedupe_key).sort().join('|'));
      }));
    }
  }

  test('G1: the aggregator plus bank overlap fixture still dedupes with the aggregator imported first', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
    const r = await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(off));
    assert.equal(r.counts.duplicates, 2);
    assert.equal(await count(s.db, 'transactions'), 3);
    assert.equal((await items(s.db, 'near_duplicate')).length, 0);
  }));

  // G2: a duplicate_confirmed tombstone stores the archived row's normalized description; a later
  // colliding row is skipped only when it matches the tombstone under G1's evidence rule.
  const coffeeA = (name, extra = []) => activityFile(name, [{ date: '03/09/2032', amount: '-4.50', balance: '', description: 'HARBOR ESPRESSO BAR' }, ...extra]);
  const coffeeB = (name, extra = []) => activityFile(name, [{ date: '03/10/2032', amount: '-4.50', balance: '', description: 'MORNING BREW COFFEE' }, ...extra]);
  const lunch = (name, extra = []) => activityFile(name, [{ date: '03/10/2032', amount: '-4.50', balance: '', description: 'SUNNY DELI LUNCH' }, ...extra]);
  const filler = (n) => ({ date: '03/25/2032', amount: `-${70 + n}.00`, balance: '', description: `SYNTH FILLER ${n}` });
  const pendingNear = async (db) => await all(db, "SELECT * FROM confirm_items WHERE kind = 'near_duplicate' AND status = 'pending' ORDER BY id");

  async function confirmSecondCoffee(s, off) {
    await P.ingestFile(s.db, coffeeA('Chase4321_Activity_coffee_A.csv'), s.opts(off));
    await P.ingestFile(s.db, coffeeB('Chase4321_Activity_coffee_B.csv'), s.opts(off));
    const [q] = await pendingNear(s.db);
    assert.ok(q, 'the second coffee is asked about');
    C.answer(s.db, q.id, 'same', { now: NOW });
    const tomb = await all(s.db, "SELECT * FROM superseded_rows WHERE reason = 'duplicate_confirmed'");
    assert.equal(tomb.length, 1);
    assert.ok(JSON.stringify(tomb[0]).includes(normalize('MORNING BREW COFFEE')), 'the tombstone stores the normalized description');
    return tomb[0].dedupe_key;
  }

  for (const answer of ['same', 'different']) {
    test(`G2: after a confirmed duplicate, a distinct same-key lunch is kept and asked about; answered ${answer}, re-imports ask nothing new`, async () => withStore(async (s) => {
      const off = await offEngine();
      const tombKey = await confirmSecondCoffee(s, off);
      const r = await P.ingestFile(s.db, lunch('Chase4321_Activity_lunch.csv'), s.opts(off));
      assert.equal(r.counts.duplicates, 0, 'the lunch is not the confirmed coffee');
      const kept = await one(s.db, "SELECT * FROM transactions WHERE description = 'SUNNY DELI LUNCH'");
      assert.ok(kept, 'the lunch is stored');
      assert.equal(kept.dedupe_key, `${tombKey}:d:${sha256(normalize('SUNNY DELI LUNCH')).slice(0, 16)}`, 'under its alt key');
      const asked = await pendingNear(s.db);
      assert.equal(asked.length, 1, 'the lunch is asked about');
      assert.ok(asked[0].subject.split('|').includes(kept.dedupe_key));

      C.answer(s.db, asked[0].id, answer, { now: NOW });
      const before = await count(s.db, 'transactions');
      const questions = await count(s.db, 'confirm_items', "kind = 'near_duplicate'");
      for (const [i, file] of [coffeeB('Chase4321_Activity_coffee_B2.csv', [filler(1)]), lunch('Chase4321_Activity_lunch_2.csv', [filler(2)])].entries()) {
        const again = await P.ingestFile(s.db, file, s.opts(off));
        assert.equal(again.counts.duplicates, 1, `re-import ${i + 1} skips the known posting`);
        assert.equal(inserted(again, 'transaction'), 1, 'only the filler row lands');
      }
      assert.equal(await count(s.db, 'transactions'), before + 2);
      assert.equal(await count(s.db, 'confirm_items', "kind = 'near_duplicate'"), questions, 'no new question');
      assert.equal((await pendingNear(s.db)).length, 0);
    }));
  }

  // C2: a cross-format duplicate's own observation (parser plus normalized description) is kept, so a
  // later same-parser row with the same key and another description is a second transaction under
  // the same-format rule, not a silent cross-format drop.
  const shopAgg = () => aggregatorFile('aggregator-c2.csv', [{ date: '2032-03-09', amount: '25.00', description: 'Example Shop', number: '9999990042', inst: 'Chase', account: 'Synthetic checking' }]);
  const shopBank = (name, description, extra = []) => activityFile(name, [{ date: '03/09/2032', amount: '-25.00', balance: '', description }, ...extra]);

  test('C2: aggregator then bank (cross-format duplicate) then a distinct same-key bank row: the third row is kept with one question; re-imports change nothing', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, shopAgg(), s.opts(off));
    const bankA = await P.ingestFile(s.db, shopBank('Chase0042_Activity_C2_A.csv', 'EXAMPLE SHOP 0042'), s.opts(off));
    assert.equal(bankA.counts.duplicates, 1, 'the bank row is the aggregator posting');
    assert.equal(await count(s.db, 'transactions'), 1);
    assert.equal(await count(s.db, 'accounts'), 1, 'one account for both formats');
    const [aggRow] = await all(s.db, 'SELECT * FROM transactions');

    const bankB = await P.ingestFile(s.db, shopBank('Chase0042_Activity_C2_B.csv', 'EXAMPLE SHOP 0043'), s.opts(off));
    assert.equal(bankB.counts.duplicates, 0, 'EXAMPLE SHOP 0043 is not the EXAMPLE SHOP 0042 bank posting');
    assert.equal(inserted(bankB, 'transaction'), 1);
    assert.equal(await count(s.db, 'transactions'), 2);
    const kept = await one(s.db, "SELECT * FROM transactions WHERE description = 'EXAMPLE SHOP 0043'");
    assert.ok(kept, 'the third row is stored');
    assert.equal(kept.dedupe_key, `${aggRow.dedupe_key}:d:${sha256(normalize('EXAMPLE SHOP 0043')).slice(0, 16)}`, 'under its alt key');
    const q = await items(s.db, 'near_duplicate');
    assert.equal(q.length, 1, 'exactly one question');
    assert.ok(q[0].subject.split('|').includes(kept.dedupe_key), 'the question is about the third row');

    const before = await count(s.db, 'transactions');
    const same = await P.ingestFile(s.db, shopBank('Chase0042_Activity_C2_A.csv', 'EXAMPLE SHOP 0042'), s.opts(off));
    assert.equal(same.status, 'duplicate', 'identical bytes are a duplicate file');
    for (const [i, file] of [
      shopBank('Chase0042_Activity_C2_A2.csv', 'EXAMPLE SHOP 0042', [filler(1)]),
      shopBank('Chase0042_Activity_C2_B2.csv', 'EXAMPLE SHOP 0043', [filler(2)]),
    ].entries()) {
      const again = await P.ingestFile(s.db, file, s.opts(off));
      assert.equal(again.counts.duplicates, 1, `re-import ${i + 1} skips the known posting`);
      assert.equal(inserted(again, 'transaction'), 1, 'only the filler row lands');
    }
    assert.equal(await count(s.db, 'transactions'), before + 2);
    assert.equal(await count(s.db, 'transactions', "description LIKE 'EXAMPLE SHOP%' OR description = 'Example Shop'"), 2, 'no shop row added');
    assert.equal((await items(s.db, 'near_duplicate')).length, 1, 'no new question');
  }));

  // C3: the external-id key carries the signed amount, so a check and its return in separate
  // uploads are two rows; the same check at the same amount still dedupes.
  const check = (date, amount) => ({ date, amount, balance: '', description: 'CHECK 1042', check: '1042' });

  test('C3: a check and its return in separate uploads share an id but not an amount: both rows are kept; the same id and amount still dedupes', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, activityFile('Chase0042_Activity_C3_A.csv', [check('03/01/2032', '-125.00')]), s.opts(off));
    const b = await P.ingestFile(s.db, activityFile('Chase0042_Activity_C3_B.csv', [check('03/04/2032', '125.00')]), s.opts(off));
    assert.equal(b.counts.duplicates, 0, 'the return is not the check');
    assert.equal(inserted(b, 'transaction'), 1);
    const tx = await all(s.db, 'SELECT * FROM transactions ORDER BY id');
    assert.deepEqual(tx.map((t) => [t.date, t.amount, t.external_id]), [['2032-03-01', -125, '1042'], ['2032-03-04', 125, '1042']]);
    assert.notEqual(tx[0].dedupe_key, tx[1].dedupe_key);

    for (const [name, row] of [['Chase0042_Activity_C3_C.csv', check('03/02/2032', '-125.00')], ['Chase0042_Activity_C3_D.csv', check('03/05/2032', '125.00')]]) {
      const again = await P.ingestFile(s.db, activityFile(name, [row]), s.opts(off));
      assert.equal(again.counts.duplicates, 1, `${row.amount} with id 1042 is already stored`);
      assert.equal(inserted(again, 'transaction'), 0);
    }
    assert.equal(await count(s.db, 'transactions'), 2);
  }));

  // E3: an external-id key collision kept under the alt key (other description) is asked about
  // whatever the distance between the dates.
  test('E3: same check id and amount 9 days apart with different descriptions: both rows are kept with exactly one question', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, activityFile('Chase0042_Activity_E3_A.csv', [{ ...check('03/01/2032', '-125.00'), description: 'CHECK 1042 SYNTH LANDLORD' }]), s.opts(off));
    const b = await P.ingestFile(s.db, activityFile('Chase0042_Activity_E3_B.csv', [{ ...check('03/10/2032', '-125.00'), description: 'CHECK 1042 SYNTH PLUMBER' }]), s.opts(off));
    assert.equal(b.counts.duplicates, 0, 'another description is another transaction');
    assert.equal(inserted(b, 'transaction'), 1);
    const tx = await all(s.db, 'SELECT * FROM transactions ORDER BY id');
    assert.deepEqual(tx.map((t) => [t.date, t.amount, t.external_id, t.description]), [
      ['2032-03-01', -125, '1042', 'CHECK 1042 SYNTH LANDLORD'],
      ['2032-03-10', -125, '1042', 'CHECK 1042 SYNTH PLUMBER'],
    ]);
    const q = await items(s.db, 'near_duplicate');
    assert.equal(q.length, 1, 'exactly one question');
    assert.equal(q[0].subject, tx.map((t) => t.dedupe_key).sort().join('|'));
  }));

  // F2: a distant key collision whose collided key holds no stored row (its posting was archived as
  // a confirmed or cross-format duplicate) is still asked about, against the surviving posting.
  const checkAgg = () => aggregatorFile('aggregator-f2.csv', [{ date: '2032-03-01', amount: '125.00', description: 'Check 1042', number: '9999990042', inst: 'Chase', account: 'Synthetic checking' }]);
  const checkBank = (name, date, description, extra = []) => activityFile(name, [{ ...check(date, '-125.00'), description }, ...extra]);
  const PLUMBER = 'CHECK 1042 SYNTH PLUMBER';
  // A novel export with a reference column, mapped with externalId; the mask comes from the file name.
  const LEDGER_HEADERS = ['posted on', 'memo text', 'value usd', 'ref no', 'bank label'];
  const LEDGER_MAPPING = { target: 'transaction', date: 'posted on', amount: 'value usd', description: 'memo text', externalId: 'ref no', institution: 'bank label', amountSign: 'as_is', dateOrder: 'ymd' };
  const ledgerFile = (name, date, description) => textFile(name, `${LEDGER_HEADERS.join(',')}\n${date},${description},-125.00,1042,Chase\n`, 'text/csv');

  // Aggregator March 1, bank check March 2 asked as near-duplicate and answered same: the bank row's
  // key now holds only its duplicate_confirmed tombstone. Returns the aggregator row.
  async function confirmCheckIntoAggregator(s, off) {
    await P.ingestFile(s.db, checkAgg(), s.opts(off));
    await P.ingestFile(s.db, checkBank('Chase0042_Activity_F2_A.csv', '03/02/2032', 'CHECK 1042'), s.opts(off));
    assert.equal(await count(s.db, 'accounts'), 1, 'one account for both formats');
    const [q] = await pendingNear(s.db);
    assert.ok(q, 'the bank check is asked about against the aggregator posting');
    C.answer(s.db, q.id, 'same', { now: NOW });
    assert.equal(await count(s.db, 'superseded_rows', "reason = 'duplicate_confirmed'"), 1);
    const rows = await all(s.db, 'SELECT * FROM transactions');
    assert.deepEqual(rows.map((t) => [t.date, t.amount, t.description]), [['2032-03-01', -125, 'Check 1042']], 'only the aggregator posting is stored');
    return rows[0];
  }

  test('F2: after a confirmed duplicate, the same check id and amount 9 days later with another description is kept with exactly one new question', async () => withStore(async (s) => {
    const off = await offEngine();
    const agg = await confirmCheckIntoAggregator(s, off);
    const tomb = await one(s.db, "SELECT * FROM superseded_rows WHERE reason = 'duplicate_confirmed'");
    const questions = await count(s.db, 'confirm_items', "kind = 'near_duplicate'");
    const r = await P.ingestFile(s.db, checkBank('Chase0042_Activity_F2_B.csv', '03/11/2032', PLUMBER), s.opts(off));
    assert.equal(r.counts.duplicates, 0, 'another description is another transaction');
    assert.equal(inserted(r, 'transaction'), 1);
    const kept = await one(s.db, 'SELECT * FROM transactions WHERE description = ?', PLUMBER);
    assert.ok(kept, 'the March 11 check is stored');
    assert.equal(kept.dedupe_key, `${tomb.dedupe_key}:d:${sha256(normalize(PLUMBER)).slice(0, 16)}`, 'under its alt key');
    assert.equal(await count(s.db, 'confirm_items', "kind = 'near_duplicate'"), questions + 1, 'exactly one new question');
    const asked = await pendingNear(s.db);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].subject, [kept.dedupe_key, agg.dedupe_key].sort().join('|'), 'asked against the surviving aggregator posting');
  }));

  for (const answer of [null, 'same', 'different']) {
    test(`F2: re-importing the March 11 check ${answer ? `after answering ${answer} ` : ''}asks nothing new`, async () => withStore(async (s) => {
      const off = await offEngine();
      await confirmCheckIntoAggregator(s, off);
      await P.ingestFile(s.db, checkBank('Chase0042_Activity_F2_B.csv', '03/11/2032', PLUMBER), s.opts(off));
      const [q] = await pendingNear(s.db);
      assert.ok(q, 'the March 11 check is asked about');
      if (answer) C.answer(s.db, q.id, answer, { now: NOW });
      const before = await count(s.db, 'transactions');
      const questions = await count(s.db, 'confirm_items', "kind = 'near_duplicate'");
      const pending = (await pendingNear(s.db)).length;
      const same = await P.ingestFile(s.db, checkBank('Chase0042_Activity_F2_B.csv', '03/11/2032', PLUMBER), s.opts(off));
      assert.equal(same.status, 'duplicate', 'identical bytes are a duplicate file');
      for (const [i, file] of [
        checkBank('Chase0042_Activity_F2_B2.csv', '03/11/2032', PLUMBER, [filler(1)]),
        checkBank('Chase0042_Activity_F2_B3.csv', '03/12/2032', PLUMBER, [filler(2)]),
      ].entries()) {
        const again = await P.ingestFile(s.db, file, s.opts(off));
        assert.equal(again.counts.duplicates, 1, `re-import ${i + 1} skips the known posting`);
        assert.equal(inserted(again, 'transaction'), 1, 'only the filler row lands');
      }
      assert.equal(await count(s.db, 'transactions'), before + 2);
      assert.equal(await count(s.db, 'confirm_items', "kind = 'near_duplicate'"), questions, 'no new question');
      assert.equal((await pendingNear(s.db)).length, pending);
    }));
  }

  // The aggregator format carries no check number, so a mapped export with a reference column stands
  // in for the second format that dedupes against the bank check by its external id.




  // Review finding H2: survivor links are followed to the active row, not one hop. A (aggregator,
  // March 1), B (bank, March 4, no check number) and C (bank check 1042, March 6): C is confirmed
  // into B, then B into A, so C's tombstone names B, which is itself a tombstone naming A.
  const transferB = () => activityFile('Chase0042_Activity_H2_B.csv', [{ date: '03/04/2032', amount: '-125.00', balance: '', description: 'SYNTH TRANSFER OUT' }]);
  const checkC = () => checkBank('Chase0042_Activity_H2_C.csv', '03/06/2032', 'CHECK 1042');
  const nearBetween = async (db, x, y) => (await pendingNear(db)).find((q) => q.subject === [x, y].sort().join('|'));

  // Returns {a, b, c}: the three stored rows before the confirmations; only A stays active.
  async function confirmChain(s, off) {
    await P.ingestFile(s.db, checkAgg(), s.opts(off));
    await P.ingestFile(s.db, transferB(), s.opts(off));
    await P.ingestFile(s.db, checkC(), s.opts(off));
    assert.equal(await count(s.db, 'accounts'), 1, 'one account for both formats');
    const [a, b, c] = await all(s.db, 'SELECT * FROM transactions ORDER BY id');
    assert.deepEqual([a, b, c].map((t) => [t.date, t.amount, t.external_id]), [['2032-03-01', -125, null], ['2032-03-04', -125, null], ['2032-03-06', -125, '1042']]);
    const ab = await nearBetween(s.db, a.dedupe_key, b.dedupe_key);
    const bc = await nearBetween(s.db, b.dedupe_key, c.dedupe_key);
    assert.ok(ab && bc, 'A and B, and B and C, are asked about');
    assert.equal((await pendingNear(s.db)).length, 2, 'A and C are five days apart: not asked');
    C.answer(s.db, bc.id, 'same', { now: NOW });
    C.answer(s.db, ab.id, 'same', { now: NOW });
    assert.deepEqual((await all(s.db, 'SELECT dedupe_key FROM transactions')).map((t) => t.dedupe_key), [a.dedupe_key], 'only A is stored');
    const tomb = async (key) => (await one(s.db, "SELECT survivor_key FROM superseded_rows WHERE reason = 'duplicate_confirmed' AND dedupe_key = ?", key))?.survivor_key;
    assert.equal(await tomb(c.dedupe_key), b.dedupe_key, "C's tombstone names B");
    assert.equal(await tomb(b.dedupe_key), a.dedupe_key, "B's tombstone names A");
    return { a, b, c };
  }

  test('H2: C confirmed into B, then B into A; check 1042 on March 15 with another description is kept and asked once against A', async () => withStore(async (s) => {
    const off = await offEngine();
    const { a, c } = await confirmChain(s, off);
    const questions = await count(s.db, 'confirm_items', "kind = 'near_duplicate'");
    const r = await P.ingestFile(s.db, checkBank('Chase0042_Activity_H2_D.csv', '03/15/2032', PLUMBER), s.opts(off));
    assert.equal(r.counts.duplicates, 0, 'another description is another transaction');
    assert.equal(inserted(r, 'transaction'), 1);
    const kept = await one(s.db, 'SELECT * FROM transactions WHERE description = ?', PLUMBER);
    assert.equal(kept.dedupe_key, `${c.dedupe_key}:d:${sha256(normalize(PLUMBER)).slice(0, 16)}`, 'under its alt key');
    assert.equal(await count(s.db, 'confirm_items', "kind = 'near_duplicate'"), questions + 1, 'exactly one new question');
    const asked = await pendingNear(s.db);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].subject, [kept.dedupe_key, a.dedupe_key].sort().join('|'), 'asked against A, the end of the survivor chain');
  }));

  test('H2: after the chain, re-importing the March 15 check asks nothing new', async () => withStore(async (s) => {
    const off = await offEngine();
    await confirmChain(s, off);
    await P.ingestFile(s.db, checkBank('Chase0042_Activity_H2_D.csv', '03/15/2032', PLUMBER), s.opts(off));
    const before = await count(s.db, 'transactions');
    const questions = await count(s.db, 'confirm_items', "kind = 'near_duplicate'");
    const again = await P.ingestFile(s.db, checkBank('Chase0042_Activity_H2_D2.csv', '03/15/2032', PLUMBER, [filler(1)]), s.opts(off));
    assert.equal(again.counts.duplicates, 1, 'the March 15 check is already stored');
    assert.equal(inserted(again, 'transaction'), 1, 'only the filler row lands');
    assert.equal(await count(s.db, 'transactions'), before + 1);
    assert.equal(await count(s.db, 'confirm_items', "kind = 'near_duplicate'"), questions, 'no new question');
  }));

  // H2 guard: survivor links are followed boundedly. No sequence of answers builds a cycle (a
  // confirmed duplicate drops the newer stored row, and a tombstoned key is never stored again), so
  // these tests write the superseded_rows links directly. The import runs in a worker thread so a
  // loop fails the test by timeout instead of hanging the runner.
  async function ingestInWorker(s, file, timeoutMs = 10000) {
    const { Worker } = await import('node:worker_threads');
    const { pathToFileURL } = await import('node:url');
    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      (async () => {
        const { openDb } = await import(workerData.dbUrl);
        const { openPlatform } = await import(workerData.platformUrl);
        const { createInstanceSecrets } = await import(workerData.secretsUrl);
        const { createHouseholdContext } = await import(workerData.runtimeUrl);
        const P = await import(workerData.pipelineUrl);
        const db = openDb(workerData.file);
        const platform = openPlatform(workerData.platformFile);
        try {
          const household = createHouseholdContext({
            householdId: workerData.householdId, mode: 'real', db, config: workerData.config, platform,
            secrets: createInstanceSecrets({ config: workerData.config, mode: 'real' }),
          });
          const r = await P.ingestFile(db, { ...workerData.input, bytes: new Uint8Array(workerData.input.bytes) },
            { config: workerData.config, now: workerData.now, household });
          parentPort.postMessage({ ok: true, result: r });
        } catch (error) {
          parentPort.postMessage({ ok: false, error: String(error && error.stack || error) });
        } finally { db.close(); platform.close(); }
      })();`;
    const { ROOT } = await import('../helpers/server.mjs');
    const worker = new Worker(code, {
      eval: true,
      workerData: {
        dbUrl: pathToFileURL(join(ROOT, 'src/store/db.mjs')).href, pipelineUrl: pathToFileURL(join(ROOT, 'src/ingest/pipeline.mjs')).href,
        platformUrl: pathToFileURL(join(ROOT, 'src/platform/db.mjs')).href, secretsUrl: pathToFileURL(join(ROOT, 'src/platform/secrets.mjs')).href,
        runtimeUrl: pathToFileURL(join(ROOT, 'src/platform/runtime.mjs')).href,
        file: s.file, platformFile: s.platformFile, householdId: s.householdId, input: file, config: s.config, now: NOW,
      },
    });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ingest did not finish within ${timeoutMs} ms (survivor loop)`)), timeoutMs);
        worker.once('message', (m) => { clearTimeout(timer); if (m.ok) resolve(m.result); else reject(new Error(m.error)); });
        worker.once('error', (e) => { clearTimeout(timer); reject(e); });
      });
    } finally { await worker.terminate(); }
  }

  // Stores check C (ref 1042, March 6) and tombstones it as a confirmed duplicate whose survivor
  // links are `links` ([[from, to], ...], keys named 'C' or literal), written directly.
  async function tombstoneC(s, off, links) {
    await P.ingestFile(s.db, checkC(), s.opts(off));
    const c = await one(s.db, 'SELECT * FROM transactions');
    const ghost = (name) => (name === 'C' ? c.dedupe_key : `transaction:${sha256(`synthetic-ghost-${name}`)}`);
    const insert = s.db.prepare(`INSERT INTO superseded_rows (table_name, dedupe_key, row, file_id, superseded_by, reason, at, survivor_key)
                                 VALUES ('transactions', ?, ?, ?, ?, 'duplicate_confirmed', ?, ?)`);
    for (const [from, to] of links) {
      const row = from === 'C' ? { ...c, normalized_description: normalize(c.description) } : { dedupe_key: ghost(from), description: `SYNTH GHOST ${from}`, normalized_description: normalize(`SYNTH GHOST ${from}`) };
      await insert.run(ghost(from), JSON.stringify(row), c.file_id, c.file_id, NOW, ghost(to));
    }
    await s.db.prepare('DELETE FROM transactions WHERE id = ?').run(c.id);
    return c;
  }

  const survivorGuards = [
    ['a two-key cycle (C names X, X names C)', [['C', 'X'], ['X', 'C']]],
    ['a three-key cycle (C names X, X names Y, Y names X)', [['C', 'X'], ['X', 'Y'], ['Y', 'X']]],
    ['a self link (C names C)', [['C', 'C']]],
    ['a missing survivor (C names X, which has no row and no tombstone)', [['C', 'X']]],
  ];
  for (const [what, links] of survivorGuards) {
    test(`H2 guard: ${what} ends; the March 15 check is kept and asks nothing against an inactive key`, async () => withStore(async (s) => {
      const off = await offEngine();
      const c = await tombstoneC(s, off, links);
      assert.equal(await count(s.db, 'transactions'), 0, 'nothing is active');
      const questions = await count(s.db, 'confirm_items', "kind = 'near_duplicate'");
      const r = await ingestInWorker(s, checkBank('Chase0042_Activity_H2_G.csv', '03/15/2032', PLUMBER));
      assert.equal(r.status, 'imported');
      assert.equal(inserted(r, 'transaction'), 1);
      const kept = await one(s.db, 'SELECT * FROM transactions WHERE description = ?', PLUMBER);
      assert.equal(kept.dedupe_key, `${c.dedupe_key}:d:${sha256(normalize(PLUMBER)).slice(0, 16)}`, 'under its alt key');
      assert.equal(await count(s.db, 'confirm_items', "kind = 'near_duplicate'"), questions, 'no active counterpart: no question');
    }));
  }
});

// D5: a complete positions snapshot removes same-account, same-day holdings it no longer lists.
describe('authoritative position snapshots (D5)', () => {
  const A = { symbol: 'EXMPL', quantity: '10', price: '20.00', value: '200.00' };
  const B = { symbol: 'OTHR', quantity: '5', price: '10.00', value: '50.00' };
  const figure = async (db) => {
    const acct = await one(db, "SELECT * FROM accounts WHERE mask = '2222'");
    return (await one(db, 'SELECT v FROM figures WHERE key = ?', `acct.${acct.id}.balance`)).v;
  };
  const removed = async (db) => await all(db, "SELECT * FROM superseded_rows WHERE table_name = 'positions' AND reason = 'removed'");

  test('A and B, then the same day with A only: B is archived as removed and the total equals A', async () => withStore(async (s) => {
    const off = await offEngine();
    const first = await P.ingestFile(s.db, positionsFile('positions-ab.csv', [A, B]), s.opts(off));
    const second = await P.ingestFile(s.db, positionsFile('positions-a.csv', [A]), s.opts(off));
    assert.equal(second.counts.superseded, 1);
    assert.deepEqual((await all(s.db, 'SELECT symbol FROM positions')).map((p) => p.symbol), ['EXMPL']);
    const gone = await removed(s.db);
    assert.deepEqual(gone.map((x) => [JSON.parse(x.row).symbol, x.file_id, x.superseded_by]), [['OTHR', first.fileId, second.fileId]]);
    assert.equal(await figure(s.db), 200);
  }));

  test('a pending activity row does not make the snapshot incomplete', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, positionsFile('positions-ab.csv', [A, B]), s.opts(off));
    const pending = { symbol: 'PENDING', description: 'Pending activity', quantity: '', price: '0', value: '0' };
    const second = await P.ingestFile(s.db, positionsFile('positions-a-pending.csv', [A, pending]), s.opts(off));
    assert.equal(second.counts.warningCodes.pending_activity, 1);
    assert.deepEqual((await all(s.db, 'SELECT symbol FROM positions')).map((p) => p.symbol), ['EXMPL']);
    assert.equal((await removed(s.db)).length, 1);
  }));

  test('an invalid position row for the account keeps B (incomplete snapshot)', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, positionsFile('positions-ab.csv', [A, B]), s.opts(off));
    const second = await P.ingestFile(s.db, positionsFile('positions-a-invalid.csv', [A, { symbol: 'BROKEN', quantity: '1', price: '1.00', value: 'n/a' }]), s.opts(off));
    assert.equal(second.counts.warningCodes.invalid_position, 1);
    assert.deepEqual((await all(s.db, 'SELECT symbol FROM positions ORDER BY symbol')).map((p) => p.symbol), ['EXMPL', 'OTHR']);
    assert.equal((await removed(s.db)).length, 0);
    assert.equal(await figure(s.db), 250);
  }));

  test('an older second file keeps B', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, positionsFile('positions-ab.csv', [A, B]), s.opts(off));
    await P.ingestFile(s.db, positionsFile('positions-a-older.csv', [A], { asOf: 'Mar-04-2032' }), s.opts(off));
    assert.equal(await count(s.db, 'positions', "as_of = '2032-03-05'"), 2);
    assert.equal((await removed(s.db)).length, 0);
    assert.equal(await figure(s.db), 250);
  }));

  // G5: a snapshot is authoritative per (account, asOf) only when the file proves coverage.
  test('G5: a truncated record for the account warns truncated_position and keeps the omitted holding', async () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, positionsFile('positions-ab.csv', [A, B]), s.opts(off));
    const second = await P.ingestFile(s.db, positionsFile('positions-a-truncated.csv', [A], { extra: ['Z5550002222,Synthetic brokerage'] }), s.opts(off));
    assert.equal(second.counts.warningCodes.truncated_position, 1);
    assert.deepEqual((await all(s.db, 'SELECT symbol FROM positions ORDER BY symbol')).map((p) => p.symbol), ['EXMPL', 'OTHR']);
    assert.equal((await removed(s.db)).length, 0);
    assert.equal(await figure(s.db), 250);
  }));

  test('G5: a warning on account X does not block a complete account Y in the same file', async () => withStore(async (s) => {
    const off = await offEngine();
    const X = { account: 'Z5550003333', accountName: 'Synthetic brokerage X' };
    await P.ingestFile(s.db, positionsFile('positions-xy-ab.csv', [{ ...A, ...X }, { ...B, ...X }, A, B]), s.opts(off));
    const second = await P.ingestFile(s.db, positionsFile('positions-xy-a.csv', [{ ...A, ...X }, { symbol: 'BROKEN', quantity: '1', price: '1.00', value: 'n/a', ...X }, A]), s.opts(off));
    assert.equal(second.counts.warningCodes.invalid_position, 1);
    const held = async (mask) => (await all(s.db, 'SELECT p.symbol FROM positions p JOIN accounts a ON a.id = p.account_id WHERE a.mask = ? ORDER BY p.symbol', mask)).map((p) => p.symbol);
    assert.deepEqual(await held('3333'), ['EXMPL', 'OTHR'], 'X is incomplete: nothing removed');
    assert.deepEqual(await held('2222'), ['EXMPL'], 'Y is complete: OTHR removed');
    assert.deepEqual((await removed(s.db)).map((x) => JSON.parse(x.row).symbol), ['OTHR']);
    assert.equal(await figure(s.db), 200);
  }));

  test('G5: an unattributable warning marks the whole file incomplete', async () => withStore(async (s) => {
    const off = await offEngine();
    const X = { account: 'Z5550003333', accountName: 'Synthetic brokerage X' };
    await P.ingestFile(s.db, positionsFile('positions-xy-ab.csv', [{ ...A, ...X }, { ...B, ...X }, A, B]), s.opts(off));
    const second = await P.ingestFile(s.db, positionsFile('positions-xy-a-orphan.csv', [{ ...A, ...X }, A, { symbol: 'ORPHAN', quantity: '1', price: '1.00', value: '1.00', account: '' }]), s.opts(off));
    assert.equal(second.counts.warningCodes.invalid_position, 1);
    assert.equal(await count(s.db, 'positions'), 4);
    assert.equal((await removed(s.db)).length, 0);
  }));

  // Statements: an absent holdings key is not a snapshot; an explicit empty array is.
  const statement = (holdings) => ({
    institution: 'Example Bank', accountLast4: '4321', accountKind: 'brokerage', periodEnd: '2032-03-31', endingBalance: 1500, confidence: 0.9,
    ...(holdings === undefined ? {} : { holdings }),
  });
  const statementFile = (tag) => textFile(`statement-${tag}.txt`, `Synthetic brokerage statement ${tag} for the period ending 2032-03-31`, 'text/plain');
  const importStatement = async (s,tag,holdings) => importProposedRows(s, [{ target: 'document', docType: 'statement', fields: statement(holdings) }], { name: `statement-${tag}.xlsx`, marker: tag, now: NOW });
  const HOLDINGS = [{ symbol: 'EXMPL', name: 'Example Index Fund', quantity: 10, value: 200 }, { symbol: 'OTHR', name: 'Other Example Fund', quantity: 5, value: 50 }];
  const statementSymbols = async (db) => (await all(db, "SELECT p.symbol FROM positions p JOIN accounts a ON a.id = p.account_id WHERE a.mask = '4321' ORDER BY p.symbol")).map((p) => p.symbol);

  test('G5: a statement extraction without a holdings key keeps the stored holdings', async () => withStore(async (s) => {
    assert.equal((await importStatement(s, 'full', HOLDINGS)).status, 'imported');
    assert.equal((await importStatement(s, 'no-holdings', undefined)).status, 'imported');
    assert.deepEqual(await statementSymbols(s.db), ['EXMPL', 'OTHR']);
    assert.equal((await removed(s.db)).length, 0);
  }));

  test('G5: an explicit empty holdings array is a complete empty snapshot that archives every stored symbol', async () => withStore(async (s) => {
    const first = await importStatement(s, 'full', HOLDINGS);
    const empty = await importStatement(s, 'empty', []);
    assert.equal(empty.status, 'imported');
    assert.deepEqual(await statementSymbols(s.db), []);
    assert.deepEqual((await removed(s.db)).map((x) => [JSON.parse(x.row).symbol, x.file_id, x.superseded_by]).sort(), [['EXMPL', first.fileId, empty.fileId], ['OTHR', first.fileId, empty.fileId]]);
  }));

  // Review finding H3: with no ending balance the account figure is the holdings total, so an
  // authoritative empty snapshot makes it 0, with provenance from the empty snapshot's file. The
  // figure is read where the scenario reads it: accounts[].fig names a figures row.
  const holdingsOnly = (periodEnd, holdings) => ({ institution: 'Example Bank', accountLast4: '4321', accountKind: 'brokerage', periodEnd, holdings, confidence: 0.9 });
  const holdingsFile = (tag, periodEnd) => textFile(`statement-holdings-${tag}.txt`, `Synthetic brokerage statement ${tag} for the period ending ${periodEnd}`, 'text/plain');
  const importHoldings = async (s, tag, periodEnd, holdings) => {
    const r = await importProposedRows(s, [{ target: 'document', docType: 'statement', fields: holdingsOnly(periodEnd,holdings) }], { name: `holdings-${tag}.xlsx`, marker: tag, now: NOW });
    assert.equal(r.status, 'imported');
    return r;
  };
  // The scenario's figure for the 4321 account plus the stored figure row behind it.
  const holdingsFigure = async (db) => {
    const sc = Bld.buildScenario(db, { clock: '2032-05-10' });
    const acct = sc.accounts.find((a) => a.mask === '4321');
    assert.ok(acct?.fig, 'the account names a figure');
    return { shown: sc.fig[acct.fig], row: await one(db, 'SELECT * FROM figures WHERE key = ?', acct.fig) };
  };
  const sourceOf = async (db, fileId) => (await one(db, 'SELECT source_id FROM files WHERE id = ?', fileId)).source_id;

  test('H3: holdings without an ending balance, then the same date with an empty holdings list: no positions and a figure of 0 from the second file', async () => withStore(async (s) => {
    const first = await importHoldings(s, 'full', '2032-03-31', HOLDINGS);
    assert.equal(await count(s.db, 'balances'), 0, 'no ending balance');
    assert.equal((await holdingsFigure(s.db)).shown.v, 250, 'the figure is the holdings total');
    const empty = await importHoldings(s, 'empty', '2032-03-31', []);
    assert.deepEqual(await statementSymbols(s.db), [], 'no active positions');
    assert.equal((await removed(s.db)).length, 2);
    const { shown, row } = await holdingsFigure(s.db);
    assert.equal(shown.v, 0, 'the scenario shows 0, not the old total');
    assert.equal(shown.src, await sourceOf(s.db, empty.fileId));
    assert.equal(row.file_id, empty.fileId, 'provenance points at the empty snapshot');
    assert.notEqual(row.file_id, first.fileId);
    assert.equal(row.parser, 'model-import');
    assert.equal(JSON.parse(row.locator)?.field, 'holdings', 'located at the holdings list');
  }));

  test('H3: an empty holdings list dated after the first statement makes the figure 0 from the later file', async () => withStore(async (s) => {
    await importHoldings(s, 'full', '2032-03-31', HOLDINGS);
    const empty = await importHoldings(s, 'empty-later', '2032-04-30', []);
    assert.equal(await count(s.db, 'positions', "as_of = '2032-04-30'"), 0, 'nothing held on April 30');
    const { shown, row } = await holdingsFigure(s.db);
    assert.equal(shown.v, 0, 'the latest snapshot is empty');
    assert.equal(shown.src, await sourceOf(s.db, empty.fileId));
    assert.equal(row.file_id, empty.fileId);
    assert.equal(JSON.parse(row.locator)?.field, 'holdings');
  }));

  test('H3: an empty holdings list dated before a stored full statement leaves the later total and its provenance', async () => withStore(async (s) => {
    const full = await importHoldings(s, 'full-later', '2032-04-30', HOLDINGS);
    await importHoldings(s, 'empty-earlier', '2032-03-31', []);
    assert.deepEqual(await statementSymbols(s.db), ['EXMPL', 'OTHR']);
    const { shown, row } = await holdingsFigure(s.db);
    assert.equal(shown.v, 250);
    assert.equal(row.file_id, full.fileId);
  }));
});

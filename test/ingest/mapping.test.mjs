// AC4: an unknown tabular export gets a column mapping proposed by the engine from its headers
// and at most five redacted rows, validated and applied by code, then remembered by header
// signature so the next file with the same headers needs no model call.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { src } from '../helpers/server.mjs';
import { textFile, realStore, fakeEngine, recordingEngine, offEngine, all, one, count } from '../helpers/ingest.mjs';

let P;
let M;
let R;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  M = await src('src/ingest/mapping.mjs');
  R = await src('src/ingest/registry.mjs');
});

// Lowercase headers so the column names are the same before and after header normalization.
const HEADERS = ['posted on', 'memo text', 'value usd', 'acct ref', 'bank label'];
const MEMO = ['SYNTH ROW1 REF 1234567890', 'SYNTH ROW2 REF 2345678901', 'SYNTH ROW3', 'SYNTH ROW4', 'SYNTH ROW5', 'SYNTH ROW6 MARKER', 'SYNTH ROW7 MARKER'];
function novelCsv(memos = MEMO, start = 2) {
  const lines = memos.map((memo, i) => `2032-03-${String(start + i).padStart(2, '0')},${memo},-${i + 1}.25,000123456789,Example Credit Union`);
  return [HEADERS.join(','), ...lines].join('\n') + '\n';
}
const novelFile = (name = 'novel-export.csv', memos, start) => textFile(name, novelCsv(memos, start), 'text/csv');

const MAPPING = {
  target: 'transaction', date: 'posted on', amount: 'value usd', description: 'memo text',
  accountNumber: 'acct ref', institution: 'bank label', amountSign: 'as_is', dateOrder: 'ymd',
};

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

test('the novel CSV is not claimed by any frozen parser', () => {
  assert.equal(R.pickParser(novelFile()), null);
});

describe('helpers', () => {
  test('headerSignature hashes normalized headers', () => {
    const want = createHash('sha256').update(JSON.stringify(['posted on', 'memo text'])).digest('hex');
    assert.equal(M.headerSignature(['Posted  On', ' memo text ']), want);
    assert.equal(M.headerSignature(['posted on', 'memo text']), want);
    assert.notEqual(M.headerSignature(['posted on', 'memo']), want);
  });

  test('readTable reads headers and rows with locators; null for a non-table', () => {
    const table = M.readTable(novelFile());
    assert.deepEqual(table.headers, HEADERS);
    assert.equal(table.rows.length, 7);
    assert.equal(table.rows[0].values[1], MEMO[0]);
    assert.deepEqual(table.rows[0].locator, { row: 2 });
    assert.equal(M.readTable({ name: 'scan.pdf', bytes: new TextEncoder().encode('%PDF-1.4 synthetic') }), null);
  });

  test('validateMapping accepts a valid mapping and names each problem otherwise', () => {
    assert.deepEqual(M.validateMapping(MAPPING, HEADERS), { ok: true, errors: [] });
    const unknown = M.validateMapping({ ...MAPPING, description: 'no such column' }, HEADERS);
    assert.equal(unknown.ok, false);
    assert.ok(unknown.errors.length >= 1);
    const noDate = { ...MAPPING }; delete noDate.date;
    assert.equal(M.validateMapping(noDate, HEADERS).ok, false, 'transaction needs a date');
    const noAmount = { ...MAPPING }; delete noAmount.amount;
    assert.equal(M.validateMapping(noAmount, HEADERS).ok, false, 'transaction needs amount or debit and credit');
    assert.equal(M.validateMapping({ ...MAPPING, description: 'value usd' }, HEADERS).ok, false, 'no column used twice');
    const debitCredit = { target: 'transaction', date: 'when', debit: 'out', credit: 'in', amountSign: 'as_is', dateOrder: 'mdy' };
    assert.equal(M.validateMapping(debitCredit, ['when', 'out', 'in']).ok, true);
    assert.equal(M.validateMapping({ target: 'balance', date: 'when', amount: 'out', amountSign: 'as_is', dateOrder: 'ymd' }, ['when', 'out']).ok, true);
    assert.equal(M.validateMapping({ target: 'balance', amount: 'out', amountSign: 'as_is', dateOrder: 'ymd' }, ['when', 'out']).ok, false);
    assert.equal(M.validateMapping({ target: 'position', date: 'when', symbol: 'sym', quantity: 'qty', amountSign: 'as_is', dateOrder: 'ymd' }, ['when', 'sym', 'qty']).ok, false, 'position needs value');
  });

  test('applyMapping: debit and credit, month-first dates, negate, masks and invalid rows', () => {
    const csv = 'when,payee,out,in,number,bank\n03/04/2032,Synthetic payee,12.50,,4444333322221111,Example Bank\n03/05/2032,Synthetic refund,,5.00,4444333322221111,Example Bank\n13/40/2032,Broken,1,,4444333322221111,Example Bank\n';
    const file = textFile('card.csv', csv, 'text/csv');
    const table = M.readTable(file);
    const mapping = { target: 'transaction', date: 'when', description: 'payee', debit: 'out', credit: 'in', accountNumber: 'number', institution: 'bank', amountSign: 'as_is', dateOrder: 'mdy' };
    const out = M.applyMapping(mapping, table, file);
    assert.deepEqual(out.rows.map((r) => [r.kind, r.date, r.amount, r.occurrence]), [['transaction', '2032-03-04', -12.5, 1], ['transaction', '2032-03-05', 5, 1]]);
    assert.equal(out.rows[0].account.mask, '1111');
    assert.equal(out.rows[0].account.inst, 'Example Bank');
    assert.ok(!JSON.stringify(out.rows).includes('4444333322221111'), 'full card number never in rows');
    assert.ok(out.warnings.some((w) => w.code === 'invalid_mapped_row'));
    assert.ok(!JSON.stringify(out.warnings).includes('Broken'), 'warnings carry codes, not values');
    assert.deepEqual(out.period, { from: '2032-03-04', to: '2032-03-05' });
    const negateMapping = { target: 'transaction', date: 'when', description: 'payee', amount: 'out', accountNumber: 'number', institution: 'bank', amountSign: 'negate', dateOrder: 'mdy' };
    const negated = M.applyMapping(negateMapping, table, file);
    assert.equal(negated.rows[0].amount, -12.5);
  });

  test('applyMapping takes a 4 digit mask from the file name when no account column is mapped', () => {
    const file = textFile('Example_9876_export.csv', 'day,amt\n2032-03-01,4.00\n', 'text/csv');
    const out = M.applyMapping({ target: 'transaction', date: 'day', amount: 'amt', amountSign: 'as_is', dateOrder: 'ymd' }, M.readTable(file), file);
    assert.equal(out.rows[0].account.mask, '9876');
  });
});

describe('mapTabular through ingestFile', () => {
  test('a valid proposal imports the rows; the model saw headers and at most 5 redacted rows', () => withStore(async (s) => {
    const engine = await recordingEngine([[MAPPING]]);
    const file = novelFile();
    const r = await P.ingestFile(s.db, file, s.opts(engine));
    assert.equal(r.status, 'imported');
    assert.equal(r.parser, 'mapped');
    assert.equal((r.counts.rows || {}).transaction, 7);
    const tx = all(s.db, 'SELECT * FROM transactions ORDER BY date');
    assert.deepEqual(tx.map((t) => t.amount), [-1.25, -2.25, -3.25, -4.25, -5.25, -6.25, -7.25]);
    assert.ok(tx.every((t) => t.parser === 'mapped' && t.file_id === r.fileId));
    const acct = one(s.db, 'SELECT * FROM accounts');
    assert.equal(acct.mask, '6789');
    assert.equal(acct.inst, 'Example Credit Union');

    assert.equal(engine.extracts.length, 1, 'one model call');
    const sent = engine.extracts[0].document.text;
    assert.equal(engine.extracts[0].document.type, 'text');
    for (const h of HEADERS) assert.ok(sent.includes(h), `header ${h} sent`);
    assert.ok(sent.includes('SYNTH ROW1'), 'sample rows are sent');
    assert.ok(!sent.includes('ROW6 MARKER') && !sent.includes('ROW7 MARKER'), 'no more than 5 data rows');
    assert.doesNotMatch(engine.sent(), /\d{5,}/, 'every digit run over 4 is masked');
    for (const run of ['1234567890', '2345678901', '000123456789', '123456789']) assert.ok(!engine.sent().includes(run));

    const stored = one(s.db, 'SELECT * FROM column_mappings');
    assert.equal(stored.signature, M.headerSignature(HEADERS));
    assert.equal(stored.src, 'engine');
    assert.deepEqual(JSON.parse(stored.mapping), MAPPING);
    assert.equal(one(s.db, 'SELECT header_signature FROM files WHERE id = ?', r.fileId).header_signature, stored.signature);
  }));

  test('a second file with the same headers imports with no model call', () => withStore(async (s) => {
    await P.ingestFile(s.db, novelFile(), s.opts(await fakeEngine([[MAPPING]])));
    const usesBefore = one(s.db, 'SELECT uses FROM column_mappings').uses;
    const silent = await recordingEngine([]);
    const r = await P.ingestFile(s.db, novelFile('novel-april.csv', ['SYNTH APRIL A', 'SYNTH APRIL B'], 20), s.opts(silent));
    assert.equal(r.status, 'imported');
    assert.equal((r.counts.rows || {}).transaction, 2);
    assert.equal(silent.extracts.length + silent.calls.length, 0, 'no model call');
    assert.equal(one(s.db, 'SELECT uses FROM column_mappings').uses, usesBefore + 1);
    assert.equal(count(s.db, 'transactions'), 9);
  }));

  test('a proposal naming an unknown column is refused: needs_mapping, nothing stored', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, novelFile(), s.opts(await fakeEngine([[{ ...MAPPING, description: 'not a column' }]])));
    assert.equal(r.status, 'needs_mapping');
    assert.equal(one(s.db, 'SELECT status FROM files WHERE id = ?', r.fileId).status, 'needs_mapping');
    assert.equal(count(s.db, 'transactions'), 0);
    assert.equal(count(s.db, 'column_mappings'), 0);
  }));

  test('mapTabular returns needs_mapping when the engine is off or fails', () => withStore(async (s) => {
    const file = novelFile();
    const off = await M.mapTabular(s.db, await offEngine(), file);
    assert.equal(off.status, 'needs_mapping');
    assert.equal(off.signature, M.headerSignature(HEADERS));
    const failing = await M.mapTabular(s.db, await fakeEngine([]), file);
    assert.equal(failing.status, 'needs_mapping');
    const ok = await M.mapTabular(s.db, await fakeEngine([[MAPPING]]), file);
    assert.equal(ok.status, 'imported');
    assert.equal(ok.result.rows.length, 7);
  }));

  test('proposeMapping returns null for an invalid proposal and the mapping for a valid one', async () => {
    const table = M.readTable(novelFile());
    assert.equal(await M.proposeMapping(await fakeEngine([[{ ...MAPPING, amount: 'missing' }]]), table), null);
    assert.deepEqual(await M.proposeMapping(await fakeEngine([[MAPPING]]), table), MAPPING);
  });

  test('engine off leaves the file waiting; retryFile with the engine on imports it under the same id', () => withStore(async (s) => {
    const first = await P.ingestFile(s.db, novelFile(), s.opts(await offEngine()));
    assert.equal(first.status, 'needs_mapping');
    assert.equal(count(s.db, 'transactions'), 0);
    const retried = await P.retryFile(s.db, first.fileId, s.opts(await fakeEngine([[MAPPING]])));
    assert.equal(retried.status, 'imported');
    assert.equal(retried.fileId, first.fileId);
    assert.equal(count(s.db, 'transactions'), 7);
    assert.equal(one(s.db, 'SELECT status FROM files WHERE id = ?', first.fileId).status, 'imported');
    assert.equal(count(s.db, 'files'), 1);
    await assert.rejects(async () => P.retryFile(s.db, first.fileId, s.opts(await fakeEngine([[MAPPING]]))), (e) => e.status === 409);
    await assert.rejects(async () => P.retryFile(s.db, 'f-000000000000000000000000', s.opts(await fakeEngine([[MAPPING]]))), (e) => e.status === 404);
  }));
});

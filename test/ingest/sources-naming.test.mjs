import { importProposedRows } from '../helpers/import-proposal-fixture.mjs';
// SRC1 AC1: every source in ingestState(db).sources is named by its real origin, never by its
// parser label. A file source whose accounts share one institution is named for it; otherwise it
// carries its file name, and with several live files the newest name plus " and N more files".
// Each source also lists its date range (ISO days), its accounts and its live uploaded files.
// Expected values are read from the store the import wrote, never from private data. Every file,
// account and institution here is synthetic.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import { realStore, fixture, aggregatorFile, textFile, offEngine, one, NOW } from '../helpers/ingest.mjs';
import { mapSeries } from '../../src/shared/series.mjs';

let FR;
let P;
let SF;
before(async () => {
  FR = await src('src/ingest/freshness.mjs');
  P = await src('src/ingest/pipeline.mjs');
  SF = await src('src/ingest/simplefin.mjs');
});

const CLOCK = '2032-03-10';
const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { await s.close(); }
}

const sourcesOf = (s) => FR.ingestState(s.db, { clock: CLOCK }).sources;
const fileRow = async (s, name) => await one(s.db, 'SELECT * FROM files WHERE name = ?', name);
const sourceOfFile = async (s, name) => {
  const f = await fileRow(s, name);
  assert.ok(f, `${name} was stored`);
  const source = sourcesOf(s).find((x) => x.id === f.source_id);
  assert.ok(source, `${name} has a source in ingestState`);
  return source;
};
// The parser label the import wrote ("<parser label> (<account>)" for a one account source).
const parserLabel = (source) => String(source.label).replace(/ \([^)]*\)$/, '');

function assertNotParserLabel(source) {
  assert.equal(typeof source.label, 'string', 'label is kept for compatibility');
  assert.ok(typeof source.name === 'string' && source.name.length > 0, `${source.id} has a name`);
  assert.notEqual(source.name, source.label, `${source.id} name is not the parser label`);
  assert.ok(!source.name.startsWith(parserLabel(source)), `${source.id} name "${source.name}" does not start with the parser label "${parserLabel(source)}"`);
}

async function ingest(s, file, now = NOW) {
  const r = await P.ingestFile(s.db, file, s.opts(await offEngine(), { now }));
  assert.equal(r.status, 'imported', `${file.name} imported`);
  return r;
}

test('a one account file source is named for its institution, with its range, accounts and files', async () => withStore(async (s) => {
  await ingest(s, fixture('aggregator.csv', 'text/csv'));
  const file = await fileRow(s, 'aggregator.csv');
  const account = await one(s.db, 'SELECT * FROM accounts WHERE id IN (SELECT account_id FROM transactions WHERE file_id = ?)', file.id);
  assert.ok(account.inst, 'precondition: the export names an institution');
  const source = await sourceOfFile(s, 'aggregator.csv');
  assertNotParserLabel(source);
  assert.equal(source.name, account.inst);
  const days = await s.db.prepare('SELECT min(date) AS a, max(date) AS b FROM transactions WHERE file_id = ?').get(file.id);
  assert.deepEqual(source.range, { from: days.a, to: days.b });
  assert.match(source.range.from, ISO);
  assert.match(source.range.to, ISO);
  assert.ok(Array.isArray(source.accounts));
  const listed = source.accounts.find((a) => a.id === account.id);
  assert.ok(listed, 'the source lists the account it fed');
  assert.ok(typeof listed.label === 'string' && listed.label.length > 0, 'the account carries its display label');
  assert.equal(typeof listed.state, 'string');
  assert.equal(listed.archived, false);
  assert.deepEqual(source.files, [{ id: file.id, name: 'aggregator.csv', removable: true }]);
}));

test('a source with no institution is named for its file', async () => withStore(async (s) => {
  await ingest(s, fixture('positions.csv', 'text/csv'));
  const file = await fileRow(s, 'positions.csv');
  const account = await one(s.db, 'SELECT * FROM accounts WHERE id IN (SELECT account_id FROM positions WHERE file_id = ?)', file.id);
  assert.ok(!account.inst, 'precondition: the positions export names no institution');
  const source = await sourceOfFile(s, 'positions.csv');
  assertNotParserLabel(source);
  assert.equal(source.name, 'positions.csv');
  const asOf = await s.db.prepare('SELECT min(as_of) AS a, max(as_of) AS b FROM positions WHERE file_id = ?').get(file.id);
  assert.deepEqual(source.range, { from: asOf.a, to: asOf.b });
  assert.deepEqual(source.accounts.map((a) => a.id), [account.id]);
  assert.deepEqual(source.files.map((f) => f.name), ['positions.csv']);
}));

test('the bank activity and balance fixtures are named by institution or file, never by parser', async () => withStore(async (s) => {
  await ingest(s, fixture('Chase7766_Activity_20320305.csv', 'text/csv'));
  await s.db.prepare("INSERT INTO accounts(id,name,kind,identity) VALUES ('balance-synthetic','Daily account','cash','synthetic-balance')").run();
  const reviewed = await importProposedRows(s,[['2032-02-29',1400.25],['2032-03-31',2300.75]].map(([asOf,amount])=>({target:'balance',basis:'closing',datePrecision:'day',fields:{accountId:'balance-synthetic',asOf,amount}})),{name:'month-end-balances.csv'});
  assert.equal(reviewed.status,'imported');
  for (const name of ['Chase7766_Activity_20320305.csv', 'month-end-balances.csv']) {
    const source = await sourceOfFile(s, name);
    assertNotParserLabel(source);
    const insts = [...new Set(await mapSeries(source.accounts, async (a) => (await one(s.db, 'SELECT inst FROM accounts WHERE id = ?', a.id)).inst))];
    const expected = insts.length === 1 && insts[0] ? insts[0] : name;
    assert.equal(source.name, expected, `${name} source name`);
    assert.match(source.range.from, ISO);
    assert.match(source.range.to, ISO);
    assert.ok(source.range.from <= source.range.to);
  }
}));

const account = (n, inst) => ({ account: `Synthetic account ${n}`, number: `555000${n}${n}${n}${n}`, inst });

test('a multi account export whose accounts share an institution is named for it', async () => withStore(async (s) => {
  await ingest(s, aggregatorFile('shared-institution.csv', [
    { ...account(1, 'Example Bank'), date: '2032-02-03', amount: '11.00' },
    { ...account(2, 'Example Bank'), date: '2032-02-20', amount: '12.00' },
  ]));
  const shared = await sourceOfFile(s, 'shared-institution.csv');
  assertNotParserLabel(shared);
  assert.equal(shared.accounts.length, 2);
  assert.equal(shared.name, 'Example Bank');
  assert.deepEqual(shared.range, { from: '2032-02-03', to: '2032-02-20' });
}));

test('a multi account export whose accounts are at different institutions is named for its file', async () => withStore(async (s) => {
  await ingest(s, aggregatorFile('mixed-institutions.csv', [
    { ...account(3, 'Example Bank'), date: '2032-01-05', amount: '13.00' },
    { ...account(4, 'Sample Credit Union'), date: '2032-01-25', amount: '14.00' },
  ]));
  const mixed = await sourceOfFile(s, 'mixed-institutions.csv');
  assertNotParserLabel(mixed);
  assert.equal(mixed.name, 'mixed-institutions.csv');
}));

test('several live files in one source: newest file name plus the count of the others, range over all of them', async () => withStore(async (s) => {
  const rows = (month, a, b) => [
    { ...account(5, 'Example Bank'), date: `2031-${month}-04`, amount: a },
    { ...account(6, 'Sample Credit Union'), date: `2031-${month}-18`, amount: b },
  ];
  await ingest(s, aggregatorFile('export-a.csv', rows('10', '21.00', '22.00')), '2032-03-01T10:00:00.000Z');
  await ingest(s, aggregatorFile('export-c.csv', rows('12', '25.00', '26.00')), '2032-03-03T10:00:00.000Z');
  await ingest(s, aggregatorFile('export-b.csv', rows('11', '23.00', '24.00')), '2032-03-02T10:00:00.000Z');
  const ids = await mapSeries(['export-a.csv', 'export-b.csv', 'export-c.csv'], async (n) => (await fileRow(s, n)).source_id);
  assert.equal(new Set(ids).size, 1, 'precondition: the three exports feed one source');
  const source = sourcesOf(s).find((x) => x.id === ids[0]);
  assertNotParserLabel(source);
  assert.equal(source.name, 'export-c.csv and 2 more files');
  assert.deepEqual(source.range, { from: '2031-10-04', to: '2031-12-18' });
  assert.deepEqual(source.files.map((f) => f.name).sort(), ['export-a.csv', 'export-b.csv', 'export-c.csv']);
  assert.ok(source.files.every((f) => f.removable === true));
  assert.equal(source.accounts.length, 2);
}));

test('a bank connection source is named for its institutions', async () => withStore(async (s) => {
  const own = P.accountIdOf('simplefin:synthetic-naming');
  const doc = { accounts: [{ accountId: own, identity: 'simplefin:synthetic-naming', account: { inst: 'Example Bank', name: 'Everyday x4321', mask: '4321', kind: 'checking' },
    balance: { date: '2032-03-01', amount: 900 },
    transactions: [{ date: '2032-03-01', amount: -10, description: 'Bridge posting', externalId: 'bridge-naming' }] }] };
  const r = await P.ingestFile(s.db, textFile('bridge-naming.json', JSON.stringify(doc)), s.opts(null, { parser: SF.parser }));
  assert.equal(r.status, 'imported');
  const source = sourcesOf(s).find((x) => x.kind === 'simplefin');
  assert.ok(source, 'the bridge sync has a source');
  assertNotParserLabel(source);
  assert.equal(source.name, 'Example Bank');
  assert.ok(source.accounts.some((a) => a.id === own));
}));

test('sources sort stale first, then fresh, then history, then by name', async () => withStore(async (s) => {
  // aggregator.csv then the bank activity export for the same account: the activity file holds
  // newer rows, so the aggregator source is history. An old export of another account is stale.
  await ingest(s, fixture('aggregator.csv', 'text/csv'));
  await ingest(s, fixture('Chase7766_Activity_20320305.csv', 'text/csv'));
  await ingest(s, fixture('positions.csv', 'text/csv'));
  await ingest(s, aggregatorFile('old-reserve.csv', [{ ...account(7, 'Example Bank'), date: '2031-06-01', amount: '30.00' }]));
  const list = sourcesOf(s);
  const states = list.map((x) => x.state);
  assert.ok(states.includes('stale') && states.includes('fresh') && states.includes('history'), `stale, fresh and history present: ${states}`);
  const rank = { stale: 0, fresh: 1, history: 2 };
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    const ra = rank[a.state] ?? 3, rb = rank[b.state] ?? 3;
    assert.ok(ra < rb || (ra === rb && a.name.localeCompare(b.name) <= 0), `order at ${i}: ${a.state} ${a.name} before ${b.state} ${b.name}`);
  }
}));

test('two sources named for the same institution each add their newest file name', async () => withStore(async (s) => {
  await ingest(s, fixture('aggregator.csv', 'text/csv'));
  await ingest(s, fixture('Chase7766_Activity_20320305.csv', 'text/csv'));
  const agg = await sourceOfFile(s, 'aggregator.csv');
  const bank = await sourceOfFile(s, 'Chase7766_Activity_20320305.csv');
  const inst = (await one(s.db, 'SELECT inst FROM accounts WHERE id = ?', agg.accounts[0].id)).inst;
  assert.equal(agg.name, `${inst}, aggregator.csv`);
  assert.equal(bank.name, `${inst}, Chase7766_Activity_20320305.csv`);
  assert.notEqual(agg.name, bank.name);
}));

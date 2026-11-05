import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsers, listParsers, pickParser } from '../../src/ingest/registry.mjs';
import { writeXlsx } from '../helpers/xlsx.mjs';
import { dedupeKey } from '../../src/ingest/dedupe.mjs';

const fixture = (name) => ({ name, bytes: readFileSync(new URL(`../fixtures/ingest/${name}`, import.meta.url)) });
const textFile = (name, text, mime) => ({ name, bytes: new TextEncoder().encode(text), mime });
const run = (name) => pickParser(fixture(name)).parse(fixture(name));

const cases = [
  ['aggregator.csv', 'aggregator'],
  ['Chase7766_Activity_20320305.csv', 'chase-activity'],
  ['positions.csv', 'brokerage-positions'],
  ['business-pnl.xlsx', 'pnl-workbook'],
  ['tax-payments.xlsx', 'tax-payments'],
  ['month-end-balances.csv', 'balances'],
  ['account-map.csv', 'account-map'],
  ['notes.md', 'notes'],
];

for (const [name, id] of cases) {
  test(`registry discriminates ${id} and exposes frozen interface`, () => {
    const file = fixture(name);
    const parser = pickParser(file);
    assert.equal(parser.id, id);
    assert.equal(typeof parser.label, 'string');
    assert.equal(typeof parser.sourceKind, 'string');
    for (const candidate of parsers) {
      const score = candidate.sniff(file);
      assert.ok(Number.isFinite(score) && score >= 0 && score <= 1);
    }
    const result = parser.parse(file);
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.every((row) => row.kind && row.locator));
    assert.deepEqual(Object.keys(result.period).sort(), ['from', 'to']);
  });
}

test('aggregator converts outflows, preserves posted date and masks account numbers', () => {
  const { rows, warnings, period } = run('aggregator.csv');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'transaction');
  assert.equal(rows[0].amount, -42.35);
  assert.equal(rows[1].amount, 900.50);
  assert.equal(rows[0].date, '2032-02-29');
  assert.equal(rows[0].account.mask, '7766');
  assert.equal(rows[0].category, 'Shopping');
  assert.equal(rows[0].locator.row, 2);
  assert.equal(warnings.length, 2);
  assert.deepEqual(period, { from: '2032-02-29', to: '2032-03-01' });
  assert.ok(!JSON.stringify(rows).includes('9911227766'));
});

test('bank retains signed transactions and running balance provenance', () => {
  const { rows, warnings } = run('Chase7766_Activity_20320305.csv');
  const tx = rows.filter((row) => row.kind === 'transaction');
  const balances = rows.filter((row) => row.kind === 'balance');
  assert.deepEqual(tx.map((row) => row.amount), [-42.35, 900.50, -10]);
  assert.deepEqual(balances.map((row) => row.amount), [1400.25, 2300.75]);
  assert.equal(tx[0].account.mask, '7766');
  assert.equal(balances[0].locator.row, 2);
  assert.ok(warnings.length >= 2);
});

test('CSV handles BOM, CRLF, casing, quoted commas and embedded newlines', () => {
  const file = textFile('Chase7766_Activity.csv', '\ufeffdetails,posting date,description,amount,type,balance,check or slip #\r\nDEBIT,03/04/2032,"A, ""quoted""\nshop",-12.50,OTHER,,\r\n');
  const result = pickParser(file).parse(file);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].description, 'A, "quoted"\nshop');
  assert.equal(result.warnings.length, 0);
});

test('malformed CSV records warn and leave valid neighboring rows intact', () => {
  const file = textFile('Chase7766_Activity.csv', 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,03/01/2032,Valid,-1,OTHER,,\nDEBIT,03/02/2032,Too short\nDEBIT,03/03/2032,"Unclosed,-2,OTHER,,');
  const result = pickParser(file).parse(file);
  assert.equal(result.rows.length, 1);
  assert.ok(result.warnings.length >= 2);
  assert.ok(!JSON.stringify(result.warnings).includes('Unclosed'));
});

test('exporter trailing empty columns are accepted, nonempty extra columns warn', () => {
  const file = textFile('Chase7766_Activity.csv', 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,03/01/2032,Valid,-1,OTHER,,,\nDEBIT,03/02/2032,Invalid,-2,OTHER,,,extra\n');
  const result = pickParser(file).parse(file);
  assert.equal(result.rows.length, 1);
  assert.equal(result.warnings[0].code, 'column_count');
});

test('missing bank mask warns without storing filename or inventing identity', () => {
  const file = fixture('Chase7766_Activity_20320305.csv');
  file.name = 'activity.csv';
  const result = pickParser(file).parse(file);
  assert.equal(result.rows[0].account.mask, '');
  assert.ok(result.warnings.some((w) => w.code === 'missing_account_mask'));
});

test('positions handle fractional shares, cash, pending rows and content as-of date', () => {
  const { rows, warnings, period } = run('positions.csv');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].account.mask, '5544');
  assert.equal(rows[0].asOf, '2032-03-05');
  assert.equal(rows[0].quantity, 3.125);
  assert.equal(rows[0].price, 24);
  assert.equal(rows[0].costBasis, 65.25);
  assert.equal(rows[1].value, 125.75);
  assert.equal(rows[1].symbol, 'CASH');
  assert.ok(warnings.some((w) => w.code === 'pending_activity'));
  assert.ok(warnings.some((w) => w.code === 'invalid_position'));
  assert.deepEqual(period, { from: '2032-03-05', to: '2032-03-05' });
});

test('positions accept filename as-of dates and reject ungrounded dates', () => {
  const file = fixture('positions.csv');
  file.bytes = new TextEncoder().encode(new TextDecoder().decode(file.bytes).replace(/Date downloaded[^\n]+/, ''));
  file.name = 'positions-2032-04-30.csv';
  assert.equal(pickParser(file).parse(file).rows[0].asOf, '2032-04-30');
  file.name = 'positions.csv';
  const result = pickParser(file).parse(file);
  assert.equal(result.rows.length, 0);
  assert.ok(result.warnings.some((w) => w.code === 'missing_as_of'));
});

test('pending activity may appear in the brokerage symbol column', () => {
  const file = fixture('positions.csv');
  file.bytes = new TextEncoder().encode(new TextDecoder().decode(file.bytes).replace(',,Pending activity,', ',Pending activity,,'));
  const result = pickParser(file).parse(file);
  assert.equal(result.rows.length, 2);
  assert.ok(result.warnings.some((w) => w.code === 'pending_activity'));
});

test('P&L aggregates actual detailed sheets by entity, category and month', () => {
  const { rows, warnings } = run('business-pnl.xlsx');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.kind), ['pnl_line', 'pnl_line', 'pnl_line']);
  assert.equal(rows.find((row) => row.entity === 'Example Studio' && row.category === 'Income').amount, 400);
  assert.equal(rows.find((row) => row.category === 'Office supplies').amount, -35);
  assert.equal(rows.find((row) => row.entity === 'Example Shop').amount, 175.25);
  assert.ok(rows.every((row) => row.locator.cells.length > 0));
  assert.ok(warnings.some((w) => w.code === 'formula_without_cache'));
  assert.ok(warnings.some((w) => w.code === 'invalid_pnl_row'));
});

test('paired income and expense sheets normalize to the same entity', () => {
  const { rows } = run('business-pnl-paired.xlsx');
  const income = rows.find((row) => row.category === 'Income' && row.amount === 400);
  const expense = rows.find((row) => row.category === 'Office supplies');
  assert.equal(income.entity, 'Example Studio');
  assert.equal(expense.entity, income.entity);
  assert.equal(expense.amount, -35);
  assert.equal(income.locator.sheet, 'Example Studio - (Actual Income)');
  assert.equal(expense.locator.sheet, '[Example Studio: Expenses]');
});

test('monthly tax matrix keeps both payers, ignores safe-harbor totals and records precision', () => {
  const { rows, warnings } = run('tax-payments.xlsx');
  assert.equal(rows.length, 10);
  assert.ok(rows.every((row) => row.kind === 'tax_payment' && row.paymentKind === 'paid'));
  assert.ok(rows.every((row) => row.datePrecision === 'month'));
  assert.equal(rows.find((row) => row.locator.cell === 'C5').date, '2032-02-29');
  assert.equal(rows.find((row) => row.locator.cell === 'C6').amount, 425);
  assert.equal(rows.find((row) => row.locator.cell === 'E6').amount, -10);
  assert.equal(rows.filter((row) => row.taxYear === 2031).length, 2);
  assert.ok(warnings.some((w) => w.code === 'month_precision'));
  assert.ok(warnings.some((w) => w.code === 'invalid_tax_payment'));
  const payment = rows.find((row) => row.payer === 'Owner');
  assert.notEqual(dedupeKey(payment), dedupeKey({ ...payment, payer: 'Spouse' }));
});

test('January tax rows retain sheet years and mark both year interpretations as assumptions', () => {
  const { rows, warnings } = run('tax-payments.xlsx');
  const january = rows.filter((row) => row.date === '2032-01-31');
  assert.equal(january.length, 4);
  for (const row of january) {
    assert.equal(row.sheetYear, 2032);
    assert.equal(row.taxYearBasis, 'sheet_label');
    assert.equal(row.dateBasis, 'sheet_label');
    assert.ok(warnings.some((w) => w.code === 'tax_year_assumed' && w.locator.cell === row.locator.cell));
  }
});

test('revised P&L and tax workbook cells retain slot identity across reimports', () => {
  for (const [originalName, revisedName, category, cell, before, after] of [
    ['business-pnl.xlsx', 'business-pnl-revised.xlsx', 'Office supplies', null, -35, -50],
    ['tax-payments.xlsx', 'tax-payments-revised.xlsx', null, 'C5', 225, 250],
  ]) {
    const original = run(originalName).rows;
    const revised = run(revisedName).rows;
    const matches = (row) => category ? row.category === category : row.locator.cell === cell && row.sheetYear === 2032;
    const oldRow = original.find(matches), newRow = revised.find(matches);
    assert.equal(oldRow.amount, before);
    assert.equal(newRow.amount, after);
    assert.equal(dedupeKey(oldRow), dedupeKey(newRow));
    const current = new Map([...original, ...revised].map((row) => [dedupeKey(row), row]));
    assert.equal(current.size, original.length);
    assert.equal(current.get(dedupeKey(oldRow)).amount, after);
  }
});

test('Excel date epochs and cached formulas produce grounded monthly figures', () => {
  for (const name of ['pnl-epoch-1900.xlsx', 'pnl-epoch-1904.xlsx']) {
    const { rows, warnings } = run(name);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].period, '2032-02');
    assert.equal(rows[0].amount, 400);
    assert.equal(rows[1].period, '2032-03');
    assert.equal(rows[1].amount, 125.25);
    assert.equal(warnings.length, 0);
  }
});

test('invalid XML and corrupt archives fall back, while valid workbooks remain live', () => {
  for (const name of ['invalid-xml.xlsx', 'corrupt-archive.xlsx']) {
    const file = fixture(name);
    assert.equal(pickParser(file), null);
    for (const id of ['pnl-workbook', 'tax-payments']) {
      const result = parsers.find((parser) => parser.id === id).parse(file);
      assert.deepEqual(result.rows, []);
      assert.equal(result.warnings[0].code, 'malformed_workbook');
    }
  }
  assert.equal(pickParser(fixture('business-pnl.xlsx')).id, 'pnl-workbook');
});

test('balances use actual month end including leap years and expose account metadata', () => {
  const balances = run('month-end-balances.csv');
  assert.equal(balances.rows.length, 2);
  assert.equal(balances.rows[0].date, '2032-02-29');
  assert.equal(balances.rows[0].account.name, 'daily');
  assert.equal(balances.warnings.length, 2);
  const metadata = run('account-map.csv');
  assert.equal(metadata.rows.length, 2);
  assert.equal(metadata.rows[0].kind, 'document');
  assert.equal(metadata.rows[0].docType, 'account_metadata');
  assert.deepEqual(metadata.rows[0].fields, { account: { inst: '', mask: '', name: 'daily', kind: 'checking' }, source: 'direct_export' });
  assert.equal(metadata.warnings.length, 1);
});

test('notes retain text as a document without extracting financial facts', () => {
  const file = fixture('notes.md');
  const { rows, period, warnings } = pickParser(file).parse(file);
  assert.deepEqual(rows, [{ kind: 'document', docType: 'notes', fields: { text: new TextDecoder().decode(file.bytes) }, locator: { row: 1 } }]);
  assert.deepEqual(period, { from: null, to: null });
  assert.deepEqual(warnings, []);
});

test('registry declines PDFs, unknowns, broken workbooks, and extension-only claims', () => {
  for (const file of [textFile('paystub.pdf', '%PDF-1.7'), textFile('trick.md', '%PDF-1.7'), textFile('export.csv', 'x,y\na,b'), textFile('business-pnl.xlsx', 'not a zip'), textFile('tax-payments.xlsx', ''), textFile('notes.md', '\0binary')]) {
    assert.equal(pickParser(file), null);
    for (const parser of parsers) assert.doesNotThrow(() => parser.parse(file));
  }
  assert.equal(listParsers().length, cases.length);
  assert.equal(pickParser(fixture('notes.md'), { threshold: 1 }), null);
});

test('overlapping bank and aggregator transactions collide despite description differences', () => {
  const aggregator = run('aggregator.csv').rows;
  const bank = run('Chase7766_Activity_20320305.csv').rows.filter((row) => row.kind === 'transaction');
  assert.equal(dedupeKey(aggregator[0]), dedupeKey(bank[0]));
  assert.equal(dedupeKey(aggregator[1]), dedupeKey(bank[1]));
  const changed = { ...bank[0], amount: -42.36 };
  assert.notEqual(dedupeKey(changed), dedupeKey(bank[0]));
  assert.notEqual(dedupeKey({ ...bank[0], date: '2032-03-01' }), dedupeKey(bank[0]));
  assert.notEqual(dedupeKey({ ...bank[0], account: { inst: 'Chase', mask: '8899' } }), dedupeKey(bank[0]));
});

test('occurrence ordinals preserve repeated postings and collide across overlapping exports', () => {
  const keysBySource = [];
  for (const name of ['aggregator.csv', 'Chase7766_Activity_20320305.csv']) {
    const [heading, posting, unrelated, malformed] = new TextDecoder().decode(fixture(name).bytes).trim().split('\n');
    const first = textFile(name, [heading, posting, posting].join('\n'));
    const overlap = textFile(name, [heading, unrelated, posting, malformed, posting].join('\n'));
    const original = pickParser(first).parse(first).rows.filter((row) => row.kind === 'transaction');
    const repeated = pickParser(overlap).parse(overlap).rows.filter((row) => row.kind === 'transaction' && row.date === '2032-02-29');
    assert.equal(original.length, 2);
    assert.deepEqual(original.map((row) => row.occurrence), [1, 2]);
    assert.deepEqual(repeated.map((row) => row.occurrence), [1, 2]);
    const keys = original.map(dedupeKey);
    assert.equal(new Set(keys).size, 2);
    assert.deepEqual(repeated.map(dedupeKey), keys);
    assert.equal(new Set([...original, ...repeated].map(dedupeKey)).size, 2);
    assert.deepEqual(pickParser(first).parse(first).rows.filter((row) => row.kind === 'transaction').map(dedupeKey), keys);
    const differentDescriptions = textFile(name, [heading, posting, posting.replace('EXAMPLE SHOP', 'OTHER MEMO')].join('\n'));
    assert.deepEqual(pickParser(differentDescriptions).parse(differentDescriptions).rows.filter((row) => row.kind === 'transaction').map(dedupeKey), keys);
    keysBySource.push(keys);
  }
  assert.deepEqual(keysBySource[0], keysBySource[1]);
});

test('unnamed unmasked accounts use opaque source identity for transactions and balances', () => {
  const bytes = fixture('Chase7766_Activity_20320305.csv').bytes;
  const first = { name: 'daily-export.csv', bytes };
  const second = { name: 'reserve-export.csv', bytes };
  const original = pickParser(first).parse(first).rows;
  const another = pickParser(second).parse(second).rows;
  for (let index = 0; index < original.length; index++) {
    assert.equal(original[index].account.mask, '');
    assert.equal(original[index].account.name, undefined);
    assert.match(original[index].locator.source, /^[a-f0-9]{64}$/);
    assert.notEqual(dedupeKey(original[index]), dedupeKey(another[index]));
    assert.equal(dedupeKey(original[index]), dedupeKey(pickParser(first).parse(first).rows[index]));
  }
  const known = fixture('Chase7766_Activity_20320305.csv');
  const renamed = { name: 'Chase7766_Activity_20320306.csv', bytes };
  assert.deepEqual(pickParser(known).parse(known).rows.map(dedupeKey), pickParser(renamed).parse(renamed).rows.map(dedupeKey));
  const anonymous = { ...original[0], locator: { row: 2 } };
  assert.throws(() => dedupeKey(anonymous), /source identity/);
  const sameNameDifferentContent = { name: first.name, bytes: new TextEncoder().encode(new TextDecoder().decode(bytes).replace('Deposit', 'Different memo')) };
  assert.notEqual(dedupeKey(original[0]), dedupeKey(pickParser(sameNameDifferentContent).parse(sameNameDifferentContent).rows[0]));
});

test('named unmasked accounts keep identity across files', () => {
  const first = fixture('aggregator.csv');
  first.bytes = new TextEncoder().encode(new TextDecoder().decode(first.bytes).replaceAll('9911227766', ''));
  const second = { ...first, name: 'aggregator-overlap.csv' };
  assert.deepEqual(pickParser(first).parse(first).rows.map(dedupeKey), pickParser(second).parse(second).rows.map(dedupeKey));
});

test('dedupe supports every row kind, ignores locators, and canonicalizes document fields', () => {
  const rows = cases.flatMap(([name]) => run(name).rows);
  rows.push({ kind: 'fact', key: 'household.state', value: 'ZZ', locator: { row: 1 } });
  for (const row of rows) {
    assert.match(dedupeKey(row), /^[a-z_]+:[a-f0-9]{64}$/);
    assert.equal(dedupeKey(row), dedupeKey({ ...row, locator: { row: 900 }, parser: 'other', fileId: 'another' }));
  }
  assert.equal(dedupeKey({ kind: 'document', docType: 'test', fields: { b: 2, a: 1 } }), dedupeKey({ kind: 'document', docType: 'test', fields: { a: 1, b: 2 } }));
  assert.throws(() => dedupeKey({ kind: 'unknown' }), /Unsupported row kind/);
});

test('an uncached formula in a tax Month cell warns invalid_tax_month with its locator', () => {
  const head = [[null, 'Federal', null, 'State'], ['Month', 'Owner Paid', 'Spouse Paid', 'Owner Paid', 'Spouse Paid']];
  const file = { name: 'tax-month.xlsx', bytes: new Uint8Array(writeXlsx([{ name: '2032', rows: [...head, ['January', 100, 50, 30, 20], [{ formula: 'A2' }, 120, 60, null, null]] }])) };
  const { rows, warnings } = pickParser(file).parse(file);
  assert.equal(rows.length, 4, 'the readable month still parses');
  const warn = warnings.find((w) => w.code === 'invalid_tax_month');
  assert.ok(warn, 'invalid_tax_month warning present');
  assert.deepEqual(warn.locator, { sheet: '2032', cell: 'A4' });
});

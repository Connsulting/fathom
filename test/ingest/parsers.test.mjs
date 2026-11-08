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

// G5: a nonblank record with fewer than three cells whose first cell holds an account number of the
// file is a truncated position; other short lines (footers) stay silent.
test('positions warn truncated_position for a short record of a file account; footers stay silent', () => {
  const file = fixture('positions.csv');
  const body = new TextDecoder().decode(file.bytes);
  assert.ok(!pickParser(file).parse(file).warnings.some((w) => w.code === 'truncated_position'), 'the fixture footers are silent');
  const lines = body.split('\n');
  lines.splice(2, 0, 'Z8877665544,Long term');
  lines.splice(lines.length - 2, 0, 'Totals,1');
  file.bytes = new TextEncoder().encode(lines.join('\n'));
  const { rows, warnings } = pickParser(file).parse(file);
  assert.equal(rows.length, 2);
  assert.equal(warnings.filter((w) => w.code === 'truncated_position').length, 1);
  assert.deepEqual(warnings.find((w) => w.code === 'truncated_position').locator, { row: 3 });
});

test('pending activity may appear in the brokerage symbol column', () => {
  const file = fixture('positions.csv');
  file.bytes = new TextEncoder().encode(new TextDecoder().decode(file.bytes).replace(',,Pending activity,', ',Pending activity,,'));
  const result = pickParser(file).parse(file);
  assert.equal(result.rows.length, 2);
  assert.ok(result.warnings.some((w) => w.code === 'pending_activity'));
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

test('format.number and a bank CSV read Unicode minus forms as negative', async () => {
  const { number } = await import('../../src/ingest/format.mjs');
  for (const m of ['\u2212', '\u2012', '\u2013', '\u2014', '\uFE63', '\uFF0D']) {
    const hex = m.codePointAt(0).toString(16);
    assert.equal(number(`${m}12.50`), -12.5, `U+${hex}`);
    assert.equal(number(`${m}$1,234.50`), -1234.5, `U+${hex} before $`);
  }
  assert.equal(number('12\u201314'), null, 'a dash between digits is still not a number');
  const file = textFile('Chase4321_Activity_minus.csv', 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,03/05/2032,Synthetic card,\u221242.35,OTHER,\u2212957.65,\n', 'text/csv');
  const parsed = pickParser(file).parse(file);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.rows.map((r) => [r.kind, r.amount]), [['transaction', -42.35], ['balance', -957.65]]);
});

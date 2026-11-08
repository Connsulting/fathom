// UI3 AC2: the readable transaction name reaches the Confirm card context (recent rows and
// near-duplicate comparisons) and Ask blocks that pick a transaction's merchant, while the raw bank
// text stays beside it. Every description here is synthetic.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { tempDb } from './helpers/server.mjs';
import { cardDetail } from '../src/ingest/context.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { normalizeMerchant } from '../src/categories/resolve.mjs';

const ACH = 'ORIG CO NAME:GUSTO CO ENTRY DESCR:NET SEC:CCD';
const WIRE = 'OUTGOING WIRE TRANSFER A/C: SAMPLE TRADING LLC DENVER CO 80202 US REF: SYN';
const ACCOUNT = 'a_biz';

let store;
before(async () => {
  store = await tempDb(); seedDemo(store.db);
  const add = store.db.prepare('INSERT INTO transactions (account_id, date, amount, description, dedupe_key) VALUES (?, ?, ?, ?, ?)');
  add.run(ACCOUNT, '2099-01-02', -1250, ACH, 'ui3-k1');
  add.run(ACCOUNT, '2099-01-03', -1250, WIRE, 'ui3-k2');
});
after(() => store?.close());

test('Confirm account context lists recent rows by readable name, keeping the raw text, date and amount', () => {
  const detail = cardDetail(store.db, { kind: 'account_owner', subject: ACCOUNT });
  const recent = detail.account?.recent ?? detail.recent;
  assert.ok(Array.isArray(recent) && recent.length >= 2, 'recent rows are listed');
  const [wire, ach] = recent;
  assert.deepEqual([wire.description, wire.name, wire.date, wire.amount], [WIRE, 'Wire to Sample Trading', '2099-01-03', -1250]);
  assert.deepEqual([ach.description, ach.name], [ACH, 'Gusto payroll (net)']);
});

test('Confirm near-duplicate comparisons carry each entry\'s readable name beside its raw description', () => {
  const detail = cardDetail(store.db, { kind: 'near_duplicate', subject: 'ui3-k1|ui3-k2', context: { keys: ['ui3-k1', 'ui3-k2'] } });
  assert.deepEqual(detail.entries.map((e) => [e.description, e.name]), [[ACH, 'Gusto payroll (net)'], [WIRE, 'Wire to Sample Trading']]);
});

test('Ask blocks that pick a transaction\'s merchant show its readable name, and compare options are labeled by it', () => {
  const rows = [ACH, WIRE].map((description, i) => ({ id: `t${i}`, date: '2099-01-0' + (i + 2), amount: -1250, description, merchant: normalizeMerchant(description), accountId: ACCOUNT }));
  const calls = [{ name: 'transactions', args: { operation: 'search' }, result: { rows } }];
  const source = { tool: 'transactions', args: { operation: 'search' }, path: 'rows' };
  const table = buildSnapshot('table', { source, columns: ['date', 'merchant', 'amount'] }, calls);
  const merchant = table.rows.map((r) => r.cells[1]);
  assert.deepEqual(merchant.map((c) => [c.text, c.name, c.raw]), rows.map((r, i) => [r.merchant, ['Gusto payroll (net)', 'Wire to Sample Trading'][i], r.description]));
  const compare = buildSnapshot('compare', { source, fields: ['merchant', 'amount'] }, calls);
  assert.deepEqual(compare.options.map((o) => o.label), ['Gusto payroll (net)', 'Wire to Sample Trading']);
});

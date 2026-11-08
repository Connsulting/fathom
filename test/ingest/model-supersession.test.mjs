import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, upload, approve, transactions } from '../helpers/model-cutover.mjs';
import { recipe } from '../helpers/model-import.mjs';

test('same bytes reinterpret only replace active rows after approval and preserve history', async () => {
  const x = await setup();
  try {
    const r = await upload(x, transactions()); await approve(x, r);
    const layout = recipe(); layout.tables[0].fields.amount.transform = { op: 'sign', mode: 'negate' };
    const next = await upload(x, transactions(), layout, { reinterpret: true });
    assert.equal(next.status, 'needs_confirmation');
    assert.deepEqual(x.db.prepare('SELECT amount FROM transactions').all().map(r => r.amount), [-12.25, -12.25]);
    await approve(x, next);
    assert.deepEqual(x.db.prepare('SELECT amount FROM transactions').all().map(r => r.amount), [12.25, 12.25]);
    assert.equal(x.db.prepare('SELECT count(*) n FROM superseded_rows').get().n, 2);
  } finally { x.close(); }
});

import { importProposedRows } from '../helpers/import-proposal-fixture.mjs';
const pnl = (period, category, amount) => ({ target: 'pnl', purpose: 'business', fields: { entity: 'Synthetic studio', period, category, amount, basis: 'cash' } });
test('corrected overlapping files remove only complete represented groups, retain other periods, and archive revisions', async () => {
  const x = await setup();
  try {
    x.db.prepare('INSERT INTO entity_aliases(alias,entity,created_at) VALUES (?,?,?)').run('syntheticstudio', 'Synthetic studio', x.ctx.now);
    await importProposedRows(x, [pnl('2032-02','Income',100), pnl('2032-02','Travel',-20), pnl('2032-03','Income',120)]);
    const next = await importProposedRows(x, [pnl('2032-02','Income',110)]);
    assert.equal(next.status, 'imported');
    assert.deepEqual(x.db.prepare('SELECT period,category,amount FROM pnl_lines ORDER BY period,category').all().map(r => [r.period,r.category,r.amount]), [['2032-02','Income',110],['2032-03','Income',120]]);
    assert.equal(x.db.prepare("SELECT count(*) n FROM superseded_rows WHERE reason IN ('revised','removed')").get().n, 2);
  } finally { x.close(); }
});

test('month-precision tax revisions retain tax year basis, recipient and full source history', async () => {
  const x = await setup();
  try {
    const payment = amount => ({ target: 'tax_payment', kind: 'estimate', status: 'paid', datePrecision: 'month', fields: {
      jurisdiction: 'federal', payer: 'Synthetic payer', recipient: 'you', amount, taxYear: 2031, taxYearBasis: 'confirmed_tax_year', paymentDate: '2032-01-31',
    } });
    const first = await importProposedRows(x,[payment(250)]);
    const second = await importProposedRows(x,[payment(275)]);
    const stored = x.db.prepare('SELECT * FROM tax_payments').get();
    assert.equal(stored.amount,275); assert.equal(stored.tax_year,2031);
    assert.equal(stored.date_precision,'month'); assert.equal(stored.tax_year_basis,'confirmed_tax_year');
    assert.equal(stored.date,'2032-01-31'); assert.equal(stored.file_id,second.fileId);
    const archived = x.db.prepare("SELECT * FROM superseded_rows WHERE table_name='tax_payments' AND reason='revised'").get();
    assert.equal(JSON.parse(archived.row).amount,250); assert.equal(archived.file_id,first.fileId);
  } finally { x.close(); }
});

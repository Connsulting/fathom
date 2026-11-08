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

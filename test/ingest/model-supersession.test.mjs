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

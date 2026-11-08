import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, recipe } from '../helpers/model-import.mjs';
import { applyLayout, layoutContext } from '../../src/ingest/model-layout.mjs';
import { stageImport, reviewImport, reuseApprovedMapping } from '../../src/ingest/model-review.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { writeXlsx } from '../helpers/xlsx.mjs';

test('approved repeats apply every current row with no engine call or layout prompt while off', async () => {
  const x = await fixture();
  try {
    const source = await x.source();
    const staged = stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    await reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    const repeat = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-04,-7.00,Next synthetic purchase\n');
    const out = await reuseApprovedMapping(x.ctx, { source: repeat, layout: recipe() });
    assert.equal(out.status, 'imported'); assert.equal(out.confirmationRequired, false);
    assert.equal(x.db.prepare('SELECT sum(amount) n FROM transactions').get().n, -17);
    const mapping = x.db.prepare('SELECT mapping FROM column_mappings').get().mapping;
    assert.ok(!mapping.includes('12.25')); assert.ok(!mapping.includes('2032-03-02'));
  } finally { x.close(); }
});

test('column, sign, unit, and same-header context changes hold and return only their delta', async () => {
  const x = await fixture();
  try {
    const source = await x.source();
    const staged = stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    await reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    for (const kind of ['column', 'sign', 'unit', 'target']) {
      const layout = recipe();
      if (kind === 'sign') layout.tables[0].fields.amount.transform = { op: 'sign', mode: 'negate' };
      if (kind === 'unit') layout.currency = 'EUR';
      if (kind === 'target') layout.tables[0].target = 'balance';
      const repeat = await x.source(`Account,Date,Amount USD,Description${kind === 'column' ? ',Credit' : ''}\naccount-synthetic,2032-03-0${kind === 'column' ? 5 : kind === 'sign' ? 6 : kind === 'unit' ? 7 : 8},-8.00,Synthetic row${kind === 'column' ? ',1.00' : ''}\n`);
      const out = await reuseApprovedMapping(x.ctx, { source: repeat, layout });
      assert.equal(out.status, 'needs_clarification');
      assert.ok(out.delta.length); assert.ok(out.preserved);
      assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 2);
    }
  } finally { x.close(); }
});

test('new populated sheets and reordered columns are structural changes, row amounts are not', async () => {
  const file = sheets => ({ fileId: 'f-synthetic', format: 'xlsx', bytes: writeXlsx(sheets) });
  const layout = recipe(); layout.tables[0].sheet = 0;
  const a = await indexSource(file([{ name: 'Synthetic', rows: [['Account', 'Date', 'Amount USD', 'Description'], ['account-synthetic', '2032-03-02', 5, 'Synthetic']] }]));
  const b = await indexSource(file([{ name: 'Synthetic', rows: [['Account', 'Date', 'Amount USD', 'Description'], ['account-synthetic', '2032-03-03', 9, 'Synthetic']] }]));
  const c = await indexSource(file([{ name: 'Synthetic', rows: [['Date', 'Account', 'Amount USD', 'Description'], ['2032-03-02', 'account-synthetic', 5, 'Synthetic']] }, { name: 'Extra', rows: [[9]] }]));
  assert.deepEqual(layoutContext(a, layout), layoutContext(b, layout));
  assert.notDeepEqual(layoutContext(a, layout), layoutContext(c, layout));
});

test('same headers and bytes in a second household cannot reuse another household approval', async () => {
  const a = await fixture(), b = await fixture();
  try {
    const source = await a.source(), staged = stageImport(a.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    await reviewImport(a.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    const foreign = await b.source();
    const result = await reuseApprovedMapping(b.ctx, { source: foreign, layout: recipe() });
    assert.equal(result.status, 'needs_clarification');
    assert.equal(b.db.prepare('SELECT count(*) n FROM column_mappings').get().n, 0);
    assert.equal(b.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
    await assert.rejects(reviewImport(b.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'not_found');
  } finally { a.close(); b.close(); }
});

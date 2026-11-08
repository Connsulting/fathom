import test from 'node:test';
import assert from 'node:assert/strict';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { fixture, recipe } from '../helpers/model-import.mjs';
import { stageImport, reviewImport, prepareImport } from '../../src/ingest/model-review.mjs';

test('mapping uses column ordinals even when header labels repeat', async () => {
  const source = await indexSource({ fileId: 'f-synthetic', format: 'csv', bytes: Buffer.from('Value,Value,Value,Value\naccount-synthetic,2032-03-02,-4,Synthetic expense\n') });
  const p = applyLayout(source, recipe());
  assert.deepEqual(p.rows[0].fields.amount.refs, ['r6']);
  assert.deepEqual(p.rows[0].fields.accountId.refs, ['r4']);
});
test('a saved approved layout revalidates and imports locally without another confirmation', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), layout = recipe();
    const staged = stageImport(x.ctx, { source, proposal: applyLayout(source, layout), layout });
    await reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    const next = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-05,-2.50,Synthetic next expense\nTotal,,-2.50,Control total\n');
    const r = await prepareImport(x.ctx, { file: { fileId: next.fileId, format: 'csv', bytes: next.bytes } });
    assert.equal(r.status, 'imported'); assert.equal(r.confirmationRequired, false);
    assert.equal(x.db.prepare('SELECT count(*) n FROM import_model_spend').get().n, 0);
  } finally { x.close(); }
});

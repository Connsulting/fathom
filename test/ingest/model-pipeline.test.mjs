import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, upload, approve, transactions } from '../helpers/model-cutover.mjs';
import { setSetting } from '../../src/store/db.mjs';
import { ingestFile } from '../../src/ingest/pipeline.mjs';

test('nonstandard upload stages, approval preserves repeated occurrences, repeat bytes deduplicate', async () => {
  const x = await setup();
  try {
    const r = await upload(x, transactions());
    assert.equal(r.status, 'needs_confirmation');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
    const out = await approve(x, r);
    assert.equal(out.counts.rows.transaction, 2);
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 2);
    const repeat = await upload(x, transactions());
    assert.equal(repeat.status, 'duplicate');
    assert.equal(x.db.prepare('SELECT count(*) n FROM import_model_spend').get().n, 1);
  } finally { x.close(); }
});
test('unknown files with the engine off wait without writes and raw scans are withheld', async () => {
  const x = await setup();
  try {
    setSetting(x.db, 'engine', { on: false });
    const r = await ingestFile(x.db, { name: 'unknown.csv', bytes: Buffer.from('One,Two\na,b\n') }, x.opts);
    assert.equal(r.status, 'waiting_for_engine');
    const pdf = await ingestFile(x.db, { name: 'scan.pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF'), mime: 'application/pdf' }, x.opts);
    assert.equal(pdf.status, 'needs_source_text');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
  } finally { x.close(); }
});

test('typed note facts use shared actions, require their scope, and expose grouped Undo', async () => {
  const { createHash } = await import('node:crypto');
  const { indexSource } = await import('../../src/ingest/model-source.mjs');
  const { undoAction } = await import('../../src/actions/receipts.mjs');
  const x = await setup();
  try {
    const bytes = Buffer.from('single\n2032-03-01\nowner\n'), fileId = 'f-' + createHash('sha256').update(bytes).digest('hex').slice(0,24);
    const source = await indexSource({ fileId, bytes, format: 'text' });
    const find = value => Object.keys(source.values).find(id => String(source.values[id]).trim() === value);
    const ref = value => ({ refs: [find(value)], transform: { op: 'trim' } });
    const output = { rows: [{ target: 'fact', key: 'household.filingStatus', scope: 'household', datePrecision: 'day', fields: {
      value: ref('single'), asOf: ref('2032-03-01'), subject: ref('owner'),
    } }], completeness: 'complete', coverage: source.regions.map(regionId => ({ regionId, refs: source.inventory[regionId].refs, disposition: 'imported_detail' })) };
    const staged = await ingestFile(x.db, { name: 'state.txt', bytes }, { ...x.opts, fake: [{ text: JSON.stringify(output), costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 40 } }] });
    assert.equal(staged.status, 'needs_confirmation', JSON.stringify(staged));
    await assert.rejects(approve(x,staged), e => e.code === 'forbidden');
    x.ctx.scopes.push('write:facts');
    const approved = await approve(x,staged);
    assert.deepEqual(approved.receipt.scopes, ['write:facts','write:imports']);
    assert.equal(JSON.parse(x.db.prepare("SELECT value FROM facts WHERE key='household.filingStatus'").get().value), 'single');
    await assert.rejects(undoAction({ ...x.ctx, scopes: ['write:imports'] }, approved.receipt.id, 'write:imports'), e => e.code === 'forbidden');
    await undoAction(x.ctx, approved.receipt.id, 'write:imports');
    assert.equal(x.db.prepare('SELECT count(*) n FROM facts').get().n, 0);
  } finally { x.close(); }
});

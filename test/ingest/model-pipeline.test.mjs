import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, upload, approve, transactions } from '../helpers/model-cutover.mjs';
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
    x.household.engine.setOn?.(false);
    x.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('engine','{\"on\":false}')").run();
    const r = await ingestFile(x.db, { name: 'unknown.csv', bytes: Buffer.from('One,Two\na,b\n') }, x.opts);
    assert.equal(r.status, 'waiting_for_engine');
    const pdf = await ingestFile(x.db, { name: 'scan.pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF'), mime: 'application/pdf' }, x.opts);
    assert.equal(pdf.status, 'needs_source_text');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
  } finally { x.close(); }
});

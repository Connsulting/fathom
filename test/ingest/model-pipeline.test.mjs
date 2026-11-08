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
    const { retryFile } = await import('../../src/ingest/pipeline.mjs');
    const again = await retryFile(x.db,fileId,{ ...x.opts, scopes: x.ctx.scopes });
    assert.equal(again.status,'needs_confirmation');
    assert.equal(x.db.prepare('SELECT count(*) n FROM facts').get().n,0);
  } finally { x.close(); }
});

test('resolved accounts scope external ids independently even with equal display names', async () => {
  const { recipe } = await import('../helpers/model-import.mjs');
  const x = await setup();
  try {
    x.db.prepare("INSERT INTO accounts(id,name,inst,kind,owner,identity) VALUES ('account-second','Synthetic account','Example bank','cash','you','synthetic-second')").run();
    const layout = recipe(); layout.tables[0].fields.externalId = { columns: [5], transform: { op: 'trim' } };
    const text = 'Account,Date,Amount USD,Description,Reference\n' +
      'account-synthetic,2032-03-02,-12.25,Synthetic purchase,reference-one\n' +
      'account-synthetic,2032-03-02,-12.25,Synthetic purchase,reference-one\n' +
      'account-second,2032-03-02,-12.25,Synthetic purchase,reference-one\n';
    const staged = await upload(x,text,layout); assert.equal(staged.status,'needs_confirmation');
    await approve(x,staged);
    assert.deepEqual(x.db.prepare('SELECT account_id,count(*) n FROM transactions GROUP BY account_id ORDER BY account_id').all().map(r => [r.account_id,r.n]), [['account-second',1],['account-synthetic',2]]);
    assert.deepEqual(x.db.prepare('SELECT occurrence FROM transactions WHERE account_id=?').all('account-second').map(r => r.occurrence), [1]);
  } finally { x.close(); }
});

test('model rows and standard exports retain the same semantic posting identity', async () => {
  const { recipe } = await import('../helpers/model-import.mjs');
  const { activityFile } = await import('../helpers/ingest.mjs');
  const x = await setup();
  try {
    await ingestFile(x.db, activityFile('Chase0042_Activity.csv', [{ date: '03/02/2032', amount: '-12.25', description: 'Synthetic purchase', check: '1042' }]), x.opts);
    const account = x.db.prepare("SELECT id FROM accounts WHERE mask='0042'").get();
    const layout = recipe(); layout.tables[0].fields.externalId = { columns: [5], transform: { op: 'trim' } };
    const staged = await upload(x, `Account,Date,Amount USD,Description,Reference\n${account.id},2032-03-02,-12.25,Synthetic purchase,1042\n`, layout);
    const r = await approve(x,staged);
    assert.equal(r.counts.duplicates, 1);
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 1);
  } finally { x.close(); }
});

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
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 0);
    const out = await approve(x, r);
    assert.equal(out.counts.rows.transaction, 2);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 2);
    const repeat = await upload(x, transactions());
    assert.equal(repeat.status, 'duplicate');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM import_model_spend').get()).n, 1);
  } finally { await x.close(); }
});
test('unknown files with the engine off wait without writes and raw scans are withheld', async () => {
  const x = await setup();
  try {
    await setSetting(x.db, 'engine', { on: false });
    const r = await ingestFile(x.db, { name: 'unknown.csv', bytes: Buffer.from('One,Two\na,b\n') }, x.opts);
    assert.equal(r.status, 'waiting_for_engine');
    const pdf = await ingestFile(x.db, { name: 'scan.pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF'), mime: 'application/pdf' }, x.opts);
    assert.equal(pdf.status, 'needs_source_text');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 0);
  } finally { await x.close(); }
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
    assert.equal(JSON.parse((await x.db.prepare("SELECT value FROM facts WHERE key='household.filingStatus'").get()).value), 'single');
    await assert.rejects(undoAction({ ...x.ctx, scopes: ['write:imports'] }, approved.receipt.id, 'write:imports'), e => e.code === 'forbidden');
    await undoAction(x.ctx, approved.receipt.id, 'write:imports');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM facts').get()).n, 0);
    const { retryFile } = await import('../../src/ingest/pipeline.mjs');
    const again = await retryFile(x.db,fileId,{ ...x.opts, scopes: x.ctx.scopes });
    assert.equal(again.status,'needs_confirmation');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM facts').get()).n,0);
  } finally { await x.close(); }
});

test('resolved accounts scope external ids independently even with equal display names', async () => {
  const { recipe } = await import('../helpers/model-import.mjs');
  const x = await setup();
  try {
    await x.db.prepare("INSERT INTO accounts(id,name,inst,kind,owner,identity) VALUES ('account-second','Synthetic account','Example bank','cash','you','synthetic-second')").run();
    const layout = recipe(); layout.tables[0].fields.externalId = { columns: [5], transform: { op: 'trim' } };
    const text = 'Account,Date,Amount USD,Description,Reference\n' +
      'account-synthetic,2032-03-02,-12.25,Synthetic purchase,reference-one\n' +
      'account-synthetic,2032-03-02,-12.25,Synthetic purchase,reference-one\n' +
      'account-second,2032-03-02,-12.25,Synthetic purchase,reference-one\n';
    const staged = await upload(x,text,layout); assert.equal(staged.status,'needs_confirmation');
    await approve(x,staged);
    assert.deepEqual((await x.db.prepare('SELECT account_id,count(*) n FROM transactions GROUP BY account_id ORDER BY account_id').all()).map(r => [r.account_id,r.n]), [['account-second',1],['account-synthetic',2]]);
    assert.deepEqual((await x.db.prepare('SELECT occurrence FROM transactions WHERE account_id=?').all('account-second')).map(r => r.occurrence), [1]);
  } finally { await x.close(); }
});

test('model rows and standard exports retain the same semantic posting identity', async () => {
  const { recipe } = await import('../helpers/model-import.mjs');
  const { activityFile } = await import('../helpers/ingest.mjs');
  const x = await setup();
  try {
    await ingestFile(x.db, activityFile('Chase0042_Activity.csv', [{ date: '03/02/2032', amount: '-12.25', description: 'Synthetic purchase', check: '1042' }]), x.opts);
    const account = await x.db.prepare("SELECT id FROM accounts WHERE mask='0042'").get();
    const layout = recipe(); layout.tables[0].fields.externalId = { columns: [5], transform: { op: 'trim' } };
    const staged = await upload(x, `Account,Date,Amount USD,Description,Reference\n${account.id},2032-03-02,-12.25,Synthetic purchase,1042\n`, layout);
    const r = await approve(x,staged);
    assert.equal(r.counts.duplicates, 1);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 1);
  } finally { await x.close(); }
});

test('source groups retain financial freshness when an unrelated note is approved', async () => {
  const { importProposedRows } = await import('../helpers/import-proposal-fixture.mjs');
  const { sourceStates } = await import('../../src/ingest/coverage.mjs');
  const x = await setup();
  try {
    await importProposedRows(x,[{ target: 'balance', basis: 'closing', datePrecision: 'day', fields: { accountId: 'account-synthetic', asOf: '2032-03-01', amount: 100 } }]);
    const source = await x.db.prepare("SELECT * FROM sources WHERE kind='balances'").get();
    await importProposedRows(x,[],{ marker: 'Synthetic explanatory note' });
    assert.deepEqual(await x.db.prepare('SELECT * FROM sources WHERE id=?').get(source.id),source);
    assert.equal((await sourceStates(x.db,'2032-03-10')).sources.get(source.id).state,'fresh');
    assert.equal((await x.db.prepare("SELECT count(*) n FROM sources WHERE substr(id,1,4)='ing:'").get()).n,2);
  } finally { await x.close(); }
});


test('typed withholding recipients reach the planner in the filing unit and joint rows stay held for a single filer', async () => {
  const { importProposedRows } = await import('../helpers/import-proposal-fixture.mjs');
  const { loadPlanningData } = await import('../../src/jobs/planner/data.mjs');
  const { classifyPayments } = await import('../../src/jobs/planner/payments.mjs');
  const x = await setup();
  try {
    const rows = ['you','spouse','joint'].map((recipient,i)=>({target:'tax_payment',kind:'withholding',status:'paid',datePrecision:'month',fields:{jurisdiction:'federal',payer:'Synthetic payer '+i,recipient,amount:100,taxYear:2032,taxYearBasis:'confirmed_tax_year',paymentDate:'2032-01-31'}}));
    const imported = await importProposedRows(x,rows);
    assert.equal(imported.status,'imported');
    const data = await loadPlanningData(x.db,'2032-03-10');
    const joint = classifyPayments(data,{persons:['owner','spouse'],f:'mfj',isVa:true});
    assert.equal(joint.fed.withheld.total,300);
    assert.equal(joint.fed.withheld.blocked,null);
    const single = classifyPayments(data,{persons:['owner'],f:'single',isVa:true});
    assert.equal(single.fed.withheld.blocked,'withholding_recipient_unknown');
  } finally { await x.close(); }
});

test('a tax source cannot overwrite an estimate with withholding under the same frozen payment identity', async () => {
  const { importProposedRows } = await import('../helpers/import-proposal-fixture.mjs');
  const x = await setup();
  try {
    const payment = kind => ({target:'tax_payment',kind,status:'paid',datePrecision:'month',fields:{jurisdiction:'federal',payer:'Synthetic payer',recipient:'you',amount:100,taxYear:2032,taxYearBasis:'confirmed_tax_year',paymentDate:'2032-01-31'}});
    const mixed = await importProposedRows(x,[payment('estimate'),payment('withholding')]);
    assert.equal(mixed.status,'needs_clarification');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM tax_payments').get()).n,0);
    await importProposedRows(x,[payment('estimate')]);
    const next = await importProposedRows(x,[payment('withholding')]);
    assert.equal(next.status,'needs_clarification');
    assert.equal((await x.db.prepare('SELECT kind FROM tax_payments').get()).kind,'estimate');
  } finally { await x.close(); }
});


test('corrected typed withholding uses the existing recipient conflict safeguards', async () => {
  const { importProposedRows } = await import('../helpers/import-proposal-fixture.mjs');
  const { loadPlanningData } = await import('../../src/jobs/planner/data.mjs');
  const { classifyPayments } = await import('../../src/jobs/planner/payments.mjs');
  const { pendingItems, answer } = await import('../../src/ingest/confirm.mjs');
  const x = await setup();
  try {
    const payment = amount => ({target:'tax_payment',kind:'withholding',status:'paid',datePrecision:'month',fields:{jurisdiction:'federal',payer:'Synthetic payer',recipient:'you',amount,taxYear:2032,taxYearBasis:'confirmed_tax_year',paymentDate:'2032-01-31'}});
    await importProposedRows(x,[payment(100)]);
    await importProposedRows(x,[payment(125)]);
    const item = (await pendingItems(x.db)).find(item=>item.kind==='withholding_conflict');
    assert.ok(item,'different withholding amounts require a choice');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM tax_payments').get()).n,2);
    const classify = async ()=>classifyPayments(await loadPlanningData(x.db,'2032-03-10'),{persons:['owner','spouse'],f:'mfj',isVa:true});
    assert.equal((await classify()).fed.withheld.blocked,'withholding_conflict_pending');
    await answer(x.db,item.id,'second',{now:x.ctx.now});
    assert.equal((await classify()).fed.withheld.blocked,null);
    assert.equal((await classify()).fed.withheld.total,125);
  } finally { await x.close(); }
});

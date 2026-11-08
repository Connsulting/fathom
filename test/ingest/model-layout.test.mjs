import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, recipe } from '../helpers/model-import.mjs';
import { applyLayout, layoutContext } from '../../src/ingest/model-layout.mjs';
import { stageImport, reviewImport, reuseApprovedMapping, prepareImport } from '../../src/ingest/model-review.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { writeXlsx } from '../helpers/xlsx.mjs';
import { setOutbound } from '../../src/platform/outbound.mjs';
import { setInstanceCap } from '../../src/platform/model-budget.mjs';

test('approved repeats apply every current row with no engine call or layout prompt while off', async () => {
  const x = await fixture();
  try {
    const source = await x.source();
    const staged = await stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    await reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    const repeat = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-04,-7.00,Next synthetic purchase\n');
    const out = await reuseApprovedMapping(x.ctx, { source: repeat, layout: recipe() });
    assert.equal(out.status, 'imported'); assert.equal(out.confirmationRequired, false);
    assert.equal((await x.db.prepare('SELECT sum(amount) n FROM transactions').get()).n, -17);
    const mapping = (await x.db.prepare('SELECT mapping FROM column_mappings').get()).mapping;
    assert.ok(!mapping.includes('12.25')); assert.ok(!mapping.includes('2032-03-02'));
  } finally { x.close(); }
});

test('column, sign, unit, and same-header context changes hold and return only their delta', async () => {
  const x = await fixture();
  try {
    const source = await x.source();
    const staged = await stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
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
      assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 2);
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
    const source = await a.source(), staged = await stageImport(a.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    await reviewImport(a.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    const foreign = await b.source();
    const result = await reuseApprovedMapping(b.ctx, { source: foreign, layout: recipe() });
    assert.equal(result.status, 'needs_clarification');
    assert.equal((await b.db.prepare('SELECT count(*) n FROM column_mappings').get()).n, 0);
    assert.equal((await b.db.prepare('SELECT count(*) n FROM transactions').get()).n, 0);
    await assert.rejects(reviewImport(b.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'not_found');
  } finally { a.close(); b.close(); }
});

test('prepareImport discovers its approved layout from headers with no caller recipe or engine call', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), staged = await stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    await reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    const s = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-19,-9,Synthetic automatic repeat\n');
    const out = await prepareImport(x.ctx, { file: { fileId: s.fileId, format: s.format, bytes: s.bytes } });
    assert.equal(out.status, 'imported'); assert.equal(out.confirmationRequired, false);
    assert.equal((await x.db.prepare('SELECT sum(amount) n FROM transactions').get()).n, -19);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM import_model_spend').get()).n, 0);
  } finally { x.close(); }
});

test('multiple approved layouts retain only the relevant changed-header delta across reads', async () => {
  const x = await fixture();
  try {
    for (const [labels, date] of [['Account,Date,Amount USD,Description', '2032-03-02'], ['Reference,Posted,Value USD,Memo', '2032-03-12']]) {
      const source = await x.source(`${labels}\naccount-synthetic,${date},-3,Synthetic seed\n`);
      const staged = await stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
      await reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    }
    const source = await x.source('Account,Date,Amount USD,Description,Credit\naccount-synthetic,2032-03-22,-4,Synthetic changed layout,0\n');
    const file = { fileId: source.fileId, format: source.format, bytes: source.bytes };
    const held = await prepareImport(x.ctx, { file });
    assert.equal(held.status, 'needs_clarification');
    assert.ok(held.delta.some(d => d.field.includes('headers')));
    assert.deepEqual(held.preserved.layout, recipe());
    assert.ok(held.preserved.bindings.includes('account-synthetic'));
    const again = await prepareImport(x.ctx, { file });
    assert.deepEqual(again.delta, held.delta); assert.deepEqual(again.preserved, held.preserved);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM import_model_spend').get()).n, 0);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 2);
  } finally { x.close(); }
});

test('identical headers stay uniquely bound to the right account context', async () => {
  const x = await fixture();
  try {
    await x.db.prepare("INSERT INTO accounts (id,name,inst,kind,owner,identity) VALUES ('account-second','Second synthetic account','Other example bank','cash','spouse','second-synthetic-account')").run();
    for (const [id, date] of [['account-synthetic', '2032-03-11'], ['account-second', '2032-03-12']]) {
      const source = await x.source(`Account,Date,Amount USD,Description\n${id},${date},-3,Synthetic seed\n`);
      const p = await stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
      await reviewImport(x.ctx, { proposalId: p.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    }
    const repeat = await x.source('Account,Date,Amount USD,Description\naccount-second,2032-03-21,-7,Second account repeat\n');
    assert.equal((await prepareImport(x.ctx, { file: { fileId: repeat.fileId, format: repeat.format, bytes: repeat.bytes } })).status, 'imported');
    const changed = await x.source('Account,Date,Amount USD,Description,Credit\naccount-synthetic,2032-03-24,-4,Synthetic delta,0\n');
    const result = await prepareImport(x.ctx, { file: { fileId: changed.fileId, format: changed.format, bytes: changed.bytes } });
    assert.equal(result.status, 'needs_clarification');
    assert.deepEqual(result.preserved.bindings, ['account-synthetic']);
    assert.ok(result.delta.some(d => d.field.includes('headers')));
  } finally { x.close(); }
});

test('an approved sign correction creates a newer mapping version for automatic use', async () => {
  const x = await fixture();
  try {
    const source = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-11,-3,Synthetic seed\n');
    const p = await stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    await reviewImport(x.ctx, { proposalId: p.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    const next = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-12,-7,Synthetic revised sign\n');
    const layout = recipe(); layout.tables[0].fields.amount.transform = { op: 'sign', mode: 'negate' };
    const updated = await prepareImport(x.ctx, { file: { fileId: next.fileId, format: next.format, bytes: next.bytes }, layout });
    assert.equal(updated.status, 'needs_confirmation'); assert.ok(updated.delta.some(d => d.field.includes('transform')));
    await reviewImport(x.ctx, { proposalId: updated.proposalId, version: updated.version, decision: 'approve', evidence: 'yes' });
    assert.equal((await x.db.prepare("SELECT mapping_version FROM column_mappings WHERE approval_status='approved'").get()).mapping_version, 2);
    assert.equal((await x.db.prepare("SELECT count(*) n FROM column_mappings WHERE approval_status='invalidated'").get()).n, 1);
    const repeat = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-13,-9,Synthetic newer repeat\n');
    assert.equal((await prepareImport(x.ctx, { file: { fileId: repeat.fileId, format: repeat.format, bytes: repeat.bytes } })).status, 'imported');
    assert.equal((await x.db.prepare("SELECT amount FROM transactions WHERE date='2032-03-13'").get()).amount, 9);
  } finally { x.close(); }
});

test('non-USD layouts wait with a reason code rather than throwing or dispatching', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), layout = recipe(); layout.currency = 'EUR';
    const out = await prepareImport(x.ctx, { file: { fileId: source.fileId, format: source.format, bytes: source.bytes }, layout });
    assert.equal(out.status, 'needs_clarification'); assert.equal(out.reasonCode, 'unsupported_currency');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 0);
  } finally { x.close(); }
});

test('first preparation stages the engine layout, then header discovery repeats with engine paused', async () => {
  const x = await fixture({ engine: 'fake' });
  try {
    await setOutbound(x.platform, x.householdId, { engine: true }); await setInstanceCap(x.platform, 10);
    const source = await x.source(), mapped = applyLayout(source, recipe());
    const output = { rows: mapped.rows, coverage: mapped.coverage, completeness: mapped.completeness, controls: mapped.controls, layout: recipe() };
    const first = await prepareImport(x.ctx, { file: { fileId: source.fileId, format: source.format, bytes: source.bytes },
      fake: [{ text: JSON.stringify(output), costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 30 } }] });
    assert.equal(first.status, 'needs_confirmation', JSON.stringify(first));
    await reviewImport(x.ctx, { proposalId: first.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    await setOutbound(x.platform, x.householdId, { engine: false });
    const repeat = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-28,-9,New automatic source\n');
    assert.equal((await prepareImport(x.ctx, { file: { fileId: repeat.fileId, format: repeat.format, bytes: repeat.bytes } })).status, 'imported');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM import_model_spend').get()).n, 1);
  } finally { x.close(); }
});

test('a model layout disagreeing with its cited rows stays held without active writes', async () => {
  const x = await fixture({ engine: 'fake' });
  try {
    await setOutbound(x.platform, x.householdId, { engine: true }); await setInstanceCap(x.platform, 10);
    const source = await x.source(), mapped = applyLayout(source, recipe()), layout = recipe();
    layout.tables[0].fields.amount.columns = [2];
    const first = await prepareImport(x.ctx, { file: { fileId: source.fileId, format: source.format, bytes: source.bytes },
      fake: [{ text: JSON.stringify({ rows: mapped.rows, coverage: mapped.coverage, completeness: mapped.completeness, controls: mapped.controls, layout }),
        costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 30 } }] });
    assert.equal(first.status, 'needs_clarification'); assert.equal(first.reasonCode, 'layout_mismatch');
    await assert.rejects(reviewImport(x.ctx, { proposalId: first.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'bad_input');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 0);
  } finally { x.close(); }
});

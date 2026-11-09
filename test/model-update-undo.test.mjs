import test from 'node:test';
import assert from 'node:assert/strict';
import { updateFixture } from './helpers/model-updates.mjs';
import { stageUpdate } from '../src/ingest/model-updates.mjs';
import { reviewImport } from '../src/ingest/model-review.mjs';
import { proposalBasis } from '../src/actions/proposals.mjs';
import { callTool } from '../src/tools/index.mjs';
import { currentHandle } from '../src/storage/index.mjs';

async function apply(x, actions = [x.step, x.expected]) {
  const p = await stageUpdate(x.ctx, { source: x.source, actions, capturedAt: '2032-03-02T14:00:00Z' });
  return reviewImport({ ...x.ctx, ownerText: 'yes' }, { proposalId: p.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
}

test('group approval and Undo preflight all scopes and actors without partial writes', async () => {
  const x = await updateFixture();
  try {
    const p = await stageUpdate(x.ctx, { source: x.source, actions: [x.step, x.expected], capturedAt: '2032-03-02T14:00:00Z' });
    const request = { proposalId: p.proposalId, version: 1, decision: 'approve', evidence: 'yes' };
    await assert.rejects(reviewImport({ ...x.ctx, ownerText: 'yes', scopes: ['write:imports'] }, request), /write:steps/);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM action_receipts').get()).n, 0);
    const result = await reviewImport({ ...x.ctx, ownerText: 'yes' }, request);
    for (const ctx of [{ ...x.ctx, scopes: ['write:imports'] }, { ...x.ctx, actorId: 'foreign' }]) {
      await assert.rejects(callTool('undo', { operation: 'undo', id: result.receipt.id }, ctx));
      assert.equal((await x.db.prepare('SELECT count(*) n FROM expected_transactions').get()).n, 1);
    }
    await callTool('undo', { operation: 'undo', id: result.receipt.id }, x.ctx);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM expected_transactions').get()).n, 0);
    assert.deepEqual(JSON.parse((await x.db.prepare("SELECT tasks_done FROM recs WHERE id='payroll'").get()).tasks_done), []);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM files').get()).n, 1);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM action_receipts WHERE undone_at IS NOT NULL').get()).n, 3);
  } finally { await x.close(); }
});

test('stale child Undo and a later direct child Undo refuse the whole group', async () => {
  for (const stale of ['step', 'child']) {
    const x = await updateFixture();
    try {
      const result = await apply(x);
      if (stale === 'step') await x.db.prepare("UPDATE recs SET tasks_done='[false]' WHERE id='payroll'").run();
      else {
        const child = await x.db.prepare("SELECT id FROM action_receipts WHERE kind='expected_transaction'").get();
        await assert.rejects(callTool('undo', { operation: 'undo', id: child.id }, x.ctx), /grouped Undo/);
        await x.db.prepare('UPDATE action_receipts SET undone_at=? WHERE id=?').run(x.ctx.now, child.id);
      }
      await assert.rejects(callTool('undo', { operation: 'undo', id: result.receipt.id }, x.ctx), /changed|undone/);
      assert.equal((await x.db.prepare('SELECT undone_at FROM action_receipts WHERE id=?').get(result.receipt.id)).undone_at, null);
      if (stale === 'step') assert.equal((await x.db.prepare('SELECT count(*) n FROM expected_transactions').get()).n, 1);
    } finally { await x.close(); }
  }
});

test('facts and goals use shared actions, defer planning, and require their child scopes for Undo', async () => {
  const text = 'Set expected date to 2032-06-19 and create a reserve goal of $64000.';
  const x = await updateFixture(text);
  try {
    let planned = 0;
    x.ctx.replan = async () => { assert.equal(currentHandle(x.db), x.db); planned++; return { status: 'ok' }; };
    const actions = [
      { tool: 'answer', operation: 'fact', args: { key: 'household.expectedDate', value: '2032-06-19', evidence: 'expected date to 2032-06-19' }, span: x.span },
      { tool: 'update_goal', operation: 'create', args: { title: 'Reserve', target: 64000 }, span: x.span },
    ];
    const result = await apply(x, actions);
    assert.equal(planned, 1);
    assert.equal(JSON.parse((await x.db.prepare("SELECT value FROM facts WHERE key='household.expectedDate'").get()).value), '2032-06-19');
    assert.equal((await x.db.prepare('SELECT count(*) n FROM goals').get()).n, 1);
    assert.deepEqual(new Set((await x.db.prepare('SELECT kind FROM action_receipts').all()).map(r => r.kind)), new Set(['fact', 'goal', 'receipt_group']));
    await assert.rejects(callTool('undo', { operation: 'undo', id: result.receipt.id }, { ...x.ctx, scopes: ['write:imports', 'write:facts'] }), /write:goals/);
    await callTool('undo', { operation: 'undo', id: result.receipt.id }, x.ctx);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM goals').get()).n, 0);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM facts').get()).n, 0);
  } finally { await x.close(); }
});

test('a failed later shared action rolls back earlier actions and receipts', async () => {
  const x = await updateFixture();
  try {
    await assert.rejects(async () => await stageUpdate(x.ctx, { source: x.source, actions: [x.step, { ...x.expected, args: { ...x.expected.args, amount: 1234 } }], capturedAt: '2032-03-02T14:00:00Z' }));
    assert.equal((await x.db.prepare('SELECT count(*) n FROM action_receipts').get()).n, 0);
    assert.deepEqual(JSON.parse((await x.db.prepare("SELECT tasks_done FROM recs WHERE id='payroll'").get()).tasks_done), []);
  } finally { await x.close(); }
});

test('several steps in one recommendation undo in reverse order with one visible affordance', async () => {
  const x = await updateFixture();
  try {
    await x.db.prepare("UPDATE recs SET def=? WHERE id='payroll'").run(JSON.stringify({ tasks: [{ t: 'Payroll true-up' }, { t: 'Payroll check' }] }));
    const result = await apply(x, [x.step, { ...x.step, args: { ...x.step.args, index: 1 } }, x.expected]);
    await callTool('undo', { operation: 'undo', id: result.receipt.id }, x.ctx);
    assert.deepEqual(JSON.parse((await x.db.prepare("SELECT tasks_done FROM recs WHERE id='payroll'").get()).tasks_done), []);
  } finally { await x.close(); }
});

test('routine recommendation prose changes preserve step Undo while task changes still refuse', async () => {
  const x = await updateFixture();
  try {
    const result = await apply(x);
    await x.db.prepare("UPDATE recs SET def=json_set(def,'$.title','Updated plan prose') WHERE id='payroll'").run();
    await callTool('undo', { operation: 'undo', id: result.receipt.id }, x.ctx);
    assert.equal(JSON.parse((await x.db.prepare("SELECT def FROM recs WHERE id='payroll'").get()).def).title, 'Updated plan prose');
    assert.deepEqual(JSON.parse((await x.db.prepare("SELECT tasks_done FROM recs WHERE id='payroll'").get()).tasks_done), []);
  } finally { await x.close(); }
});

test('pending grouped Undo depends on its children and target rows rather than unrelated activity', async () => {
  const x = await updateFixture();
  try {
    const result = await apply(x);
    const input = { id: result.receipt.id };
    const before = await proposalBasis(x.db, 'undo', result.receipt.scopes, input);
    await x.db.prepare("INSERT INTO facts (key,value,updated_at) VALUES ('household.state','\"VA\"',?)").run(x.ctx.now);
    await x.db.prepare("INSERT INTO recs (id,def,status,updated_at) VALUES ('unrelated','{}','proposed',?)").run(x.ctx.now);
    assert.equal(await proposalBasis(x.db, 'undo', result.receipt.scopes, input), before);
    await x.db.prepare("UPDATE recs SET tasks_done='[false]' WHERE id='payroll'").run();
    assert.notEqual(await proposalBasis(x.db, 'undo', result.receipt.scopes, input), before);
  } finally { await x.close(); }
});

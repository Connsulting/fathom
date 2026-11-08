import test from 'node:test';
import assert from 'node:assert/strict';
import { updateFixture } from './helpers/model-updates.mjs';
import { stageUpdate } from '../src/ingest/model-updates.mjs';
import { reviewImport } from '../src/ingest/model-review.mjs';

const approve = (x, p, extra = {}) => reviewImport({ ...x.ctx, ownerText: 'looks right', ...extra }, { proposalId: p.proposalId, version: p.version, decision: 'approve', evidence: 'looks right' });

test('payroll note stages existing step and unknown payment, then explicitly approves both', async () => {
  const x = await updateFixture();
  try {
    const p = stageUpdate(x.ctx, { source: x.source, actions: [x.step, x.expected], capturedAt: '2032-03-02T14:00:00Z' });
    assert.equal(p.status, 'needs_confirmation');
    assert.match(JSON.stringify(p), /2032-03-09/);
    assert.match(JSON.stringify(p), /America\/New_York/);
    assert.equal(x.db.prepare('SELECT count(*) n FROM expected_transactions').get().n, 0);
    const result = await approve(x, p);
    assert.equal(result.status, 'imported');
    assert.equal(JSON.parse(x.db.prepare("SELECT tasks_done FROM recs WHERE id='payroll'").get().tasks_done)[0], true);
    const row = x.db.prepare('SELECT * FROM expected_transactions').get();
    assert.equal(row.amount, null); assert.equal(row.due_date, '2032-03-09'); assert.equal(row.actor_id, x.ctx.actorId);
    assert.equal(row.status, 'expected'); assert.equal(row.file_id, x.source.fileId);
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
    assert.ok(result.receipt);
  } finally { x.close(); }
});

test('unknown facts and missing recommendation steps remain cited notes', async () => {
  const x = await updateFixture();
  try {
    x.db.prepare("DELETE FROM recs WHERE id='payroll'").run();
    const p = stageUpdate(x.ctx, { source: x.source, capturedAt: '2032-03-02T14:00:00Z', actions: [x.step,
      { tool: 'answer', operation: 'fact', args: { key: 'payroll.trueUpDone', value: true, evidence: 'Payroll true-up done' }, span: x.span }] });
    assert.equal(p.notes.length, 2);
    assert.equal(p.actions.length, 0);
    await approve(x, p);
    assert.equal(x.db.prepare('SELECT count(*) n FROM facts').get().n, 0);
  } finally { x.close(); }
});

test('historical unanchored notes ask for the anchor and guessed amounts or dates fail', async () => {
  const x = await updateFixture();
  try {
    const p = stageUpdate(x.ctx, { source: x.source, actions: [x.expected] });
    assert.equal(p.status, 'needs_clarification'); assert.equal(p.reasonCode, 'needs_date_anchor');
    await assert.rejects(approve(x, p));
    for (const args of [{ amount: 1250 }, { dueDate: '2032-03-16' }]) {
      assert.throws(() => stageUpdate(x.ctx, { source: x.source, capturedAt: '2032-03-02T14:00:00Z', actions: [{ ...x.expected, args: { ...x.expected.args, ...args } }] }), /stated|date|evidence/);
    }
    assert.equal(x.db.prepare('SELECT count(*) n FROM action_receipts').get().n, 0);
  } finally { x.close(); }
});

test('source spans bind the exact file, bytes and actor instead of conversation history', async () => {
  const x = await updateFixture();
  try {
    for (const span of [{ ...x.span, sha256: '0'.repeat(64) }, { ...x.span, fileId: 'foreign' }, { ...x.span, byteEnd: 99999 }, { ...x.span, byteStart: -1 }]) {
      assert.throws(() => stageUpdate(x.ctx, { source: x.source, capturedAt: '2032-03-02T14:00:00Z', actions: [{ ...x.expected, span }] }), /source|span/);
    }
    const p = stageUpdate(x.ctx, { source: x.source, capturedAt: '2032-03-02T14:00:00Z', actions: [x.expected] });
    await assert.rejects(approve(x, p, { actorId: 'foreign-actor' }), /owner|available/);
    await approve(x, p);
  } finally { x.close(); }
});

test('approval refuses changed step definitions and stores a versioned correction without writes', async () => {
  const x = await updateFixture();
  try {
    const p = stageUpdate(x.ctx, { source: x.source, capturedAt: '2032-03-02T14:00:00Z', actions: [x.step, x.expected] });
    x.db.prepare("UPDATE recs SET def=? WHERE id='payroll'").run(JSON.stringify({ tasks: [{ t: 'Different step' }] }));
    await assert.rejects(approve(x, p), e => e.code === 'proposal_stale');
    const correction = await reviewImport({ ...x.ctx, ownerText: 'Use the other step' }, { proposalId: p.proposalId, version: 1, decision: 'correct', evidence: 'Use the other step' });
    assert.equal(correction.version, 2); assert.equal(correction.status, 'queued');
    await assert.rejects(approve(x, p), e => e.code === 'proposal_stale');
    assert.equal(x.db.prepare('SELECT count(*) n FROM expected_transactions').get().n, 0);
  } finally { x.close(); }
});

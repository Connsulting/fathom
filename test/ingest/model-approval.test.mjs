import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, recipe } from '../helpers/model-import.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { stageImport, reviewImport, prepareImport } from '../../src/ingest/model-review.mjs';
import { field } from '../helpers/model-import.mjs';
import { runWithPrincipal } from '../../src/platform/model-budget.mjs';

test('staging writes no ledger or mapping; explicit actor-bound approval commits once with a receipt', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), proposal = applyLayout(source, recipe());
    const staged = stageImport(x.ctx, { source, proposal, layout: recipe() });
    assert.equal(staged.status, 'needs_confirmation');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
    assert.equal(x.db.prepare('SELECT count(*) n FROM column_mappings').get().n, 0);
    for (const evidence of ['yes, but change the account', 'wait', 'maybe', 'yes import a different file']) {
      await assert.rejects(reviewImport({ ...x.ctx, ownerText: evidence }, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence }), e => e.code === 'bad_input');
    }
    await assert.rejects(reviewImport({ ...x.ctx, actorId: 'another-actor' }, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'forbidden');
    const out = await reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' });
    assert.equal(out.status, 'imported'); assert.equal(out.counts.rows.transaction, 2);
    assert.equal(out.receipt.scope, 'write:imports');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 2);
    assert.equal(x.db.prepare('SELECT approval_status FROM column_mappings').get().approval_status, 'approved');
    await assert.rejects(reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'proposal_stale');
  } finally { x.close(); }
});

test('underlying fact scopes are checked before any mixed proposal effect', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), proposal = applyLayout(source, recipe());
    proposal.rows.push({ target: 'fact', key: 'household.state', scope: 'household', datePrecision: 'day',
      fields: { value: field('r7'), asOf: field('r5'), subject: field('r4') } });
    const staged = stageImport(x.ctx, { source, proposal });
    await assert.rejects(reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'forbidden');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
    assert.equal(x.db.prepare('SELECT count(*) n FROM action_receipts').get().n, 0);
  } finally { x.close(); }
});

test('identical source preparation reuses its staged interpretation without another engine call', async () => {
  const x = await fixture();
  try {
    const source = await x.source();
    const staged = stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    const out = await prepareImport(x.ctx, { file: { fileId: source.fileId, format: source.format, bytes: source.bytes } });
    assert.equal(out.proposalId, staged.proposalId); assert.equal(out.version, staged.version);
    assert.equal(out.status, 'needs_confirmation');
  } finally { x.close(); }
});

test('stale stored state or changed source refuses atomically without mapping, receipt or batch approval', async () => {
  for (const changed of ['account', 'source', 'generation']) {
    const x = await fixture();
    try {
      const source = await x.source(), proposal = applyLayout(source, recipe());
      const staged = stageImport(x.ctx, { source, proposal, layout: recipe() });
      let ctx = x.ctx;
      if (changed === 'account') x.db.prepare("UPDATE accounts SET owner='spouse'").run();
      if (changed === 'source') x.db.prepare("UPDATE files SET sha256=?").run('f'.repeat(64));
      if (changed === 'generation') ctx = { ...ctx, household: { ...ctx.household, isCurrent: () => false } };
      await assert.rejects(reviewImport(ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'proposal_stale');
      for (const table of ['transactions', 'column_mappings', 'action_receipts', 'import_batches']) assert.equal(x.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    } finally { x.close(); }
  }
});

test('corrections retain exact owner evidence, queue a fresh version and invalidate old approval', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), proposal = applyLayout(source, recipe());
    const staged = stageImport(x.ctx, { source, proposal, layout: recipe() });
    const evidence = 'The amounts are expenses; negate the sign.';
    const out = await reviewImport({ ...x.ctx, ownerText: evidence }, { proposalId: staged.proposalId, version: 1, decision: 'correct', evidence });
    assert.equal(out.status, 'queued'); assert.equal(out.version, 2);
    assert.equal(x.db.prepare('SELECT approval_evidence FROM import_proposals WHERE version=2').get().approval_evidence, evidence);
    await assert.rejects(reviewImport(x.ctx, { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' }), e => e.code === 'proposal_stale');
    await assert.rejects(reviewImport(x.ctx, { proposalId: staged.proposalId, version: 2, decision: 'approve', evidence: 'yes' }), e => e.code === 'bad_input');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
  } finally { x.close(); }
});

test('mismatched owner evidence and missing import scope refuse without effects', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), proposal = applyLayout(source, recipe());
    const staged = stageImport(x.ctx, { source, proposal });
    const args = { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' };
    await assert.rejects(reviewImport({ ...x.ctx, ownerText: 'wait' }, args), e => e.code === 'bad_input');
    await assert.rejects(reviewImport({ ...x.ctx, scopes: [] }, args), e => e.code === 'forbidden');
    assert.equal(x.db.prepare('SELECT count(*) n FROM action_receipts').get().n, 0);
  } finally { x.close(); }
});

test('authorization revoked during source read refuses the late commit', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), staged = stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()) });
    let authorized = true;
    const household = { ...x.household, async vault() { const vault = await x.household.vault(); authorized = false; return vault; } };
    await assert.rejects(runWithPrincipal({ check: () => authorized }, () => reviewImport({ ...x.ctx, household },
      { proposalId: staged.proposalId, version: 1, decision: 'approve', evidence: 'yes' })), e => e.code === 'forbidden');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
  } finally { x.close(); }
});

test('a corrected interpretation needs a fresh acceptance of its own version', async () => {
  const x = await fixture();
  try {
    const source = await x.source(), staged = stageImport(x.ctx, { source, proposal: applyLayout(source, recipe()) });
    await reviewImport({ ...x.ctx, ownerText: 'Use the original sign.' }, { proposalId: staged.proposalId, version: 1, decision: 'correct', evidence: 'Use the original sign.' });
    const revised = { ...applyLayout(source, recipe()), proposalId: staged.proposalId, version: 2 };
    const ready = stageImport(x.ctx, { source, proposal: revised, layout: recipe() });
    assert.equal(ready.status, 'needs_confirmation');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
    const out = await reviewImport({ ...x.ctx, ownerText: 'looks right' }, { proposalId: staged.proposalId, version: 2, decision: 'approve', evidence: 'looks right' });
    assert.equal(out.status, 'imported'); assert.equal(out.version, 2);
  } finally { x.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { updateFixture } from './helpers/model-updates.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { setSetting } from '../src/store/db.mjs';
import { proposalBasis } from '../src/actions/proposals.mjs';

const args = { operation: 'expected_transaction', subject: 'payroll provider', direction: 'inflow', amount: null,
  dueDate: '2032-03-09', datePrecision: 'day', relativeDate: 'next Tuesday', evidence: 'The payroll provider pays next Tuesday' };

test('one shared expected action records provenance and Undo without affecting actual tables', async () => {
  const x = await updateFixture();
  try {
    const ctx = { ...x.ctx, now: '2032-03-02T14:00:00Z', ownerText: args.evidence };
    const before = proposalBasis(x.db, 'answer', ['write:imports'], args);
    const out = await callTool('answer', args, ctx);
    assert.equal(getTool('answer').operations.find(o => o.name === args.operation).scope, 'write:imports');
    assert.equal(out.expectedTransaction.amount, null);
    assert.equal(out.expectedTransaction.dateEvidence.rule, 'next_weekday');
    assert.notEqual(proposalBasis(x.db, 'answer', ['write:imports'], args), before);
    for (const table of ['transactions', 'balances', 'pnl_lines', 'tax_payments']) assert.equal(x.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    await callTool('undo', { operation: 'undo', id: out.receipt.id }, ctx);
    assert.equal(x.db.prepare('SELECT count(*) n FROM expected_transactions').get().n, 0);
  } finally { x.close(); }
});

test('relative dates use household local midnight, strict next weekday and DST', async () => {
  const x = await updateFixture();
  try {
    setSetting(x.db, 'timezone', 'America/Los_Angeles');
    for (const [now, dueDate] of [['2032-03-03T00:30:00Z', '2032-03-09'], ['2032-03-09T08:30:00Z', '2032-03-16'], ['2032-03-14T10:30:00Z', '2032-03-16']]) {
      const out = await callTool('answer', { ...args, dueDate }, { ...x.ctx, now, ownerText: args.evidence });
      assert.equal(out.expectedTransaction.dueDate, dueDate);
      assert.equal(out.expectedTransaction.dateEvidence.timezone, 'America/Los_Angeles');
    }
    setSetting(x.db, 'timezone', 'invalid');
    const out = await callTool('answer', args, { ...x.ctx, now: '2032-03-02T14:00:00Z', ownerText: args.evidence });
    assert.equal(out.expectedTransaction.dateEvidence.timezone, 'America/New_York');
  } finally { x.close(); }
});

test('expected action refuses fabricated figures, arbitrary dates, foreign accounts and statuses', async () => {
  const x = await updateFixture();
  try {
    const ctx = { ...x.ctx, now: '2032-03-02T14:00:00Z', ownerText: args.evidence };
    for (const patch of [{ amount: 800 }, { dueDate: '2032-03-10' }, { accountId: 'foreign' }, { status: 'observed' }, { actorId: 'foreign' }, { householdId: 'foreign' }, { datePrecision: 'month' }]) {
      await assert.rejects(callTool('answer', { ...args, ...patch }, ctx));
    }
    await assert.rejects(callTool('answer', args, { ...ctx, scopes: ['read'] }), /Permission/);
    await assert.rejects(callTool('answer', args, { ...ctx, ownerText: 'Unrelated words' }), /evidence|stated/);
    await callTool('answer', args, ctx);
  } finally { x.close(); }
});

test('observed expectations refuse Undo and cannot delete an observed posting', async () => {
  const x = await updateFixture();
  try {
    const ctx = { ...x.ctx, now: '2032-03-02T14:00:00Z', ownerText: args.evidence };
    const out = await callTool('answer', args, ctx);
    x.db.prepare("UPDATE expected_transactions SET status='observed' WHERE id=?").run(out.expectedTransaction.id);
    await assert.rejects(callTool('undo', { operation: 'undo', id: out.receipt.id }, ctx), /changed/);
    assert.equal(x.db.prepare('SELECT status FROM expected_transactions').get().status, 'observed');
  } finally { x.close(); }
});

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { actionTx, parseJson } from '../store/db.mjs';
import { isoDate } from '../ingest/format.mjs';
import { ToolError } from '../tools/errors.mjs';
import { requireActor, requireScope, saveReceipt, registerReceiptKind } from './receipts.mjs';
import { requireEvidence, relativeDateEvidence, sourceStatement } from './evidence.mjs';
import { actionTxWith } from '../store/db.mjs';

export const expectedOut = row => ({ id: row.id, subject: row.subject, direction: row.direction, dueDate: row.due_date,
  datePrecision: row.date_precision, amount: row.amount, accountId: row.account_id, status: row.status,
  dateEvidence: parseJson(row.evidence, {}).date ?? null });

export async function expectedTransaction(args, ctx) {
  requireScope(ctx, 'write:imports');
  const actor = await requireActor(ctx);
  if (typeof args.evidence !== 'string' || !args.evidence.trim() || args.evidence.length > 4000) throw new ToolError('bad_input', 'Use evidence between one and 4000 characters.');
  if (isoDate(args.dueDate) !== args.dueDate || !['day', 'month', 'year'].includes(args.datePrecision) ||
    !['inflow', 'outflow'].includes(args.direction) || typeof args.subject !== 'string' || !args.subject.trim() ||
    args.amount !== null && (typeof args.amount !== 'number' || !Number.isFinite(args.amount) || args.amount < 0)) throw new ToolError('bad_input', 'Invalid expected transaction.');
  if (args.accountId != null && !await ctx.db.prepare('SELECT id FROM accounts WHERE id=?').get(args.accountId)) throw new ToolError('not_found', 'No such account.');
  await requireEvidence(ctx, args.subject, { evidence: args.evidence, argument: 'subject' });
  if (args.amount !== null) await requireEvidence(ctx, args.amount, { evidence: args.evidence, shape: { unit: 'USD' }, argument: 'amount' });
  const date = args.relativeDate ? await relativeDateEvidence(ctx, args.relativeDate) : null;
  if (date && args.datePrecision !== 'day' || args.datePrecision === 'month' && !args.dueDate.endsWith('-01') ||
    args.datePrecision === 'year' && !args.dueDate.endsWith('-01-01')) throw new ToolError('bad_input', 'Invalid date precision.');
  await requireEvidence(ctx, args.dueDate, { evidence: args.evidence, argument: 'due date', derivation: date });
  const evidence = { date, ...(ctx.sourceEvidence ? { sourceSpan: ctx.sourceEvidence.span, ...(ctx.sourceEvidence.correction ? { correction: ctx.sourceEvidence.correction } : {}) } : {}) };
  return await actionTxWith(ctx, async (ctx) => {
    const id = randomUUID(), now = new Date(ctx.now ?? Date.now()).toISOString();
    await ctx.db.prepare(`INSERT INTO expected_transactions (id,subject,direction,due_date,date_precision,amount,account_id,status,statement,evidence,actor_id,file_id,created_at)
      VALUES (?,?,?,?,?,?,?,'expected',?,?,?,?,?)`).run(id, args.subject.trim(), args.direction, args.dueDate, args.datePrecision, args.amount,
      args.accountId ?? null, ctx.sourceEvidence ? sourceStatement(ctx) : args.evidence, JSON.stringify(evidence), actor, ctx.sourceEvidence?.source.fileId ?? null, now);
    const after = { ...await ctx.db.prepare('SELECT * FROM expected_transactions WHERE id=?').get(id) };
    const receipt = await saveReceipt(ctx, { scope: 'write:imports', kind: 'expected_transaction', id, label: 'Expected payment', before: null, after,
      from: null, to: expectedOut(after) });
    ctx.onReceipt?.(receipt);
    return { expectedTransaction: expectedOut(after), receipt };
  });
}

registerReceiptKind('expected_transaction', { async restore(ctx, { id, before, after, checkOnly }) {
  const row = await ctx.db.prepare('SELECT * FROM expected_transactions WHERE id=?').get(id);
  if (!isDeepStrictEqual(row ? { ...row } : null, after) || row?.status !== 'expected' || row?.observed_transaction_id) {
    throw new ToolError('conflict', 'This expected payment changed since that action.');
  }
  if (before !== null) throw new ToolError('bad_input', 'Invalid expected payment receipt.');
  if (!checkOnly) await ctx.db.prepare('DELETE FROM expected_transactions WHERE id=?').run(id);
} });

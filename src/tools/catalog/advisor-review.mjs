import { sendToAdvisor, recordVerdict, setCheckin, AdvisorError, VETO_REASON } from '../../advisor/index.mjs';
import { buildAndStorePacket } from '../../advisor/packet.mjs';
import { applyStatusAction } from '../../store/recs.mjs';
import { tx } from '../../store/db.mjs';
import { requireActor, saveReceipt, registerReceiptKind } from '../../actions/receipts.mjs';
import { requireEvidence } from '../../actions/evidence.mjs';
import { clockOf } from './figures.mjs';
import { ToolError } from '../errors.mjs';
import { VaultError } from '../../ingest/vault.mjs';
import { txWith } from '../../store/db.mjs';

registerReceiptKind('advisor_checkin', { table: 'advisor_checkin', pk: 'id' });
const stamp = ctx => new Date(ctx.now ?? Date.now()).toISOString();
const id = { type: 'string', minLength: 1 };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
function guard(fn) {
  try { return fn(); }
  catch (err) {
    if (err instanceof AdvisorError) throw new ToolError(err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : 'bad_input', err.message);
    if (err instanceof VaultError) throw new ToolError('conflict', err.message);
    throw err;
  }
}
async function receipt(ctx, kind, entityId, before, after, label, from = before, to = after) {
  const result = await saveReceipt(ctx, { scope: 'write:recs', kind, id: String(entityId), label, before, after, from, to });
  ctx.onReceipt?.(result);
  return result;
}
const unavailable = reason => ({ available: false, reason });
const reviews = async (db, recId) => await db.prepare('SELECT * FROM advisor_reviews WHERE rec_id = ? ORDER BY id').all(recId);
const verdictShape = { type: 'choice', choices: [
  ...['approved', 'signed off', 'agreed'].map(label => ({ value: 'confirmed', label })),
  ...['rejected', 'said no', 'declined'].map(label => ({ value: 'vetoed', label })),
] };

export const operations = [
  { tool: 'advisor_review', name: 'send', scope: 'write:recs', summary: 'Mark a recommendation for advisor review inside Fathom.',
    route: 'Send a recommendation for advisor review', routes: ['POST /api/advisor/reviews'], params: { recId: id }, required: ['recId'],
    async handler(args, ctx) {
      await requireActor(ctx);
      return guard(async () => await txWith(ctx, async (ctx) => {
        const before = await reviews(ctx.db, args.recId);
        const reviewId = await sendToAdvisor(ctx.db, args.recId, { now: stamp(ctx) });
        return { reviewId, receipt: await receipt(ctx, 'advisor_send', reviewId, before, await reviews(ctx.db, args.recId), 'Advisor review',
          { recId: args.recId }, { recId: args.recId, reviewId }),
          undo: unavailable('A sent review is a record; a new verdict or review supersedes it.') };
      }));
    } },
  { tool: 'advisor_review', name: 'verdict', scope: 'write:recs', summary: 'Record the advisor’s stated verdict, note and date; a veto dismisses the recommendation.',
    route: 'Record an advisor verdict', routes: ['POST /api/advisor/reviews/:id/verdict'],
    params: { reviewId: { type: 'integer', minimum: 1 }, verdict: { type: 'string', enum: ['confirmed', 'vetoed'] },
      note: { type: 'string', maxLength: 1000 }, date, evidence: { type: 'string', minLength: 1 } }, required: ['reviewId', 'verdict', 'date', 'evidence'],
    async handler(args, ctx) {
      const actor = await requireActor(ctx);
      const evidenceCtx = ctx.channel === 'mcp' ? { ...ctx, ownerText: args.evidence } : ctx;
      await requireEvidence(evidenceCtx, args.verdict, { evidence: args.evidence, argument: 'verdict', shape: verdictShape });
      if (args.note) await requireEvidence(evidenceCtx, args.note, { evidence: args.evidence, argument: 'note' });
      return guard(async () => await txWith(ctx, async (ctx) => {
        const before = await ctx.db.prepare('SELECT * FROM advisor_reviews WHERE id = ?').get(args.reviewId) ?? null;
        await recordVerdict(ctx.db, args.reviewId, { ...args, now: stamp(ctx) },
          async row => await applyStatusAction(ctx.db, row, 'dismiss', VETO_REASON, { now: stamp(ctx), actor }));
        const after = await ctx.db.prepare('SELECT * FROM advisor_reviews WHERE id = ?').get(args.reviewId);
        return { review: { id: after.id, verdict: after.verdict, date: after.reviewed_on },
          receipt: await receipt(ctx, 'advisor_verdict', args.reviewId, before, after, 'Advisor verdict',
            { verdict: before.verdict }, { verdict: after.verdict, date: after.reviewed_on }),
          undo: unavailable('This records an outside person’s decision; send the recommendation again to reopen review.') };
      }));
    } },
  { tool: 'advisor_review', name: 'checkin', scope: 'write:recs', summary: 'Set the next advisor check-in, with an optional time and length in minutes.',
    route: 'Set the next advisor check-in', routes: ['POST /api/advisor/checkin'],
    params: { date, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, lengthMin: { type: 'integer', minimum: 15, maximum: 480 } }, required: ['date'],
    async handler(args, ctx) {
      await requireActor(ctx);
      return guard(async () => await txWith(ctx, async (ctx) => {
        const before = await ctx.db.prepare('SELECT * FROM advisor_checkin WHERE id = 1').get() ?? null;
        const lengthMin = args.lengthMin ?? 30;
        await setCheckin(ctx.db, { ...args, lengthMin, now: stamp(ctx) });
        const after = await ctx.db.prepare('SELECT * FROM advisor_checkin WHERE id = 1').get();
        return { checkin: { date: after.date, time: after.time, lengthMin: after.length_min },
          receipt: await receipt(ctx, 'advisor_checkin', 1, before, after, 'Advisor check-in',
            before ? { date: before.date, time: before.time, lengthMin: before.length_min } : null,
            { date: after.date, time: after.time, lengthMin: after.length_min }) };
      }));
    } },
  { tool: 'advisor_review', name: 'packet', scope: 'write:recs', summary: 'Store an encrypted review packet for all waiting reviews; nothing leaves Fathom.',
    route: 'Prepare an advisor review packet', routes: ['POST /api/advisor/packets'], params: {}, required: [],
    async handler(args, ctx) {
      await requireActor(ctx);
      let result;
      try { result = await buildAndStorePacket(ctx.db, { clock: await clockOf(ctx), now: stamp(ctx), vault: () => ctx.services.vault() }); }
      catch (err) { return guard(() => { throw err; }); }
      const after = await ctx.db.prepare('SELECT * FROM advisor_packets WHERE id = ?').get(result.packetId);
      return { ...result, receipt: await receipt(ctx, 'advisor_packet', result.packetId, null, after, 'Advisor packet', null, result),
        undo: unavailable('A stored packet is a record.') };
    } },
];

export const rules = ['Advisor review stays inside Fathom. Marking for review or preparing a packet sends nothing outside the product. Never claim to have emailed anyone.'];

import { sendToAdvisor, recordVerdict, setCheckin, AdvisorError, VETO_REASON } from '../../advisor/index.mjs';
import { buildAndStorePacket } from '../../advisor/packet.mjs';
import { applyStatusAction } from '../../store/recs.mjs';
import { tx } from '../../store/db.mjs';
import { requireActor, saveReceipt, registerReceiptKind } from '../../actions/receipts.mjs';
import { requireEvidence } from '../../actions/evidence.mjs';
import { clockOf } from './figures.mjs';
import { ToolError } from '../errors.mjs';

registerReceiptKind('advisor_checkin', { table: 'advisor_checkin', pk: 'id' });
const stamp = ctx => new Date(ctx.now ?? Date.now()).toISOString();
const id = { type: 'string', minLength: 1 };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
function guard(fn) {
  try { return fn(); }
  catch (err) { if (err instanceof AdvisorError) throw new ToolError(err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : 'bad_input', err.message); throw err; }
}
function receipt(ctx, kind, entityId, before, after, label, from = before, to = after) {
  const result = saveReceipt(ctx, { scope: 'write:recs', kind, id: String(entityId), label, before, after, from, to });
  ctx.onReceipt?.(result);
  return result;
}
const unavailable = reason => ({ available: false, reason });
const reviews = (db, recId) => db.prepare('SELECT * FROM advisor_reviews WHERE rec_id = ? ORDER BY id').all(recId);

export const operations = [
  { tool: 'advisor_review', name: 'send', scope: 'write:recs', summary: 'Mark a recommendation for advisor review inside Fathom.',
    route: 'Send a recommendation for advisor review', routes: ['POST /api/advisor/reviews'], params: { recId: id }, required: ['recId'],
    handler(args, ctx) {
      requireActor(ctx);
      return guard(() => tx(ctx.db, () => {
        const before = reviews(ctx.db, args.recId);
        const reviewId = sendToAdvisor(ctx.db, args.recId, { now: stamp(ctx) });
        return { reviewId, receipt: receipt(ctx, 'advisor_send', reviewId, before, reviews(ctx.db, args.recId), 'Advisor review',
          { recId: args.recId }, { recId: args.recId, reviewId }),
          undo: unavailable('A sent review is a record; a new verdict or review supersedes it.') };
      }));
    } },
  { tool: 'advisor_review', name: 'verdict', scope: 'write:recs', summary: 'Record the advisor’s stated verdict, note and date; a veto dismisses the recommendation.',
    route: 'Record an advisor verdict', routes: ['POST /api/advisor/reviews/:id/verdict'],
    params: { reviewId: { type: 'integer', minimum: 1 }, verdict: { type: 'string', enum: ['confirmed', 'vetoed'] },
      note: { type: 'string', maxLength: 1000 }, date, evidence: { type: 'string', minLength: 1 } }, required: ['reviewId', 'verdict', 'date', 'evidence'],
    handler(args, ctx) {
      const actor = requireActor(ctx);
      const evidenceCtx = ctx.channel === 'mcp' ? { ...ctx, ownerText: args.evidence } : ctx;
      for (const field of ['verdict', 'date', ...(args.note ? ['note'] : [])]) requireEvidence(evidenceCtx, args[field], { evidence: args.evidence, argument: field });
      return guard(() => tx(ctx.db, () => {
        const before = ctx.db.prepare('SELECT * FROM advisor_reviews WHERE id = ?').get(args.reviewId) ?? null;
        recordVerdict(ctx.db, args.reviewId, { ...args, now: stamp(ctx) },
          row => applyStatusAction(ctx.db, row, 'dismiss', VETO_REASON, { now: stamp(ctx), actor }));
        const after = ctx.db.prepare('SELECT * FROM advisor_reviews WHERE id = ?').get(args.reviewId);
        return { review: { id: after.id, verdict: after.verdict, date: after.reviewed_on },
          receipt: receipt(ctx, 'advisor_verdict', args.reviewId, before, after, 'Advisor verdict',
            { verdict: before.verdict }, { verdict: after.verdict, date: after.reviewed_on }),
          undo: unavailable('This records an outside person’s decision; send the recommendation again to reopen review.') };
      }));
    } },
  { tool: 'advisor_review', name: 'checkin', scope: 'write:recs', summary: 'Set the next advisor check-in, with an optional time and length in minutes.',
    route: 'Set the next advisor check-in', routes: ['POST /api/advisor/checkin'],
    params: { date, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, lengthMin: { type: 'integer', minimum: 15, maximum: 480 } }, required: ['date'],
    handler(args, ctx) {
      requireActor(ctx);
      return guard(() => tx(ctx.db, () => {
        const before = ctx.db.prepare('SELECT * FROM advisor_checkin WHERE id = 1').get() ?? null;
        const lengthMin = args.lengthMin ?? 30;
        setCheckin(ctx.db, { ...args, lengthMin, now: stamp(ctx) });
        const after = ctx.db.prepare('SELECT * FROM advisor_checkin WHERE id = 1').get();
        return { checkin: { date: after.date, time: after.time, lengthMin: after.length_min },
          receipt: receipt(ctx, 'advisor_checkin', 1, before, after, 'Advisor check-in',
            before ? { date: before.date, time: before.time, lengthMin: before.length_min } : null,
            { date: after.date, time: after.time, lengthMin: after.length_min }) };
      }));
    } },
  { tool: 'advisor_review', name: 'packet', scope: 'write:recs', summary: 'Store an encrypted review packet for all waiting reviews; nothing leaves Fathom.',
    route: 'Prepare an advisor review packet', routes: ['POST /api/advisor/packets'], params: {}, required: [],
    async handler(args, ctx) {
      requireActor(ctx);
      let result;
      try { result = await buildAndStorePacket(ctx.db, { clock: clockOf(ctx), now: stamp(ctx), vault: () => ctx.services.vault() }); }
      catch (err) { return guard(() => { throw err; }); }
      const after = ctx.db.prepare('SELECT * FROM advisor_packets WHERE id = ?').get(result.packetId);
      return { ...result, receipt: receipt(ctx, 'advisor_packet', result.packetId, null, after, 'Advisor packet', null, result),
        undo: unavailable('A stored packet is a record.') };
    } },
];

export const rules = ['Advisor review stays inside Fathom. Marking for review or preparing a packet sends nothing outside the product. Never claim to have emailed anyone.'];

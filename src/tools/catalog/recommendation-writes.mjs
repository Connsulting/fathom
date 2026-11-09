import { isDeepStrictEqual } from 'node:util';
import { decide, revisit, pickWargame, decisionState } from '../../decisions/write.mjs';
import { detachRecThreads } from '../../store/recs.mjs';
import { requireActor, saveReceipt, registerReceiptKind, replanAction } from '../../actions/receipts.mjs';
import { clockOf } from './figures.mjs';
import { envelope } from '../../calc/figure.mjs';
import { ToolError } from '../errors.mjs';

const id = { type: 'string', minLength: 1 };
const point = { anyOf: [{ type: 'integer', minimum: 0 }, id] };
const stamp = ctx => new Date(ctx.now ?? Date.now()).toISOString();
const changed = () => { throw new ToolError('conflict', 'This item changed since that action. Ask for a new change instead.'); };

registerReceiptKind('rec_detach', { async restore(ctx, { before, after }) {
  for (const row of after) {
    const current = await ctx.db.prepare('SELECT key, rec_id, rec_detached_at FROM conversations WHERE key = ?').get(row.key);
    if (!isDeepStrictEqual(current ? { ...current } : null, row)) changed();
  }
  for (const row of before) await ctx.db.prepare('UPDATE conversations SET rec_detached_at = ? WHERE key = ?').run(row.rec_detached_at, row.key);
} });

for (const kind of ['decision_decide', 'decision_revisit']) registerReceiptKind(kind, { async restore(ctx, { id: decisionId, before, after }) {
  const expected = kind === 'decision_revisit' ? after.state : after;
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(await decisionState(ctx.db, decisionId))), expected)) changed();
  const opts = { clock: await clockOf(ctx), now: stamp(ctx), actor: await requireActor(ctx) };
  if (kind === 'decision_decide') await revisit(ctx.db, decisionId, opts);
  else {
    if (before.decidedIndex === null) changed();
    await decide(ctx.db, decisionId, { ...opts, point: before.decidedIndex });
  }
} });

async function changeDecision(args, ctx, operation) {
  const actor = await requireActor(ctx);
  let receipt;
  const result = await (operation === 'decide' ? decide : revisit)(ctx.db, args.decisionId, {
    point: args.point, clock: await clockOf(ctx), now: stamp(ctx), actor,
    async onWrite(before, after, meta) {
      receipt = await saveReceipt(ctx, { scope: 'write:decisions', kind: `decision_${operation}`, id: args.decisionId,
        label: operation === 'decide' ? 'Decision' : 'Revisit decision',
        before: operation === 'revisit' ? { state: before, decidedIndex: meta.decidedIndex } : before,
        after: operation === 'revisit' ? { state: after } : after,
        from: { id: args.decisionId, status: before.decision.status },
        to: { id: args.decisionId, status: after.decision.status, ...(after.decision.decided_line ? { decidedLine: after.decision.decided_line } : {}) } });
    },
  });
  ctx.onReceipt?.(receipt);
  await replanAction(ctx, receipt);
  return { ...result, receipt };
}

export const operations = [
  { tool: 'act_on_recommendation', name: 'start_over', scope: 'write:recs',
    summary: 'Detach a recommendation’s conversations; keep them in Ask.', route: 'Start a recommendation conversation over',
    routes: ['POST /api/recs/:id/start-over'], params: { id }, required: ['id'],
    async handler(args, ctx) {
      await requireActor(ctx);
      let receipt;
      const count = await detachRecThreads(ctx.db, args.id, { now: stamp(ctx), async onWrite(before, after) {
        receipt = await saveReceipt(ctx, { scope: 'write:recs', kind: 'rec_detach', id: args.id, label: 'Start over', before, after,
          from: { attached: before.length }, to: { attached: 0 } });
      } });
      ctx.onReceipt?.(receipt);
      return { detached: envelope(count, { unit: 'count', label: 'Detached conversations', kind: 'a', asOf: await clockOf(ctx),
        provenance: { sources: [{ table: 'conversations', count }] } }), receipt };
    } },
  { tool: 'act_on_recommendation', name: 'decide', scope: 'write:decisions',
    summary: 'Decide on a stored war-game point, or the current pick.', route: 'Decide a salary or deferral choice',
    routes: ['POST /api/decisions/:id/decide', 'POST /api/threads/:id/messages/:messageId/blocks/:blockId/act'], params: { decisionId: id, point }, required: ['decisionId'],
    handler: async (args, ctx) => changeDecision(args, ctx, 'decide') },
  { tool: 'act_on_recommendation', name: 'revisit', scope: 'write:decisions',
    summary: 'Reopen a decision and remove its decided assumption.', route: 'Revisit a decided choice',
    routes: ['POST /api/decisions/:id/revisit'], params: { decisionId: id }, required: ['decisionId'],
    handler: async (args, ctx) => changeDecision(args, ctx, 'revisit') },
  { tool: 'act_on_recommendation', name: 'pick_point', scope: 'write:decisions',
    summary: 'Pick a salary or deferral point without deciding.', route: 'Pick a war-game point',
    routes: ['POST /api/wargame/:name/pick', 'POST /api/threads/:id/messages/:messageId/blocks/:blockId/act'], params: { name: { type: 'string', enum: ['salary', 'deferral'] }, point }, required: ['name', 'point'],
    async handler(args, ctx) {
      await requireActor(ctx);
      let receipt;
      const picked = await pickWargame(ctx.db, args.name, args.point, { async onWrite(before, after) {
        receipt = await saveReceipt(ctx, { scope: 'write:decisions', kind: 'setting', id: 'wargame.picks', label: 'War-game pick', before, after,
          from: before ? JSON.parse(before.value) : null, to: JSON.parse(after.value) });
      } });
      ctx.onReceipt?.(receipt);
      return { picked, receipt };
    } },
];

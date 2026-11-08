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

registerReceiptKind('rec_detach', { restore(ctx, { before, after }) {
  for (const row of after) {
    const current = ctx.db.prepare('SELECT key, rec_id, rec_detached_at FROM conversations WHERE key = ?').get(row.key);
    if (!isDeepStrictEqual(current ? { ...current } : null, row)) changed();
  }
  for (const row of before) ctx.db.prepare('UPDATE conversations SET rec_detached_at = ? WHERE key = ?').run(row.rec_detached_at, row.key);
} });

for (const kind of ['decision_decide', 'decision_revisit']) registerReceiptKind(kind, { restore(ctx, { id: decisionId, before, after }) {
  const expected = kind === 'decision_revisit' ? after.state : after;
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(decisionState(ctx.db, decisionId))), expected)) changed();
  const opts = { clock: clockOf(ctx), now: stamp(ctx), actor: requireActor(ctx) };
  if (kind === 'decision_decide') revisit(ctx.db, decisionId, opts);
  else {
    if (before.decidedIndex === null) changed();
    decide(ctx.db, decisionId, { ...opts, point: before.decidedIndex });
  }
} });

async function changeDecision(args, ctx, operation) {
  const actor = requireActor(ctx);
  let receipt;
  const result = (operation === 'decide' ? decide : revisit)(ctx.db, args.decisionId, {
    point: args.point, clock: clockOf(ctx), now: stamp(ctx), actor,
    onWrite(before, after, meta) {
      receipt = saveReceipt(ctx, { scope: 'write:decisions', kind: `decision_${operation}`, id: args.decisionId,
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
    handler(args, ctx) {
      requireActor(ctx);
      let receipt;
      const count = detachRecThreads(ctx.db, args.id, { now: stamp(ctx), onWrite(before, after) {
        receipt = saveReceipt(ctx, { scope: 'write:recs', kind: 'rec_detach', id: args.id, label: 'Start over', before, after,
          from: { attached: before.length }, to: { attached: 0 } });
      } });
      ctx.onReceipt?.(receipt);
      return { detached: envelope(count, { unit: 'count', label: 'Detached conversations', kind: 'a', asOf: clockOf(ctx),
        provenance: { sources: [{ table: 'conversations', count }] } }), receipt };
    } },
  { tool: 'act_on_recommendation', name: 'decide', scope: 'write:decisions',
    summary: 'Decide on a stored war-game point, or the current pick.', route: 'Decide a salary or deferral choice',
    routes: ['POST /api/decisions/:id/decide'], params: { decisionId: id, point }, required: ['decisionId'],
    handler: (args, ctx) => changeDecision(args, ctx, 'decide') },
  { tool: 'act_on_recommendation', name: 'revisit', scope: 'write:decisions',
    summary: 'Reopen a decision and remove its decided assumption.', route: 'Revisit a decided choice',
    routes: ['POST /api/decisions/:id/revisit'], params: { decisionId: id }, required: ['decisionId'],
    handler: (args, ctx) => changeDecision(args, ctx, 'revisit') },
  { tool: 'act_on_recommendation', name: 'pick_point', scope: 'write:decisions',
    summary: 'Pick a salary or deferral point without deciding.', route: 'Pick a war-game point',
    routes: ['POST /api/wargame/:name/pick'], params: { name: { type: 'string', enum: ['salary', 'deferral'] }, point }, required: ['name', 'point'],
    handler(args, ctx) {
      requireActor(ctx);
      let receipt;
      const picked = pickWargame(ctx.db, args.name, args.point, { onWrite(before, after) {
        receipt = saveReceipt(ctx, { scope: 'write:decisions', kind: 'setting', id: 'wargame.picks', label: 'War-game pick', before, after,
          from: before ? JSON.parse(before.value) : null, to: JSON.parse(after.value) });
      } });
      ctx.onReceipt?.(receipt);
      return { picked, receipt };
    } },
];

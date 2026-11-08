import { isDeepStrictEqual } from 'node:util';
import { setPackActive, packActivationState, packIsActive } from '../../packs/state.mjs';
import { registerReceiptKind, requireActor, saveReceipt } from '../../actions/receipts.mjs';
import { tx } from '../../store/db.mjs';
import { ToolError } from '../errors.mjs';

registerReceiptKind('pack_active', { restore(ctx, { id, before, after }) {
  if (!isDeepStrictEqual(packActivationState(ctx.db, id), after)) throw new ToolError('conflict', 'This item changed since that action. Ask for a new change instead.');
  setPackActive(ctx.db, id, packIsActive(before.pack), { now: new Date(ctx.now ?? Date.now()).toISOString(), actorId: ctx.actorId });
} });
export const operations = [{
  tool: 'update_preferences', name: 'pack', scope: 'write:preferences',
  summary: 'Set a pack active or inactive and update its recommendations.', route: 'Turn a knowledge pack on or off', routes: ['POST /api/packs/:id/toggle'],
  params: { packId: { type: 'string', minLength: 1 }, active: { type: 'boolean' } }, required: ['packId', 'active'],
  handler(args, ctx) {
    const actorId = requireActor(ctx);
    const result = tx(ctx.db, () => {
      const { pack, wasActive, before, after } = setPackActive(ctx.db, args.packId, args.active, { now: new Date(ctx.now ?? Date.now()).toISOString(), actorId });
      const receipt = saveReceipt(ctx, { scope: 'write:preferences', kind: 'pack_active', id: args.packId, label: 'Knowledge pack activation', before, after, from: wasActive, to: args.active });
      return { pack, wasActive, receipt };
    });
    ctx.onReceipt?.(result.receipt);
    return result;
  },
}];

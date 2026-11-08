import { undoAction } from '../../actions/receipts.mjs';
import { WRITE_SCOPES } from '../../shared/action-scopes.mjs';
import { ToolError } from '../errors.mjs';
export const capabilities = ['ownerStatements'];
export const operations = [{
  tool: 'undo', name: 'undo', scopes: WRITE_SCOPES,
  summary: 'Undo your earlier change by receipt id; refuses another actor or an item edited since.',
  route: 'Undo an earlier change', routes: ['POST /api/actions/:id/undo'],
  params: { id: { type: 'string', minLength: 1 } }, required: ['id'],
  async handler(args, ctx) {
    const row = await ctx.db.prepare('SELECT scope FROM action_receipts WHERE id = ?').get(args.id);
    if (!row) throw new ToolError('forbidden', 'This change is not available to you.');
    return undoAction(ctx, args.id, row.scope);
  },
}];

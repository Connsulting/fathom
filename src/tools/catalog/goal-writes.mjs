import { archiveGoal, deleteGoal } from '../../goals/write.mjs';
import { setCurvePositions } from '../../goals/curve.mjs';
import { setGoalSuggestion } from '../../suggest/write.mjs';
import { buildSuggestions, SUGGEST_SETTING } from '../../suggest/build.mjs';
import { checkAssumption } from '../assumption-evidence.mjs';
import { requireActor, saveReceipt, registerReceiptKind } from '../../actions/receipts.mjs';
import { clockOf } from './figures.mjs';
import { goalStatusOf } from '../../shared/goals.mjs';

registerReceiptKind('goal_row', { table: 'goals', pk: 'id' });
const id = { type: 'string', minLength: 1 };
const assumption = { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string', enum: ['owner', 'preference', 'fact', 'default'] },
  evidence: { type: 'string' }, factKey: { type: 'string' }, preferenceId: { type: 'string' }, note: { type: 'string', maxLength: 200 } }, required: ['value', 'source'], additionalProperties: false };

function writing(ctx, { scope, kind, id: entityId, label }, fn) {
  requireActor(ctx);
  let receipt;
  const result = fn((before, after) => {
    const value = row => !row ? null : kind === 'setting' ? JSON.parse(row.value)
      : { id: row.id, title: JSON.parse(row.def).title, status: goalStatusOf(row) };
    receipt = saveReceipt(ctx, { scope, kind, id: entityId, label, before, after, from: value(before), to: value(after) });
  });
  ctx.onReceipt?.(receipt);
  return { result, receipt };
}

export const operations = [
  { tool: 'goals', name: 'suggestions', scope: 'read', summary: 'Suggested targets for active goals without a target.',
    route: 'Read suggested goal targets', routes: ['GET /api/goals/suggestions'], params: {}, required: [],
    handler(args, ctx) { const { clock, suggestions } = buildSuggestions(ctx.db, { clock: clockOf(ctx) }); return { clock, suggestions }; } },
  { tool: 'update_goal', name: 'archive', scope: 'write:goals', summary: 'Archive a goal, preserving its history.',
    route: 'Archive a goal', routes: ['POST /api/goals/:id/archive'], params: { id }, required: ['id'],
    handler(args, ctx) {
      const { receipt } = writing(ctx, { scope: 'write:goals', kind: 'goal', id: args.id, label: 'Archive goal' },
        onWrite => archiveGoal(ctx.db, args.id, { now: new Date(ctx.now ?? Date.now()).toISOString(), onWrite }));
      return { goal: { id: args.id, archived: true }, receipt };
    } },
  { tool: 'update_goal', name: 'delete', scope: 'write:goals', summary: 'Delete an owner-created goal; Undo restores every column.',
    route: 'Delete your own goal', routes: ['POST /api/goals/:id/delete'], params: { id }, required: ['id'],
    handler(args, ctx) {
      const { receipt } = writing(ctx, { scope: 'write:goals', kind: 'goal_row', id: args.id, label: 'Delete goal' },
        onWrite => deleteGoal(ctx.db, args.id, { ownerOnly: true, onWrite }));
      return { deleted: args.id, receipt };
    } },
  { tool: 'update_goal', name: 'suggestion', scope: 'write:goals', summary: 'Dismiss or restore a suggestion, or set a sourced withdrawal rate.',
    route: 'Change a suggested goal target', routes: ['POST /api/goals/:id/suggestion'],
    params: { id, action: { type: 'string', enum: ['dismiss', 'restore'] }, withdrawalRate: assumption }, required: ['id'],
    handler({ id: goalId, ...args }, ctx) {
      if (args.withdrawalRate !== undefined) args.withdrawalRate = checkAssumption(args.withdrawalRate,
        { name: 'withdrawalRate', unit: 'ratio', min: 0.02, max: 0.06 }, ctx).value;
      const { result, receipt } = writing(ctx, { scope: 'write:goals', kind: 'setting', id: SUGGEST_SETTING, label: 'Goal suggestion' },
        onWrite => setGoalSuggestion(ctx.db, goalId, args, { clock: clockOf(ctx), onWrite }));
      return { suggestion: result, receipt };
    } },
  { tool: 'update_preferences', name: 'curve', scope: 'write:preferences', summary: 'Set one to twenty known tradeoff axes between zero and one.',
    route: 'Change tradeoff curve positions', routes: ['POST /api/curve'],
    params: { positions: { type: 'object', minProperties: 1, maxProperties: 20, additionalProperties: { type: 'number', minimum: 0, maximum: 1 } } }, required: ['positions'],
    handler(args, ctx) {
      const { result, receipt } = writing(ctx, { scope: 'write:preferences', kind: 'setting', id: 'curve.positions', label: 'Tradeoff curve' },
        onWrite => setCurvePositions(ctx.db, args.positions, { onWrite }));
      return { positions: result, receipt };
    } },
];

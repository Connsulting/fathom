import { isDeepStrictEqual } from 'node:util';
import { archiveGoal, deleteGoal } from '../../goals/write.mjs';
import { setCurvePositions } from '../../goals/curve.mjs';
import { setGoalSuggestion } from '../../suggest/write.mjs';
import { buildSuggestions, SUGGEST_SETTING } from '../../suggest/build.mjs';
import { requireActor, saveReceipt, registerReceiptKind } from '../../actions/receipts.mjs';
import { clockOf } from './figures.mjs';
import { goalStatusOf } from '../../shared/goals.mjs';
import { ToolError } from '../errors.mjs';

registerReceiptKind('goal_row', { table: 'goals', pk: 'id' });
const id = { type: 'string', minLength: 1 };
const same = (a, b) => isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), b);
const changed = () => { throw new ToolError('conflict', 'This item changed since that action. Ask for a new change instead.'); };
function restoreRow(db, table, pk, id, row) {
  if (!row) { db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(id); return; }
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})
    ON CONFLICT(${pk}) DO UPDATE SET ${keys.filter(k => k !== pk).map(k => `${k} = excluded.${k}`).join(',')}`).run(...keys.map(k => row[k]));
}
registerReceiptKind('goal_suggestion', { restore(ctx, { id, before, after }) {
  const goal = ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) ?? null;
  const setting = ctx.db.prepare('SELECT * FROM settings WHERE key = ?').get(SUGGEST_SETTING) ?? null;
  if (!same({ goal, setting }, after)) changed();
  restoreRow(ctx.db, 'goals', 'id', id, before.goal);
  restoreRow(ctx.db, 'settings', 'key', SUGGEST_SETTING, before.setting);
} });
registerReceiptKind('curve_preferences', { restore(ctx, { after }) {
  for (const row of after) if (!same(ctx.db.prepare('SELECT * FROM preferences WHERE id = ?').get(row.id), row)) changed();
  for (const row of after) ctx.db.prepare('DELETE FROM preferences WHERE id = ?').run(row.id);
} });


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
  { tool: 'update_goal', name: 'suggestion', scope: 'write:goals', summary: 'Undo a target Fathom set and decline it so automatic passes cannot adopt it again.',
    route: 'Undo a target Fathom set', routes: ['POST /api/goals/:id/suggestion'],
    params: { id, action: { type: 'string', enum: ['undo'] } }, required: ['id', 'action'],
    handler({ id: goalId, ...args }, ctx) {
      requireActor(ctx);
      let receipt;
      setGoalSuggestion(ctx.db, goalId, args, { now: new Date(ctx.now ?? Date.now()).toISOString(), onWrite(before, after) {
        receipt = saveReceipt(ctx, { scope: 'write:goals', kind: 'goal_suggestion', id: goalId, label: 'Undo Fathom target', before, after,
          from: { adopted: true }, to: { adopted: false, declined: true } });
      } });
      ctx.onReceipt?.(receipt);
      return { suggestion: { goalId, adopted: false, declined: true }, receipt };
    } },
  { tool: 'update_preferences', name: 'curve', scope: 'write:preferences', summary: 'Remember positions on known tradeoff axes between zero and one.',
    route: 'Change tradeoff curve positions', routes: ['POST /api/curve'],
    params: { positions: { type: 'object', minProperties: 1, maxProperties: 20, additionalProperties: { type: 'number', minimum: 0, maximum: 1 } } }, required: ['positions'],
    handler(args, ctx) {
      const actorId = requireActor(ctx);
      let receipt;
      const positions = setCurvePositions(ctx.db, args.positions, { now: new Date(ctx.now ?? Date.now()).toISOString(), actorId,
        conversationKey: ctx.conversationKey, origin: ctx.channel === 'ask' ? 'ask' : 'you', onWrite(before, after) {
          receipt = saveReceipt(ctx, { scope: 'write:preferences', kind: 'curve_preferences', id: actorId, label: 'Tradeoff curve',
            before, after, from: null, to: args.positions });
        } });
      ctx.onReceipt?.(receipt);
      return { positions, receipt };
    } },
];

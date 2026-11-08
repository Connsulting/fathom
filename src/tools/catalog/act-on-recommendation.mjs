import { clockOf, recOutById } from './figures.mjs';
import { SETTABLE_REC_STATUSES } from '../../store/recs.mjs';
import { changeRec } from '../../actions/index.mjs';
import { OWNERS } from '../../shared/rec-links.mjs';

export const operations = [
{
    tool: 'act_on_recommendation', name: 'status',
    summary: 'Change recommendation status, optionally a snooze wake label.', route: 'Change recommendation status', routes: ['POST /api/recs/:id/action'],
    params: {"id":{"type":"string","minLength":1},"status":{"type":"string","enum": SETTABLE_REC_STATUSES},"wake":{"type":"string","maxLength":200}},
    required: ["id","status"],
    scope: 'write:recs',
    handler(args, ctx) {
      const { receipt } = changeRec(args, ctx, 'status');
      return { ...recOutById(ctx.db, clockOf(ctx), args.id), receipt };
    },
  },
{
    tool: 'act_on_recommendation', name: 'owner',
    summary: 'Change who acts on a recommendation.', route: 'Change recommendation owner', routes: ['POST /api/recs/:id/action'],
    params: {"id":{"type":"string","minLength":1},"owner":{"type":"string","enum": [...OWNERS]}},
    required: ["id","owner"],
    scope: 'write:recs',
    handler(args, ctx) {
      const { receipt } = changeRec(args, ctx, 'owner');
      return { ...recOutById(ctx.db, clockOf(ctx), args.id), receipt };
    },
  },
];
operations.push({
  tool: 'act_on_recommendation', name: 'step', scope: 'write:steps',
  summary: 'Mark an unobservable rec step done (I did this) or undone by zero-based index; verified steps complete themselves.', route: 'Mark a recommendation step done', routes: ['POST /api/recs/:id/action'],
  params: { id: { type: 'string', minLength: 1 }, index: { type: 'integer', minimum: 0 }, checked: { type: 'boolean' } }, required: ['id', 'index', 'checked'],
  handler(args, ctx) { const { row, receipt } = changeRec(args, ctx, 'step'); return { id: row.id, tasksDone: JSON.parse(row.tasks_done), receipt }; },
});

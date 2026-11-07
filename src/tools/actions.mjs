import { writePreference } from '../actions/preferences.mjs';
import { recordFact, changeGoal, changeRec } from '../actions/index.mjs';
import { undoAction } from '../actions/receipts.mjs';
import { HORIZONS, HORIZON_IDS } from '../shared/goals.mjs';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1 };
const goalFields = { title: { type: 'string' }, note: { type: 'string' }, horizon: { type: 'string', enum: HORIZON_IDS,
  description: HORIZONS.map(h => `${h.id}: ${h.label}`).join('; ') },
  target: { anyOf: [{ type: 'number' }, { type: 'null' }] }, targetDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  track: { anyOf: [{ type: 'null' }, obj({ accounts: { type: 'array', items: { type: 'string' } } }, ['accounts']), obj({ figure: id }, ['figure'])] } };

export const actionTools = [
  { name: 'remember_preference', scope: 'write:preferences', description: 'Remember a short household preference or definition the person states, verbatim. Include their exact words as evidence. Optionally edit an existing preference id. Shown in Settings, used in Ask, with Undo.',
    inputSchema: obj({ id, text: { type: 'string', minLength: 1, maxLength: 300 }, evidence: { type: 'string', minLength: 1 }, conversationKey: { type: 'string' } }, ['text', 'evidence']),
    handler: (args, ctx) => writePreference(ctx.channel === 'mcp' ? { ...ctx, conversationKey: args.conversationKey } : ctx, args, { fromAsk: true }) },
  { name: 'record_household_fact', scope: 'write:facts',
    description: 'Record or correct a typed household fact using only the person\'s exact words in this conversation or the existing stored value. Use get_fact_answer_shapes for accepted keys and shapes. Unknown keys are refused. Include the exact words as evidence; never infer an amount or date. Returns a change receipt with Undo.',
    inputSchema: obj({ key: id, value: {}, evidence: { type: 'string', minLength: 1 }, conversationKey: { type: 'string' } }, ['key', 'value', 'evidence']),
    handler: (args, ctx) => recordFact(args, ctx.channel === 'mcp' ? { ...ctx, conversationKey: args.conversationKey } : ctx) },
  { name: 'set_recommendation_step', scope: 'write:steps', description: 'Check or uncheck a recommendation step by its zero-based index. Shares the dialog checkbox write path and returns a receipt.',
    inputSchema: obj({ id, index: { type: 'integer', minimum: 0 }, checked: { type: 'boolean' } }, ['id', 'index', 'checked']),
    handler: (args, ctx) => { const { row, receipt } = changeRec(args, ctx, 'step'); return { id: row.id, tasksDone: JSON.parse(row.tasks_done), receipt }; } },
  { name: 'create_goal', scope: 'write:goals', description: 'Create a goal in the person\'s words, using a target amount and date only when stated in this conversation or already stored. Returns the saved goal and a receipt.',
    inputSchema: obj(goalFields, ['title']), handler: (args, ctx) => changeGoal(args, ctx) },
  { name: 'edit_goal', scope: 'write:goals', description: 'Edit a goal, target or target date. Supply only changed fields, with target amounts and dates from the person\'s words or stored data. Returns a receipt.',
    inputSchema: obj({ id, ...goalFields }, ['id']), handler: (args, ctx) => changeGoal(args, ctx, true) },
  ...[['preference', 'write:preferences'], ['fact', 'write:facts'], ['step', 'write:steps'], ['goal', 'write:goals'], ['recommendation', 'write:recs']].map(([kind, scope]) => ({
    name: `undo_${kind}_action`, scope, mcpOnly: true, description: `Undo your earlier ${kind} change using its receipt id. Refuses another person's change or an item edited since.`,
    inputSchema: obj({ id }, ['id']), handler: (args, ctx) => undoAction(ctx, args.id, scope),
  })),
];

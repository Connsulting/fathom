import { writePreference } from '../actions/preferences.mjs';
import { recordFact, changeGoal, changeRec } from '../actions/index.mjs';
import { undoAction } from '../actions/receipts.mjs';
import { GOAL_KINDS, PRIORITIES, GOAL_STATUSES } from '../shared/goals.mjs';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1 };
const goalFields = { title: { type: 'string' }, note: { type: 'string' }, horizon: { type: 'string' },
  target: { anyOf: [{ type: 'number' }, { type: 'null' }] }, targetDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  track: { anyOf: [{ type: 'null' }, obj({ accounts: { type: 'array', items: { type: 'string' } } }, ['accounts']), obj({ figure: id }, ['figure'])] },
  ...goalModelFields() };

// The goal model fields (src/shared/goals.mjs): kind, whose goal, priority, status and the kind
// fields. validateGoal holds the per-kind rules; the schema holds the shapes.
function goalModelFields() {
  const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
  const share = obj({ person: { type: 'string' }, amount: { type: 'number' } }, ['person', 'amount']);
  return {
    kind: { type: 'string', enum: [...GOAL_KINDS] },
    owner: nullable({ type: 'string' }),
    priority: nullable({ type: 'string', enum: [...PRIORITIES] }),
    status: { type: 'string', enum: [...GOAL_STATUSES] },
    targetLow: nullable({ type: 'number' }),
    targetHigh: nullable({ type: 'number' }),
    floor: nullable({ type: 'number' }),
    taxYear: nullable({ type: 'integer' }),
    accounts: nullable({ type: 'array', items: { type: 'string' } }),
    split: nullable({ type: 'array', items: share }),
    entered: nullable(obj({ asOf: { type: 'string' }, total: { type: 'number' }, people: { type: 'array', items: share } }, ['asOf'])),
  };
}

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
  { name: 'create_goal', scope: 'write:goals', description: 'Create a goal in the person\'s words. kind is balance (default), range (targetLow, targetHigh), floor (floor and track) or contribution (target is the amount, taxYear, targetDate is the deadline, optional accounts, split and entered). owner is whose goal (owner, spouse, joint or a dependent key such as kid); priority is high, medium or low. Use amounts and dates only when stated in this conversation or already stored. Returns the saved goal and a receipt.',
    inputSchema: obj(goalFields, ['title']), handler: (args, ctx) => changeGoal(args, ctx) },
  { name: 'edit_goal', scope: 'write:goals', description: 'Edit a goal: any field create_goal takes, or status done to mark it done and open to reopen it. Supply only changed fields, with amounts and dates from the person\'s words or stored data. Returns a receipt.',
    inputSchema: obj({ id, ...goalFields }, ['id']), handler: (args, ctx) => changeGoal(args, ctx, true) },
  ...[['preference', 'write:preferences'], ['fact', 'write:facts'], ['step', 'write:steps'], ['goal', 'write:goals'], ['recommendation', 'write:recs']].map(([kind, scope]) => ({
    name: `undo_${kind}_action`, scope, mcpOnly: true, description: `Undo your earlier ${kind} change using its receipt id. Refuses another person's change or an item edited since.`,
    inputSchema: obj({ id }, ['id']), handler: (args, ctx) => undoAction(ctx, args.id, scope),
  })),
];

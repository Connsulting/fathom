import { GOAL_KINDS, PRIORITIES, GOAL_STATUSES, HORIZONS, HORIZON_IDS } from '../../shared/goals.mjs';
import { changeGoal } from '../../actions/index.mjs';
const id = { type: 'string', minLength: 1 };
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const fields = { title: { type: 'string' }, note: { type: 'string' }, horizon: { type: 'string', enum: HORIZON_IDS, description: HORIZONS.map(h => `${h.id}: ${h.label}`).join('; ') },
  target: { anyOf: [{ type: 'number' }, { type: 'null' }] }, targetDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  track: { anyOf: [{ type: 'null' }, obj({ accounts: { type: 'array', items: { type: 'string' } } }, ['accounts']), obj({ figure: id }, ['figure'])] }, ...goalModelFields() };
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


export const operations = [
  { tool: 'update_goal', name: 'create', scope: 'write:goals', summary: 'Create a balance, range, floor or contribution goal with stated amounts and dates.', route: 'Create a household goal', routes: ['POST /api/goals'], params: fields, required: ['title'], handler: (args, ctx) => changeGoal(args, ctx) },
  { tool: 'update_goal', name: 'edit', scope: 'write:goals', summary: 'Edit supplied goal fields; status done completes a goal and open reopens it.', route: 'Edit a household goal', routes: ['POST /api/goals/:id'], params: { id, ...fields }, required: ['id'], handler: (args, ctx) => changeGoal(args, ctx, true) },
];

export const rules = ['On a failed write, quote the tool reason, then retry with corrected arguments when the reason allows. Never tell the person to try the UI to discover the error.'];

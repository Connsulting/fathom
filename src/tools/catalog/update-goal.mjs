import { changeGoal } from '../../actions/index.mjs';
const id = { type: 'string', minLength: 1 };
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const fields = { title: { type: 'string' }, note: { type: 'string' }, horizon: { type: 'string' },
  target: { anyOf: [{ type: 'number' }, { type: 'null' }] }, targetDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  track: { anyOf: [{ type: 'null' }, obj({ accounts: { type: 'array', items: { type: 'string' } } }, ['accounts']), obj({ figure: id }, ['figure'])] } };
export const operations = [
  { tool: 'update_goal', name: 'create', scope: 'write:goals', summary: 'Create a goal using owner words or stored targets and dates.', route: 'Create a household goal', routes: ['POST /api/goals'], params: fields, required: ['title'], handler: (args, ctx) => changeGoal(args, ctx) },
  { tool: 'update_goal', name: 'edit', scope: 'write:goals', summary: 'Edit only the supplied goal fields using owner words or stored data.', route: 'Edit a household goal', routes: ['POST /api/goals/:id'], params: { id, ...fields }, required: ['id'], handler: (args, ctx) => changeGoal(args, ctx, true) },
];

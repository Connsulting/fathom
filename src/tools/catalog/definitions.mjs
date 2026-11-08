import { saveDefinition, deleteDefinition, validateDefinition } from '../../spending/definitions.mjs';
import { writePreference } from '../../actions/preferences.mjs';

const definitionId = { type: 'string', minLength: 2, maxLength: 40, pattern: '^[a-z][a-z0-9_]+$' };
const scope = 'write:preferences';
export const capabilities = ['definitions'];
export const rules = ['A named spending selection the owner wants kept is update_preferences.save_definition, never update_preferences.remember. A saved definition named in a question is passed as definition, by the id the context lists.'];
export const operations = [
  { tool: 'update_preferences', name: 'save_definition', scope, summary: 'Save a named spending selection and its linked preference.', route: 'Remember a named spending selection', routes: [],
    params: { definitionId, name: { type: 'string', minLength: 1, maxLength: 60 }, def: { type: 'object' }, evidence: { type: 'string', minLength: 1 } }, required: ['definitionId', 'name', 'def', 'evidence'],
    preflight: args => validateDefinition(args), handler: saveArgs },
  { tool: 'update_preferences', name: 'delete_definition', scope, summary: 'Delete a saved selection and its linked preference.', route: 'Delete a saved spending definition', routes: [],
    params: { definitionId }, required: ['definitionId'], handler: (args, ctx) => deleteDefinition(ctx, args.definitionId) },
  { tool: 'update_preferences', name: 'forget', scope, summary: 'Forget a preference; its linked spending definition is deleted too.', route: 'Forget a household preference', routes: ['POST /api/preferences/:id/delete'],
    params: { id: { type: 'string', minLength: 1 } }, required: ['id'], handler: (args, ctx) => writePreference(ctx, args, { remove: true }) },
];
function saveArgs(args, ctx) { return saveDefinition(ctx, args); }

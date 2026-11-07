import { BUILTIN_DEFINITIONS } from '../calc/classes.mjs';
import { ToolError } from '../tools/errors.mjs';

export const spendingDefinitions = () => Object.values(BUILTIN_DEFINITIONS).map(d=>structuredClone(d));
export function resolveDefinition(db,id) {
  if(id===undefined)return null;
  if(!Object.hasOwn(BUILTIN_DEFINITIONS,id))throw new ToolError('bad_input','Unknown spending definition');
  return structuredClone(BUILTIN_DEFINITIONS[id]);
}

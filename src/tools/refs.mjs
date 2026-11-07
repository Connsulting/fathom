// Figure references (section 3, Figure references and chaining). A ref is { tool, args, path }: a
// read call (args include operation) and a dotted path to a figure in its result. MCP is stateless,
// so a ref is re-evaluated server-side with the same ctx (same store, same clock) through callTool.
// Only referenceable read operations can be named, and refs nest at most MAX_REF_DEPTH deep: a ref
// whose call holds a ref whose call holds a ref. The depth rides on ctx.refDepth.
import { ToolError } from './errors.mjs';
import { UNITS } from '../calc/figure.mjs';

export const MAX_REF_DEPTH = 3;
const PATH = /^(?:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)?$/;
const KEYS = new Set(['tool', 'args', 'path']);

// The registry imports every catalog module at load time, and a catalog module imports this file,
// so the registry is loaded on first use rather than at import (a static import would wait on
// itself through the registry's top-level await).
let registry;
const loadRegistry = async () => (registry ??= await import('./index.mjs'));

const bad = message => new ToolError('bad_input', message);
const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v);

// A figure envelope (src/calc/figure.mjs): a value, a known unit and provenance.
export const isFigure = v => isObject(v) && Object.hasOwn(v, 'value') && UNITS.includes(v.unit) && isObject(v.provenance);

function at(result, path) {
  if (path === '') return result;
  let value = result;
  for (const key of path.split('.')) {
    if (value == null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// Re-run the referenced call and return the figure at its path, or, when the path names a
// nonempty list of figures, that list (only `sum` accepts one; the caller decides). `where` names
// the argument in every refusal.
export async function resolveRef(ref, ctx, where = 'ref') {
  if (!isObject(ref)) throw bad(`${where} must be { tool, args, path }`);
  for (const key of Object.keys(ref)) if (!KEYS.has(key)) throw bad(`${where}.${key} is not a known ref field`);
  if (typeof ref.tool !== 'string' || !ref.tool) throw bad(`${where}.tool must name a read tool`);
  if (!isObject(ref.args) || typeof ref.args.operation !== 'string') throw bad(`${where}.args must be an object with operation`);
  if (typeof ref.path !== 'string' || ref.path.length > 200 || !PATH.test(ref.path)) throw bad(`${where}.path must be a dotted path to a figure`);
  const depth = (ctx?.refDepth ?? 0) + 1;
  if (depth > MAX_REF_DEPTH) throw bad(`${where}: ref depth over ${MAX_REF_DEPTH}; refs nest at most ${MAX_REF_DEPTH} deep`);

  const { getTool, callTool } = await loadRegistry();
  const tool = getTool(ref.tool);
  if (!tool) throw bad(`${where}.tool: no tool ${ref.tool}`);
  if (tool.kind !== 'read') throw bad(`${where}.tool: ${ref.tool} is a write tool; refs name read operations only`);
  const pair = `${ref.tool}.${ref.args.operation}`;
  const op = tool.operations.find(o => o.name === ref.args.operation);
  if (!op) throw bad(`${where}.args.operation: ${ref.tool} has no operation ${ref.args.operation}; it has ${tool.operations.map(o => o.name).join(', ')}`);
  if (!op.referenceable) throw bad(`${where}: ${pair} is not referenceable`);

  let result;
  try {
    result = await callTool(ref.tool, ref.args, { ...ctx, refDepth: depth });
  } catch (e) {
    if (e instanceof ToolError) throw new ToolError(e.code, `${where}: ${e.message}`);
    throw e;
  }
  const target = at(result, ref.path);
  if (isFigure(target)) return target;
  if (Array.isArray(target) && target.length && target.every(isFigure)) return target;
  throw bad(`${where}.path: ${ref.path || '(the whole result)'} is not a figure in the ${pair} result`);
}

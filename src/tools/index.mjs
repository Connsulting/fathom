import { readdir } from 'node:fs/promises';
import { ToolError } from './errors.mjs';

export { ToolError };
export { packDirsFor } from './packs.mjs';

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v != null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return false;
  }
}

function check(schema, v, path) {
  if (schema.anyOf) {
    let first = null;
    const ok = schema.anyOf.some(branch => {
      try { check(branch, v, path); return true; } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        first = first || e;
        return false;
      }
    });
    if (!ok) throw first || new ToolError('bad_input', `${path} does not match any allowed shape`);
  }
  const types = schema.type == null ? null : [].concat(schema.type);
  if (types && !types.some(t => typeOk(t, v))) throw new ToolError('bad_input', `${path} must be ${types.join(' or ')}`);
  if (schema.enum && !schema.enum.includes(v)) throw new ToolError('bad_input', `${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) throw new ToolError('bad_input', `${path} must be at least ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) throw new ToolError('bad_input', `${path} must be at most ${schema.maximum}`);
  }
  if (typeof v === 'string') {
    if (schema.minLength != null && v.length < schema.minLength) throw new ToolError('bad_input', `${path} is too short`);
    if (schema.maxLength != null && v.length > schema.maxLength) throw new ToolError('bad_input', `${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) throw new ToolError('bad_input', `${path} has the wrong format`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) throw new ToolError('bad_input', `${path} has too few items`);
    if (schema.maxItems != null && v.length > schema.maxItems) throw new ToolError('bad_input', `${path} has too many items`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, `${path}[${i}]`));
  }
  if (typeOk('object', v) && (schema.properties || schema.required)) {
    for (const k of schema.required || []) if (v[k] === undefined) throw new ToolError('bad_input', `${path}.${k} is required`);
    for (const [k, x] of Object.entries(v)) {
      const sub = schema.properties && schema.properties[k];
      if (!sub) {
        if (schema.additionalProperties === false) throw new ToolError('bad_input', `${path}.${k} is not a known argument`);
        continue;
      }
      if (x !== undefined) check(sub, x, `${path}.${k}`);
    }
  }
}

export function validate(schema, args) {
  check(schema, args, 'args');
  return args;
}

const directory = new URL('./catalog/', import.meta.url);
const modules = [];
for (const filename of (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort()) {
  modules.push(await import(new URL(filename, directory)));
}

const byToolName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
export const tools = modules.flatMap(module => module.tools).sort(byToolName);
export const parity = {};
for (const module of modules) {
  for (const [route, names] of Object.entries(module.parity)) {
    parity[route] = [...new Set([...(parity[route] || []), ...names])].sort();
  }
}
export const CAPABILITIES = [...new Set(modules.flatMap(module => module.capabilities || []))].sort();

const byName = new Map(tools.map(t => [t.name, t]));

export function getTool(name) {
  return byName.get(name) || null;
}

export async function callTool(name, args, ctx) {
  const tool = getTool(name);
  if (!tool) throw new ToolError('not_found', `no tool ${name}`);
  const a = args == null ? {} : args;
  validate(tool.inputSchema, a);
  return tool.handler(a, ctx);
}

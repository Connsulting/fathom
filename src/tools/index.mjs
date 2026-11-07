import { readdir } from 'node:fs/promises';
import { ToolError } from './errors.mjs';

export { ToolError };
export { packDirsFor } from './catalog/knowledge.mjs';
import { headers, operationScopes } from './tools.mjs';
import { WRITE_SCOPES } from '../shared/action-scopes.mjs';
import { isDeepStrictEqual } from 'node:util';

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

export { operationScopes } from './tools.mjs';

export function buildRegistry(modules, toolHeaders = headers) {
  const grouped = new Map();
  const parity = {};
  for (const op of modules.flatMap(m => m.operations || [])) {
    const header = toolHeaders.find(t => t.name === op.tool);
    if (!header) throw new TypeError(`Unknown tool ${op.tool}`);
    if (!/^[a-z][a-z0-9_]*$/.test(op.name) || !op.summary || op.summary.length > 140 || !op.route || !Array.isArray(op.routes)) throw new TypeError(`Invalid operation ${op.tool}.${op.name}`);
    const scopes = operationScopes(op);
    if ((op.scope === undefined) === (op.scopes === undefined) || !scopes.length || new Set(scopes).size !== scopes.length ||
      scopes.some(s => header.kind === 'read' ? s !== 'read' : !WRITE_SCOPES.includes(s))) throw new TypeError(`Invalid scope for ${op.tool}.${op.name}`);
    const list = grouped.get(op.tool) || [];
    if (list.some(o => o.name === op.name)) throw new TypeError(`Duplicate operation ${op.tool}.${op.name}`);
    if (!op.params || !Array.isArray(op.required) || op.required.some(k => !Object.hasOwn(op.params, k)) || Object.hasOwn(op.params, 'operation')) throw new TypeError(`Invalid parameters for ${op.tool}.${op.name}`);
    list.push(op); grouped.set(op.tool, list);
    for (const route of op.routes) (parity[route] ||= []).push(`${op.tool}.${op.name}`);
  }
  const tools = toolHeaders.filter(t => grouped.has(t.name)).map(header => {
    const operations = grouped.get(header.name);
    const first = operations.find(o => !o.required.length && o.name === header.firstOperation) || operations.find(o => !o.required.length);
    operations.sort((a, b) => a === first ? -1 : b === first ? 1 : a.name.localeCompare(b.name));
    if (operations.length > 8 && header.name !== 'calculate') throw new TypeError(`Too many operations for ${header.name}`);
    if (header.kind === 'read' && header.name !== 'calculate' && operations[0].required.length) throw new TypeError(`First read operation requires arguments: ${header.name}`);
    const properties = { operation: { type: 'string', enum: operations.map(o => o.name) } };
    for (const op of operations) for (const [key, schema] of Object.entries(op.params)) {
      if (Object.hasOwn(properties, key) && !isDeepStrictEqual(properties[key], schema)) throw new TypeError(`Conflicting parameter schema: ${header.name}.${key}`);
      properties[key] = schema;
    }
    const description = [header.purpose, ...operations.map(o => `${o.name} (${Object.keys(o.params).map(k => k + (o.required.includes(k) ? '' : '?')).join(', ')}): ${o.summary}`)].join('\n');
    if (description.length > 900) throw new TypeError(`Description too long: ${header.name}`);
    const inputSchema = { type: 'object', properties, required: ['operation'], additionalProperties: false };
    return { ...header, operations, description, inputSchema, async handler(args, ctx) {
      const op = operations.find(o => o.name === args?.operation);
      const pair = `${header.name}.${args?.operation ?? '(missing operation)'}`;
      if (!op) throw new ToolError('bad_input', `${pair}: operation must be one of ${operations.map(o => o.name).join(', ')}`);
      try { validate({ type: 'object', properties: { operation: properties.operation, ...op.params }, required: ['operation', ...op.required], additionalProperties: false }, args); }
      catch (e) { if (e instanceof ToolError) throw new ToolError('bad_input', `${pair}: ${e.message}`); throw e; }
      const { operation, ...params } = args;
      const result = await op.handler(params, ctx);
      if (header.kind === 'write' && result?.receipt) {
        result.undo = result.receipt.undone ? { available: false, reason: 'Already undone.' } : { available: true, tool: 'undo', args: { operation: 'undo', id: result.receipt.id } };
      }
      return result;
    } };
  }).sort((a, b) => a.name.localeCompare(b.name));
  for (const route of Object.keys(parity)) parity[route] = [...new Set(parity[route])].sort();
  const rules = [...new Set(modules.flatMap(m => m.rules || []))];
  const routing = tools.flatMap(t => t.operations.map(o => `${o.route}: ${t.name}.${o.name}`)).join('\n');
  const instructions = [
    'Route by question shape. Every call requires operation.', routing,
    'When no tool covers the question, say "Fathom does not have that" and what it does have. No securities selection, live market quotes, money movement or tax filing.',
    'Use write operations only in chat when the owner asked for that change in this conversation. Confirm each change with its receipt and Undo. Never chain unrequested writes. Confirm only when their request is ambiguous.',
    'Use only typed owner words or stored data for fact values and goal targets; never invent a figure or infer a date.',
    'Write stored figures as {f:key} tokens returned by household.figures, never typed amounts.',
    ...rules,
  ].join('\n');
  return { tools, parity, instructions, capabilities: [...new Set(modules.flatMap(m => m.capabilities || []))].sort() };
}

const directory = new URL('./catalog/', import.meta.url);
const modules = [];
for (const filename of (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort()) {
  modules.push(await import(new URL(filename, directory)));
}
const registry = buildRegistry(modules);
export const tools = registry.tools;
export const parity = registry.parity;
export const instructions = registry.instructions;
export const CAPABILITIES = registry.capabilities;
const byName = new Map(tools.map(t => [t.name, t]));
export function getTool(name) { return byName.get(name) || null; }
export async function callTool(name, args, ctx) {
  const tool = getTool(name);
  if (!tool) throw new ToolError('not_found', `no tool ${name}`);
  return tool.handler(args ?? {}, ctx);
}

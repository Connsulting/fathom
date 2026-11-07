import assert from 'node:assert/strict';
import { callTool } from '../../src/tools/index.mjs';

export function envelopeEntries(result) {
  const found = [];
  function visit(value, path) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'value') && typeof value.unit === 'string' && value.ref) {
      found.push({ path, figure: value });
    }
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
  }
  visit(result, '');
  return found;
}

export async function assertRefsResolve(result, ctx) {
  const entries = envelopeEntries(result);
  assert.ok(entries.length > 0, 'the result contains at least one figure envelope');
  for (const { path, figure } of entries) {
    const { tool, args, path: target } = figure.ref;
    assert.equal(typeof target, 'string', `${path} has a dotted reference path`);
    const replay = await callTool(tool, args, ctx);
    const resolved = target.split('.').reduce((value, key) => value?.[key], replay);
    assert.deepEqual(resolved, figure, `${path} resolves through ${tool}:${target}`);
  }
  return entries.length;
}

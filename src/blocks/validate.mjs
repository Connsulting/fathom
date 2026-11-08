import { headers } from '../tools/tools.mjs';
import { at, isObject, validPath, findCall, groups, sources, fieldType, isFigure, isoDate } from './paths.mjs';
import { validTitle } from './labels.mjs';
import { buildSnapshot } from './snapshot.mjs';

const exact = (v, allowed, required = []) => isObject(v) && Object.keys(v).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(v, k));
const refShape = v => exact(v, ['tool', 'args', 'path'], ['tool', 'args', 'path']) && typeof v.tool === 'string' && v.tool.length > 0 && isObject(v.args) && validPath(v.path, true);
const paths = v => Array.isArray(v) && v.length > 0 && v.every(p => validPath(p));
function schema(op, a) {
  if (!isObject(a) || Object.hasOwn(a, 'title') && !validTitle(a.title)) return false;
  if (op === 'chart') return exact(a, ['kind', 'source', 'x', 'series', 'stacked', 'title'], ['kind', 'source', 'x', 'series']) &&
    ['line', 'bar', 'area', 'scatter'].includes(a.kind) && refShape(a.source) && validPath(a.x) &&
    Array.isArray(a.series) && a.series.length > 0 && a.series.every(s => exact(s, ['path', 'source'], ['path']) && validPath(s.path) && (!Object.hasOwn(s, 'source') || refShape(s.source))) &&
    (!Object.hasOwn(a, 'stacked') || ['bar', 'area'].includes(a.kind) && typeof a.stacked === 'boolean');
  if (op === 'table') return exact(a, ['source', 'columns', 'sort', 'title'], ['source', 'columns']) && refShape(a.source) && paths(a.columns) &&
    (!Object.hasOwn(a, 'sort') || exact(a.sort, ['column', 'dir'], ['column', 'dir']) && a.columns.includes(a.sort.column) && ['asc', 'desc'].includes(a.sort.dir));
  if (op === 'compare') return exact(a, ['source', 'options', 'fields', 'title'], ['fields']) && paths(a.fields) &&
    Object.hasOwn(a, 'source') !== Object.hasOwn(a, 'options') && (Object.hasOwn(a, 'source') ? refShape(a.source) :
      Array.isArray(a.options) && a.options.every(o => exact(o, ['source'], ['source']) && refShape(o.source)));
  if (op === 'timeline') return exact(a, ['source', 'date', 'value', 'title'], ['source', 'date']) && refShape(a.source) && validPath(a.date) &&
    (!Object.hasOwn(a, 'value') || validPath(a.value));
  return false;
}
function fieldsFor(op, spec, resolved) {
  if (op === 'chart') return [
    ...(spec.kind === 'scatter' ? [resolved[0]] : resolved).map(g => ({ ...g, path: spec.x, role: spec.kind === 'scatter' ? 'number' : 'x', axis: 'x' })),
    ...spec.series.map(s => ({ ...resolved.find(g => g.ref === (s.source || spec.source)), path: s.path, role: 'number', axis: 'y' })),
  ];
  if (op === 'table' || op === 'compare') return (spec.columns || spec.fields).flatMap(path => resolved.map(g => ({ ...g, path })));
  return [{ ...resolved[0], path: spec.date, role: 'date' }, ...(spec.value ? [{ ...resolved[0], path: spec.value, role: 'figure' }] : [])];
}
const identity = value => JSON.stringify(isFigure(value) ? value.value : value);
export function validateBlock(op, args, turnResults) {
  const fail = reason => ({ ok: false, reason });
  if (!schema(op, args) || !Array.isArray(turnResults)) return fail('bad_input');
  const refs = sources(op, args);
  if (refs.some(ref => !findCall(ref, turnResults))) return fail('not_in_answer');
  if (refs.some(ref => ref.tool === 'show' || !headers.some(t => t.name === ref.tool && t.kind === 'read'))) return fail('not_a_read');
  const resolved = groups(op, args, turnResults);
  if (resolved.some(g => op === 'compare' && args.options ? !isObject(g.items[0]) : !Array.isArray(g.items))) return fail('bad_path');
  const fields = fieldsFor(op, args, resolved);
  if (fields.some(f => f.items.some(item => {
    const type = fieldType(f.ref, item, f.path);
    return !type || f.role === 'number' && type.type === 'text' || f.role === 'figure' && type.type !== 'fig';
  }))) return fail('bad_field');
  const units = f => new Set(f.items.map(item => fieldType(f.ref, item, f.path).unit));
  const mixed = fields.some(f => units(f).size > 1) ||
    (op === 'chart' && args.kind !== 'scatter' && new Set(fields.filter(f => f.axis === 'y').flatMap(f => [...units(f)])).size > 1) ||
    (op === 'chart' && fields.filter(f => f.axis === 'y').some(f => units(f).has('date'))) ||
    (op === 'compare' && args.fields.some(path => new Set(fields.filter(f => f.path === path).flatMap(f => [...units(f)])).size > 1)) ||
    (op === 'timeline' && resolved[0].items.some(item => { const v = at(item, args.date); return isFigure(v) ? v.unit !== 'date' : !isoDate(v); }));
  if (mixed) return fail('mixed_units');
  const limit = { chart: 120, table: 200, compare: 8, timeline: 60 }[op];
  const count = op === 'compare' && args.options ? args.options.length : resolved[0].items.length;
  if (resolved.some(g => !g.items.length || g.items.length > limit) || count < (op === 'compare' ? 2 : 1) || count > limit ||
    args.columns?.length > 8 || args.fields?.length > 8 || args.series?.length > 4 || args.kind === 'scatter' && args.series.length !== 1) return fail('too_large');
  if (turnResults.filter(c => c.name === 'show' && !c.isError && c.result?.status === 'shown').length >= 4) return fail('too_many');
  if (!(op === 'chart' && args.kind === 'scatter' && resolved.some(g => g.items.length !== count)) &&
    Buffer.byteLength(JSON.stringify(buildSnapshot(op, args, turnResults)), 'utf8') > 65_536) return fail('too_large');
  if (op === 'chart' && args.kind !== 'scatter') {
    const xs = resolved.map(g => g.items.map(item => identity(at(item, args.x))));
    if (xs.some(values => new Set(values).size !== values.length || values.length !== xs[0].length || values.some(v => !xs[0].includes(v)))) return fail('misaligned');
  }
  if (op === 'chart' && args.kind === 'scatter' && resolved.some(g => g.items.length !== count)) return fail('misaligned');
  return { ok: true };
}

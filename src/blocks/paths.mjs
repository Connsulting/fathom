import { isDeepStrictEqual } from 'node:util';
import { UNITS } from '../calc/figure.mjs';

export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
export const validPath = (path, root = false) => typeof path === 'string' &&
  (root && path === '' || path.length > 0 && path.split('.').length <= 6 && path.split('.').every(s => SEGMENT.test(s) && !FORBIDDEN.has(s)));
export function at(value, path) {
  if (path === '') return value;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
export const isoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export const isFigure = v => isObject(v) && UNITS.includes(v.unit) && isObject(v.provenance) &&
  (v.value === null ? Array.isArray(v.gaps) && v.gaps.length > 0 : v.unit === 'date' ? isoDate(v.value) : typeof v.value === 'number' && Number.isFinite(v.value));
export const findCall = (ref, results) => results.find(c => c.name === ref.tool && !c.isError && isDeepStrictEqual(c.args, ref.args));
export const resolve = (ref, results) => at(findCall(ref, results).result, ref.path);
export function sources(op, spec) {
  if (op === 'compare' && spec.options) return spec.options.map(o => o.source);
  return [spec.source, ...(op === 'chart' ? spec.series.flatMap(s => s.source ? [s.source] : []) : [])];
}
export function groups(op, spec, results) {
  if (op === 'compare' && spec.options) return spec.options.map(o => ({ ref: o.source, items: [resolve(o.source, results)] }));
  return sources(op, spec).map(ref => ({ ref, items: resolve(ref, results) }));
}
export function rowNumber(ref, field) {
  return field === 'amount' && (ref.tool === 'transactions' && ref.args.operation === 'search' && ref.path === 'rows' ||
    ref.tool === 'business' && ref.args.operation === 'rows' && ref.path === '');
}
const TEXT = new Set(['month', 'year', 'key', 'label', 'date', 'description', 'category', 'merchant', 'cadence', 'status', 'account.label', 'window.from', 'window.to']);
const NUMERIC_TEXT = new Set(['month', 'date', 'year', 'key', 'window.from', 'window.to']);
export function fieldType(ref, item, field) {
  const value = at(item, field);
  if (isFigure(value)) return { type: 'fig', unit: value.unit };
  if (rowNumber(ref, field) && typeof value === 'number' && Number.isFinite(value)) return { type: 'row', unit: 'usd' };
  if (typeof value === 'string' && TEXT.has(field) && (NUMERIC_TEXT.has(field) || !/\p{N}/u.test(value))) return { type: 'text' };
  return null;
}

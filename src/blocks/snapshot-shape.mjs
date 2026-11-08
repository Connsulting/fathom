import { isFigure, isObject, isoDate } from './paths.mjs';

const text = v => typeof v === 'string';
const list = (v, check, min = 0, max = Infinity) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(check);
const bounded = v => v === undefined || (Array.isArray(v) ? v.length <= 20 : isObject(v) && Object.keys(v).length <= 20);
const fig = v => isFigure(v) && text(v.label) && text(v.kind) && (v.asOf === null || text(v.asOf)) && text(v.source) &&
  Array.isArray(v.gaps) && bounded(v.provenance.steps) && bounded(v.provenance.inputs);
const cell = v => isObject(v) && (v.t === 'fig' && fig(v.fig) || v.t === 'text' && text(v.text) || v.t === 'none' ||
  v.t === 'row' && typeof v.value === 'number' && Number.isFinite(v.value) && v.unit === 'usd' && isObject(v.row) && ['account', 'date', 'description'].every(k => Object.hasOwn(v.row, k)));
export function assertSnapshotShape(op, snapshot) {
  const s = snapshot;
  let ok = isObject(s) && text(s.title);
  if (ok && op === 'chart') {
    if (s.kind === 'scatter') ok = text(s.xLabel) && text(s.yLabel) && text(s.xUnit) && text(s.yUnit) && list(s.points,
      p => isObject(p) && text(p.label) && fig(p.x) && fig(p.y) && p.x.unit === s.xUnit && p.y.unit === s.yUnit && typeof p.frontier === 'boolean' && typeof p.current === 'boolean', 1, 120);
    else ok = ['line', 'bar', 'area'].includes(s.kind) && typeof s.stacked === 'boolean' && list(s.x, x => isObject(x) && text(x.text), 1, 120) &&
      list(s.series, series => isObject(series) && text(series.label) && text(series.unit) && list(series.points, p => p === null || fig(p) && p.unit === series.unit) && series.points.length === s.x.length, 1, 4);
  } else if (ok && op === 'table') ok = list(s.columns, c => isObject(c) && text(c.label) && ['fig', 'row', 'text'].includes(c.type), 1, 8) &&
    list(s.rows, r => isObject(r) && list(r.cells, cell) && r.cells.length === s.columns.length, 1, 200) &&
    (s.sort === undefined || isObject(s.sort) && Number.isInteger(s.sort.column) && s.sort.column >= 0 && s.sort.column < s.columns.length && ['asc', 'desc'].includes(s.sort.dir));
  else if (ok && op === 'compare') ok = list(s.fields, f => isObject(f) && text(f.label), 1, 8) &&
    list(s.options, o => isObject(o) && text(o.label) && list(o.cells, cell) && o.cells.length === s.fields.length, 2, 8);
  else if (ok && op === 'timeline') ok = list(s.events, e => isObject(e) && (e.date === null || isoDate(e.date)) && text(e.label) && (e.value === undefined || fig(e.value)), 1, 60);
  else ok = false;
  if (!ok) throw new TypeError(`Invalid ${op} snapshot`);
  return snapshot;
}

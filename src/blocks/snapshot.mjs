import { isDeepStrictEqual } from 'node:util';
import { at, isFigure, resolve, rowNumber } from './paths.mjs';
import { columnLabel, sourceLabel, fieldLabel, figureLabel, itemLabel, dateText } from './labels.mjs';
import { drillQuery } from './drill.mjs';

function provenanceOf(provenance) {
  const out = {};
  for (const key of ['calc', 'formula', 'sources', 'accounts', 'assumptions', 'packRefs'])
    if (provenance[key] !== undefined) out[key] = structuredClone(provenance[key]);
  const more = { steps: 0, inputs: 0 };
  for (const key of ['steps', 'inputs']) {
    const value = provenance[key];
    if (Array.isArray(value)) { out[key] = structuredClone(value.slice(0, 20)); more[key] = Math.max(0, value.length - 20); }
    else if (value && typeof value === 'object') {
      const entries = Object.entries(value); out[key] = structuredClone(Object.fromEntries(entries.slice(0, 20))); more[key] = Math.max(0, entries.length - 20);
    }
  }
  if (more.steps || more.inputs) out.more = more;
  return out;
}
function figure(fig, ref, field) {
  const out = { value: fig.value, unit: fig.unit, label: figureLabel(fig, ref, field), kind: fig.kind ?? 'e', asOf: fig.asOf ?? null,
    gaps: structuredClone(fig.gaps || []), provenance: provenanceOf(fig.provenance), source: sourceLabel(ref) };
  for (const key of ['window', 'quote', 'direction']) if (fig[key] !== undefined) out[key] = structuredClone(fig[key]);
  return out;
}
function cell(item, ref, field, accountLabels) {
  const value = at(item, field);
  if (isFigure(value)) return { t: 'fig', fig: figure(value, ref, field) };
  if (rowNumber(ref, field)) return { t: 'row', value, unit: 'usd', row: {
    account: item.account?.label ?? accountLabels.get(item.accountId) ?? null, date: item.date ?? null, description: item.description ?? null } };
  return { t: 'text', text: value };
}
function pointFigure(item, ref, field, accountLabels) {
  const value = at(item, field);
  if (isFigure(value)) {
    const fig = figure(value, ref, field), drill = drillQuery(ref, item, field);
    return drill ? { ...fig, drill } : fig;
  }
  const row = cell(item, ref, field, accountLabels);
  return { value: row.value, unit: 'usd', label: columnLabel([item], ref, field), kind: 'a', asOf: row.row.date,
    gaps: [], provenance: { sources: [row.row] }, source: sourceLabel(ref) };
}
const xKey = value => JSON.stringify(isFigure(value) ? value.value : value);
function drillSource(ref, results) {
  if (ref.tool !== 'business' || !/^entities\.\d+\.groups$/.test(ref.path)) return ref;
  const entity = resolve({ ...ref, path: ref.path.replace(/\.groups$/, '.entity.key') }, results);
  return { ...ref, args: { ...ref.args, entity } };
}
function chart(spec, results, accountLabels) {
  const items = resolve(spec.source, results);
  if (spec.kind === 'scatter') {
    const series = spec.series[0], ref = series.source || spec.source;
    const ys = resolve(ref, results);
    return { title: spec.title ?? sourceLabel(spec.source), kind: 'scatter',
      xLabel: columnLabel(items, spec.source, spec.x), yLabel: columnLabel(ys, ref, series.path),
      xUnit: pointFigure(items[0], spec.source, spec.x, accountLabels).unit, yUnit: pointFigure(ys[0], ref, series.path, accountLabels).unit,
      points: items.map((item, i) => ({ ...(typeof item.id === 'string' ? { id: item.id } : {}), label: itemLabel(item, spec.source),
        x: pointFigure(item, spec.source, spec.x, accountLabels), y: pointFigure(ys[i], ref, series.path, accountLabels),
        frontier: item.frontier === true, current: item.current === true })) };
  }
  return { title: spec.title ?? sourceLabel(spec.source), kind: spec.kind, stacked: spec.stacked ?? false,
    x: items.map(item => { const v = at(item, spec.x); return { text: dateText(isFigure(v) ? v.value : v) }; }),
    series: spec.series.map(s => {
      const ref = s.source || spec.source, rows = resolve(ref, results);
      const byX = new Map(rows.map(item => [xKey(at(item, spec.x)), item]));
      return { label: columnLabel(rows, ref, s.path), unit: pointFigure(rows[0], ref, s.path, accountLabels).unit,
        points: items.map(item => { const matched = byX.get(xKey(at(item, spec.x))); return matched ? pointFigure(matched, drillSource(ref, results), s.path, accountLabels) : null; }) };
    }) };
}
function table(spec, results, accountLabels) {
  const items = resolve(spec.source, results);
  const drillRef = drillSource(spec.source, results);
  return { title: spec.title ?? sourceLabel(spec.source), columns: spec.columns.map(field => {
    const sample = cell(items[0], spec.source, field, accountLabels);
    return { label: columnLabel(items, spec.source, field), type: sample.t,
      ...(sample.t === 'fig' ? { unit: sample.fig.unit } : sample.t === 'row' ? { unit: sample.unit } : {}) };
  }), rows: items.map(item => ({ cells: spec.columns.map(field => {
    const value = cell(item, spec.source, field, accountLabels), drill = drillQuery(drillRef, item, field);
    return drill ? { ...value, drill } : value;
  }) })),
  ...(spec.sort ? { sort: { column: spec.columns.indexOf(spec.sort.column), dir: spec.sort.dir } } : {}) };
}
function assumptionLabels(refs, items, fields) {
  if (refs.length < 2 || refs.some(r => r.tool !== refs[0].tool)) return null;
  const assumptions = items.map(item => fields.flatMap(field => at(item, field)?.provenance?.assumptions || []));
  const changed = assumptions[0].filter(a => assumptions.some(list => list.find(b => b.name === a.name)?.stated !== a.stated));
  if (changed.length !== 1) return null;
  const name = changed[0].name;
  const strip = (value, key) => {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && Object.hasOwn(value, 'value') && (value.name === name || key === name)) return { assumption: name };
    return Array.isArray(value) ? value.map(v => strip(v)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v, k)]));
  };
  if (!refs.every(r => isDeepStrictEqual(strip(r.args), strip(refs[0].args)))) return null;
  const records = assumptions.map(list => list.find(a => a.name === name));
  return records.every(a => typeof a?.stated === 'string') ? records.map(a => `${name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase())} ${a.stated}`) : null;
}
function compare(spec, results, accountLabels) {
  const refs = spec.options ? spec.options.map(o => o.source) : resolve(spec.source, results).map(() => spec.source);
  const items = spec.options ? refs.map(ref => resolve(ref, results)) : resolve(spec.source, results);
  const labels = spec.options ? assumptionLabels(refs, items, spec.fields) : null;
  return { title: spec.title ?? sourceLabel(refs[0]), fields: spec.fields.map(field => {
    const c = cell(items[0], refs[0], field, accountLabels);
    const labels = items.map((item, i) => columnLabel([item], refs[i], field));
    return { label: labels.every(label => label === labels[0]) ? labels[0] : fieldLabel(refs[0], field), ...(c.t === 'fig' ? { unit: c.fig.unit } : c.t === 'row' ? { unit: c.unit } : {}) };
  }), options: items.map((item, i) => ({ ...(typeof item.id === 'string' ? { id: item.id } : {}),
    label: labels?.[i] ?? itemLabel(item, refs[i]), cells: spec.fields.map(field => cell(item, refs[i], field, accountLabels)) })) };
}
function timeline(spec, results) {
  return { title: spec.title ?? sourceLabel(spec.source), events: resolve(spec.source, results).map(item => {
    const date = at(item, spec.date);
    return { date: isFigure(date) ? date.value : date, label: itemLabel(item, spec.source),
      ...(spec.value ? { value: figure(at(item, spec.value), spec.source, spec.value) } : {}) };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date))) };
}
export function buildSnapshot(op, spec, results) {
  const build = { chart, table, compare, timeline }[op];
  if (!Object.hasOwn({ chart, table, compare, timeline }, op)) throw new TypeError(`Unknown block operation: ${op}`);
  const accountLabels = new Map(results.filter(c => c.name === 'accounts' && c.args?.operation === 'list' && !c.isError)
    .flatMap(c => c.result).map(a => [a.id, a.name]));
  return build(spec, results, accountLabels);
}

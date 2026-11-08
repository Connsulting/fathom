import Ajv from 'ajv';
import { createHash, randomUUID } from 'node:crypto';
import { header } from './format.mjs';
import { TRANSFORM_SCHEMA, TARGET_SCHEMAS } from './model-contract.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const column = { type: 'integer', minimum: 1 };
const tableSchema = object({ sheet: { type: ['integer', 'null'], minimum: 0 }, headerRow: column,
  target: { enum: Object.keys(TARGET_SCHEMAS) }, fields: { type: 'object', minProperties: 1,
    additionalProperties: object({ columns: { type: 'array', items: column, minItems: 1, uniqueItems: true }, transform: TRANSFORM_SCHEMA }) },
  attributes: { type: 'object', properties: {
    basis: { enum: ['running', 'closing'] }, datePrecision: { enum: ['day', 'month', 'year', 'unknown'] },
    purpose: { enum: ['business', 'household_spending'] }, kind: { enum: ['estimate', 'withholding', 'extension', 'return', 'other'] },
    status: { enum: ['paid', 'required'] },
  }, additionalProperties: false },
  roles: { type: 'array', items: object({ column, equals: { type: 'string', minLength: 1 },
    disposition: { enum: ['control_total', 'duplicate_summary', 'forecast', 'explanatory_text', 'excluded'] }, amountColumn: column }) },
});
const check = new Ajv({ strict: true, allowUnionTypes: true }).compile(object({ schemaVersion: { const: 1 }, currency: { const: 'USD' },
  tables: { type: 'array', minItems: 1, items: tableSchema } }));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const layoutDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sheetOf = ref => ref.sheet?.index ?? null;
const grids = new WeakMap();
function grid(source) {
  if (grids.has(source)) return grids.get(source);
  const sheets = new Map();
  for (const [id, ref] of Object.entries(source.refs)) {
    const sheet = sheetOf(ref);
    if (!sheets.has(sheet)) sheets.set(sheet, new Map());
    const rows = sheets.get(sheet);
    if (!rows.has(ref.row)) rows.set(ref.row, []);
    rows.get(ref.row).push(id);
  }
  for (const rows of sheets.values()) for (const ids of rows.values()) ids.sort((a, b) => source.refs[a].column - source.refs[b].column);
  grids.set(source, sheets); return sheets;
}
const idsAt = (source, sheet, row) => grid(source).get(sheet)?.get(row) ?? [];
const field = (refs, transform = { op: 'identity' }) => ({ refs, transform });

export function layoutContext(source, layout) {
  const headers = layout.tables.map(t => ({ sheet: t.sheet, row: t.headerRow,
    columns: idsAt(source, t.sheet, t.headerRow).map(id => ({ ordinal: source.refs[id].column, label: header(String(source.values[id])) })) }));
  const structure = [...grid(source)].map(([sheet, rows]) => ({ sheet,
    columns: [...new Set([...rows.values()].flat().map(id => source.refs[id].column))].sort((a, b) => a - b),
    hidden: source.sheets.find(s => s.index === sheet)?.hidden ?? false }));
  return { headers, structure, epoch: source.epoch, layout };
}

export function applyLayout(source, layout) {
  if (!check(layout)) throw new TypeError('Invalid declarative layout');
  const context = layoutContext(source, layout), covered = new Map(), rows = [], controls = [];
  if (new Set(layout.tables.map(t => `${t.sheet}:${t.headerRow}`)).size !== layout.tables.length) throw new TypeError('Overlapping layout tables');
  for (const table of layout.tables) {
    const end = Math.min(...layout.tables.filter(t => t.sheet === table.sheet && t.headerRow > table.headerRow).map(t => t.headerRow), Infinity);
    const indices = [], pending = [];
    const numbers = [...(grid(source).get(table.sheet)?.keys() ?? [])].filter(row => row >= table.headerRow && row < end).sort((a, b) => a - b);
    for (const row of numbers) {
      const ids = idsAt(source, table.sheet, row);
      const at = col => ids.find(id => source.refs[id].column === col);
      const roles = table.roles.filter(role => String(source.values[at(role.column)]).trim() === role.equals);
      if (roles.length > 1) throw new TypeError('Ambiguous row role');
      const role = roles[0], disposition = row === table.headerRow ? 'explanatory_text' : role?.disposition ?? 'imported_detail';
      for (const id of ids) covered.set(id, { disposition, reason: field([row === table.headerRow ? ids[0] : at(role?.column) ?? ids[0]]) });
      if (disposition === 'control_total') pending.push(field([at(role.amountColumn)], { op: 'currency_decode', currency: 'USD' }));
      if (disposition !== 'imported_detail') continue;
      const fields = Object.fromEntries(Object.entries(table.fields).map(([key, selector]) => [key, field(selector.columns.map(at), selector.transform)]));
      indices.push(rows.length); rows.push({ target: table.target, fields, ...table.attributes });
    }
    for (const total of pending) controls.push({ field: total, rows: indices, precision: 'cent' });
  }
  const coverage = source.regions.map(regionId => {
    const refs = source.inventory[regionId].refs, roles = refs.map(id => covered.get(id));
    const disposition = roles.every(r => r && r.disposition === roles[0].disposition) ? roles[0].disposition : 'unresolved';
    return { regionId, disposition, refs, ...(!['imported_detail', 'control_total', 'unresolved'].includes(disposition) ? { reason: roles[0].reason } : {}) };
  });
  return { version: 1, fileId: source.fileId, sha256: source.sha256, proposalId: randomUUID(), interpreterVersion: '1',
    mappingId: layoutDigest(context), mappingVersion: 1, rows, coverage, completeness: coverage.some(c => c.disposition === 'unresolved') ? 'incomplete' : 'complete', controls };
}

export function layoutDelta(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [{ field: path, before, after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => layoutDelta(before[key], after[key], path ? `${path}.${key}` : key));
}

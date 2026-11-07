// Unknown tabular exports: the engine proposes a column mapping from the headers and at most five
// redacted rows; code validates it, applies it and remembers it by header signature so the next
// file with the same headers needs no model call. The model never sees a long digit run.

import { createHash } from 'node:crypto';
import { parseJson } from '../store/db.mjs';
import { csv, header, isoDate, money, number, mask, institution, warning, result, LIMITS, LimitError } from './format.mjs';
import { readWorkbook } from './workbook.mjs';
import { identifyAccountRows } from './dedupe.mjs';
import { redact } from './redact.mjs';

export const id = 'mapped';
export const label = 'Mapped export';
export const SAMPLE_ROWS = 5;

const COLUMNS = ['date', 'amount', 'description', 'category', 'accountName', 'accountNumber', 'institution', 'symbol', 'quantity', 'price', 'value', 'debit', 'credit', 'externalId', 'accountHolder'];
const TARGETS = ['transaction', 'balance', 'position'];
const SIGNS = ['as_is', 'negate'];
const ORDERS = ['ymd', 'mdy', 'dmy'];

export const MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', enum: TARGETS },
    ...Object.fromEntries(COLUMNS.map((c) => [c, { type: 'string' }])),
    amountSign: { type: 'string', enum: SIGNS },
    dateOrder: { type: 'string', enum: ORDERS },
  },
  required: ['target', 'amountSign', 'dateOrder'],
  additionalProperties: false,
};

const SYSTEM = [
  'You map the columns of a tabular financial export.',
  'Name each column by its exact header text. Choose target transaction, balance or position.',
  'Use externalId only for a check, slip or reference number column that identifies a transaction.',
  'Use amountSign negate only when outflows are positive numbers. Choose the date order the sample dates use.',
  'Leave out any field no column holds. Long numbers in the sample are masked on purpose.',
].join(' ');

export const headerSignature = (headers) => createHash('sha256').update(JSON.stringify(headers.map(header))).digest('hex');

export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const isCsvName = (file) => /\.(csv|tsv)$/i.test(file.name ?? '') || /csv/i.test(file.mime ?? '');

// {headers, rows: [{values, locator}]} for a CSV or the first workbook sheet with a header row of
// at least two text cells; null for anything else. Both readers are bounded: an input past
// LIMITS throws LimitError instead of returning null. The table is cached per file bytes, so a
// caller that reads it again (routing, then mapping) never holds two copies.
const tables = new WeakMap();
export function readTable(file) {
  if (!file || !(file.bytes instanceof Uint8Array) || file.bytes.length === 0) return null;
  const cached = tables.get(file.bytes);
  if (cached && cached.name === file.name && cached.mime === file.mime) return cached.table;
  const table = tableOf(file);
  tables.set(file.bytes, { name: file.name, mime: file.mime, table });
  return table;
}

function tableOf(file) {
  if (isZip(file.bytes) || /\.xlsx$/i.test(file.name ?? '')) {
    try { return workbookTable(file); } catch (e) { if (e instanceof LimitError) throw e; return null; }
  }
  if (!isCsvName(file)) return null;
  try {
    const { headers, records } = csv(file);
    if (headers.filter(Boolean).length < 2 || !records.length) return null;
    // Trimmed in place: a table near the cell limit is held once.
    for (const { values } of records) for (let i = 0; i < values.length; i++) values[i] = values[i].trim();
    return { headers, rows: records };
  } catch (e) { if (e instanceof LimitError) throw e; return null; }
}

function workbookTable(file) {
  for (const sheet of readWorkbook(file).sheets) {
    const at = sheet.rows.findIndex((row) => [...row.cells.values()].filter((c) => typeof c.value === 'string' && c.value.trim()).length >= 2);
    if (at < 0) continue;
    const head = sheet.rows[at];
    const columns = [...head.cells.keys()];
    const headers = columns.map((c) => header(head.cells.get(c).value));
    if (new Set(headers).size !== headers.length || headers.some((h) => !h)) return null;
    // Data-less rows are dropped first; only the rows that are widened to the header are budgeted.
    const data = sheet.rows.slice(at + 1).filter((row) => columns.some((c) => {
      const v = row.cells.get(c)?.value;
      return v !== undefined && v !== null && String(v).trim() !== '';
    }));
    if (data.length * columns.length > LIMITS.cells) throw new LimitError('Workbook table has too many cells');
    const rows = data.map((row) => ({ values: columns.map((c) => { const v = row.cells.get(c)?.value; return v === undefined || v === null ? '' : v; }), locator: { sheet: sheet.name, row: row.number } }));
    return rows.length ? { headers, rows } : null;
  }
  return null;
}

export function validateMapping(mapping, headers) {
  const errors = [];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return { ok: false, errors: ['mapping must be an object'] };
  for (const key of Object.keys(mapping)) {
    if (!['target', 'amountSign', 'dateOrder', ...COLUMNS].includes(key)) errors.push(`unknown field ${key}`);
  }
  if (!TARGETS.includes(mapping.target)) errors.push('target must be transaction, balance or position');
  if (!SIGNS.includes(mapping.amountSign)) errors.push('amountSign must be as_is or negate');
  if (!ORDERS.includes(mapping.dateOrder)) errors.push('dateOrder must be ymd, mdy or dmy');
  const known = new Set(headers);
  const used = new Map();
  for (const field of COLUMNS) {
    const column = mapping[field];
    if (column === undefined) continue;
    if (typeof column !== 'string' || !known.has(column)) { errors.push(`${field} names no column`); continue; }
    if (used.has(column)) errors.push(`${field} reuses the ${used.get(column)} column`);
    else used.set(column, field);
  }
  const has = (f) => typeof mapping[f] === 'string';
  if (mapping.target === 'transaction') {
    if (!has('date')) errors.push('transaction needs date');
    if (!has('amount') && !(has('debit') && has('credit'))) errors.push('transaction needs amount or debit and credit');
  } else if (mapping.target === 'balance') {
    if (!has('date')) errors.push('balance needs date');
    if (!has('amount')) errors.push('balance needs amount');
  } else if (mapping.target === 'position') {
    for (const f of ['symbol', 'quantity', 'value', 'date']) if (!has(f)) errors.push(`position needs ${f}`);
  }
  return { ok: errors.length === 0, errors };
}

function parseDate(value, order, date1904) {
  if (typeof value === 'number') return isoDate(value, date1904);
  const s = String(value ?? '').trim();
  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = order === 'ymd' ? [m[1], m[2], m[3]] : order === 'mdy' ? [m[3], m[1], m[2]] : [m[3], m[2], m[1]];
  if (y.length !== 4) return null;
  return isoDate(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
}

// A 4 digit run in the file name (not a year) stands in for an account mask.
function nameMask(file) {
  const runs = [...String(file.name ?? '').matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]).filter((r) => !/^(19|20)\d\d$/.test(r));
  return runs.at(-1) ?? '';
}

// Parser-shaped result (parser id `mapped`) from a validated mapping.
export function applyMapping(mapping, table, file) {
  const index = new Map(table.headers.map((h, i) => [h, i]));
  const cell = (values, field) => (typeof mapping[field] === 'string' ? values[index.get(mapping[field])] : undefined);
  const text = (values, field) => { const v = cell(values, field); return v === undefined || v === null ? '' : String(v).trim(); };
  const sign = mapping.amountSign === 'negate' ? -1 : 1;
  const fileMask = nameMask(file);
  let date1904 = false;
  if (table.rows[0]?.locator?.sheet) { try { date1904 = readWorkbook(file).date1904; } catch { /* plain table */ } }
  const rows = [];
  const warnings = [];
  for (const { values, locator } of table.rows) {
    const date = parseDate(cell(values, 'date'), mapping.dateOrder, date1904);
    const holder = text(values, 'accountHolder');
    const account = { inst: institution(text(values, 'institution')), mask: mask(text(values, 'accountNumber')) || fileMask, name: text(values, 'accountName'), ...(holder ? { holder } : {}) };
    if (mapping.target === 'position') {
      const symbol = text(values, 'symbol');
      const quantity = number(cell(values, 'quantity'));
      const value = money(cell(values, 'value'));
      const mapped = money(cell(values, 'price'));
      if (!date || !symbol || quantity === null || value === null) { warning(warnings, 'invalid_mapped_row', locator); continue; }
      const price = mapped ?? (quantity ? money(value / quantity) : null);
      rows.push({ kind: 'position', account, asOf: date, symbol, name: text(values, 'description'), quantity, price, value, locator });
      continue;
    }
    let amount;
    if (typeof mapping.amount === 'string') amount = money(cell(values, 'amount'));
    else {
      const debit = text(values, 'debit') ? money(cell(values, 'debit')) : 0;
      const credit = text(values, 'credit') ? money(cell(values, 'credit')) : 0;
      amount = debit === null || credit === null || (!text(values, 'debit') && !text(values, 'credit')) ? null : money(credit - debit);
    }
    if (!date || amount === null) { warning(warnings, 'invalid_mapped_row', locator); continue; }
    amount = money(sign * amount) || 0;
    if (mapping.target === 'balance') { rows.push({ kind: 'balance', account, date, amount, locator }); continue; }
    const category = text(values, 'category');
    const externalId = text(values, 'externalId');
    rows.push({ kind: 'transaction', account, date, amount, description: text(values, 'description'), ...(category ? { category } : {}), ...(externalId ? { externalId } : {}), locator });
  }
  return identifyAccountRows(result(rows, warnings), file);
}

// Prompt text: the headers and at most SAMPLE_ROWS data rows, every cell redacted.
export function sampleText(table) {
  const line = (cells) => cells.map((c) => JSON.stringify(redact(c))).join(',');
  return [line(table.headers), ...table.rows.slice(0, SAMPLE_ROWS).map((r) => line(r.values))].join('\n');
}

// The engine's mapping for this table, or null when the engine is off, fails or proposes an
// invalid mapping.
export async function proposeMapping(engine, table) {
  try {
    const rows = await engine.extract({ document: { type: 'text', text: sampleText(table) }, schema: MAPPING_SCHEMA, system: SYSTEM, maxTokens: 512 });
    const mapping = Array.isArray(rows) ? rows[0] : null;
    return mapping && validateMapping(mapping, table.headers).ok ? mapping : null;
  } catch {
    return null;
  }
}

// Map a table with a stored mapping (no model call) or a new valid proposal (stored for next time).
// Returns {status: 'imported', result, signature, mapping} or {status: 'needs_mapping', signature}.
export async function mapTabular(db, engine, file, { now } = {}) {
  const table = readTable(file);
  if (!table) return { status: 'needs_mapping', signature: null };
  const signature = headerSignature(table.headers);
  const stored = db.prepare('SELECT mapping FROM column_mappings WHERE signature = ?').get(signature);
  if (stored) {
    const mapping = parseJson(stored.mapping, null);
    if (mapping && validateMapping(mapping, table.headers).ok) {
      db.prepare('UPDATE column_mappings SET uses = uses + 1 WHERE signature = ?').run(signature);
      return { status: 'imported', result: applyMapping(mapping, table, file), signature, mapping };
    }
  }
  const mapping = await proposeMapping(engine, table);
  if (!mapping) return { status: 'needs_mapping', signature };
  db.prepare(`INSERT INTO column_mappings (signature, mapping, src, created_at, uses) VALUES (?, ?, 'engine', ?, 1)
              ON CONFLICT(signature) DO UPDATE SET mapping = excluded.mapping, src = excluded.src, uses = column_mappings.uses + 1`)
    .run(signature, JSON.stringify(mapping), now || new Date().toISOString());
  return { status: 'imported', result: applyMapping(mapping, table, file), signature, mapping };
}

export function sourceKindOf(mapping) {
  return mapping?.target === 'position' ? 'brokerage_positions' : mapping?.target === 'balance' ? 'balances' : 'bank_csv';
}

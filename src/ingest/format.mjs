export const text = (file) => new TextDecoder('utf-8', { fatal: true }).decode(file.bytes).replace(/^\uFEFF/, '');
export const header = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const warning = (warnings, code, locator = { row: 1 }) => warnings.push({ code, locator });
export const empty = (code = 'unsupported_format') => ({ rows: [], warnings: [{ code, locator: { row: 1 } }], period: { from: null, to: null } });

export function result(rows, warnings = []) {
  const dates = rows.flatMap((row) => row.date ? [row.date] : row.asOf ? [row.asOf] : row.period ? [row.period + '-01', monthEnd(row.period)] : []).sort();
  return { rows, warnings, period: { from: dates[0] ?? null, to: dates.at(-1) ?? null } };
}

export function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let valueText = asciiMinus(String(value ?? '').trim());
  if (!valueText) return null;
  const parentheses = /^\(.*\)$/.test(valueText);
  if (parentheses) valueText = valueText.slice(1, -1).trim();
  valueText = valueText.replace(/^([+-]?)\$/, '$1');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(valueText)) return null;
  const parsed = Number(valueText.replaceAll(',', '')) * (parentheses ? -1 : 1);
  return Number.isFinite(parsed) ? parsed : null;
}

export const cents = (value) => Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100 || 0;
export const money = (value) => { const n = number(value); return n === null ? null : cents(n); };
export const mask = (value) => String(value ?? '').replace(/\D/g, '').slice(-4);
export const institution = (value) => /chase/i.test(String(value)) ? 'Chase' : String(value ?? '').trim();

export function isoDate(value, date1904 = false) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || (!date1904 && Math.floor(value) === 60)) return null;
    const serial = Math.floor(value);
    const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
    const date = new Date(epoch + (serial - (!date1904 && serial > 60 ? 1 : 0)) * 86400000);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1900 && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : null;
  }
  const s = String(value ?? '').trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) { const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); if (us) match = [s, us[3], us[1], us[2]]; }
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
}

export function monthEnd(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period)) || !isoDate(period + '-01')) return null;
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Parse limits. Every reader counts while it scans and throws LimitError before it would hold
// more than this: rows (records, header included), columns (cells in one record), cells (total),
// cellChars (characters in one cell).
export const LIMITS = Object.freeze({ rows: 200000, columns: 512, cells: 2000000, cellChars: 32768 });
// Workbooks keep LIMITS but a lower cell budget (worksheet cells, shared strings and rich-text
// runs together), because every cell of a workbook is held in memory once it is read.
export const XLSX_LIMITS = Object.freeze({ cells: 250000 });
export class LimitError extends Error {
  code = 'limit_exceeded';
  constructor(message = 'Input exceeds parse limits') { super(message); this.name = 'LimitError'; }
}
const HEADER_WINDOW = 64 * 1024;

// Unicode minus and dash forms directly before a digit or `$` become an ASCII minus.
const MINUS_FORMS = /[\u2212\u2012\u2013\u2014\uFE63\uFF0D](?=[\d$])/g;
export const asciiMinus = (value) => String(value).replace(MINUS_FORMS, '-');

// Scans CSV text record by record. onRecord(values, locator) returns true to stop. A malformed
// record goes to onBad(locator). The trailing record is finished only when `complete` (the text
// is the whole input). Returns {stopped, unclosed, start}. Cells are counted, never built one
// character at a time: with `build` a well-formed record's cells are sliced from the source when
// each cell ends; without it nothing is built or kept, and onRecord gets an empty array.
function scanCsv(input, limits, complete, onRecord, onBad, build = true, delimiter = ',') {
  let cells = [], count = 0, chars = 0, begin = 0, open = -1, close = -1, escaped = false;
  let quoted = false, closed = false, bad = false, blank = true, line = 1, start = 1;
  let rows = 0, total = 0, stopped = false;
  const push = (end) => {
    if (count >= limits.columns) throw new LimitError('CSV record has too many columns');
    count++;
    if (build && !bad) {
      const value = close < 0 ? input.slice(begin, end) : input.slice(open + 1, close);
      cells.push(escaped ? value.replaceAll('""', '"') : value);
    }
    chars = 0; open = -1; close = -1; escaped = false; closed = false;
  };
  const finish = (end) => {
    push(end);
    if (!blank) {
      if (++rows > limits.rows) throw new LimitError('CSV has too many rows');
      if (bad) onBad({ row: start });
      else {
        total += count;
        if (total > limits.cells) throw new LimitError('CSV has too many cells');
        stopped = onRecord(cells, { row: start }) === true;
      }
    }
    cells = []; count = 0; bad = false; blank = true; start = line + 1;
  };
  const add = (ch) => {
    if (chars >= limits.cellChars) throw new LimitError('CSV cell is too long');
    chars++;
    if (blank && !/\s/.test(ch)) blank = false;
  };
  for (let i = 0; i < input.length && !stopped; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { add('"'); escaped = true; i++; }
      else if (ch === '"') { quoted = false; closed = true; close = i; }
      else { add(ch); if (ch === '\n') line++; }
    } else if (ch === delimiter) { push(i); begin = i + 1; }
    else if (ch === '\n' || ch === '\r') {
      const end = i;
      if (ch === '\r' && input[i + 1] === '\n') i++;
      finish(end); line++; start = line; begin = i + 1;
    } else if (ch === '"' && !chars && !closed) { quoted = true; open = i; }
    else if (closed && /\s/.test(ch)) continue;
    else { if (closed || ch === '"') bad = true; add(ch); }
  }
  if (stopped) return { stopped, unclosed: false, start };
  if (complete && !quoted && (chars || count)) finish(input.length);
  return { stopped, unclosed: quoted, start };
}

const headersOf = (values) => {
  const headers = values.map(header);
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV headers');
  return headers;
};

export function csv(file, { limits = LIMITS } = {}) {
  const input = text(file);
  // A counting pass builds and keeps nothing, so an input past a limit is rejected before any cell
  // text exists.
  scanCsv(input, limits, true, () => {}, () => {}, false);
  const records = [], warnings = [];
  let headers = null;
  const scan = scanCsv(input, limits, true, (values, locator) => {
    if (headers) records.push({ values, locator });
    else headers = headersOf(values);
  }, (locator) => warning(warnings, 'malformed_csv', locator));
  if (scan.unclosed) warning(warnings, 'unclosed_csv_quote', { row: scan.start });
  return { headers: headers ?? [], records, warnings };
}

// The normalized headers of the first well-formed nonempty record, reading at most the first
// 64 KiB. A header record that does not end inside that window is a LimitError.
export function csvHeader(file, { limits = LIMITS } = {}) {
  const bytes = file.bytes;
  const complete = bytes.length <= HEADER_WINDOW;
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, HEADER_WINDOW), { stream: !complete }).replace(/^\uFEFF/, '');
  let headers = null;
  scanCsv(input, limits, complete, (values) => { headers = headersOf(values); return true; }, () => {});
  if (headers) return headers;
  if (!complete) throw new LimitError('CSV header exceeds the scan window');
  return [];
}

export function csvScore(file, required) {
  try {
    if (!/\.csv$/i.test(file.name ?? '') && !/csv/i.test(file.mime ?? '')) return 0;
    const headers = csvHeader(file);
    return required.every((key) => headers.includes(key)) ? 0.98 : 0;
  } catch (e) {
    if (e instanceof LimitError) throw e;
    return 0;
  }
}

export function csvParse(file, required, convert) {
  try {
    const { headers, records, warnings } = csv(file);
    if (!required.every((key) => headers.includes(key))) return empty('missing_headers');
    const rows = [];
    for (const { values, locator } of records) {
      while (values.length > headers.length && !values.at(-1).trim()) values.pop();
      if (values.length !== headers.length) { warning(warnings, 'column_count', locator); continue; }
      convert(Object.fromEntries(headers.map((key, i) => [key, values[i].trim()])), locator, rows, warnings);
    }
    return result(rows, warnings);
  } catch (e) {
    if (e instanceof LimitError) throw e;
    return empty('malformed_csv');
  }
}

export function delimitedCells(file, delimiter = ',') {
  const input = text(file), rows = [];
  const bad = () => { throw new Error('Malformed delimited source'); };
  scanCsv(input, LIMITS, true, () => {}, bad, false, delimiter);
  const result = scanCsv(input, LIMITS, true, (values, locator) => { rows.push({ values, row: locator.row }); }, bad, true, delimiter);
  if (result.unclosed) bad();
  return rows;
}

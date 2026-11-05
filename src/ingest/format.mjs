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
  let valueText = String(value ?? '').trim();
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

export function csv(file) {
  const input = text(file);
  const records = [], warnings = [];
  let cells = [], cell = '', quoted = false, closed = false, bad = false, line = 1, start = 1;
  const finish = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim())) {
      if (bad) warning(warnings, 'malformed_csv', { row: start });
      else records.push({ values: cells, locator: { row: start } });
    }
    cells = []; cell = ''; closed = false; bad = false; start = line + 1;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else { cell += ch; if (ch === '\n') line++; }
    } else if (ch === ',') { cells.push(cell); cell = ''; closed = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      finish(); line++; start = line;
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else if (closed && /\s/.test(ch)) continue;
    else { if (closed || ch === '"') bad = true; cell += ch; }
  }
  if (quoted) warning(warnings, 'unclosed_csv_quote', { row: start });
  else if (cell || cells.length) finish();
  const first = records.shift();
  const headers = first?.values.map(header) ?? [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV headers');
  return { headers, records, warnings };
}

export function csvScore(file, required) {
  try {
    if (!/\.csv$/i.test(file.name ?? '') && !/csv/i.test(file.mime ?? '')) return 0;
    const { headers } = csv(file);
    return required.every((key) => headers.includes(key)) ? 0.98 : 0;
  } catch { return 0; }
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
  } catch { return empty('malformed_csv'); }
}

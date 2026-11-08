import { createHash } from 'node:crypto';
import { readWorkbook } from './workbook.mjs';
import { delimitedCells, number, cents, isoDate, LimitError } from './format.mjs';
import { pdfText } from './pdftext.mjs';
import { scrubDescription } from '../categories/jev.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const colNumber = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const quantity = /(?:\$\s*)?[-+]?\d[\d,]*(?:\.\d+)?(?:%|(?:[-/]\d+){1,2})?/g;
const identifiers = /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b|\b\d{5,}\b|\b(?:bearer\s+\S+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)|\b[\w.+-]+@[\w.-]+\.[a-z]+\b|(?:https?:\/\/|(?:\/[^\s/]+){2,})\S*/gi;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const opaque = n => { let s = ''; do { s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return `@q${s}@`; };

export async function indexSource(file, privacy = {}) {
  if (!(file.bytes instanceof Uint8Array) || !file.fileId) throw new TypeError('Source bytes and file id required');
  if (file.bytes.length > 20 * 1024 * 1024) throw new LimitError();
  const bytes = Buffer.from(file.bytes), sha256 = digest(bytes);
  const source = { fileId: file.fileId, format: file.format, sha256, bytes, refs: {}, values: {}, regions: [], inventory: {}, sheets: [], epoch: '1900', status: 'indexed' };
  const envelope = { sheets: [], regions: [], values: [] };
  source.envelope = envelope;
  let tokenIndex = 0, refIndex = 0;
  const privateWords = [file.name, ...Object.values(privacy.householdNames ?? {}).filter(v => typeof v === 'string').flatMap(v => v.split(/\s+/)),
    ...(privacy.entityNames ?? []), ...(privacy.accounts ?? []).flatMap(a => [a.name, a.inst, a.mask, a.id])].filter(v => typeof v === 'string' && v.trim()).map(v => v.normalize('NFKC'));
  function masked(value) {
    let s = String(value).normalize('NFKC');
    for (const word of privateWords) s = s.replace(new RegExp(escape(word), 'gi'), '[redacted]');
    return s.replace(identifiers, '[redacted]');
  }
  function add(value, meta) {
    if (refIndex >= 250000) throw new LimitError('Too many source references');
    const id = `r${refIndex++}`;
    source.refs[id] = { fileId: file.fileId, sha256, rawHash: digest(JSON.stringify(value)), valueType: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : value === '' ? 'empty' : 'text', precision: 'exact', ...meta };
    source.values[id] = value;
    return id;
  }
  function view(id, redacted = null) {
    const r = source.refs[id], raw = source.values[id];
    let value;
    if (r.valueType === 'number' || r.valueType === 'date' || r.valueType === 'boolean') value = opaque(tokenIndex++);
    else {
      const clean = redacted ?? masked(raw);
      value = clean.replace(quantity, () => opaque(tokenIndex++));
      value = value.match(/[\s\S]{1,500}/g)?.map(part => scrubDescription(part, privacy)).join('') ?? '';
    }
    envelope.values.push({ id, type: r.valueType, value, ...(r.sheet ? { sheet: `s${r.sheet.index}`, cell: r.cell, row: r.row, column: r.column, formula: r.formula, cached: r.cached, hidden: r.hidden ?? false, ...(r.mergedAnchor ? { mergedAnchor: r.mergedAnchor } : {}) } :
      { row: r.row, column: r.column, headerRef: r.headerRef, page: r.page, line: r.line }) });
  }
  function region(ids, disposition = 'unresolved') {
    const id = `g${source.regions.length}`;
    source.regions.push(id); source.inventory[id] = { regionId: id, refs: ids, disposition };
    envelope.regions.push({ regionId: id, refs: ids, disposition });
  }
  if (file.format === 'xlsx') {
    const book = readWorkbook({ bytes }); source.epoch = book.date1904 ? '1904' : '1900';
    book.sheets.forEach((sheet, index) => {
      source.sheets.push({ index, name: sheet.name, hidden: sheet.hidden });
      envelope.sheets.push({ id: `s${index}`, hidden: sheet.hidden, epoch: source.epoch });
      for (const row of sheet.rows) {
        const ids = [];
        for (const cell of row.cells.values()) {
          const column = colNumber(cell.address.match(/^[A-Z]+/)[0]), rowNumber = Number(cell.address.match(/\d+$/)[0]);
          const merge = sheet.merges.find(range => {
            const [a, b] = range.split(':').map(v => /^([A-Z]+)(\d+)$/.exec(v));
            return a && b && rowNumber >= +a[2] && rowNumber <= +b[2] && column >= colNumber(a[1]) && column <= colNumber(b[1]);
          });
          const id = add(cell.value, { sheet: { index, nameRef: `s${index}` }, cell: cell.address, row: rowNumber, column,
            valueType: cell.valueType, formula: cell.formula, cached: cell.cached,
            hidden: sheet.hidden || cell.hidden || sheet.hiddenColumns.some(([min, max]) => column >= min && column <= max),
            ...(merge ? { mergedAnchor: merge.split(':')[0] } : {}) });
          ids.push(id); view(id);
        }
        const groups = new Map();
        for (const id of ids) {
          const r = source.refs[id];
          const disposition = r.formula && !r.cached ? 'uncached_formula' : ['empty', 'error'].includes(r.valueType) ? r.valueType : r.hidden ? 'hidden' : 'unresolved';
          if (!groups.has(disposition)) groups.set(disposition, []);
          groups.get(disposition).push(id);
        }
        for (const [disposition, group] of groups) region(group, disposition);
      }
    });
  } else if (['csv', 'tsv'].includes(file.format)) {
    const rows = delimitedCells({ bytes }, file.format === 'tsv' ? '\t' : ',');
    const headers = rows[0]?.values.map((_, i) => `h${i}`) ?? [];
    for (const row of rows) {
      const ids = row.values.map((value, i) => add(value, { row: row.row, column: i + 1, headerRef: headers[i] ?? `h${i}` }));
      ids.forEach(id => view(id)); region(ids);
    }
  } else if (['text', 'pdf'].includes(file.format)) {
    let input;
    if (file.format === 'pdf') {
      const pdf = await pdfText(bytes);
      if (pdf.status !== 'text') return { ...source, status: 'needs_source_text' };
      input = pdf.text; source.bytes = Buffer.from(input);
    } else input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    let offset = 0, page = 1, line = 1;
    for (const part of input.match(/[^\n\f]*[\n\f]?/g) ?? []) {
      if (!part) continue;
      const blockedSpans = [...part.matchAll(identifiers)].map(m => [m.index, m.index + m[0].length]);
      for (const word of privateWords) for (const m of part.matchAll(new RegExp(escape(word), 'gi'))) blockedSpans.push([m.index, m.index + m[0].length]);
      let charOffset = 0;
      for (const chunk of part.match(/[\s\S]{1,500}/gu) ?? []) {
        const byteStart = offset, byteEnd = offset + Buffer.byteLength(chunk);
        const id = add(chunk, { line, ...(file.format === 'pdf' ? { page } : {}), byteStart, byteEnd });
        const ids = [id];
        // Quantity references retain original byte positions. Identifier spans never gain tokens.
        for (const m of chunk.matchAll(quantity)) {
          const before = chunk.slice(0, m.index), end = m.index + m[0].length;
          const blocked = blockedSpans.some(([a, b]) => charOffset + m.index < b && charOffset + end > a);
          if (!blocked) ids.push(add(m[0], { line, ...(file.format === 'pdf' ? { page } : {}),
            byteStart: byteStart + Buffer.byteLength(before), byteEnd: byteStart + Buffer.byteLength(before + m[0]) }));
        }
        let safe = '';
        for (let i = 0; i < chunk.length; i++) safe += blockedSpans.some(([a, b]) => charOffset + i >= a && charOffset + i < b) ? 'X' : chunk[i];
        view(id, masked(safe));
        ids.slice(1).forEach(valueId => view(valueId)); region(ids); offset = byteEnd; charOffset += chunk.length;
      }
      if (part.endsWith('\f')) { page++; line = 1; } else if (part.endsWith('\n')) line++;
    }
  } else throw new TypeError('Unsupported source format');
  return source;
}

export function resolveField(source, field) {
  const values = field.refs.map(id => {
    const ref = source.refs[id];
    if (!ref || ['empty', 'error'].includes(ref.valueType) || ref.formula && !ref.cached) throw new TypeError('Unusable source reference');
    if (ref.rawHash !== digest(JSON.stringify(source.values[id]))) throw new TypeError('Source value changed');
    return source.values[id];
  });
  const transform = field.transform;
  const numeric = v => { const n = number(v); if (n === null) throw new TypeError('Invalid numeric source'); return n; };
  switch (transform.op) {
    case 'identity': return values[0];
    case 'trim': return String(values[0]).trim();
    case 'currency_decode': if (transform.currency !== 'USD') throw new TypeError('Unsupported currency'); return cents(numeric(values[0]));
    case 'sign': return cents(numeric(values[0]) * (transform.mode === 'negate' ? -1 : 1));
    case 'sum': {
      if (transform.signs && transform.signs.length !== values.length) throw new TypeError('Invalid sum signs');
      return values.reduce((sum, v, i) => sum + Math.round(cents(numeric(v)) * 100) * (transform.signs?.[i] === 'negate' ? -1 : 1), 0) / 100;
    }
    case 'debit_credit': return (Math.round(cents(numeric(values[1])) * 100) - Math.round(cents(numeric(values[0])) * 100)) / 100;
    case 'date_decode': {
      let v = values[0];
      if (transform.locale === 'en-GB' && typeof v === 'string') v = v.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, '$2/$1/$3');
      if (typeof v === 'number' && transform.epoch !== source.epoch) throw new TypeError('Epoch mismatch');
      const date = isoDate(v, transform.epoch === '1904');
      if (!date) throw new TypeError('Invalid source date'); return date;
    }
    case 'month_anchor': {
      const v = values.length === 2 ? `${values[1]}-${String(values[0]).padStart(2, '0')}` : String(values[0]);
      if (!/^\d{4}-\d{2}$/.test(v) || !isoDate(`${v}-01`)) throw new TypeError('Invalid source month'); return `${v}-01`;
    }
    default: throw new TypeError('Unknown source transform');
  }
}

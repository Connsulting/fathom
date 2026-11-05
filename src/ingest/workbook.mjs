import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { header, LIMITS, LimitError } from './format.mjs';

const cache = new WeakMap();
const MAX_PART = 32 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unzip(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = buffer.length - 22;
  const min = Math.max(0, buffer.length - 65557);
  for (; end >= min; end--) {
    if (buffer.readUInt32LE(end) === 0x06054b50 && end + 22 + buffer.readUInt16LE(end + 20) === buffer.length) break;
  }
  if (end < min || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16), total = 0;
  if (count === 0xffff || buffer.readUInt16LE(end + 8) !== count || offset + buffer.readUInt32LE(end + 12) !== end) throw new Error('Invalid ZIP directory');
  const parts = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16), compressedSize = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameSize = buffer.readUInt16LE(offset + 28), extraSize = buffer.readUInt16LE(offset + 30), commentSize = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    total += size;
    if (flags & 1 || ![0, 8].includes(method) || size > MAX_PART || total > MAX_TOTAL || offset + 46 + nameSize + extraSize + commentSize > end) throw new Error('Unsupported ZIP entry');
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    if (parts.has(name) || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) throw new Error('Invalid ZIP name');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP data');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressedSize > buffer.readUInt32LE(end + 16)) throw new Error('Truncated ZIP data');
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: MAX_PART });
    if (data.length !== size || crc32(data) !== crc) throw new Error('Corrupt ZIP data');
    parts.set(name, data);
    offset += 46 + nameSize + extraSize + commentSize;
  }
  if (offset !== end) throw new Error('Invalid ZIP directory size');
  return parts;
}

function unescapeXml(value) {
  return value.replace(/&([^;]*);/g, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:x[\da-f]+|\d+)$/i.test(entity)) throw new Error('Unknown XML entity');
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(point) || point < 1 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('Invalid XML character');
    return String.fromCodePoint(point);
  });
}

function xml(bytes) {
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('Unsupported XML declaration');
  const root = { name: '', children: [], text: '' }, stack = [root];
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[\w:.-]+\s*>|<[\w:.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|[^<]+/gy;
  let offset = 0;
  while (offset < input.length) {
    tokens.lastIndex = offset;
    const token = tokens.exec(input)?.[0];
    if (!token) throw new Error('Malformed XML');
    offset = tokens.lastIndex;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { stack.at(-1).text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      if (stack.length === 1 || stack.at(-1).qualified !== token.slice(2, -1).trim()) throw new Error('Unbalanced XML');
      stack.pop(); continue;
    }
    if (token[0] !== '<') { stack.at(-1).text += unescapeXml(token); continue; }
    const qualified = /^<([^\s/>]+)/.exec(token)[1];
    const attrs = {};
    for (const attribute of token.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (Object.hasOwn(attrs, attribute[1])) throw new Error('Duplicate XML attribute');
      attrs[attribute[1]] = unescapeXml(attribute[2] ?? attribute[3]);
    }
    const node = { name: qualified.split(':').at(-1), qualified, attrs, children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!token.endsWith('/>')) stack.push(node);
    if (stack.length > 128) throw new Error('XML nesting limit');
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw new Error('Invalid XML document');
  return root.children[0];
}

const child = (node, name) => node.children.find((item) => item.name === name);
const children = (node, name) => node?.children.filter((item) => item.name === name) ?? [];
const allText = (node) => node ? node.text + node.children.map(allText).join('') : '';

// Counts row, cell and shared string (si) start tags in raw XML bytes without decoding or
// allocating, and throws LimitError as soon as a count passes its limit. Namespace prefixes are
// ignored; tags inside comments or CDATA count too, which only errs toward rejecting.
const NAME_BYTE = new Uint8Array(256);
for (let b = 0; b < 256; b++) NAME_BYTE[b] = /[\w:.-]/.test(String.fromCharCode(b)) || b >= 0x80 ? 1 : 0;
function countTags(bytes, limits, totals) {
  let rowCells = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x3c) continue;
    let j = i + 1, local = j;
    while (j < bytes.length && NAME_BYTE[bytes[j]]) { if (bytes[j] === 0x3a) local = j + 1; j++; }
    const length = j - local;
    if (length === 1 && bytes[local] === 0x63) { // c
      if (++rowCells > limits.columns) throw new LimitError('Workbook row has too many cells');
      if (++totals.cells > limits.cells) throw new LimitError('Workbook has too many cells');
    } else if (length === 3 && bytes[local] === 0x72 && bytes[local + 1] === 0x6f && bytes[local + 2] === 0x77) { // row
      rowCells = 0;
      if (++totals.rows > limits.rows) throw new LimitError('Workbook has too many rows');
    } else if (length === 2 && bytes[local] === 0x73 && bytes[local + 1] === 0x69) { // si
      if (++totals.cells > limits.cells) throw new LimitError('Workbook has too many cells');
    }
    if (j > i + 1) i = j - 1;
  }
}

export function readWorkbook(file, { limits = LIMITS } = {}) {
  if (cache.has(file.bytes)) return cache.get(file.bytes);
  const parts = unzip(file.bytes);
  const read = (name) => { const part = parts.get(name); if (!part) throw new Error('Missing workbook part'); return xml(part); };
  const workbook = read('xl/workbook.xml');
  const relations = new Map(children(read('xl/_rels/workbook.xml.rels'), 'Relationship').filter((item) => item.attrs.TargetMode !== 'External').map((item) => [item.attrs.Id, item.attrs.Target]));
  const date1904 = ['1', 'true'].includes(child(workbook, 'workbookPr')?.attrs.date1904);
  const sheetParts = children(child(workbook, 'sheets'), 'sheet').map((sheet) => {
    const target = relations.get(sheet.attrs['r:id']);
    if (!target) throw new Error('Missing worksheet relation');
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
    if (!path.startsWith('xl/')) throw new Error('Invalid worksheet path');
    return { sheet, path };
  });
  // Every part is counted before any is parsed, so an oversized workbook never builds a tree.
  const totals = { rows: 0, cells: 0 };
  for (const name of ['xl/sharedStrings.xml', ...sheetParts.map((item) => item.path)]) if (parts.has(name)) countTags(parts.get(name), limits, totals);
  const strings = parts.has('xl/sharedStrings.xml') ? children(read('xl/sharedStrings.xml'), 'si').map(allText) : [];
  const capped = (value) => { if (value.length > limits.cellChars) throw new LimitError('Workbook cell is too long'); return value; };
  strings.forEach(capped);
  const sheets = sheetParts.map(({ sheet, path }) => {
    const rows = children(child(read(path), 'sheetData'), 'row').map((row) => {
      const cells = new Map();
      for (const cell of children(row, 'c')) {
        const address = cell.attrs.r;
        if (!/^[A-Z]+[1-9]\d*$/.test(address ?? '')) throw new Error('Invalid cell address');
        const raw = child(cell, 'v'), type = cell.attrs.t;
        const formula = child(cell, 'f');
        let value = capped(raw?.text ?? '');
        if (type === 's') {
          if (!/^\d+$/.test(value) || Number(value) >= strings.length) throw new Error('Invalid shared string');
          value = strings[Number(value)];
        } else if (type === 'inlineStr') value = capped(allText(child(cell, 'is')));
        else if ((!type || type === 'n') && raw && value.trim()) value = Number(value);
        cells.set(address.replace(/\d/g, ''), { value, address, missingCache: Boolean(formula && !raw), error: type === 'e' });
      }
      return { number: Number(row.attrs.r), cells };
    });
    return { name: sheet.attrs.name, rows };
  });
  const parsed = { sheets, date1904 };
  cache.set(file.bytes, parsed);
  return parsed;
}

export function findHeader(sheet, predicate) {
  for (let index = 0; index < Math.min(sheet.rows.length, 40); index++) {
    const columns = new Map([...sheet.rows[index].cells].map(([col, cell]) => [header(cell.value), col]));
    if (predicate(columns)) return { index, columns };
  }
  return null;
}

export function ledgerHeader(sheet) {
  return findHeader(sheet, (columns) => columns.has('payment date') && (columns.has('payment amount') || [...columns.keys()].some((key) => key.endsWith('actual income'))) || columns.has('date') && columns.has('amount') && columns.has('category'));
}

export function taxHeader(sheet) {
  const found = findHeader(sheet, (columns) => columns.has('month') && [...columns.keys()].some((key) => /\bpaid$/.test(key)));
  if (!found || !/^\d{4}$/.test(sheet.name) || found.index < 1) return null;
  const groups = [...sheet.rows[found.index - 1].cells].filter(([, cell]) => /^(federal|state)$/i.test(String(cell.value).trim())).map(([column, cell]) => ({ column, jurisdiction: String(cell.value).trim().toLowerCase() }));
  if (!groups.length) return null;
  return { ...found, groups };
}

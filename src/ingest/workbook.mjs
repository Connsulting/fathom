import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { header, LIMITS, XLSX_LIMITS, LimitError } from './format.mjs';

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

// Walks one XML part token by token, calling open(name, attrs), text(value) and close(), so a
// reader keeps only what it needs. Throws on malformed XML, a declaration, nesting past 127
// elements or anything but a single root element.
function walkXml(bytes, { open, text, close }) {
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('Unsupported XML declaration');
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[\w:.-]+\s*>|<[\w:.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|[^<]+/gy;
  const stack = [];
  let offset = 0, roots = 0;
  const content = (value) => {
    if (stack.length) text(value);
    else if (value.trim()) throw new Error('Invalid XML document');
  };
  while (offset < input.length) {
    tokens.lastIndex = offset;
    const token = tokens.exec(input)?.[0];
    if (!token) throw new Error('Malformed XML');
    offset = tokens.lastIndex;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { content(token.slice(9, -3)); continue; }
    if (token.startsWith('</')) {
      if (!stack.length || stack.at(-1) !== token.slice(2, -1).trim()) throw new Error('Unbalanced XML');
      stack.pop(); close(); continue;
    }
    if (token[0] !== '<') { content(unescapeXml(token)); continue; }
    const qualified = /^<([^\s/>]+)/.exec(token)[1];
    const attrs = {};
    for (const attribute of token.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (Object.hasOwn(attrs, attribute[1])) throw new Error('Duplicate XML attribute');
      attrs[attribute[1]] = unescapeXml(attribute[2] ?? attribute[3]);
    }
    if (!stack.length && roots++) throw new Error('Invalid XML document');
    open(qualified.split(':').at(-1), attrs);
    if (token.endsWith('/>')) close();
    else if (stack.push(qualified) > 127) throw new Error('XML nesting limit');
  }
  if (stack.length || roots !== 1) throw new Error('Invalid XML document');
}

// The element tree of a small part (workbook, relationships): {name, attrs, children, text}.
function xml(bytes) {
  const root = { children: [], text: '' }, stack = [root];
  walkXml(bytes, {
    open(name, attrs) { const node = { name, attrs, children: [], text: '' }; stack.at(-1).children.push(node); stack.push(node); },
    text(value) { stack.at(-1).text += value; },
    close() { stack.pop(); },
  });
  return root.children[0];
}

const child = (node, name) => node.children.find((item) => item.name === name);
const children = (node, name) => node?.children.filter((item) => item.name === name) ?? [];

// The text of every si under the root, its runs joined in document order.
function sharedStrings(bytes) {
  const strings = [];
  let depth = 0, current = null;
  walkXml(bytes, {
    open(name) { if (++depth === 2 && name === 'si') current = ''; },
    text(value) { if (current !== null) current += value; },
    close() { if (depth-- === 2 && current !== null) { strings.push(current); current = null; } },
  });
  return strings;
}

// The rows of a worksheet's first sheetData, read without building an element tree. Column keys
// are shared across rows, so a cell holds only its value and address; rows without cells share
// one empty map, which readers never write.
const NO_CELLS = new Map();
function worksheetRows(bytes, strings) {
  const rows = [], columns = new Map();
  let depth = 0, sheetData = 0, row = null, cell = null, target = null;
  const finish = ({ address, type, v, inline, formula }) => {
    if (!/^[A-Z]+[1-9]\d*$/.test(address ?? '')) throw new Error('Invalid cell address');
    let value = v ?? '';
    if (type === 's') {
      if (!/^\d+$/.test(value) || Number(value) >= strings.length) throw new Error('Invalid shared string');
      value = strings[Number(value)];
    } else if (type === 'inlineStr') value = inline ?? '';
    else if ((!type || type === 'n') && v !== null && value.trim()) value = Number(value);
    const letters = address.replace(/\d/g, '');
    if (!columns.has(letters)) columns.set(letters, letters);
    if (row.cells === NO_CELLS) row.cells = new Map();
    row.cells.set(columns.get(letters), { value, address, missingCache: formula && v === null, error: type === 'e' });
  };
  walkXml(bytes, {
    open(name, attrs) {
      depth++;
      if (depth === 2 && name === 'sheetData' && sheetData === 0) sheetData = 1;
      else if (depth === 3 && sheetData === 1 && name === 'row') row = { number: Number(attrs.r), cells: NO_CELLS };
      else if (depth === 4 && row && name === 'c') cell = { address: attrs.r, type: attrs.t, v: null, inline: null, formula: false };
      else if (depth === 5 && cell) {
        if (name === 'v' && cell.v === null) { cell.v = ''; target = 'v'; }
        else if (name === 'is' && cell.inline === null) { cell.inline = ''; target = 'is'; }
        else if (name === 'f') cell.formula = true;
      }
    },
    text(value) {
      if (target === 'v' && depth === 5) cell.v += value;
      else if (target === 'is') cell.inline += value;
    },
    close() {
      if (depth === 5) target = null;
      else if (depth === 4 && cell) { finish(cell); cell = null; }
      else if (depth === 3 && row) { rows.push(row); row = null; }
      else if (depth === 2 && sheetData === 1) sheetData = 2;
      depth--;
    },
  });
  return rows;
}

// Checks one XML part against the parse limits on its raw bytes, before it is decoded or read,
// and throws LimitError as soon as a budget is passed. Counted: element start tags (nodes, at
// most NODE_FACTOR per cell of the cell budget plus one per row), rows, cells per row, and cells in total,
// where a cell is a worksheet cell (c), a shared string (si) or a rich-text run (r). Text length
// is counted in UTF-16 units, an entity as the character it stands for: per shared or inline
// string (si, is) summed across its runs, and per element elsewhere. One tag longer than
// cellChars is past the limit too. Namespace prefixes are ignored; tags inside comments or CDATA
// count, which only errs toward rejecting. A metadata part (workbook, relationships) also has its
// own budget of META_ELEMENTS start tags, since it is read into an element tree.
const NODE_FACTOR = 3;
const META_ELEMENTS = 20000;
const NAME_BYTE = new Uint8Array(256);
for (let b = 0; b < 256; b++) NAME_BYTE[b] = /[\w:.-]/.test(String.fromCharCode(b)) || b >= 0x80 ? 1 : 0;
const ascii = (value) => [...value].map((ch) => ch.charCodeAt(0));
const CDATA = ascii('<![CDATA['), CDATA_END = ascii(']]>'), COMMENT = ascii('<!--'), COMMENT_END = ascii('-->'), PI_END = ascii('?>');
const startsWith = (bytes, at, seq) => seq.every((b, k) => bytes[at + k] === b);
function indexOf(bytes, seq, from) {
  for (let i = from; i <= bytes.length - seq.length; i++) if (startsWith(bytes, i, seq)) return i;
  return bytes.length;
}
const isName = (bytes, from, to, seq) => to - from === seq.length && startsWith(bytes, from, seq);
const C = ascii('c'), ROW = ascii('row'), SI = ascii('si'), IS = ascii('is'), R = ascii('r');

// UTF-16 length of an entity body (between & and ;): 2 for a numeric reference past the BMP.
function entityWidth(bytes, from, to) {
  if (bytes[from] !== 0x23) return 1;
  const hex = bytes[from + 1] === 0x78 || bytes[from + 1] === 0x58;
  const point = parseInt(Buffer.from(bytes.subarray(from + (hex ? 2 : 1), to)).toString('latin1'), hex ? 16 : 10);
  return point > 0xffff ? 2 : 1;
}

function scanXml(bytes, limits, totals, elementLimit = Infinity) {
  const nodeLimit = NODE_FACTOR * limits.cells + limits.rows;
  let rowCells = 0, text = 0, inString = false, elements = 0;
  const addText = (width) => { if ((text += width) > limits.cellChars) throw new LimitError('Workbook text is too long'); };
  const addChars = (from, to) => {
    for (let k = from; k < to; k++) {
      const b = bytes[k];
      if (b < 0x80 || b >= 0xc0) addText(b >= 0xf0 ? 2 : 1);
    }
  };
  const cell = () => { if (++totals.cells > limits.cells) throw new LimitError('Workbook has too many cells'); };
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x26) { // &: an entity is one character (two past the BMP)
      let j = i + 1;
      while (j < bytes.length && j - i <= 12 && bytes[j] !== 0x3b && bytes[j] !== 0x3c) j++;
      if (bytes[j] === 0x3b) { addText(entityWidth(bytes, i + 1, j)); i = j + 1; } else { addText(1); i++; }
      continue;
    }
    if (b !== 0x3c) { addChars(i, i + 1); i++; continue; }
    if (bytes[i + 1] === 0x21 && startsWith(bytes, i, CDATA)) {
      const end = indexOf(bytes, CDATA_END, i + CDATA.length);
      addChars(i + CDATA.length, end);
      i = end + CDATA_END.length;
      continue;
    }
    if (bytes[i + 1] === 0x21 && startsWith(bytes, i, COMMENT)) { i = indexOf(bytes, COMMENT_END, i + COMMENT.length) + COMMENT_END.length; continue; }
    if (bytes[i + 1] === 0x3f) { i = indexOf(bytes, PI_END, i + 2) + PI_END.length; continue; }
    let end = i + 1;
    while (end < bytes.length && bytes[end] !== 0x3e) end++;
    if (end - i > limits.cellChars) throw new LimitError('Workbook tag is too long');
    const closing = bytes[i + 1] === 0x2f;
    const from = closing ? i + 2 : i + 1;
    let j = from, local = from;
    while (j < end && NAME_BYTE[bytes[j]]) { if (bytes[j] === 0x3a) local = j + 1; j++; }
    if (j > from) {
      const string = isName(bytes, local, j, SI) || isName(bytes, local, j, IS);
      if (closing) {
        if (string) inString = false;
      } else {
        if (++totals.nodes > nodeLimit || ++elements > elementLimit) throw new LimitError('Workbook has too many XML nodes');
        if (isName(bytes, local, j, C)) {
          if (++rowCells > limits.columns) throw new LimitError('Workbook row has too many cells');
          cell();
        } else if (isName(bytes, local, j, ROW)) {
          rowCells = 0;
          if (++totals.rows > limits.rows) throw new LimitError('Workbook has too many rows');
        } else if (isName(bytes, local, j, SI) || isName(bytes, local, j, R)) cell();
        if (string) { text = 0; inString = bytes[end - 1] !== 0x2f; }
      }
      if (!inString) text = 0;
    }
    i = end + 1;
  }
}

// A workbook keeps LIMITS but the lower XLSX_LIMITS cell budget, which keeps a workbook just under
// it readable on a 128 MB heap.
const WORKBOOK_LIMITS = Object.freeze({ ...LIMITS, ...XLSX_LIMITS });

export function readWorkbook(file, { limits = WORKBOOK_LIMITS } = {}) {
  if (cache.has(file.bytes)) return cache.get(file.bytes);
  const parts = unzip(file.bytes);
  // Every part is checked on its raw bytes before it is parsed, and every worksheet and the
  // shared strings before any of them is, so an oversized workbook is never read. Worksheets and
  // shared strings are read without an element tree; the metadata parts that are read into one
  // have their own small element budget.
  const totals = { rows: 0, cells: 0, nodes: 0 };
  const part = (name) => { const bytes = parts.get(name); if (!bytes) throw new Error('Missing workbook part'); return bytes; };
  const scanned = (name, elementLimit) => { const bytes = part(name); scanXml(bytes, limits, totals, elementLimit); return bytes; };
  const workbook = xml(scanned('xl/workbook.xml', META_ELEMENTS));
  const relations = new Map(children(xml(scanned('xl/_rels/workbook.xml.rels', META_ELEMENTS)), 'Relationship').filter((item) => item.attrs.TargetMode !== 'External').map((item) => [item.attrs.Id, item.attrs.Target]));
  const date1904 = ['1', 'true'].includes(child(workbook, 'workbookPr')?.attrs.date1904);
  const sheetParts = children(child(workbook, 'sheets'), 'sheet').map((sheet) => {
    const target = relations.get(sheet.attrs['r:id']);
    if (!target) throw new Error('Missing worksheet relation');
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
    if (!path.startsWith('xl/')) throw new Error('Invalid worksheet path');
    return { sheet, path };
  });
  for (const name of ['xl/sharedStrings.xml', ...sheetParts.map((item) => item.path)]) if (parts.has(name)) scanned(name);
  const strings = parts.has('xl/sharedStrings.xml') ? sharedStrings(parts.get('xl/sharedStrings.xml')) : [];
  const sheets = sheetParts.map(({ sheet, path }) => ({ name: sheet.attrs.name, rows: worksheetRows(part(path), strings) }));
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

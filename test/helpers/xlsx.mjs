// Minimal XLSX writer for tests: a stored (uncompressed) ZIP holding a workbook, its relations
// and one worksheet per sheet, with inline string and numeric cells. It writes exactly what
// src/ingest/workbook.mjs readWorkbook needs (no shared strings, no styles).
//
// xlsx([{ name: 'Sheet', rows: [['Header', 'Other'], ['text', 12.5], [null, 3]] }]) -> Uint8Array
// A row is an array of cells (index 0 is column A); null, undefined and '' leave the cell out.
// A row may also be { r: <row number>, cells: [...] } to place it at an explicit row number.

import { crc32 } from 'node:zlib';

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function columnName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellXml(value, address) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`cell ${address} is not a finite number`);
    return `<c r="${address}"><v>${value}</v></c>`;
  }
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(rows) {
  const out = [];
  rows.forEach((row, i) => {
    const r = Array.isArray(row) ? i + 1 : row.r;
    const cells = Array.isArray(row) ? row : row.cells;
    const body = cells.map((v, c) => cellXml(v, `${columnName(c)}${r}`)).join('');
    out.push(`<row r="${r}">${body}</row>`);
  });
  return `${DECL}<worksheet xmlns="${NS_MAIN}"><sheetData>${out.join('')}</sheetData></worksheet>`;
}

function parts(sheets) {
  const list = [];
  list.push(['[Content_Types].xml', `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>']);
  list.push(['_rels/.rels', `${DECL}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  list.push(['xl/workbook.xml', `${DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>`
    + sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>']);
  list.push(['xl/_rels/workbook.xml.rels', `${DECL}<Relationships xmlns="${NS_PKG}">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>']);
  sheets.forEach((s, i) => list.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]));
  return list.map(([name, text]) => ({ name: Buffer.from(name, 'utf8'), data: Buffer.from(text, 'utf8') }));
}

// Stored ZIP: local headers with data, then the central directory, then the end record.
export function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: stored
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x21, 12);        // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk start
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);    // local header offset
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

export function xlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new TypeError('xlsx needs at least one sheet');
  return zipStored(parts(sheets));
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

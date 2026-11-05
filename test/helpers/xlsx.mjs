// Minimal XLSX writer for synthetic test workbooks: stored (uncompressed) ZIP entries with real
// CRC32s, inline string cells and numeric cells. Enough for src/ingest/workbook.mjs to read.
//
// writeXlsx([{ name: 'Sheet', rows: [['Date', 'Amount'], ['2032-04-01', 12.5]] }]) -> Buffer
// A null or undefined cell is left out. Strings are inline strings, finite numbers are numbers.
// { formula: 'B2*2' } is a formula cell with no cached value; add `cached: n` to cache one.
// { empty: true } is a present cell element with no value (`<c r="A1"/>`), the smallest cell.
// { shared: n } is a shared-string cell pointing at item n of xl/sharedStrings.xml.
// { inline: '<r><t>a</t></r>' } is an inline string cell whose <is> body is that raw XML.
//
// Options: { sharedStrings: '<si>...</si>...' } writes xl/sharedStrings.xml with that body inside
// <sst>; { deflate: true } stores every entry deflated (method 8) instead of stored.

import { deflateRawSync } from 'node:zlib';

const enc = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const xmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function column(index) {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

function sheetXml(rows) {
  const body = rows.map((cells, r) => {
    const number = r + 1;
    const xml = cells.map((value, c) => {
      if (value === null || value === undefined) return '';
      const ref = `${column(c)}${number}`;
      if (typeof value === 'object' && value.empty) return `<c r="${ref}"/>`;
      if (typeof value === 'object' && Number.isInteger(value.shared)) return `<c r="${ref}" t="s"><v>${value.shared}</v></c>`;
      if (typeof value === 'object' && typeof value.inline === 'string') return `<c r="${ref}" t="inlineStr"><is>${value.inline}</is></c>`;
      if (typeof value === 'object' && value.formula) {
        const cached = typeof value.cached === 'number' ? `<v>${value.cached}</v>` : '';
        return `<c r="${ref}"><f>${xmlEscape(value.formula)}</f>${cached}</c>`;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError('numeric cells must be finite');
        return `<c r="${ref}"><v>${value}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${number}">${xml}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${body}</sheetData></worksheet>`;
}

function zip(entries, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const stored = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, Buffer.from(nameBytes), Buffer.from(stored));
    centrals.push(central, Buffer.from(nameBytes));
    offset += 30 + nameBytes.length + stored.length;
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
  return Buffer.concat([...locals, directory, end]);
}

export function writeXlsx(sheets, { sharedStrings, deflate = false } = {}) {
  if (!Array.isArray(sheets) || !sheets.length) throw new TypeError('at least one sheet is required');
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + (sharedStrings !== undefined ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '')
    + '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
    + '</workbook>';
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + (sharedStrings !== undefined ? `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` : '')
    + '</Relationships>';
  const entries = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s.rows)) })),
    ...(sharedStrings !== undefined ? [{
      name: 'xl/sharedStrings.xml',
      data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + sharedStrings + '</sst>'),
    }] : []),
  ];
  return zip(entries, { deflate });
}

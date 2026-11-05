// Minimal valid PDF writer for synthetic test documents: standard Type1 fonts and an exact
// cross-reference table, so a real PDF reader (pdfjs) opens it.
//
// textPdf(['line one', 'line two'], {tag, fontName}) -> Uint8Array: one page whose content stream
//   draws each line with text operators (a real text layer). tag adds a header comment so equal
//   lines can still give distinct bytes; fontName replaces the BaseFont name.
// imagePdf({tag}) -> Uint8Array: one page that only paints a small grayscale image (no text).
// multiPagePdf(pages, lineOf) -> Uint8Array: `pages` pages, each with one line of text.
// malformedPdf() -> Uint8Array: a PDF header and trailer with no objects, which pdfjs refuses.
// partialTextPdf(lines) -> Uint8Array: one page whose first content stream is readable text and
//   whose second is a FlateDecode stream with corrupt data (a partial-text error).
// markerFontPdf(marker, lines) -> Uint8Array: a text page whose font is an embedded TrueType font
//   whose BaseFont is `marker`, with an unusable font program and a descriptor FontName that
//   differs, so pdfjs names the font in its messages when its verbosity allows them.
// inflateBombPdf({inflatedBytes, fill}) -> Promise<Uint8Array>: a text page followed by a
//   FlateDecode content stream that inflates to inflatedBytes (default 300 MB) from a few hundred
//   KB; fill 'zeros' (default) or 'text' (text-show operators of short lines).
// Lines are ASCII; parentheses and backslashes are escaped.

import { createDeflate } from 'node:zlib';

const latin1 = (s) => Buffer.from(s, 'latin1');

function pdf(objects, { comment } = {}) {
  const head = `%PDF-1.4\n%\xe2\xe3\xcf\xd3\n${comment ? `% ${comment}\n` : ''}`;
  const chunks = [latin1(head)];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const open = latin1(`${i + 1} 0 obj\n`);
    const data = Buffer.isBuffer(body) ? body : latin1(body);
    const tail = latin1('\nendobj\n');
    chunks.push(open, data, tail);
    offset += open.length + data.length + tail.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  chunks.push(latin1(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

const stream = (dict, data) => Buffer.concat([latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin1('\nendstream')]);
const escapeText = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
const checkLines = (lines) => {
  if (!Array.isArray(lines) || !lines.length) throw new TypeError('at least one line is required');
  for (const line of lines) if (!/^[\x20-\x7e]*$/.test(line)) throw new TypeError('lines must be printable ASCII');
};
const textOps = (lines) => latin1(['BT', '/F1 11 Tf', '14 TL', '50 760 Td', ...lines.map((l) => `(${escapeText(l)}) Tj T*`), 'ET'].join('\n'));
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const PAGE = '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]';

export function textPdf(lines, { tag, fontName } = {}) {
  checkLines(lines);
  if (fontName !== undefined && !/^[A-Za-z0-9+-]+$/.test(fontName)) throw new TypeError('fontName must be a plain PDF name');
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< ${PAGE} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    fontName ? `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} /Encoding /WinAnsiEncoding >>` : HELVETICA,
    stream('', textOps(lines)),
  ], { comment: tag });
}

export function imagePdf({ tag } = {}) {
  const pixels = Buffer.from([0x00, 0x80, 0xff, 0x40]);
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< ${PAGE} /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8', pixels),
    stream('', latin1('q 200 0 0 200 100 500 cm /Im1 Do Q')),
  ], { comment: tag });
}

// Objects: 1 catalog, 2 pages, 3 font, then a page and its content stream per page.
export function multiPagePdf(pages, lineOf = (n) => `Synthetic statement page ${n} of ${pages}`) {
  if (!Number.isInteger(pages) || pages < 1) throw new TypeError('pages must be a positive integer');
  const lines = Array.from({ length: pages }, (_, i) => lineOf(i + 1));
  checkLines(lines);
  const kids = lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, HELVETICA];
  lines.forEach((line, i) => {
    objects.push(`<< ${PAGE} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(stream('', textOps([line])));
  });
  return pdf(objects);
}

export function malformedPdf() {
  return new Uint8Array(latin1('%PDF-1.4\n% synthetic, no objects and no cross-reference table\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'));
}

export function partialTextPdf(lines) {
  checkLines(lines);
  const corrupt = Buffer.concat([Buffer.from([0x78, 0x9c]), Buffer.alloc(64, 0xff)]);
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< ${PAGE} /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R 6 0 R] >>`,
    HELVETICA,
    stream('', textOps(lines)),
    stream('/Filter /FlateDecode', corrupt),
  ]);
}

export function markerFontPdf(marker, lines) {
  checkLines(lines);
  if (!/^[A-Za-z0-9]+$/.test(marker)) throw new TypeError('marker must be letters and digits');
  const program = Buffer.from('SYNTHETIC NOT A FONT PROGRAM '.repeat(8), 'latin1');
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< ${PAGE} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /Font /Subtype /TrueType /BaseFont /${marker} /FirstChar 32 /LastChar 126 /Widths [${new Array(95).fill(500).join(' ')}] /FontDescriptor 6 0 R /Encoding /WinAnsiEncoding >>`,
    stream('', textOps(lines)),
    '<< /Type /FontDescriptor /FontName /SyntheticDescriptor /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>',
    stream(`/Length1 ${program.length}`, program),
  ]);
}

// Deflates `total` bytes made of `unit` repeated (whole units only), streaming, so the inflated
// data never exists in this process.
function deflateRepeated(unit, total) {
  return new Promise((resolve, reject) => {
    const z = createDeflate({ level: 9 });
    const out = [];
    z.on('data', (c) => out.push(c));
    z.on('error', reject);
    z.on('end', () => resolve(Buffer.concat(out)));
    const per = Math.max(1, Math.floor((1024 * 1024) / unit.length));
    const chunk = Buffer.concat(new Array(per).fill(unit));
    let left = Math.ceil(total / unit.length);
    const pump = () => {
      while (left > 0) {
        const n = Math.min(left, per);
        left -= n;
        if (!z.write(n === per ? chunk : chunk.subarray(0, n * unit.length))) { z.once('drain', pump); return; }
      }
      z.end();
    };
    pump();
  });
}

// fill 'zeros': the stream inflates to zero bytes (whitespace to a PDF reader; the inflated data
// lives in typed arrays). fill 'text': it inflates to text-show operators of 60 character lines,
// about 60 percent of inflatedBytes as extracted text.
export async function inflateBombPdf({ inflatedBytes = 300 * 1024 * 1024, fill = 'zeros', lines = ['Synthetic statement with an oversized content stream'] } = {}) {
  checkLines(lines);
  const unit = fill === 'zeros' ? Buffer.alloc(1)
    : fill === 'text' ? latin1(`BT /F1 10 Tf 40 700 Td (${'SYNTHETIC '.repeat(6)}) Tj ET\n`)
      : null;
  if (!unit) throw new TypeError("fill is 'zeros' or 'text'");
  const data = await deflateRepeated(unit, inflatedBytes);
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< ${PAGE} /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R 6 0 R] >>`,
    HELVETICA,
    stream('', textOps(lines)),
    stream('/Filter /FlateDecode', data),
  ]);
}

// Minimal valid PDF writer for synthetic test documents: one page, a standard Type1 font and an
// exact cross-reference table, so a real PDF reader (pdfjs) opens it.
//
// textPdf(['line one', 'line two']) -> Uint8Array: a page whose content stream draws each line
// with text operators (a real text layer).
// imagePdf() -> Uint8Array: a page that only paints a small grayscale image (no text operators).
// Lines are ASCII; parentheses and backslashes are escaped.

const latin1 = (s) => Buffer.from(s, 'latin1');

function pdf(objects) {
  const chunks = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const head = latin1(`${i + 1} 0 obj\n`);
    const data = Buffer.isBuffer(body) ? body : latin1(body);
    const tail = latin1('\nendobj\n');
    chunks.push(head, data, tail);
    offset += head.length + data.length + tail.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  chunks.push(latin1(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

const stream = (dict, data) => Buffer.concat([latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin1('\nendstream')]);
const escapeText = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);

export function textPdf(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new TypeError('at least one line is required');
  for (const line of lines) if (!/^[\x20-\x7e]*$/.test(line)) throw new TypeError('lines must be printable ASCII');
  const ops = ['BT', '/F1 11 Tf', '14 TL', '50 760 Td', ...lines.map((l) => `(${escapeText(l)}) Tj T*`), 'ET'].join('\n');
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream('', latin1(ops)),
  ]);
}

export function imagePdf() {
  const pixels = Buffer.from([0x00, 0x80, 0xff, 0x40]);
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8', pixels),
    stream('', latin1('q 200 0 0 200 100 500 cm /Im1 Do Q')),
  ]);
}

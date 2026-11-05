// G6 to G8 (plan revisions to D6): pdfText(bytes) -> {status, text, pages}. status is text (any
// extracted text with a letter), image_only (no text characters on any page), incomplete (more
// than 50 pages, a timeout or the 2 MB output cap) or failed (a parse error; never partial text).
// pdfjs runs in a worker thread with its output discarded, on an owned copy of the input. This file
// runs in its own process, so the main-thread check below sees only what pdfText loaded.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { src, ROOT } from '../helpers/server.mjs';
import { textPdf, imagePdf, multiPagePdf, malformedPdf, partialTextPdf, markerFontPdf, inflateBombPdf } from '../helpers/pdf.mjs';

let pdfText;
before(async () => { ({ pdfText } = await src('src/ingest/pdftext.mjs')); });

const LINES = ['SYNTHETIC BROKERAGE STATEMENT', 'Ending balance $123456.78'];
const SHORT = ['Statement', 'Acct 000123456789', 'SSN 123-45-6789', 'Balance $1500.25'];
const MARKER = 'ZQXPDFMARKER7731';
const letters = (s) => (s.match(/\p{L}/gu) ?? []).length;

// Every write to this process's stdout and stderr while fn runs (a worker's piped output included).
async function captureOutput(fn) {
  const out = [];
  const writes = [process.stdout.write, process.stderr.write];
  const grab = (orig) => function write(chunk, ...rest) { out.push(String(chunk)); return orig.call(this, chunk, ...rest); };
  process.stdout.write = grab(writes[0]);
  process.stderr.write = grab(writes[1]);
  try {
    const value = await fn();
    await new Promise((r) => setTimeout(r, 200));
    return { value, output: out.join('') };
  } finally {
    [process.stdout.write, process.stderr.write] = writes;
  }
}

describe('pdfText outcomes (G6)', () => {
  test('a text page is text with its page count, and only status, text and pages cross back', async () => {
    const r = await pdfText(textPdf(LINES));
    assert.deepEqual(Object.keys(r).sort(), ['pages', 'status', 'text']);
    assert.equal(r.status, 'text');
    assert.equal(r.pages, 1);
    assert.ok(r.text.includes('Ending balance $123456.78'));
  });

  test('a short statement with fewer than 200 letters is still text', async () => {
    const r = await pdfText(textPdf(SHORT));
    assert.ok(letters(SHORT.join(' ')) < 200);
    assert.equal(r.status, 'text');
    assert.ok(r.text.includes('Acct 000123456789'));
  });

  test('an image-only page is image_only with no text', async () => {
    const r = await pdfText(imagePdf());
    assert.deepEqual([r.status, r.pages, r.text], ['image_only', 1, '']);
  });

  test('a malformed PDF is failed with no text', async () => {
    const r = await pdfText(malformedPdf());
    assert.equal(r.status, 'failed');
    assert.equal(r.text, '');
  });

  test('a 51-page PDF is incomplete', async () => {
    const r = await pdfText(multiPagePdf(51));
    assert.equal(r.status, 'incomplete');
  });

  test('a content stream that fails partway is failed, not partial text', async () => {
    const r = await pdfText(partialTextPdf(['Synthetic readable line before the corrupt stream']));
    assert.equal(r.status, 'failed');
    assert.ok(!r.text.includes('Synthetic readable line'), 'no partial text');
  });
});

describe('owned input (G7)', () => {
  test('the caller bytes are unchanged and still usable, for a Uint8Array and a Buffer', async () => {
    for (const make of [(b) => new Uint8Array(b), (b) => Buffer.from(b)]) {
      const bytes = make(textPdf(LINES));
      const copy = Buffer.from(bytes);
      const r = await pdfText(bytes);
      assert.ok(r.text.includes('Ending balance $123456.78'));
      assert.equal(bytes.byteLength, copy.length, 'not detached');
      assert.ok(Buffer.from(bytes).equals(copy), 'not modified');
      assert.deepEqual(await pdfText(bytes), r, 'the same bytes read again give the same result');
    }
  });
});

describe('isolation (G8)', () => {
  test('pdfjs runs in a worker module, not in this thread', async () => {
    assert.ok(existsSync(join(ROOT, 'src/ingest/pdftext-worker.mjs')), 'src/ingest/pdftext-worker.mjs exists');
    await pdfText(textPdf(LINES));
    assert.equal(globalThis.pdfjsWorker, undefined, 'the main thread never loads the pdfjs worker module');
  });

  test('a stream that inflates to more than 2 MB of text is incomplete', async () => {
    const bomb = await inflateBombPdf({ inflatedBytes: 8 * 1024 * 1024, fill: 'text' });
    const started = Date.now();
    const r = await pdfText(bomb);
    assert.equal(r.status, 'incomplete');
    assert.ok(r.text.length <= 2 * 1024 * 1024, 'never more than the output cap');
    assert.ok(Date.now() - started < 20000);
  });

  test('a font name carrying a marker is never printed', async () => {
    const { value, output } = await captureOutput(() => pdfText(markerFontPdf(MARKER, ['Synthetic marker line'])));
    assert.ok(value.text.includes('Synthetic marker line'), 'the page was read');
    assert.ok(!output.includes(MARKER), 'the marker is not on stdout or stderr');
  });
});

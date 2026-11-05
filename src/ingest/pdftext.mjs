// The text layer of a PDF, read with pdfjs-dist's legacy build in this process: no eval, no font
// loading, no system fonts, no worker fetched from outside the package, at most MAX_PAGES pages.
// Never throws: an unreadable PDF reads as no text. The text is returned to the caller only; it is
// never logged or stored here.

import * as worker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

export const MAX_PAGES = 50;
// A text layer with at least this many letters is worth sending as text instead of the PDF.
export const MIN_LETTERS = 200;

// pdfjs runs its worker in this thread when the worker module is already loaded on globalThis,
// so it never resolves or fetches a worker script.
globalThis.pdfjsWorker ??= worker;

let pdfjs;
const load = async () => (pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs'));

const letters = (text) => (text.match(/\p{L}/gu) ?? []).length;

// bytes -> {text, pages, usable}. pages is the document's page count (0 when unreadable).
export async function pdfText(bytes) {
  let task;
  try {
    const lib = await load();
    // A copy: pdfjs may transfer (detach) the buffer it is given.
    const data = new Uint8Array(bytes);
    task = lib.getDocument({
      data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      isOffscreenCanvasSupported: false, stopAtErrors: false, verbosity: 0,
    });
    const doc = await task.promise;
    const pages = doc.numPages;
    const parts = [];
    for (let n = 1; n <= Math.min(pages, MAX_PAGES); n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join(''));
      page.cleanup();
    }
    const text = parts.join('\n\n');
    return { text, pages, usable: letters(text) >= MIN_LETTERS };
  } catch {
    return { text: '', pages: 0, usable: false };
  } finally {
    try { await task?.destroy(); } catch { /* already gone */ }
  }
}

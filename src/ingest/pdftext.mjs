// The text layer of a PDF. pdfjs never runs in this thread: it reads an owned copy of the bytes in a
// worker_threads Worker (pdftext-worker.mjs) with bounded heaps, a wall timeout and a text output
// cap, and its stdout and stderr are discarded. Only a fixed status code, the page count and the
// text cross back. The text is returned to the caller only; it is never logged or stored here.
//
// pdfText(bytes: Buffer | Uint8Array) -> Promise<{status, text, pages}>, never rejects for a bad PDF.
//   text:       the extracted text has at least one letter, however short.
//   image_only: no extracted text characters on any page.
//   incomplete: more than MAX_PAGES pages, the TIMEOUT_MS wall timeout, the MAX_TEXT output cap,
//               or the worker ran out of memory.
//   failed:     any parse error (no partial text), or the worker died any other way.
// text is '' for every status but text; pages is the page count when the document opened, else 0.
// Pages are separated by '\n\f\n' and a form feed appears nowhere else, so
// text.split('\f') gives one string per page.

import { Worker } from 'node:worker_threads';

export const MAX_PAGES = 50;
export const MAX_TEXT = 2 * 1024 * 1024;
export const TIMEOUT_MS = 20000;
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };
const CODES = new Set(['text', 'image_only', 'incomplete', 'failed']);
const WORKER = new URL('./pdftext-worker.mjs', import.meta.url);

export function pdfText(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('pdfText takes a Buffer or Uint8Array');
  // An owned copy, transferred to the worker: the caller's buffer never reaches pdfjs.
  const data = new Uint8Array(bytes);
  return new Promise((resolve) => {
    const worker = new Worker(WORKER, {
      workerData: { data, maxPages: MAX_PAGES, maxText: MAX_TEXT },
      transferList: [data.buffer],
      resourceLimits: RESOURCE_LIMITS,
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const settle = (status, pages = 0, text = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, text: status === 'text' ? text : '', pages });
      worker.terminate().catch(() => {});
    };
    const timer = setTimeout(() => settle('incomplete'), TIMEOUT_MS);
    worker.on('message', (m) => {
      const ok = m && CODES.has(m.code) && Number.isInteger(m.pages) && typeof m.text === 'string';
      if (!ok) settle('failed');
      else if (m.code === 'text' && m.text.length > MAX_TEXT) settle('incomplete', m.pages);
      else settle(m.code, m.pages, m.text);
    });
    // The error carries pdfjs or V8 text; only its code is read.
    worker.on('error', (err) => settle(err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'incomplete' : 'failed'));
    worker.on('exit', () => settle('failed'));
  });
}

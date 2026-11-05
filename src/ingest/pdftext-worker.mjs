// Runs in a worker_threads Worker started by pdftext.mjs. Reads the text layer of the PDF in
// workerData.data with pdfjs-dist's legacy build, in this thread: no font loading, no system fonts,
// no worker fetched from outside the package, stopping at the first error. Posts exactly one
// message {code, pages, text}: code is a fixed status, text is non-empty only for code 'text'.
// Never logs; the parent discards this thread's stdout and stderr anyway.

import { parentPort, workerData } from 'node:worker_threads';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdfjs runs its worker side in this thread when the worker module is on globalThis, so it never
// resolves or fetches a worker script.
globalThis.pdfjsWorker = pdfWorker;

const { data, maxPages, maxText } = workerData;

async function read() {
  let pages = 0;
  const task = getDocument({
    data, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true, verbosity: 0,
  });
  try {
    const doc = await task.promise;
    pages = doc.numPages;
    if (pages > maxPages) return { code: 'incomplete', pages };
    let text = '';
    for (let n = 1; n <= pages; n += 1) {
      if (n > 1) text += '\n\n';
      const reader = (await doc.getPage(n)).streamTextContent().getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        for (const item of chunk.value.items) text += (item.str ?? '') + (item.hasEOL ? '\n' : '');
        // No reader.cancel(): pdfjs 6.4 keeps enqueueing into a cancelled stream and throws.
        // Reading stops here and task.destroy() below ends the stream.
        if (text.length > maxText) return { code: 'incomplete', pages };
      }
    }
    if (/\p{L}/u.test(text)) return { code: 'text', pages, text };
    // Characters without a letter are neither a readable text layer nor an image-only page.
    return { code: /\S/u.test(text) ? 'failed' : 'image_only', pages };
  } catch {
    return { code: 'failed', pages };
  } finally {
    try { await task.destroy(); } catch { /* already gone */ }
  }
}

const { code, pages, text = '' } = await read();
parentPort.postMessage({ code, pages, text });

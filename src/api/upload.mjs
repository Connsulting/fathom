// Multipart uploads without dependencies: the guard for upload routes and a streaming
// multipart/form-data reader that enforces the request and per-file caps as bytes arrive.
// Errors name limits, never contents; file names keep only their base name.

import { HttpError, guardOrigin } from './http.mjs';

export const UPLOAD_FILE_LIMIT = 50 * 1024 * 1024;
export const UPLOAD_REQUEST_LIMIT = 200 * 1024 * 1024;

const MAX_HEADER_BLOCK = 16 * 1024;
const MAX_PARTS = 1000;
const MAX_NAME = 255;
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

const MB = 1024 * 1024;
const sizeLabel = n => (n % MB === 0 ? `${n / MB} MB` : `${n} bytes`);
const tooLarge = msg => new HttpError(413, msg, { Connection: 'close' });
const malformed = () => new HttpError(400, 'malformed multipart body');

// Splits a header value into its first token and lowercased parameters. Quoted values end at the
// next quote: browsers percent-encode quotes in file names and never backslash-escape, so a
// Windows path such as C:\dir\name.csv arrives intact.
function parseHeaderValue(value) {
  const s = String(value || '');
  const semi = s.indexOf(';');
  const type = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
  const params = {};
  const re = /;\s*([^=;\s]+)\s*=\s*(?:"([^"]*)"|([^;]*))/g;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase();
    if (!(k in params)) params[k] = m[2] !== undefined ? m[2] : m[3].trim();
  }
  return { type, params };
}

function boundaryOf(req) {
  const { type, params } = parseHeaderValue(req.headers['content-type']);
  if (type !== 'multipart/form-data') return null;
  const b = params.boundary;
  return b && b.length <= 200 && !/[\r\n]/.test(b) ? b : null;
}

export function guardUpload(req, { origin = null } = {}) {
  guardOrigin(req, origin);
  if (!boundaryOf(req)) throw new HttpError(415, 'content-type must be multipart/form-data with a boundary');
}

function decodeExtended(v) {
  const m = /^utf-8'[^']*'(.*)$/i.exec(v || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

// Base name only: strip any directories (either slash), control characters, and cap the length
// at 255 characters, keeping a short extension.
export function baseName(raw) {
  const parts = String(raw).split(/[\\/]/);
  // eslint-disable-next-line no-control-regex
  let name = parts[parts.length - 1].replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name === '.' || name === '..') name = '';
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name;
}

function partInfo(headerText) {
  let disposition = null;
  let mime = '';
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-disposition') disposition = parseHeaderValue(value);
    else if (key === 'content-type') mime = value.slice(0, 200).toLowerCase();
  }
  if (!disposition || disposition.type !== 'form-data') return null;
  const p = disposition.params;
  const field = p.name || '';
  const rawName = p['filename*'] !== undefined ? decodeExtended(p['filename*']) : null;
  const filename = rawName !== null ? rawName : p.filename;
  if (filename === undefined) return { field, file: false };
  return { field, file: true, name: baseName(filename), mime: mime || 'application/octet-stream' };
}

// Reads the request as multipart/form-data and resolves [{field, name, mime, bytes}] for every
// part with a file name. 413 when the declared or streamed body is over requestLimit or a file is
// over fileLimit; 400 for a malformed body or no files.
export function readMultipart(req, { fileLimit = UPLOAD_FILE_LIMIT, requestLimit = UPLOAD_REQUEST_LIMIT } = {}) {
  const boundary = boundaryOf(req);
  if (!boundary) {
    req.resume();
    return Promise.reject(new HttpError(415, 'content-type must be multipart/form-data with a boundary'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > requestLimit) {
    req.resume();
    return Promise.reject(tooLarge(`upload is over the ${sizeLabel(requestLimit)} request limit`));
  }

  // The stream is read as if it began with CRLF, so the first boundary matches the delimiter.
  const delim = Buffer.from(`\r\n--${boundary}`);
  return new Promise((resolve, reject) => {
    const files = [];
    let buf = Buffer.from(CRLF);
    let state = 'preamble';
    let part = null;
    let parts = 0;
    let total = 0;
    let settled = false;

    const fail = err => {
      if (settled) return;
      settled = true;
      buf = Buffer.alloc(0);
      part = null;
      files.length = 0;
      req.removeListener('data', onData);
      req.resume();
      reject(err);
    };

    const append = bytes => {
      if (!part || !bytes.length) return;
      if (!part.file) return;
      part.size += bytes.length;
      if (part.size > fileLimit) throw tooLarge(`a file is over the ${sizeLabel(fileLimit)} file limit`);
      part.chunks.push(bytes);
    };

    const finishPart = () => {
      if (part && part.file && part.name) {
        files.push({ field: part.field, name: part.name, mime: part.mime, bytes: new Uint8Array(Buffer.concat(part.chunks)) });
      }
      part = null;
    };

    // Consumes as much of buf as the state machine can; returns when it needs more bytes.
    const step = () => {
      for (;;) {
        if (state === 'preamble') {
          const i = buf.indexOf(delim);
          if (i < 0) {
            buf = buf.subarray(Math.max(0, buf.length - delim.length + 1));
            return;
          }
          buf = buf.subarray(i + delim.length);
          state = 'afterDelim';
        } else if (state === 'afterDelim') {
          if (buf.length < 2) return;
          if (buf[0] === 0x2d && buf[1] === 0x2d) {
            state = 'done';
            buf = Buffer.alloc(0);
            return;
          }
          const eol = buf.indexOf(CRLF);
          if (eol < 0) {
            if (buf.length > 256) throw malformed();
            return;
          }
          if (!/^[ \t]*$/.test(buf.subarray(0, eol).toString('latin1'))) throw malformed();
          buf = buf.subarray(eol + 2);
          state = 'headers';
        } else if (state === 'headers') {
          const end = buf.indexOf(HEADER_END);
          const empty = buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a;
          if (end < 0 && !empty) {
            if (buf.length > MAX_HEADER_BLOCK) throw malformed();
            return;
          }
          const headerText = empty ? '' : buf.subarray(0, end).toString('utf8');
          buf = buf.subarray(empty ? 2 : end + 4);
          if (++parts > MAX_PARTS) throw new HttpError(400, `upload has more than ${MAX_PARTS} parts`);
          const info = partInfo(headerText);
          if (!info) throw malformed();
          part = { ...info, size: 0, chunks: [] };
          state = 'body';
        } else if (state === 'body') {
          const i = buf.indexOf(delim);
          if (i >= 0) {
            append(buf.subarray(0, i));
            finishPart();
            buf = buf.subarray(i + delim.length);
            state = 'afterDelim';
            continue;
          }
          const safe = buf.length - (delim.length - 1);
          if (safe > 0) {
            append(Buffer.from(buf.subarray(0, safe)));
            buf = buf.subarray(safe);
          }
          return;
        } else {
          buf = Buffer.alloc(0);
          return;
        }
      }
    };

    function onData(chunk) {
      if (settled) return;
      total += chunk.length;
      if (total > requestLimit) return fail(tooLarge(`upload is over the ${sizeLabel(requestLimit)} request limit`));
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try { step(); } catch (err) { fail(err instanceof HttpError ? err : malformed()); }
    }

    req.on('data', onData);
    req.on('error', () => fail(new HttpError(400, 'upload was interrupted')));
    req.on('end', () => {
      if (settled) return;
      if (state !== 'done') return fail(malformed());
      if (!files.length) return fail(new HttpError(400, 'the upload has no files'));
      settled = true;
      resolve(files);
    });
  });
}

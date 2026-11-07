// HTTP plumbing: errors, security headers, JSON responses and guarded JSON request bodies.

export const BODY_LIMIT = 64 * 1024;

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

// `code` is an optional fixed identifier sent next to the message, for clients that branch on it.
export class HttpError extends Error {
  constructor(status, message, headers, code) {
    super(message);
    this.status = status;
    this.headers = headers || {};
    if (code !== undefined) this.code = code;
  }
}

export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : 'internal error';
  const body = err instanceof HttpError && typeof err.code === 'string' ? { error: message, code: err.code } : { error: message };
  sendJson(res, status, body, err instanceof HttpError ? err.headers : {});
}

// Server-Sent Events for a streaming route. Headers go out with the first event, so an error
// thrown before any event is still an ordinary JSON error. send({ type, ...data }) writes one event
// named by type; finish(out) writes the 'final' event (the JSON body the route returns) and ends;
// fail(err) writes an 'error' event ({ status, error }) and ends. A client that disconnects stops
// receiving events; the handler runs to completion, so the answer is still stored. A comment line
// every 15 seconds keeps idle proxies from closing the stream.
export const wantsEventStream = req => /\btext\/event-stream\b/i.test(String(req.headers.accept || ''));

export function createEventStream(req, res, { heartbeatMs = 15000 } = {}) {
  let started = false;
  let closed = false;
  let timer = null;
  const live = () => !closed && !res.destroyed && !res.writableEnded;
  res.on('close', () => { closed = true; if (timer) clearInterval(timer); });
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    timer = setInterval(() => { if (live()) res.write(': ping\n\n'); }, heartbeatMs);
    timer.unref?.();
  };
  const write = (name, data) => {
    start();
    if (live()) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => { if (timer) clearInterval(timer); if (live()) res.end(); };
  return {
    get started() { return started; },
    send(event) {
      if (!event || typeof event.type !== 'string' || !/^[a-z]+$/.test(event.type)) return;
      const { type, ...data } = event;
      write(type, data);
    },
    finish(out) { write('final', out); end(); },
    fail(err) {
      const status = err instanceof HttpError ? err.status : 500;
      write('error', { status, error: err instanceof HttpError ? err.message : 'internal error' });
      end();
    },
  };
}

const normHost = h => {
  try { return new URL('http://' + h).host; } catch { return null; }
};

export function guardOrigin(req, expectedOrigin = null) {
  const origin = req.headers.origin;
  if (expectedOrigin !== null) {
    if (origin !== expectedOrigin) throw new HttpError(403, 'cross-origin request refused');
    return;
  }
  if (origin !== undefined) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.host === normHost(req.headers.host || '');
    } catch { ok = false; }
    if (!ok) throw new HttpError(403, 'cross-origin request refused');
  }
}

export function guardPost(req, { origin = null } = {}) {
  guardOrigin(req, origin);
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'content-type must be application/json');
}

// Read a JSON object body of at most `limit` bytes (413 over it, 400 when malformed).
export function readJsonBody(req, limit = BODY_LIMIT) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, `request body is over ${limit} bytes`, { Connection: 'close' }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, `request body is over ${limit} bytes`, { Connection: 'close' }));
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      let body;
      try { body = JSON.parse(text); } catch { return reject(new HttpError(400, 'malformed JSON body')); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'body must be a JSON object'));
      resolve(body);
    });
  });
}

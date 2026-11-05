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

export class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers || {};
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
  sendJson(res, status, { error: message }, err instanceof HttpError ? err.headers : {});
}

const normHost = h => {
  try { return new URL('http://' + h).host; } catch { return null; }
};

// POST guards: JSON content type (415), same-origin when an Origin header is sent (403).
export function guardPost(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'content-type must be application/json');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.host === normHost(req.headers.host || '');
    } catch { ok = false; }
    if (!ok) throw new HttpError(403, 'cross-origin request refused');
  }
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

import { sendJson } from './http.mjs';
import { safePath } from '../../web/auth/return-path.js';

export const identityOf = (req, auth) => auth.identity(req);

export const UNAUTHORIZED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not authorized</title></head><body><h1>Not authorized</h1><p><a href="/signin">Sign in</a> to open Fathom.</p></body></html>';

// A signed-out document GET goes to the sign-in page. The fragment is not on the request, and
// the browser keeps it when Location has none, so /#/plan arrives as /signin#/plan. A path other
// than / is carried as a validated next parameter. API calls and every non-GET stay 401.
export function signInLocation(url) {
  const raw = String(url || '/');
  const q = raw.indexOf('?');
  const path = safePath(q >= 0 ? raw.slice(0, q) : raw);
  if (!path || path === '/' || path === '/signin') return '/signin';
  return '/signin?next=' + encodeURIComponent(path);
}

export function sendUnauthorized(req, res, isApi) {
  if (req.readable) req.resume();
  if (res.headersSent) return;
  if (!isApi && req.method === 'GET') {
    const location = signInLocation(req.url);
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (isApi) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(UNAUTHORIZED_PAGE),
  });
  res.end(req.method === 'HEAD' ? undefined : UNAUTHORIZED_PAGE);
}

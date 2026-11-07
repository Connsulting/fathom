import { sendJson } from './http.mjs';

export const identityOf = (req, auth) => auth.identity(req);

export const UNAUTHORIZED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not authorized</title></head><body><h1>Not authorized</h1><p><a href="/signin">Sign in</a> to open Fathom.</p></body></html>';

export function sendUnauthorized(req, res, isApi) {
  if (req.readable) req.resume();
  if (res.headersSent) return;
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

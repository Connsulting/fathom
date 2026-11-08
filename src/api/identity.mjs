import { HttpError, sendJson } from './http.mjs';
import { safePath } from '../../web/auth/return-path.js';
import { checkAssertion } from './household-context.mjs';

export const identityOf = (req, auth) => auth.identity(req);

// After the body is read: the session must still hold, pass the route's access check, still carry
// the asserted household context (a switch meanwhile is 409 stale) and still name the household
// fixed before the body.
export function revalidateRequest({ authenticate, checkAccess, assertion = null, household, runtimes }) {
  const identity = authenticate();
  if (!identity) throw new HttpError(401, 'unauthorized');
  checkAccess?.(identity);
  if (assertion) checkAssertion(assertion, identity);
  if (household && (identity.householdId !== household.householdId || runtimes.get(household.householdId) !== household)) {
    throw new HttpError(403, 'household membership required');
  }
  return identity;
}

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

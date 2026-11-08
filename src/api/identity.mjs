import { HttpError, sendJson } from './http.mjs';
import { safePath, safeHousehold } from '../../web/auth/return-path.js';
import { checkAssertion } from './household-context.mjs';

export const identityOf = async (req, auth) => await auth.identity(req);

// After the body is read: the session must still hold, pass the route's access check, still carry
// the asserted household context (a switch meanwhile is 409 stale) and still name the household
// fixed before the body.
export async function revalidateRequest({ authenticate, checkAccess, assertion = null, household, runtimes }) {
  const identity = await authenticate();
  if (!identity) throw new HttpError(401, 'unauthorized');
  await checkAccess?.(identity);
  if (assertion) checkAssertion(assertion, identity);
  if (household && (identity.householdId !== household.householdId || (await runtimes.get(household.householdId)) !== household)) {
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
  // A deep link's household target (?household=<id>) is kept so the app still asks before opening it.
  let household = null;
  if (q >= 0) {
    try { household = safeHousehold(new URLSearchParams(raw.slice(q + 1)).get('household')); } catch { household = null; }
  }
  const params = new URLSearchParams();
  if (path && path !== '/' && path !== '/signin') params.set('next', path);
  if (household) params.set('household', household);
  const query = params.toString();
  return '/signin' + (query ? '?' + query : '');
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

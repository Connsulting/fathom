// Household context assertions (docs/multi-tenancy.md, Active household and switching).
//
// A browser sends the household id and context version it was last issued on every
// household-scoped request: headers X-Fathom-Household and X-Fathom-Context-Version, or on a
// top-level GET/HEAD download the query parameters household and contextVersion. They are
// assertions checked against the server session, never selectors: the session alone decides the
// household. A repeated, partial, malformed or conflicting assertion, or a query assertion on a
// non-GET request, is 400 household_context_invalid. A missing assertion or one that differs from
// the session is 409 household_context_stale, before the handler reads or writes anything.

import { HttpError } from './http.mjs';

export const HOUSEHOLD_HEADER = 'x-fathom-household';
export const VERSION_HEADER = 'x-fathom-context-version';
const HOUSEHOLD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const VERSION = /^[1-9][0-9]{0,15}$/;

export const invalidContext = () => new HttpError(400, 'invalid household context', undefined, 'household_context_invalid');
export const staleContext = () => new HttpError(409, 'This page is out of date: the household changed in another tab. Reload to continue.', undefined, 'household_context_stale');

// The request's assertion { householdId, contextVersion }, null when it carries none, or throws
// invalidContext(). `query` is the router's parsed query (a repeated key is an array).
export function readAssertion(req, query) {
  const header = name => {
    const values = req.headersDistinct?.[name];
    if (values === undefined) return undefined;
    if (values.length !== 1) throw invalidContext();
    return values[0];
  };
  const fromQuery = name => {
    const value = query[name];
    if (Array.isArray(value)) throw invalidContext();
    return value;
  };
  const q = { household: fromQuery('household'), version: fromQuery('contextVersion') };
  const read = req.method === 'GET' || req.method === 'HEAD';
  if (!read && (q.household !== undefined || q.version !== undefined)) throw invalidContext();
  const one = (a, b) => {
    if (a !== undefined && b !== undefined && a !== b) throw invalidContext();
    return a ?? b;
  };
  const household = one(header(HOUSEHOLD_HEADER), q.household);
  const version = one(header(VERSION_HEADER), q.version);
  if (household === undefined && version === undefined) return null;
  if (household === undefined || version === undefined || !HOUSEHOLD_ID.test(household) || !VERSION.test(version)) throw invalidContext();
  return { householdId: household, contextVersion: Number(version) };
}

// Throws staleContext() unless the assertion names the identity's current household and version.
export function checkAssertion(assertion, identity) {
  if (!assertion || !identity || assertion.householdId !== identity.householdId || assertion.contextVersion !== identity.contextVersion) {
    throw staleContext();
  }
}

// The captured context on a response, so a client can drop a response for a context it left.
export function stampContext(res, identity) {
  res.setHeader('X-Fathom-Household', identity.householdId);
  res.setHeader('X-Fathom-Context-Version', String(identity.contextVersion));
}

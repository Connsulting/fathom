// Owner identity on a real store. `tailscale serve` adds Tailscale-User-Login (and
// Tailscale-User-Name) to every request it proxies; the router admits a request only when that
// login is in the owner list from FATHOM_OWNER_LOGINS or FATHOM_OWNER_LOGINS_FILE. A missing or
// broken list fails closed. Nothing here ever echoes a header value, the file contents, its path
// or a read error.

import { readFileSync } from 'node:fs';
import { sendJson } from './http.mjs';

const LOGIN_HEADER = 'tailscale-user-login';
const NAME_HEADER = 'tailscale-user-name';

const parseLogins = text => new Set(String(text).split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean));

// config -> { logins: Set<string>, problem: string | null }.
export function loadOwnerLogins(config = {}) {
  const { ownerLogins = null, ownerLoginsFile = null } = config;
  if (ownerLogins != null && ownerLoginsFile != null) {
    return { logins: new Set(), problem: 'FATHOM_OWNER_LOGINS and FATHOM_OWNER_LOGINS_FILE are both set; set only one' };
  }
  let logins;
  if (ownerLoginsFile != null) {
    try {
      logins = parseLogins(readFileSync(ownerLoginsFile, 'utf8'));
    } catch {
      return { logins: new Set(), problem: 'FATHOM_OWNER_LOGINS_FILE could not be read' };
    }
  } else {
    logins = parseLogins(ownerLogins ?? '');
  }
  if (!logins.size) return { logins, problem: 'FATHOM_OWNER_LOGINS is not set' };
  return { logins, problem: null };
}

export function ownerLoginsProblemLine(problem) {
  return `fathom: ${problem}. Set FATHOM_OWNER_LOGINS (or FATHOM_OWNER_LOGINS_FILE) to the comma-separated Tailscale logins allowed in; until then every page and /api route answers 401.`;
}

// The request's owner identity, or null. A header Node joined from duplicates (it carries a comma)
// never matches, because no listed login contains one.
export function identityOf(req, logins) {
  const raw = req.headers[LOGIN_HEADER];
  if (typeof raw !== 'string') return null;
  const login = raw.trim();
  if (!login || login.includes(',') || !logins.has(login.toLowerCase())) return null;
  const nameRaw = req.headers[NAME_HEADER];
  const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : login;
  return { login, name };
}

export const UNAUTHORIZED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not authorized</title></head><body><h1>Not authorized</h1><p>Open Fathom through its Tailscale address while signed in to an allowed account.</p></body></html>';

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

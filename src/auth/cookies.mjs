import { validHandle } from './store.mjs';

export const SESSION_COOKIE = '__Host-fathom-session';
export const CEREMONY_COOKIE = '__Host-fathom-ceremony';

export function readCookie(req, name) {
  const value = req.headers.cookie;
  if (typeof value !== 'string') return null;
  const matches = value.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const raw = matches[0].slice(name.length + 1);
  return validHandle(raw) ? raw : null;
}

export function setCookie(res, name, issued, now = Date.now()) {
  const value = issued
    ? `${name}=${issued.token}; Max-Age=${Math.max(0, Math.floor((issued.expiresAt - now) / 1000))}; Expires=${new Date(issued.expiresAt).toUTCString()}`
    : `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  const previous = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[previous].flat(), `${value}; Secure; HttpOnly; SameSite=Lax; Path=/`]);
}

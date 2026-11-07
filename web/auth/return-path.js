// Where a signed-out person returns after signing in.
// A fragment route (#/plan) is kept by the browser across a Location that has no fragment.
// A same-origin path may also arrive in the sign-in page's next query parameter.
// Anything else, including an absolute URL, a protocol-relative URL, or a backslash trick, is Home.

export const APP_ROUTES = Object.freeze([
  'onboarding', 'home', 'pace', 'brief', 'plan', 'rec', 'ask', 'wargame', 'goals', 'accounts',
  'advisor', 'yearend', 'connect', 'engine', 'email', 'packs', 'confirm', 'add', 'money', 'settings',
]);

const ROUTE_NAMES = new Set(APP_ROUTES);

export function safeHash(hash) {
  if (typeof hash !== 'string' || hash.length < 3 || hash.length > 180) return null;
  if (!hash.startsWith('#/')) return null;
  const body = hash.slice(2);
  if (body.includes('\\') || body.includes('?') || body.includes('#') || body.includes('//')) return null;
  const parts = body.split('/');
  if (parts.length < 1 || parts.length > 2) return null;
  const name = parts[0];
  const extra = parts[1];
  if (!ROUTE_NAMES.has(name)) return null;
  if (extra !== undefined && (extra.length === 0 || extra.length > 80 || !/^[A-Za-z0-9._~-]+$/.test(extra))) return null;
  return '#/' + name + (extra ? '/' + extra : '');
}

export function safePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  let value = raw;
  if (value.includes('%')) {
    try { value = decodeURIComponent(value); } catch { return null; }
  }
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\?#\s\u0000-\u001f]/.test(value) || value.includes('://') || value.includes('@')) return null;
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(value)) return null;
  return value;
}

// Server and client both build this. The fragment is appended so a caller that already has it
// can set location in one step. A server redirect omits the fragment; the browser keeps it.
export function signInTarget(pathname, hash) {
  const path = safePath(pathname) || '/';
  const kept = safeHash(hash);
  const params = new URLSearchParams();
  if (path !== '/' && path !== '/signin') params.set('next', path);
  const query = params.toString();
  return '/signin' + (query ? '?' + query : '') + (kept || '');
}

export function afterSignIn(locationLike) {
  const hash = safeHash(locationLike && locationLike.hash);
  if (hash) return '/' + hash;
  let next = null;
  const href = locationLike && typeof locationLike.href === 'string' ? locationLike.href : '';
  if (href) {
    try { next = new URL(href).searchParams.get('next'); } catch { next = null; }
  }
  const path = safePath(next || '');
  if (path && path !== '/signin') return path;
  return '/#/home';
}

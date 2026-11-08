// Where a signed-out person returns after signing in.
// A fragment route (#/plan) is kept by the browser across a Location that has no fragment.
// A same-origin path may also arrive in the sign-in page's next query parameter.
// Anything else, including an absolute URL, a protocol-relative URL, or a backslash trick, is Home.
// A deep link's household target (?household=<id>, docs/multi-tenancy.md) travels through sign-in
// as the household parameter, so the app still asks before opening another household.

export const APP_ROUTES = Object.freeze([
  'onboarding', 'home', 'pace', 'brief', 'plan', 'rec', 'ask', 'wargame', 'goals', 'accounts',
  'advisor', 'yearend', 'connect', 'engine', 'email', 'packs', 'confirm', 'add', 'money', 'settings',
]);

const ROUTE_NAMES = new Set(APP_ROUTES);

function safeSegment(raw) {
  let value = raw;
  if (value.includes('%')) {
    try { value = decodeURIComponent(value); } catch { return false; }
  }
  return value.length > 0 && value.length <= 80 && /^[A-Za-z0-9._~:-]+$/.test(value);
}

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
  if (extra !== undefined && !safeSegment(extra)) return null;
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

// An opaque household id from a deep link, or null.
export function safeHousehold(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : null;
}

// Server and client both build this. The fragment is appended so a caller that already has it
// can set location in one step. A server redirect omits the fragment; the browser keeps it.
export function signInTarget(pathname, hash, household = null) {
  const path = safePath(pathname) || '/';
  const kept = safeHash(hash);
  const params = new URLSearchParams();
  if (path !== '/' && path !== '/signin') params.set('next', path);
  const target = safeHousehold(household);
  if (target) params.set('household', target);
  const query = params.toString();
  return '/signin' + (query ? '?' + query : '') + (kept || '');
}

export function afterSignIn(locationLike) {
  let next = null;
  let household = null;
  const href = locationLike && typeof locationLike.href === 'string' ? locationLike.href : '';
  if (href) {
    try {
      const params = new URL(href).searchParams;
      next = params.get('next');
      household = safeHousehold(params.get('household'));
    } catch { next = null; }
  }
  const hash = safeHash(locationLike && locationLike.hash);
  if (household) return '/?household=' + household + (hash || '#/home');
  if (hash) return '/' + hash;
  const path = safePath(next || '');
  if (path && path !== '/signin') return path;
  return '/#/home';
}

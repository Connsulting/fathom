// The hash routes the app knows, the old routes that moved and where each one lands now, and the
// onboarding steps that still run. Pure; the browser core and node tests both import it.

export const ROUTES = new Set(['onboarding', 'home', 'pace', 'brief', 'plan', 'rec', 'ask', 'wargame', 'goals', 'accounts',
  'advisor', 'yearend', 'connect', 'engine', 'email', 'packs', 'confirm', 'add', 'money', 'settings', 'memories', 'account', 'pnl', 'pnlrows']);

// Old route, new home. 'brief' is the old name of Home (email links still carry #/brief). Accounts
// merged into the Money overview, which renders the same account list.
const MOVED = Object.freeze({ brief: 'home', accounts: 'money' });

// The route an old link lands on, or null when the route has not moved.
export function movedRoute(r) {
  const to = r && MOVED[r.name];
  return to ? { name: to, params: {} } : null;
}

// Onboarding: 0 is the demo's welcome, then Tell us (3), What we understood (4) and Build (5). The
// Goals (1) and Curve (2) steps were cut; their links land on Tell us. A real store has no welcome.
export const ONBOARD_STEPS = Object.freeze([0, 3, 4, 5]);
export const LAST_STEP = 5;
const FIRST_TOLD = 3;

export function onboardStepOf(step, { real = false } = {}) {
  const n = Number(step);
  const v = Number.isFinite(n) ? Math.floor(n) : 0;
  const min = real ? FIRST_TOLD : 0;
  const s = Math.max(min, Math.min(LAST_STEP, v));
  return s > 0 && s < FIRST_TOLD ? FIRST_TOLD : s;
}

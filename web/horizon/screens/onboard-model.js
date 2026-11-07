// The goals-first onboarding model: the starter goals the Goals step offers, which of them the
// household already has, the goals listed as already chosen, the goal bodies to create, and the
// "Add your spouse" line. Pure: no DOM, no store, so node imports it directly
// (test/onboard-model.test.mjs). The Goals step on onboarding and on an empty Home render from it.

const freeze = (o) => Object.freeze(o);

// Starter goals, in the order the step shows them. Created with no target: Fathom asks for one later.
export const STARTERS = freeze([
  freeze({ id: 'cushion', title: 'A cash cushion', sub: 'Months of spending you never touch', horizon: 'now' }),
  freeze({ id: 'work-optional', title: 'Work less, on our terms', sub: 'The year work becomes optional', horizon: '3-10y' }),
  freeze({ id: 'family', title: 'Kids and family', sub: 'School, childcare, a new arrival', horizon: '1-3y' }),
  freeze({ id: 'tax', title: 'Pay less tax, without stress', sub: 'Use every window before Dec 31', horizon: 'now' })
]);

const arr = (a) => (Array.isArray(a) ? a : []);
const norm = (s) => String(s ?? '').trim().toLowerCase();
const openGoals = (goals) => arr(goals).filter((g) => g && !g.archived);
const titlesOf = (goals) => new Set(openGoals(goals).map((g) => norm(g.title)));

// Ids of the starters a non-archived goal already matches (trimmed, case-insensitive), in starter order.
export function existingStarterIds(goals) {
  const have = titlesOf(goals);
  return STARTERS.filter((s) => have.has(norm(s.title))).map((s) => s.id);
}

// Non-archived goals that are not a starter: listed on the step as already chosen.
export function otherGoals(goals) {
  const starters = new Set(STARTERS.map((s) => norm(s.title)));
  return openGoals(goals).filter((g) => !starters.has(norm(g.title)));
}

// The POST /api/goals bodies for the selection: selected starters in starter order, then own titles
// in the order given. Titles are trimmed, blanks dropped, and anything already among the
// non-archived goals or earlier in the list is skipped. No target and no target date.
export function goalsToCreate({ starterIds, ownTitles, goals } = {}) {
  const seen = titlesOf(goals);
  const picked = new Set(arr(starterIds));
  const out = [];
  const add = (title, note, horizon) => {
    const t = String(title ?? '').trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) return;
    seen.add(k);
    out.push({ title: t, note, horizon });
  };
  STARTERS.forEach((s) => { if (picked.has(s.id)) add(s.title, s.sub, s.horizon); });
  arr(ownTitles).forEach((t) => add(t, '', 'now'));
  return out;
}

// The "Add your spouse" line: a link to the household page for an admin on a real store, an
// explanation on the demo, nothing otherwise.
export function inviteLine({ mode, identity } = {}) {
  if (mode === 'demo') return { kind: 'text' };
  if (mode === 'real' && identity && identity.role === 'admin') return { kind: 'link', href: '/admin/users' };
  return { kind: 'none' };
}

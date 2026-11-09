/* Horizon navigation model: the tabs, each tab's views, the tab every route lights, the switcher's
   go-to entries, the onboarding rail and the Plan groups. Pure; no DOM and no api, so node can
   import it. */

const arr = (a) => (Array.isArray(a) ? a : []);

// Four tabs, in order: route, label, phone bar icon. Every route belongs to one tab or to the gear
// (settings); the active one comes from the current route, never from the screen.
export const TABS = [['home', 'Home', 'year'], ['plan', 'Plan', 'cal'], ['ask', 'Ask', 'chat'], ['money', 'Money', 'money']];

// The views inside a tab, shown as a sub-nav on each of them. Home, Ask and the gear have none:
// Ask is its conversations, and a war-game page opens from its Plan decision.
export const SUBNAV = {
  plan: [['plan', 'Plan'], ['yearend', 'Year end'], ['advisor', 'Advisor']],
  money: [['money', 'Overview'], ['pnl', 'P&L'], ['add', 'Files']]
};

// Routes with no sub-nav are listed by hand; every sub-nav view maps to its tab. Packs live under
// What Fathom knows (the memories route) in the gear.
export const TAB_OF = {
  home: 'home', pace: 'home', tax: 'home', goals: 'home', confirm: 'home',
  ask: 'ask', wargame: 'ask',
  settings: 'settings', memories: 'settings', packs: 'settings', connect: 'settings', engine: 'settings', email: 'settings', onboarding: 'settings',
  ...Object.fromEntries(Object.entries(SUBNAV).flatMap(([tab, views]) => views.map(([k]) => [k, tab])))
};

// G sequences: letter, route, label. design.js reads these for its tab and gear hints.
export const GO = [
  ['h', 'home', 'Home'], ['p', 'plan', 'Plan'], ['d', 'plan', 'Decide', 'decide'], ['a', 'ask', 'Ask'],
  ['c', 'confirm', 'Confirm'], ['k', 'packs', 'Packs'], ['f', 'add', 'Files'], ['e', 'engine', 'Engine'],
  ['m', 'email', 'Email'], ['n', 'connect', 'Connect'], ['o', 'money', 'Money'], ['s', 'settings', 'Settings']
];
// Pages the switcher lists with no key of their own.
export const GO_MORE = [['goals', 'Goals'], ['pnl', 'P&L'], ['advisor', 'Advisor'], ['yearend', 'Year end'], ['memories', 'What Fathom knows']];

// Onboarding rail: Tell us (step 3), What we understood (4), Build (5). The welcome (0) is before it.
export const OB_RAIL = ['Tell us', 'What we understood', 'Build'];
export const obRailIndex = (step) => (step >= 3 ? Math.min(step - 3, OB_RAIL.length - 1) : -1);

// Plan, grouped by who has each item: the ones that need you, the ones Fathom is carrying (open,
// waiting or set for later) and Done (done or not for us), collapsed. Order within a group is the
// order given; hidden items show nowhere.
export function planGroups(recs, needsYou) {
  const ny = new Set(arr(needsYou).map((r) => r && r.id));
  const list = arr(recs).filter((r) => r && r.status !== 'hidden');
  const closed = (r) => r.status === 'done' || r.status === 'dismissed';
  return [
    { key: 'needs', title: 'Needs you', collapsed: false, list: list.filter((r) => ny.has(r.id) && !closed(r)) },
    { key: 'fathom', title: 'Fathom has it', collapsed: false, list: list.filter((r) => !ny.has(r.id) && !closed(r)) },
    { key: 'done', title: 'Done', collapsed: true, list: list.filter(closed) }
  ];
}

/* Ask everywhere, the pure part: what the owner is looking at (the page chip, with what the screen
   shows: a month, a range, an owner filter, dates, toggles, an open goal), the references a
   question carries on the wire, the one chip markup and the shared Ask about button (a chat icon).
   No DOM at import and no imports, so node:test reads it directly. Labels are plain text built
   only from names, titles and fixed words, never from a figure value; only kind and id (with a
   validated `@key=value;...` view qualifier) ever leave the client. */

export const KINDS = Object.freeze(['account', 'transaction', 'rec', 'step', 'goal', 'figure', 'pnl', 'spending', 'confirm', 'money', 'pack', 'page']);
export const MAX_REFS = 8;
const MAX_ID = 200;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escDefault = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const arr = (a) => (Array.isArray(a) ? a : []);

function desc(route, kind, id, label, q = '') {
  return { route, kind, id, title: label.split(' > ').at(-1), label, q };
}

/* ---------- the view a screen publishes ---------- */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RANGE_WORDS = { '3M': 'last 3 months', '1Y': 'last year', All: 'all time' };
const OWNER_WORDS = { me: 'my actions', spouse: "the spouse's actions" };
// The named toggles a view may carry, in label order; any other pair is ignored.
const FILTERS = [['housing', 'off', 'housing left out'], ['tax', 'on', 'tax included'], ['type', 'income', 'income only'], ['type', 'expenses', 'expenses only']];
// The detail fields each route owns; every other route ignores the view's details.
const OWNS = { money: ['range'], pnl: ['month', 'filters'], pnlrows: ['month', 'filters'], home: ['owner'], account: ['from', 'to'] };

const str = (v) => (typeof v === 'string' ? v : '');
const known = (map, v) => typeof v === 'string' && Object.hasOwn(map, v);

// The label words and wire pairs for the fields a route owns, in the fixed order: month, range,
// owner, from and to, then the toggles. Invalid values are dropped.
function details(view, owned) {
  const words = [];
  const pairs = [];
  const has = (k) => owned.includes(k);
  const month = str(view.month);
  if (has('month') && MONTH_RE.test(month)) {
    words.push(`${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`);
    pairs.push(`month=${month}`);
  }
  if (has('range') && known(RANGE_WORDS, view.range)) { words.push(RANGE_WORDS[view.range]); pairs.push(`range=${view.range}`); }
  if (has('owner') && known(OWNER_WORDS, view.owner)) { words.push(OWNER_WORDS[view.owner]); pairs.push(`owner=${view.owner}`); }
  const from = has('from') && DAY_RE.test(str(view.from)) ? view.from : '';
  const to = has('to') && DAY_RE.test(str(view.to)) ? view.to : '';
  if (from || to) words.push([from ? `from ${from}` : '', to ? `to ${to}` : ''].filter(Boolean).join(' '));
  if (from) pairs.push(`from=${from}`);
  if (to) pairs.push(`to=${to}`);
  if (has('filters') && Array.isArray(view.filters)) {
    for (const [k, v, label] of FILTERS) {
      if (view.filters.some((f) => f && typeof f === 'object' && f.key === k && f.value === v)) { words.push(label); pairs.push(`${k}=${v}`); }
    }
  }
  return { words, q: pairs.join(';') };
}

function withDetails(d, view) {
  const owned = Object.hasOwn(OWNS, d.route) ? OWNS[d.route] : [];
  if (!owned.length) return d;
  const { words, q } = details(view, owned);
  return words.length ? desc(d.route, d.kind, d.id, `${d.label}, ${words.join(', ')}`, q) : d;
}

// The account name the way account.js shows it: a display name as typed, demo text through txt,
// imported text verbatim.
function accountName(a, txt) {
  const name = String(a.name ?? '');
  return a.displayName ? name : (a.imported === false ? String(txt(name)) : name);
}

const PAGES = {
  home: 'Home', pace: 'Home > Pace', brief: 'Home > Brief', goals: 'Home > Goals',
  plan: 'Plan', yearend: 'Plan > Year end', advisor: 'Plan > Advisor',
  wargame: 'Ask > What-if', add: 'Money > Files',
  settings: 'Settings', connect: 'Settings > Connect', engine: 'Settings > Engine', email: 'Settings > Email',
  onboarding: 'Setup'
};

// The page chip for a route: { route, kind, id, title, label, q } or null (the Ask page has none).
// ctx: { accounts, recs, packs, txt, confirm, view } where confirm is the current Confirm card
// ({ id, label }) or null, and view is what the screens published this draw (all optional):
// pnl { id, label } (the P&L entity, null for household), month 'YYYY-MM', range '3M' | '1Y' |
// 'All', owner 'me' | 'spouse', from and to 'YYYY-MM-DD', filters [{ key, value }] (housing=off,
// tax=on), item { kind: 'goal', id, label } (an open goal form). q is the wire qualifier.
export function routeContext(route, ctx) {
  const c = ctx || {};
  const view = c.view && typeof c.view === 'object' && !Array.isArray(c.view) ? c.view : {};
  const d = pageDesc(route, c, view);
  return d && withDetails(d, view);
}

function pageDesc(route, c, view) {
  const name = route && typeof route.name === 'string' ? route.name : '';
  const params = (route && route.params) || {};
  const txt = typeof c.txt === 'function' ? c.txt : (s) => s;
  const id = params.id != null ? String(params.id) : '';
  if (name === 'ask') return null;
  if (name === 'money') return desc(name, 'money', 'overview', 'Money > Overview');
  if (name === 'accounts') return desc(name, 'money', 'accounts', 'Money > Accounts');
  if (name === 'account') {
    const a = id ? arr(c.accounts).find((x) => x && String(x.id) === id) : null;
    return a ? desc(name, 'account', id, `Money > ${accountName(a, txt)}`) : desc(name, 'money', 'accounts', 'Money > Accounts');
  }
  if (name === 'rec') {
    const r = id ? arr(c.recs).find((x) => x && String(x.id) === id) : null;
    return r && r.status !== 'hidden' ? desc(name, 'rec', id, `Plan > ${String(txt(String(r.title ?? '')))}`) : desc(name, 'page', 'plan', 'Plan');
  }
  // The rows dialog sits over the P&L and shares its chip.
  if (name === 'pnl' || name === 'pnlrows') {
    const v = view.pnl;
    return v && typeof v === 'object' && v.id ? desc(name, 'pnl', String(v.id), `Money > ${String(v.label ?? '')}`) : desc(name, 'page', 'pnl', 'Money > P&L');
  }
  if (name === 'goals') {
    const it = view.item;
    if (it && typeof it === 'object' && it.kind === 'goal' && typeof it.id === 'string' && it.id && it.id.length <= MAX_ID) {
      return desc(name, 'goal', it.id, `${PAGES.goals} > ${String(it.label ?? '')}`);
    }
  }
  if (name === 'confirm') {
    const card = c.confirm;
    return card && card.id ? desc(name, 'confirm', String(card.id), `Confirm > ${String(card.label ?? '')}`) : desc(name, 'page', 'confirm', 'Home > Confirm');
  }
  if (name === 'packs') {
    const p = id ? arr(c.packs).find((x) => x && String(x.id) === id) : null;
    return p ? desc(name, 'pack', id, `Ask > ${String(txt(String(p.name || p.label || id)))}`) : desc(name, 'page', 'packs', 'Ask > Packs');
  }
  if (Object.hasOwn(PAGES, name)) return desc(name, 'page', name, PAGES[name]);
  return desc(name, 'page', 'home', 'Home');
}

// A chip's identity: kind and id; the view qualifier q is not part of it.
export const refKey = (ref) => `${ref && ref.kind}:${ref && ref.id}`;

// The references a question sends: kind and id only, known kinds, nonempty ids of at most 200
// characters, first occurrence of each, at most MAX_REFS. A chip with a nonempty q sends its id
// as `<id>@<q>` when that still fits in 200 characters, else the id alone.
export function chipPayload(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (out.length >= MAX_REFS) break;
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    if (!KINDS.includes(c.kind) || typeof c.id !== 'string' || !c.id || c.id.length > MAX_ID) continue;
    const k = refKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    const q = typeof c.q === 'string' ? c.q : '';
    out.push({ kind: c.kind, id: q && c.id.length + 1 + q.length <= MAX_ID ? `${c.id}@${q}` : c.id });
  }
  return out;
}

const X_ICON = '<svg class="h-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
// A speech bubble (tail at bottom left) with a plus in its body.
const CHAT_ADD_ICON = '<svg class="h-i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
  + '<path d="M3.5 2.75h9a1.25 1.25 0 011.25 1.25v5.5a1.25 1.25 0 01-1.25 1.25H7l-2.75 2.5v-2.5H3.5A1.25 1.25 0 012.25 9.5V4A1.25 1.25 0 013.5 2.75z"/>'
  + '<path d="M8 4.75v3.5M6.25 6.5h3.5"/></svg>';

// One context chip. o: { esc, removable, page, href, go, id, cls, bare }. With href the label is a
// link (data-go and data-id for the design's router); bare drops the "On:" prefix (the rec chip
// of an Ask thread reads as the rec title alone).
export function chipHtml(chip, o = {}) {
  const esc = typeof o.esc === 'function' ? o.esc : escDefault;
  const key = esc(refKey(chip));
  const label = String((chip && chip.label) ?? '');
  const text = o.bare ? esc(label) : `On: ${esc(label)}`;
  const cls = `h-ctx-l${o.cls ? ` ${esc(o.cls)}` : ''}`;
  const inner = o.href
    ? `<a class="${cls}" href="${esc(o.href)}"${o.go ? ` data-go="${esc(o.go)}"` : ''}${o.id != null ? ` data-id="${esc(o.id)}"` : ''}>${text}</a>`
    : `<span class="${cls}">${text}</span>`;
  const x = o.removable
    ? `<button type="button" class="h-ctx-x" data-ctx-remove="${key}" aria-label="Remove ${esc(label)} from context">${X_ICON}</button>`
    : '';
  return `<span class="h-ctx" data-ref="${key}"${o.page ? ' data-page="1"' : ''}>${inner}${x}</span>`;
}

// The shared Ask about button (a chat icon): adds the item to the Ask panel's context.
export function addButtonHtml(kind, id, label, esc = escDefault) {
  const e = typeof esc === 'function' ? esc : escDefault;
  const l = e(label);
  return `<button type="button" class="h-add" data-ctx-add="${e(kind)}" data-ctx-id="${e(id)}" data-ctx-label="${l}" aria-label="Ask about ${l}" title="Ask about ${l}">${CHAT_ADD_ICON}</button>`;
}

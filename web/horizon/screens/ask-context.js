/* Ask everywhere, the pure part: what the owner is looking at (the page chip), the references a
   question carries on the wire, the one chip markup and the shared "+" (Add to chat) button.
   No DOM at import and no imports, so node:test reads it directly. Labels are plain text built
   only from names and titles, never from a figure value; only kind and id ever leave the client. */

export const KINDS = Object.freeze(['account', 'transaction', 'rec', 'step', 'goal', 'figure', 'pnl', 'spending', 'confirm', 'money', 'pack', 'page']);
export const MAX_REFS = 8;
const MAX_ID = 200;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escDefault = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const arr = (a) => (Array.isArray(a) ? a : []);

function desc(route, kind, id, label) {
  return { route, kind, id, title: label.split(' > ').at(-1), label };
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

// The page chip for a route: { route, kind, id, title, label } or null (the Ask page has none).
// ctx: { accounts, recs, packs, txt, confirm } where confirm is the current Confirm card
// ({ id, label }) or null.
export function routeContext(route, ctx) {
  const name = route && typeof route.name === 'string' ? route.name : '';
  const params = (route && route.params) || {};
  const c = ctx || {};
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

export const refKey = (ref) => `${ref && ref.kind}:${ref && ref.id}`;

// The references a question sends: kind and id only, known kinds, nonempty ids of at most 200
// characters, first occurrence of each, at most MAX_REFS.
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
    out.push({ kind: c.kind, id: c.id });
  }
  return out;
}

const X_ICON = '<svg class="h-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
const PLUS_ICON = '<svg class="h-i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';

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

// The shared "+": adds the item to the Ask panel's context.
export function addButtonHtml(kind, id, label, esc = escDefault) {
  const e = typeof esc === 'function' ? esc : escDefault;
  const l = e(label);
  return `<button type="button" class="h-add" data-ctx-add="${e(kind)}" data-ctx-id="${e(id)}" data-ctx-label="${l}" aria-label="Add ${l} to chat" title="Add to chat">${PLUS_ICON}</button>`;
}

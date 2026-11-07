// Ask references: the items the owner pointed at on screen ("+" chips and the page chip), sent
// with a question as `context: [{ kind, id }]`. Only kind and id travel; no label or figure value
// comes from the client.
//
// parseRefs(raw) -> [{ kind, id }]. undefined or null is []. Throws HttpError(400) for a non-array,
// a non-object entry, a kind not in REF_KINDS, an id that is not a nonempty string of at most 200
// characters, or more than MAX_REFS entries. Handlers call it before any write or stream start.
//
// resolveRefs(db, scenario, refs) -> [{ kind, id, use }]: the refs the store knows, deduplicated by
// kind and id, each with `use`, a fixed hint naming the tools that read the item. Unknown items
// (a deleted account, a hidden rec, an answered Confirm card) are dropped silently. Rules:
//   account      an accounts row
//   transaction  a transactions row (the id as a string)
//   rec          a visible rec in the scenario
//   step         `<recId>:<index>`, a task index of a visible rec
//   goal         an open goal in the scenario
//   figure       a key in scenario.fig; a `txn.<id>` key becomes a transaction ref
//   pnl          an entity with P&L lines
//   spending     a transaction category
//   confirm      a pending Confirm item id, or `group:<kind>` with pending items of that kind; the
//                hint is the card question (no tool reads Confirm cards)
//   money        overview or accounts
//   pack         a pack in the scenario
//   page         a signed-in screen id
// Any id may end in a view qualifier, `<id>@<key>=<value>;...`, naming what the screen showed:
// month YYYY-MM, range 3M | 1Y | All, owner me | spouse, from and to YYYY-MM-DD, housing=off,
// tax=on. A valid qualifier resolves the id before it; the ref keeps the full id and its hint ends
// in `; on screen: month 2026-03, ...`. A suffix that is not a valid qualifier is part of the id
// (ids may contain '@'), so free text after '@' only ever fails to match a store row.
// The answerer puts these in the conversation context for the model and keeps them out of the
// grounding evidence: a reference id or hint never grounds a number.

import { HttpError } from './http.mjs';
import { resolveTokens } from '../shared/tokens.mjs';
import { pnlEntities, businessPnl } from '../pnl/business.mjs';

export const REF_KINDS = Object.freeze(['account', 'transaction', 'rec', 'step', 'goal', 'figure', 'pnl', 'spending',
  'confirm', 'money', 'pack', 'page']);
export const MAX_REFS = 8;
const MAX_ID = 200;
const MAX_GROUP_QUESTIONS = 5;

const MONEY_VIEWS = new Set(['overview', 'accounts']);
const PAGES = new Set(['home', 'pace', 'brief', 'goals', 'confirm', 'plan', 'yearend', 'advisor', 'wargame', 'packs',
  'add', 'settings', 'connect', 'engine', 'email', 'onboarding', 'pnl']);

const BAD = 'context must be a list of {kind, id}';

export function parseRefs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, BAD);
  if (raw.length > MAX_REFS) throw new HttpError(400, `context holds at most ${MAX_REFS} references`);
  return raw.map(r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, BAD);
    if (typeof r.kind !== 'string' || !REF_KINDS.includes(r.kind)) throw new HttpError(400, 'context has an unknown reference kind');
    if (typeof r.id !== 'string' || !r.id || r.id.length > MAX_ID) {
      throw new HttpError(400, `context reference ids must be nonempty strings of at most ${MAX_ID} characters`);
    }
    return { kind: r.kind, id: r.id };
  });
}

const arr = v => (Array.isArray(v) ? v : []);
const visibleRec = (scenario, id) => arr(scenario.recs).find(r => r && r.id === id && r.status !== 'hidden') || null;
const txnHint = id => `query_transactions with ids [${id}]`;
const recHint = id => `get_recommendation with id ${id}`;

function transactionRef(db, id) {
  const row = /^\d+$/.test(id) ? db.prepare('SELECT id FROM transactions WHERE id = ?').get(Number(id)) : null;
  return row ? { kind: 'transaction', id: String(row.id), use: txnHint(row.id) } : null;
}

// The categories an entity's P&L shows: its default range and the longest range the P&L allows
// (36 months) ending at the app clock month, income and expenses.
function pnlCategories(db, entity, clock) {
  const out = new Set();
  const month = String(clock || '').slice(0, 7);
  const ranges = [{}];
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m) {
    const n = Number(m[1]) * 12 + Number(m[2]) - 1 - 35;
    ranges.push({ from: `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`, to: month });
  }
  for (const r of ranges) {
    let p = null;
    try { p = businessPnl({ db, entity, clock, ...r }); } catch { p = null; }
    for (const s of ['income', 'expenses']) for (const c of (p && p[s] && Array.isArray(p[s].categories) ? p[s].categories : [])) out.add(c.category);
  }
  return out;
}

const QUALIFIER = /^[a-z]+=[A-Za-z0-9-]+(;[a-z]+=[A-Za-z0-9-]+)*$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const QUALIFIER_VALUES = {
  month: v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v),
  range: v => v === '3M' || v === '1Y' || v === 'All',
  owner: v => v === 'me' || v === 'spouse',
  from: v => DAY.test(v),
  to: v => DAY.test(v),
  housing: v => v === 'off',
  tax: v => v === 'on',
};

// { base, q, words } for an id ending in a valid view qualifier, else null.
function splitQualifier(id) {
  const at = id.lastIndexOf('@');
  if (at <= 0) return null;
  const q = id.slice(at + 1);
  if (!QUALIFIER.test(q)) return null;
  const pairs = q.split(';').map(p => p.split('='));
  if (!pairs.every(([k, v]) => Object.hasOwn(QUALIFIER_VALUES, k) && QUALIFIER_VALUES[k](v))) return null;
  return { base: id.slice(0, at), q, words: pairs.map(([k, v]) => `${k} ${v}`).join(', ') };
}

// One ref, with or without a view qualifier.
function resolveRef(db, scenario, ref) {
  const sq = ref && typeof ref.id === 'string' ? splitQualifier(ref.id) : null;
  if (!sq) return resolveOne(db, scenario, ref);
  const r = resolveOne(db, scenario, { kind: ref.kind, id: sq.base });
  return r ? { kind: r.kind, id: `${r.id}@${sq.q}`, use: `${r.use}; on screen: ${sq.words}` } : null;
}

// One ref as { kind, id, use } or null when the store does not know it.
function resolveOne(db, scenario, { kind, id }) {
  const plain = s => resolveTokens(scenario, String(s ?? ''), false);
  switch (kind) {
    case 'account':
      return db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)
        ? { kind, id, use: `query_transactions with accountId ${id}, list_accounts, list_positions with accountId ${id}` } : null;
    case 'transaction':
      return transactionRef(db, id);
    case 'rec':
      return visibleRec(scenario, id) ? { kind, id, use: recHint(id) } : null;
    case 'step': {
      const m = /^(.+):(\d+)$/.exec(id);
      const rec = m && visibleRec(scenario, m[1]);
      if (!rec || Number(m[2]) >= arr(rec.tasks).length) return null;
      return { kind, id, use: `${recHint(rec.id)}; the step is tasks[${Number(m[2])}]` };
    }
    case 'goal':
      return arr(scenario.goals).some(g => g && g.id === id && !g.archived) ? { kind, id, use: 'list_goals, get_pace' } : null;
    case 'figure': {
      if (id.startsWith('txn.')) return transactionRef(db, id.slice(4));
      if (!scenario.fig || !Object.hasOwn(scenario.fig, id)) return null;
      return { kind, id, use: `write it as the token {f:${id}}; get_figures with keys [${id}] for its source` };
    }
    case 'pnl': {
      // A P&L entity key as /api/pnl lists it (entity:<name> or account:<id>), optionally
      // <key>|<category> for one category row.
      const bar = id.indexOf('|');
      const key = bar < 0 ? id : id.slice(0, bar);
      const category = bar < 0 ? '' : id.slice(bar + 1);
      const clock = scenario.meta && scenario.meta.clock;
      let ent = null;
      try { ent = pnlEntities({ db, clock }).find(e => e.key === key) || null; } catch { ent = null; }
      if (!ent) return null;
      // A category row must be one of this entity's real P&L categories before its name reaches
      // the prompt: an invented or misspelled category drops the reference.
      if (category && !pnlCategories(db, key, clock).has(category)) return null;
      return { kind, id, use: `pnl_by_month with entity ${plain(ent.label)}${category ? `, the ${category} lines` : ''}` };
    }
    case 'spending':
      return db.prepare('SELECT 1 FROM transactions WHERE category = ? LIMIT 1').get(id)
        ? { kind, id, use: `query_transactions with category ${id}, pnl_by_month` } : null;
    case 'confirm': {
      const rows = id.startsWith('group:')
        ? db.prepare("SELECT question FROM confirm_items WHERE status = 'pending' AND kind = ? ORDER BY id").all(id.slice(6))
        : /^\d+$/.test(id) ? db.prepare("SELECT question FROM confirm_items WHERE status = 'pending' AND id = ?").all(Number(id)) : [];
      if (!rows.length) return null;
      const questions = rows.slice(0, MAX_GROUP_QUESTIONS).map(r => plain(r.question)).filter(Boolean);
      return { kind, id, use: `Confirm card question, no tool reads it: ${questions.join(' / ') || 'none'}` };
    }
    case 'money':
      return MONEY_VIEWS.has(id) ? { kind, id, use: 'list_accounts, get_figures' } : null;
    case 'pack':
      return arr(scenario.packs).some(p => p && p.id === id)
        ? { kind, id, use: `list_packs, then search_pack_entries or get_pack_entry with packId ${id}` } : null;
    case 'page':
      return PAGES.has(id) ? { kind, id, use: 'the screen the owner has open; household_summary for an overview' } : null;
    default:
      return null;
  }
}

export function resolveRefs(db, scenario, refs) {
  const out = [];
  const seen = new Set();
  for (const ref of arr(refs)) {
    const r = resolveRef(db, scenario || {}, ref);
    if (!r || seen.has(`${r.kind}:${r.id}`)) continue;
    seen.add(`${r.kind}:${r.id}`);
    out.push(r);
  }
  return out;
}

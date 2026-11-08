// POST /api/accounts/:id/name  {displayName?: string|null} -> {scenario, account}
// Stores the owner's display name. Empty clears it, and the screens fall back to the default label.
// The imported name, source_id and mirror are left alone.

import { tx, getSetting, parseJson } from '../store/db.mjs';
import { validateDisplayName, accountLabel } from '../shared/account-label.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { afterAnswer, schedulePlan, triggerFreshness } from './ingest-handlers.mjs';
import { ToolError } from '../tools/errors.mjs';
import { archiveAccount, removeFile, mergeAccounts } from '../accounts/sources.mjs';
import { sourcesView } from '../ingest/freshness.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { setAccountAnswer, undoAccountAnswer, OWNER_OPTIONS, KIND_OPTIONS } from '../ingest/confirm.mjs';
import { queueAccountPairs, mergePlan } from '../ingest/account-merge.mjs';

export function accountRename(ctx) {
  const id = ctx.params?.id;
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'missing account');
  const row = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'no such account');
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  if (!Object.hasOwn(body, 'displayName')) throw new HttpError(400, 'display name is required');
  const res = validateDisplayName(body.displayName);
  if (!res.ok) throw new HttpError(400, res.error);
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(res.value, id);
  });
  const scenario = scenarioOf(ctx);
  const account = scenario.accounts.find((a) => a.id === id) || null;
  return { scenario, account, label: accountNaming(ctx.db).label({ ...row, display_name: res.value }) };
}

// POST /api/accounts/:id/mask  {mask: "NNNN"} or {undo: before} -> {scenario, account, before}
// Stores a last 4 the owner typed, only on an account with none and no SimpleFIN identity (the
// bridge owns those). Duplicate detection reads accounts.mask, so the pairs are asked again here.
//
// POST /api/accounts/:id/owner {owner} and /kind {kind}, or {undo: before} -> {scenario, account, before}
// Recorded as the account's confirm answer (setAccountAnswer), with the same replan as a Confirm answer.
//
// GET  /api/accounts/:id/merge-candidates -> {items: [{id, label, inst, kind, mask, lastDataDate, mirror, plan, refused?}]}
// POST /api/accounts/:id/merge {withId} -> {scenario, survivorId, itemId, receipt}; Undo is
//   POST /api/actions/:receiptId/undo (or POST /api/confirm/:itemId/reopen).
//
// Sources (accounts/sources.mjs, the same code as the `sources` tool):
// GET  /api/sources -> {sources}: each source by real name with range, state, accounts and files.
// POST /api/accounts/:id/archive {archived?: boolean = true} -> {scenario, receipt} (receipt null when nothing changed)
// POST /api/files/:id/remove -> {scenario, receipt}
// Undo is POST /api/actions/:receiptId/undo.

function accountOf(ctx, id = ctx.params?.id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'missing account');
  const row = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'no such account');
  return row;
}

const bodyOf = (ctx) => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {});
const withAccount = (scenario, id) => ({ scenario, account: scenario.accounts.find((a) => a.id === id) || null });

export function accountMask(ctx) {
  const row = accountOf(ctx);
  const body = bodyOf(ctx);
  if (Object.hasOwn(body, 'undo')) return undoAccountMask(ctx, row, body.undo);
  const mask = body.mask;
  if (typeof mask !== 'string' || !/^\d{4}$/.test(mask)) throw new HttpError(400, 'last 4 must be exactly four digits');
  if ((row.mask != null && row.mask !== '') || String(row.identity ?? '').startsWith('simplefin:')) {
    throw new HttpError(409, 'this account already has its last 4');
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE accounts SET mask = ? WHERE id = ?').run(mask, row.id);
    queueAccountPairs(ctx.db);
  });
  // The receipt for Undo: the last 4 that was stored (an account only takes one while it has none).
  return { ...withAccount(scenarioOf(ctx), row.id), before: { set: mask } };
}

// {undo: {set}} takes back the last 4 an earlier save stored. It is refused when that last 4 is no
// longer the account's, when the bridge owns it, or when an answered Same account? question for the
// account built on it. Pairs only the last 4 proposed are withdrawn with it.
function undoAccountMask(ctx, row, undo) {
  if (!undo || typeof undo !== 'object' || Array.isArray(undo) || typeof undo.set !== 'string' || !/^\d{4}$/.test(undo.set)) {
    throw new HttpError(400, 'undo must be the before value an edit returned');
  }
  if (row.mask !== undo.set || String(row.identity ?? '').startsWith('simplefin:')) {
    throw new HttpError(409, 'the last 4 changed since, so it cannot be undone');
  }
  const answered = ctx.db.prepare("SELECT context FROM confirm_items WHERE kind = 'account_match' AND status = 'answered' AND answer IS NOT 'superseded'").all()
    .some((i) => { const c = parseJson(i.context, {}) || {}; return c.candidateId === row.id || c.ownId === row.id; });
  if (answered) throw new HttpError(409, 'a later answer builds on this last 4, so it is final');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE accounts SET mask = NULL WHERE id = ?').run(row.id);
    queueAccountPairs(ctx.db);
  });
  return { ...withAccount(scenarioOf(ctx), row.id), before: null };
}

const nowIso = () => new Date().toISOString();

function accountAnswer(ctx, kind, field, options) {
  const row = accountOf(ctx);
  const body = bodyOf(ctx);
  let before = null;
  let fn;
  if (Object.hasOwn(body, 'undo')) {
    const undo = body.undo;
    if (!undo || typeof undo !== 'object' || Array.isArray(undo) || (undo.answer != null && typeof undo.answer !== 'string')) {
      throw new HttpError(400, 'undo must be the before value an edit returned');
    }
    fn = () => undoAccountAnswer(ctx.db, kind, row.id, undo, { now: nowIso() });
  } else {
    const value = body[field];
    if (typeof value !== 'string' || !options.some((o) => o.id === value)) {
      throw new HttpError(400, `${field} must be one of ${options.map((o) => o.id).join(', ')}`);
    }
    fn = () => {
      const out = setAccountAnswer(ctx.db, kind, row.id, value, { now: nowIso() });
      before = out.before;
      return out;
    };
  }
  const out = afterAnswer(ctx, fn);
  return { ...withAccount(out.scenario, row.id), before };
}

export const accountOwner = (ctx) => accountAnswer(ctx, 'account_owner', 'owner', OWNER_OPTIONS);
export const accountKind = (ctx) => accountAnswer(ctx, 'account_kind', 'kind', KIND_OPTIONS);

const lastDataDate = (db, id) => db.prepare(`SELECT max(d) AS d FROM (SELECT max(date) AS d FROM transactions WHERE account_id = ?1
  UNION ALL SELECT max(date) FROM balances WHERE account_id = ?1 UNION ALL SELECT max(as_of) FROM positions WHERE account_id = ?1)`).get(id).d || null;

export function accountMergeCandidates(ctx) {
  const row = accountOf(ctx);
  const naming = accountNaming(ctx.db);
  const label = (id) => accountLabel(naming.byId.get(id));
  const items = ctx.db.prepare('SELECT * FROM accounts WHERE id != ? ORDER BY sort, id').all(row.id).map((a) => {
    const { keepId, ownId, moves, refused } = mergePlan(ctx.db, row.id, a.id);
    return {
      id: a.id, label: label(a.id), inst: a.inst, kind: a.kind, mask: a.mask, lastDataDate: lastDataDate(ctx.db, a.id), mirror: a.mirror,
      plan: { keepId, keepLabel: label(keepId), ownId, ownLabel: label(ownId), moves: moves || { transactions: 0, balances: 0, positions: 0, sources: 0 } },
      ...(refused ? { refused } : {}),
    };
  });
  return { items };
}

const HTTP_STATUS = { not_found: 404, conflict: 409, bad_input: 400, forbidden: 403 };
// A ToolError from the shared source actions as the HTTP error the routes answer.
function httpOf(e) {
  return e instanceof ToolError ? new HttpError(HTTP_STATUS[e.code] ?? 400, e.message) : e;
}
const actionCtx = (ctx) => ({ db: ctx.db, now: nowIso(), actorId: ctx.identity?.id || (getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : null) });

export function accountMerge(ctx) {
  let res = null;
  try {
    const out = afterAnswer(ctx, () => (res = mergeAccounts(actionCtx(ctx), ctx.params?.id, bodyOf(ctx).withId)));
    return { scenario: out.scenario, survivorId: res.survivorId, itemId: out.item.id, receipt: res.receipt };
  } catch (e) { throw httpOf(e); }
}

// After a source action: the plan reruns soon and freshness is recomputed; the reply carries the
// rebuilt scenario.
function afterSourceAction(ctx, fn) {
  let out;
  try { out = fn(actionCtx(ctx)); } catch (e) { throw httpOf(e); }
  schedulePlan(ctx);
  triggerFreshness(ctx);
  return { scenario: scenarioOf(ctx), receipt: out.receipt };
}

export function accountArchive(ctx) {
  const body = bodyOf(ctx);
  const archived = Object.hasOwn(body, 'archived') ? body.archived : true;
  if (typeof archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
  return afterSourceAction(ctx, (a) => archiveAccount(a, ctx.params?.id, archived));
}

export function fileRemove(ctx) {
  return afterSourceAction(ctx, (a) => removeFile(a, ctx.params?.id));
}

export function sourcesList(ctx) {
  return { sources: sourcesView(ctx.db) };
}

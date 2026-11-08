// POST /api/accounts/:id/name  {displayName?: string|null} -> {scenario, account}
// Stores the owner's display name. Empty clears it, and the screens fall back to the default label.
// The imported name, source_id and mirror are left alone.

import { getSetting } from '../store/db.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './scenario.mjs';
import { afterAnswer, schedulePlan, triggerFreshness } from './ingest-handlers.mjs';
import { ToolError } from '../tools/errors.mjs';
import { archiveAccount, removeFile, mergeAccounts } from '../accounts/sources.mjs';
import { sourcesView } from '../ingest/freshness.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { accountOf as storedAccount, renameAccount, setAccountMask, restoreAccountMask, writeAccountAnswer, mergeAccountPair } from '../accounts/write.mjs';
import { mergePlan } from '../ingest/account-merge.mjs';

export function accountRename(ctx) {
  const row = renameAccount(ctx.db, ctx.params?.id, ctx.body?.displayName);
  const scenario = scenarioOf(ctx);
  return { scenario, account: scenario.accounts.find(a => a.id === row.id) || null, label: accountNaming(ctx.db).label(row) };
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

const accountOf = (ctx, id = ctx.params?.id) => storedAccount(ctx.db, id);

const bodyOf = (ctx) => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {});
const withAccount = (scenario, id) => ({ scenario, account: scenario.accounts.find((a) => a.id === id) || null });

export function accountMask(ctx) {
  const row = accountOf(ctx), body = bodyOf(ctx);
  const before = Object.hasOwn(body, 'undo') ? (restoreAccountMask(ctx.db, row.id, body.undo), null) : setAccountMask(ctx.db, row.id, body.mask);
  return { ...withAccount(scenarioOf(ctx), row.id), before };
}

const nowIso = () => new Date().toISOString();

function accountAnswer(ctx, field) {
  const row = accountOf(ctx);
  let before;
  const out = afterAnswer(ctx, () => {
    const result = writeAccountAnswer(ctx.db, row.id, field, bodyOf(ctx), { now: nowIso() });
    before = result.before;
    return result;
  });
  return { ...withAccount(out.scenario, row.id), before };
}

export const accountOwner = (ctx) => accountAnswer(ctx, 'owner');
export const accountKind = (ctx) => accountAnswer(ctx, 'kind');

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

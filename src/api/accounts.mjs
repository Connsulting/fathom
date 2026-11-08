// POST /api/accounts/:id/name  {displayName?: string|null} -> {scenario, account}
// Stores the owner's display name. Empty clears it, and the screens fall back to the default label.
// The imported name, source_id and mirror are left alone.

import { accountLabel } from '../shared/account-label.mjs';
import { scenarioOf } from './scenario.mjs';
import { afterAnswer } from './ingest-handlers.mjs';
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
// POST /api/accounts/:id/merge {withId} -> {scenario, survivorId, itemId}; undo is POST /api/confirm/:itemId/reopen.

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

export function accountMerge(ctx) {
  let survivorId;
  const out = afterAnswer(ctx, () => {
    const result = mergeAccountPair(ctx.db, ctx.params?.id, bodyOf(ctx).withId, { now: nowIso() });
    survivorId = result.survivorId;
    return result;
  });
  return { scenario: out.scenario, survivorId, itemId: out.item.id };
}

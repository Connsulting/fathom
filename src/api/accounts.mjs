// POST /api/accounts/:id/name  {displayName?: string|null} -> {scenario, account}
// Stores the owner's display name. Empty clears it, and the screens fall back to the default label.
// The imported name, source_id and mirror are left alone.

import { tx } from '../store/db.mjs';
import { validateDisplayName, accountLabel } from '../shared/account-label.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { afterAnswer } from './ingest-handlers.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { setAccountAnswer, undoAccountAnswer, OWNER_OPTIONS, KIND_OPTIONS } from '../ingest/confirm.mjs';
import { queueAccountPairs, mergePlan, manualMerge } from '../ingest/account-merge.mjs';

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
  return { scenario, account, label: accountLabel({ ...row, display_name: res.value }) };
}

// POST /api/accounts/:id/mask  {mask: "NNNN"} -> {scenario, account}
// Stores a last 4 the owner typed, only on an account with none and no SimpleFIN identity (the
// bridge owns those). Duplicate detection reads accounts.mask, so the pairs are asked again here.
//
// POST /api/accounts/:id/owner {owner} and /kind {kind}, or {undo: before} -> {scenario, account, before}
// Recorded as the account's confirm answer (setAccountAnswer), with the same replan as a Confirm answer.
//
// GET  /api/accounts/:id/merge-candidates -> {items: [{id, label, inst, kind, mask, lastDataDate, mirror, plan, refused?}]}
// POST /api/accounts/:id/merge {withId} -> {scenario, survivorId, itemId}; undo is POST /api/confirm/:itemId/reopen.

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
  const mask = bodyOf(ctx).mask;
  if (typeof mask !== 'string' || !/^\d{4}$/.test(mask)) throw new HttpError(400, 'last 4 must be exactly four digits');
  if ((row.mask != null && row.mask !== '') || String(row.identity ?? '').startsWith('simplefin:')) {
    throw new HttpError(409, 'this account already has its last 4');
  }
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE accounts SET mask = ? WHERE id = ?').run(mask, row.id);
    queueAccountPairs(ctx.db);
  });
  return withAccount(scenarioOf(ctx), row.id);
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

export function accountMerge(ctx) {
  const row = accountOf(ctx);
  const withId = bodyOf(ctx).withId;
  if (typeof withId !== 'string' || !withId) throw new HttpError(400, 'withId must name the other account');
  if (withId === row.id) throw new HttpError(400, 'an account cannot be merged with itself');
  accountOf(ctx, withId);
  const plan = mergePlan(ctx.db, row.id, withId);
  if (plan.refused) throw new HttpError(409, plan.refused);
  let survivorId = null;
  const out = afterAnswer(ctx, () => {
    const merged = manualMerge(ctx.db, row.id, withId, { now: nowIso() });
    survivorId = merged.survivorId;
    return merged;
  });
  return { scenario: out.scenario, survivorId, itemId: out.item.id };
}

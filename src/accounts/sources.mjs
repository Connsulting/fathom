// Per-source actions with Undo (SRC1), shared by the HTTP routes and the `sources` tool:
//   archiveAccount(ctx, id, archived = true): sets or clears accounts.archived_at. An archived
//     account leaves current balances, household totals and Ask; its rows stay. Receipt kind
//     'account'; Undo is the generic single-row revert in actions/receipts.mjs.
//   removeFile(ctx, id): deletes the uploaded file's rows (transactions and their category rows,
//     balances, positions, P&L lines, tax payments, facts) and its pending questions, archives an
//     account left with no rows that no live bank connection feeds, and marks the file removed.
//     The change log (ingest/undo.mjs captureChanges) is kept in source_changes under the receipt
//     id; Undo replays it backwards (the 'file' receipt kind registered below).
//   mergeAccounts(ctx, id, withId): the account dialog's manual merge (mergePlan, manualMerge),
//     with a receipt kind 'merge' whose Undo reopens the merge's confirm item (receipt null when
//     no person is signed in).
// ctx is {db, now, actorId}; failures are ToolErrors (not_found, conflict, bad_input, forbidden).

import { tx } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { requireActor, saveReceipt, registerReceiptKind, undoAction } from '../actions/receipts.mjs';
import { captureChanges, revertChanges } from '../ingest/undo.mjs';
import { connectedAccountIds } from '../ingest/coverage.mjs';
import { ConfirmError, reopenItemInTx } from '../ingest/confirm.mjs';
import { mergeAccountPair } from './write.mjs';
import { mergePlan } from '../ingest/account-merge.mjs';
import { refreshFigures } from '../ingest/pipeline.mjs';
import { accountNaming } from './naming.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { reconcileTransactionPayments } from '../ingest/transaction-payments.mjs';

export const SOURCES_SCOPE = 'write:sources';
export const CHANGED_SINCE = 'This item changed since that action. Ask for a new change instead.';

const stampOf = (ctx) => new Date(ctx.now ?? Date.now()).toISOString();

function accountRow(db, id) {
  if (typeof id !== 'string' || !id) throw new ToolError('bad_input', 'An account id is required.');
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) throw new ToolError('not_found', 'No such account.');
  return row;
}

const hasActor = (ctx) => { try { requireActor(ctx); return true; } catch { return false; } };
const labelOf = (db, id) => accountLabel(accountNaming(db).byId.get(id) ?? { id }) || id;

export function archiveAccount(ctx, id, archived = true) {
  requireActor(ctx);
  if (typeof archived !== 'boolean') throw new ToolError('bad_input', 'archived must be true or false.');
  const row = accountRow(ctx.db, id);
  const label = labelOf(ctx.db, row.id);
  return tx(ctx.db, () => {
    const before = { archived_at: row.archived_at ?? null };
    const after = { archived_at: archived ? (row.archived_at ?? stampOf(ctx)) : null };
    if (before.archived_at === after.archived_at) return { receipt: null, id: row.id, archived, label };
    ctx.db.prepare('UPDATE accounts SET archived_at = ? WHERE id = ?').run(after.archived_at, row.id);
    const receipt = saveReceipt(ctx, { scope: SOURCES_SCOPE, kind: 'account', id: row.id, label: `${archived ? 'Archive' : 'Restore'} ${label}`, before, after });
    return { receipt, id: row.id, archived, label };
  });
}

// Rows an uploaded file carries, deleted in this order (category rows before their transactions).
// Documents (W-2s, paystubs, statements) and held facts go too, so the planner stops reading them.
const ROW_TABLES = ['transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'facts', 'held_facts', 'documents'];
const CATEGORY_TABLES = ['transaction_category_corrections', 'transaction_category_guesses', 'transaction_category_imports'];
const hasRows = (db, id) => !!db.prepare(`SELECT 1 FROM transactions WHERE account_id = ?1
  UNION ALL SELECT 1 FROM balances WHERE account_id = ?1 UNION ALL SELECT 1 FROM positions WHERE account_id = ?1 LIMIT 1`).get(id);

export function removeFile(ctx, id) {
  requireActor(ctx);
  const { db } = ctx;
  if (typeof id !== 'string' || !id) throw new ToolError('bad_input', 'A file id is required.');
  const file = db.prepare('SELECT id, name, stored_path, removed_at FROM files WHERE id = ?').get(id);
  if (!file) throw new ToolError('not_found', 'No such file.');
  if (file.removed_at) throw new ToolError('conflict', 'That file was already removed.');
  if (file.stored_path == null) throw new ToolError('bad_input', 'That file was not uploaded, so it cannot be removed.');
  const stamp = stampOf(ctx);
  return tx(db, () => {
    const fed = db.prepare(`SELECT account_id FROM transactions WHERE file_id = ?1 UNION SELECT account_id FROM balances WHERE file_id = ?1
      UNION SELECT account_id FROM positions WHERE file_id = ?1
      UNION SELECT id FROM accounts WHERE fig_key IN (SELECT key FROM figures WHERE file_id = ?1)`).all(id).map((r) => r.account_id).filter(Boolean);
    const connected = connectedAccountIds(db);
    const archived = [];
    const { changes } = captureChanges(db, () => {
      for (const table of CATEGORY_TABLES) {
        db.prepare(`DELETE FROM ${table} WHERE transaction_id IN (SELECT id FROM transactions WHERE file_id = ?)`).run(id);
      }
      for (const table of ROW_TABLES) db.prepare(`DELETE FROM ${table} WHERE file_id = ?`).run(id);
      // Questions this file raised and nobody answered go with it (their guesses are rebuilt).
      for (const table of ['confirm_guesses', 'confirm_auto', 'confirm_auto_declined']) {
        db.prepare(`DELETE FROM ${table} WHERE item_id IN (SELECT id FROM confirm_items WHERE file_id = ? AND status = 'pending')`).run(id);
      }
      db.prepare("DELETE FROM confirm_items WHERE file_id = ? AND status = 'pending'").run(id);
      for (const account of fed) {
        if (connected.has(account) || hasRows(db, account)) continue;
        const r = db.prepare('UPDATE accounts SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(stamp, account);
        if (r.changes) archived.push(account);
      }
      // Figures read from this file go; each fed account's balance figure is recomputed from the
      // rows that remain, and an account with none left has no balance figure.
      db.prepare('DELETE FROM figures WHERE file_id = ?').run(id);
      refreshFigures({ db, now: stamp, emptySnapshots: new Map() }, fed);
      const unset = db.prepare('UPDATE accounts SET fig_key = NULL WHERE id = ? AND fig_key IS NOT NULL AND fig_key NOT IN (SELECT key FROM figures)');
      for (const account of fed) unset.run(account);
      db.prepare('UPDATE files SET removed_at = ? WHERE id = ?').run(stamp, id);
      reconcileTransactionPayments(db, { now: stamp });
    });
    const receipt = saveReceipt(ctx, { scope: SOURCES_SCOPE, kind: 'file', id, label: `Remove ${file.name}`, before: { removed_at: null }, after: { removed_at: stamp } });
    db.prepare('INSERT INTO source_changes (receipt_id, changes) VALUES (?, ?)').run(receipt.id, JSON.stringify(changes));
    return { receipt, id, name: file.name, archived };
  });
}

export async function restoreRemovedFile(ctx, id) {
  const actor = requireActor(ctx);
  const receipt = ctx.db.prepare(`SELECT id FROM action_receipts WHERE kind='file' AND entity_id=?
    AND actor_id=? AND undone_at IS NULL ORDER BY rowid DESC LIMIT 1`).get(id, actor);
  if (!receipt) throw new ToolError('conflict', 'The removal receipt for this file is not available.');
  return undoAction(ctx, receipt.id, SOURCES_SCOPE);
}

export function mergeAccounts(ctx, id, withId) {
  const { db } = ctx;
  const row = accountRow(db, id);
  if (typeof withId !== 'string' || !withId) throw new ToolError('bad_input', 'withId must name the other account.');
  if (withId === row.id) throw new ToolError('bad_input', 'An account cannot be merged with itself.');
  accountRow(db, withId);
  const plan = mergePlan(db, row.id, withId);
  if (plan.refused) throw new ToolError('conflict', plan.refused);
  const label = `Merge ${labelOf(db, plan.ownId)} into ${labelOf(db, plan.keepId)}`;
  const merged = mergeAccountPair(db, row.id, withId, { now: stampOf(ctx) });
  // A merge needs no signed-in person (its confirm item can always be reopened); the receipt and
  // its Undo are recorded for the person who made it.
  const receipt = !hasActor(ctx) ? null : saveReceipt(ctx, { scope: SOURCES_SCOPE, kind: 'merge', id: String(merged.item.id), label,
    before: { survivorId: null, ownId: plan.ownId }, after: { survivorId: merged.survivorId, ownId: plan.ownId } });
  return { ...merged, itemId: merged.item.id, receipt };
}

// Undo for each receipt kind, run by actions/receipts.mjs undoAction inside its transaction:
// archive is the generic single-row revert; a file removal replays its stored change log; a merge
// reopens its confirm item. A changed row refuses with a conflict and the transaction rolls back.
const conflictOnChange = (fn) => {
  try { return fn(); } catch (e) {
    if (e instanceof ConfirmError) throw new ToolError('conflict', CHANGED_SINCE);
    throw e;
  }
};
registerReceiptKind('account', { table: 'accounts', pk: 'id' });
registerReceiptKind('file', {
  restore(ctx, { receipt }) {
    const log = ctx.db.prepare('SELECT changes FROM source_changes WHERE receipt_id = ?').get(receipt.id);
    if (!log) throw new ToolError('conflict', CHANGED_SINCE);
    conflictOnChange(() => revertChanges(ctx.db, JSON.parse(log.changes)));
    reconcileTransactionPayments(ctx.db, { now: stampOf(ctx) });
  },
});
registerReceiptKind('merge', {
  restore(ctx, { id }) {
    conflictOnChange(() => reopenItemInTx(ctx.db, Number(id), { now: stampOf(ctx) }));
  },
});

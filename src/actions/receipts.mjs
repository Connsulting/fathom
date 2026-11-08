import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getSetting, parseJson as parse, tx } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';

export function requireActor(ctx) {
  const actor = ctx.actorId || (getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : null);
  if (!actor) throw new ToolError('forbidden', 'A signed-in person is required to make this change.');
  return actor;
}

export function requireScope(ctx, scope) {
  if (ctx.scopes && !ctx.scopes.includes(scope)) throw new ToolError('forbidden', `Permission denied: this action needs ${scope}.`);
}

export function receiptOut(r) {
  return { id: r.id, scope: r.scope, label: r.label, before: parse(r.before_value, null), after: parse(r.after_value, null),
    ...(r.kind === 'receipt_group' ? { scopes: receiptScopes(r) } : {}),
    actorId: r.actor_id, ts: r.created_at, undone: !!r.undone_at, planningPending: !!r.planning_pending,
    ...(r.kind === 'refresh' ? { undo: { available: false, reason: 'This refresh cannot be undone here.' } } : {}) };
}

export function receiptsFor(db, key) {
  return db.prepare('SELECT * FROM action_receipts WHERE conversation_key = ? ORDER BY rowid').all(key);
}

export function ensureActionConversation(db, key, now, recId = null) {
  if (!/^ask:[a-f0-9]{12}$/.test(key || '')) return;
  db.prepare('INSERT OR IGNORE INTO conversations (key, created_at, last_at, rec_id) VALUES (?, ?, ?, ?)').run(key, now, now, recId);
  db.prepare('UPDATE conversations SET trashed_at = NULL, archived_at = NULL, rec_id = coalesce(rec_id, ?) WHERE key = ?').run(recId, key);
}

export function saveReceipt(ctx, { scope, kind, id, label, before, after, from = before, to = after }) {
  if (isDeepStrictEqual(before, after)) return null;
  const actor = requireActor(ctx);
  const stamp = new Date(ctx.now ?? Date.now()).toISOString();
  const receiptId = randomUUID();
  ensureActionConversation(ctx.db, ctx.conversationKey, stamp, ctx.recId);
  ctx.db.prepare(`INSERT INTO action_receipts
    (id, scope, kind, entity_id, actor_id, conversation_key, turn_id, label, before_state, after_state, before_value, after_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(receiptId, scope, kind, id, actor, ctx.conversationKey || null,
    ctx.turnId || null, label, JSON.stringify(before), JSON.stringify(after), JSON.stringify(from), JSON.stringify(to), stamp);
  return receiptOut(ctx.db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(receiptId));
}

export function receiptMessages(db, key, messages) {
  const all = receiptsFor(db, key);
  const grouped = new Set(all.filter(r => r.kind === 'receipt_group').flatMap(r => parse(r.after_state, {}).childIds ?? []));
  const rows = all.filter(r => !grouped.has(r.id));
  const used = new Set();
  for (const message of messages) {
    const turnId = message.provenance?.actionTurn;
    if (!turnId) continue;
    const actions = rows.filter(r => r.turn_id === turnId).map(r => { used.add(r.id); return receiptOut(r); });
    if (actions.length) message.provenance = { ...message.provenance, actions };
  }
  for (const row of rows) if (!used.has(row.id)) messages.push({ id: 'action-' + row.id, role: 'fathom', text: '', refs: [],
    ts: row.created_at, notice: false, provenance: { actions: [receiptOut(row)] } });
  return messages;
}

const KINDS = new Map();
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// restore(ctx, { id, before, after, receipt }) is synchronous and runs in the undo transaction.
// It must refuse a changed item before applying its domain inverse; throwing rolls back both.
export function registerReceiptKind(kind, definition) {
  if (typeof kind !== 'string' || !IDENTIFIER.test(kind) || !definition || typeof definition !== 'object') {
    throw new TypeError('Invalid receipt kind definition');
  }
  if (KINDS.has(kind)) throw new TypeError(`Receipt kind ${kind} is already registered`);
  const keys = Object.keys(definition).sort().join(',');
  const table = keys === 'pk,table' && typeof definition.table === 'string' && typeof definition.pk === 'string' && IDENTIFIER.test(definition.table) && IDENTIFIER.test(definition.pk);
  const hook = keys === 'restore' && typeof definition.restore === 'function' && definition.restore.constructor.name !== 'AsyncFunction';
  if (!table && !hook) throw new TypeError('Invalid receipt kind definition');
  KINDS.set(kind, Object.freeze({ ...definition }));
}

for (const [kind, table, pk] of [
  ['preference', 'preferences', 'id'], ['fact', 'facts', 'key'], ['goal', 'goals', 'id'],
  ['status', 'recs', 'id'], ['owner', 'recs', 'id'], ['setting', 'settings', 'key'],
]) registerReceiptKind(kind, { table, pk });

registerReceiptKind('step', { restore(ctx, { id, before, after, checkOnly }) {
  const current = ctx.db.prepare('SELECT def,tasks_done FROM recs WHERE id=?').get(id);
  if (!current || current.tasks_done !== after.tasks_done ||
    !isDeepStrictEqual(parse(current.def, {}).tasks, parse(after.def, {}).tasks)) {
    throw new ToolError('conflict', 'This step changed since that action.');
  }
  if (!checkOnly) ctx.db.prepare('UPDATE recs SET tasks_done=? WHERE id=?').run(before.tasks_done, id);
} });

export function restoreReceipt(ctx, id, scope, checkOnly = false) {
  const actor = requireActor(ctx);
  requireScope(ctx, scope);
  const row = ctx.db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(id);
  if (!row || row.actor_id !== actor || row.scope !== scope) throw new ToolError('forbidden', 'This change is not available to you.');
  if (row.undone_at) throw new ToolError('bad_input', 'This change was already undone.');
  const before = parse(row.before_state, null), after = parse(row.after_state, null);
  const definition = KINDS.get(row.kind);
  if (!definition) throw new ToolError('bad_input', 'This receipt kind does not support Undo.');
  let current = ['status', 'owner', 'step'].includes(row.kind) ? ctx.db.prepare('SELECT * FROM recs WHERE id=?').get(row.entity_id) : null;
  if (definition.restore) {
    const restored = definition.restore(ctx, { id: row.entity_id, before, after, receipt: receiptOut(row), checkOnly });
    if (restored && typeof restored.then === 'function') throw new TypeError('Receipt kind restore must be synchronous');
  } else {
    const { table, pk } = definition;
    current = ctx.db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(row.entity_id);
    // A goal's lifecycle columns are always compared, so a goal archived or marked done after the
    // receipt refuses Undo. A receipt written before migration 026 has no done_at: read as null.
    const lifecycle = row.kind === 'goal' ? ['archived_at', 'done_at'] : [];
    const fields = [...new Set([...Object.keys(after || before || {}), ...lifecycle])];
    if (![...fields, ...Object.keys(before || {})].every(k => IDENTIFIER.test(k))) throw new ToolError('bad_input', 'Invalid receipt state.');
    const value = current ? Object.fromEntries(fields.map(k => [k, current[k] ?? null])) : null;
    const expected = after ? Object.fromEntries(fields.map(k => [k, after[k] ?? null])) : null;
    if (!isDeepStrictEqual(value, expected)) throw new ToolError('conflict', 'This item changed since that action. Ask for a new change instead.');
    if (checkOnly) return;
    if (before === null) ctx.db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(row.entity_id);
    else if (!current) {
      const keys = Object.keys(before);
      ctx.db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => before[k]));
    } else {
      const keys = Object.keys(before);
      ctx.db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${pk} = ?`).run(...keys.map(k => before[k]), row.entity_id);
    }
  }
  if (checkOnly) return;
  const stamp = new Date(ctx.now ?? Date.now()).toISOString();
  ctx.db.prepare('UPDATE action_receipts SET undone_at = ?, planning_pending = 0 WHERE id = ?').run(stamp, id);
  if (['status', 'owner', 'step'].includes(row.kind)) ctx.db.prepare(`INSERT INTO rec_events
    (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, 'undo', ?, ?, ?, ?)`)
    .run(row.entity_id, stamp, id, current.status, before.status ?? current.status, actor);
  return receiptOut(ctx.db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(id));
}

export function receiptScopes(row) {
  return row.kind === 'receipt_group' ? parse(row.after_state, {}).scopes ?? [] : [row.scope];
}

export function groupReceipts(ctx, children, { id, label = 'Reviewed update' }) {
  const rows = children.filter(Boolean).map(child => ctx.db.prepare('SELECT * FROM action_receipts WHERE id=?').get(child.id));
  if (!rows.length) return null;
  const actor = requireActor(ctx), scopes = [...new Set(['write:imports', ...rows.flatMap(receiptScopes)])].sort();
  for (const row of rows) if (row.actor_id !== actor || row.undone_at) throw new ToolError('forbidden', 'This change is not available to you.');
  scopes.forEach(scope => requireScope(ctx, scope));
  return saveReceipt(ctx, { scope: 'write:imports', kind: 'receipt_group', id, label, before: null,
    after: { childIds: rows.map(r => r.id), scopes }, from: null, to: { changes: rows.length } });
}

export function restoreReceiptGroup(ctx, { after, receipt, checkOnly = false }) {
  const actor = requireActor(ctx);
  if (!Array.isArray(after?.childIds) || !after.childIds.length || !Array.isArray(after.scopes)) throw new ToolError('bad_input', 'Invalid receipt group.');
  const rows = after.childIds.map(id => ctx.db.prepare('SELECT * FROM action_receipts WHERE id=?').get(id));
  for (const row of rows) if (!row || row.actor_id !== actor || row.undone_at || row.kind === 'receipt_group') throw new ToolError('conflict', 'A child change is unavailable or already undone.');
  for (const scope of new Set([...after.scopes, ...rows.flatMap(receiptScopes)])) requireScope(ctx, scope);
  ctx.db.exec('SAVEPOINT check_receipt_group');
  try { for (const row of rows.toReversed()) restoreReceipt(ctx, row.id, row.scope); }
  finally { ctx.db.exec('ROLLBACK TO check_receipt_group'); ctx.db.exec('RELEASE check_receipt_group'); }
  if (!checkOnly) {
    for (const row of rows.toReversed()) restoreReceipt(ctx, row.id, row.scope);
    if (receipt) {
      ctx.db.prepare("UPDATE import_batches SET status='undone',undone_at=? WHERE receipt_id=?")
        .run(new Date(ctx.now ?? Date.now()).toISOString(), receipt.id);
      ctx.db.prepare("UPDATE import_proposals SET status='rejected' WHERE (id,version) IN (SELECT proposal_id,proposal_version FROM import_batches WHERE receipt_id=?)").run(receipt.id);
      ctx.db.prepare("UPDATE files SET status='waiting_for_engine' WHERE id IN (SELECT file_id FROM import_batches WHERE receipt_id=?)").run(receipt.id);
    }
  }
}

registerReceiptKind('receipt_group', { restore: restoreReceiptGroup });

export async function undoAction(ctx, id, scope) {
  let receipt, scopes, decisionChanged = false;
  tx(ctx.db, () => {
    const row = ctx.db.prepare('SELECT * FROM action_receipts WHERE id=?').get(id);
    const parent = ctx.db.prepare("SELECT after_state FROM action_receipts WHERE kind='receipt_group' AND undone_at IS NULL").all()
      .find(group => parse(group.after_state, {}).childIds?.includes(id));
    if (parent) throw new ToolError('conflict', 'Use the grouped Undo to restore this change together with its other actions.');
    scopes = row ? receiptScopes(row) : [scope];
    decisionChanged = row?.kind === 'decision_decide' || row?.kind === 'decision_revisit';
    receipt = restoreReceipt(ctx, id, scope);

  });
  if (scopes.includes('write:facts') || scope === 'write:imports' || decisionChanged) await replanAction(ctx, receipt);
  else if (scope === 'write:sources') ctx.queuePlan?.();
  if (scope === 'write:preferences') {
    const { adoptSuggestions } = await import('../goals/write.mjs');
    adoptSuggestions(ctx.db, { now: new Date(ctx.now ?? Date.now()).toISOString(), clock: ctx.config?.clock });
  }
  return { receipt };
}

export async function replanAction(ctx, receipt) {
  if (typeof ctx.queueAfterTools === 'function') {
    if (receipt) {
      receipt.planningPending = true;
      ctx.db.prepare('UPDATE action_receipts SET planning_pending = 1 WHERE id = ?').run(receipt.id);
    }
    ctx.queueAfterTools(() => replanAction({ ...ctx, queueAfterTools: null }, receipt));
    return true;
  }
  let pending = false;
  try {
    if (typeof ctx.replan !== 'function') throw new Error('planning unavailable');
    const result = await ctx.replan();
    if (result?.status && !['ok', 'skipped'].includes(result.status)) pending = true;
  } catch { pending = true; }
  if (pending) ctx.queuePlan?.();
  if (receipt) {
    receipt.planningPending = pending;
    ctx.db.prepare('UPDATE action_receipts SET planning_pending = ? WHERE id = ?').run(pending ? 1 : 0, receipt.id);
  }
  return pending;
}

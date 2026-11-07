import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getSetting, parseJson as parse, tx } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';

export function requireActor(ctx) {
  const actor = ctx.actorId || (getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : null);
  if (!actor) throw new ToolError('forbidden', 'A signed-in person is required to make this change.');
  return actor;
}

export function receiptOut(r) {
  return { id: r.id, scope: r.scope, label: r.label, before: parse(r.before_value, null), after: parse(r.after_value, null),
    actorId: r.actor_id, ts: r.created_at, undone: !!r.undone_at, planningPending: !!r.planning_pending };
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
  const rows = receiptsFor(db, key);
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

const TABLES = { preference: ['preferences', 'id'], fact: ['facts', 'key'], goal: ['goals', 'id'], step: ['recs', 'id'], status: ['recs', 'id'], owner: ['recs', 'id'] };

export async function undoAction(ctx, id, scope) {
  const actor = requireActor(ctx);
  if (ctx.scopes && !ctx.scopes.includes(scope)) throw new ToolError('forbidden', `Permission denied: Undo needs ${scope}.`);
  let receipt;
  tx(ctx.db, () => {
    const row = ctx.db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(id);
    if (!row || row.actor_id !== actor || row.scope !== scope) throw new ToolError('forbidden', 'This change is not available to you.');
    if (row.undone_at) throw new ToolError('bad_input', 'This change was already undone.');
    const before = parse(row.before_state, null), after = parse(row.after_state, null);
    const [table, pk] = TABLES[row.kind];
    const current = ctx.db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(row.entity_id);
    const fields = Object.keys(after || before || {});
    const value = current ? Object.fromEntries(fields.map(k => [k, current[k]])) : null;
    if (!isDeepStrictEqual(value, after)) throw new ToolError('conflict', 'This item changed since that action. Ask for a new change instead.');
    if (before === null) ctx.db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(row.entity_id);
    else if (!current) {
      const keys = Object.keys(before);
      ctx.db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => before[k]));
    } else {
      const keys = Object.keys(before);
      ctx.db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${pk} = ?`).run(...keys.map(k => before[k]), row.entity_id);
    }
    const stamp = new Date(ctx.now ?? Date.now()).toISOString();
    ctx.db.prepare('UPDATE action_receipts SET undone_at = ?, planning_pending = 0 WHERE id = ?').run(stamp, id);
    if (['status', 'owner', 'step'].includes(row.kind)) ctx.db.prepare(`INSERT INTO rec_events
      (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, 'undo', ?, ?, ?, ?)`).run(row.entity_id, stamp, id,
      current.status, before.status ?? current.status, actor);
    receipt = receiptOut(ctx.db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(id));
  });
  if (scope === 'write:facts') await replanAction(ctx, receipt);
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

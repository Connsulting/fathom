import { ACTION_STATUS } from '../shared/rules.mjs';
// Rec writes shared by the app's rec action path and the MCP tools.
import { actionTx as tx, parseJson as parse } from './db.mjs';
import { OWNERS } from '../shared/rec-links.mjs';
import { ToolError } from '../tools/errors.mjs';
import { isVerifiable } from '../shared/rec-steps.mjs';

export const SETTABLE_REC_STATUSES = Object.freeze(['doing', 'done', 'dismissed', 'snoozed', 'proposed']);

export async function visibleRecRow(db, id) {
  const row = await db.prepare('SELECT * FROM recs WHERE id = ?').get(id);
  if (!row || row.status === 'hidden') throw new ToolError('not_found', 'no such recommendation');
  return row;
}

export async function detachRecThreads(db, id, { now, onWrite } = {}) {
  return await tx(db, async (db) => {
    await visibleRecRow(db, id);
    const before = await db.prepare('SELECT key, rec_id, rec_detached_at FROM conversations WHERE rec_id = ? AND rec_detached_at IS NULL ORDER BY key').all(id);
    await db.prepare('UPDATE conversations SET rec_detached_at = ? WHERE rec_id = ? AND rec_detached_at IS NULL').run(now, id);
    const after = before.map(row => ({ ...row, rec_detached_at: now }));
    await onWrite?.(before, after);
    return before.length;
  });
}

export async function writeRec(db, id, kind, value, { now, actor = 'ui', onWrite, eventAction } = {}) {
  return await tx(db, async (db) => {
    const row = await visibleRecRow(db, id);
    const def = parse(row.def, {});
    if (kind === 'step') {
      if (def.question?.primary) throw new ToolError('conflict', 'save the answers to update this recommendation');
      const tasks = Array.isArray(def.tasks) ? def.tasks : [];
      if (!Number.isInteger(value.index) || value.index < 0 || value.index >= tasks.length || typeof value.checked !== 'boolean') {
        throw new ToolError('bad_input', `task index must be 0 to ${tasks.length - 1} and checked must be true or false`);
      }
      if (isVerifiable(tasks[value.index]) && !tasks[value.index].payment) throw new ToolError('conflict', 'this step completes itself once the product sees it done');
      const done = parse(row.tasks_done, []);
      const next = tasks.map((_, k) => !!done[k]);
      next[value.index] = value.checked;
      await db.prepare('UPDATE recs SET tasks_done = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), now, id);
    } else if (kind === 'owner') {
      if (!OWNERS.includes(value)) throw new ToolError('bad_input', 'unknown recommendation owner');
      await setRecOwner(db, row, value, { ts: now, actor, action: eventAction || 'set_owner' });
    } else if (kind === 'status') {
      if (!SETTABLE_REC_STATUSES.includes(value.status)) throw new ToolError('bad_input', 'unknown recommendation status');
      if (def.question?.primary && value.status === 'done') throw new ToolError('bad_input', 'Save the answers before completing this recommendation.');
      if (value.wake != null && (typeof value.wake !== 'string' || value.wake.length > 200)) throw new ToolError('bad_input', 'snooze label is too long or not text');
      const wake = value.status === 'snoozed' ? value.wake || 'Next month' : def.wake ?? null;
      await db.prepare('UPDATE recs SET status = ?, wake = ?, updated_at = ? WHERE id = ?').run(value.status, wake, now, id);
    } else throw new ToolError('bad_input', 'unknown recommendation change');
    const after = await visibleRecRow(db, id);
    // An "I did this" step records its time and actor by the step text, so a reordered list keeps it.
    const step = kind === 'step' ? def.tasks[value.index] : null;
    if (kind !== 'owner') await db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, now, step ? (value.checked ? 'step_did' : 'step_undo') : eventAction || 'set_status', step ? step.t : value.wake ?? null, row.status, after.status, actor);
    await onWrite?.(row, after);
    return after;
  });
}

// Sets who acts on a rec and marks it the owner's choice (owner_override = 1), so the planner never
// changes it again, and records the change in rec history without a status change. Callers hold
// the transaction and validate the owner. action/actor: 'owner'/'ui' from the app, 'set_owner'/'tool'
// over MCP.
export async function setRecOwner(db, row, owner, { ts, action, actor }) {
  await db.prepare('UPDATE recs SET owner = ?, owner_override = 1, updated_at = ? WHERE id = ?').run(owner, ts, row.id);
  await db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, ts, action, owner, row.status, row.status, actor);
}

export async function applyStatusAction(db, row, action, arg = null, { now = new Date().toISOString(), actor = 'ui' } = {}) {
  const status = ACTION_STATUS[action];
  if (!status) throw new ToolError('bad_input', `unknown action ${action}`);
  const wake = action === 'snooze' ? arg : (parse(row.def, {}).wake ?? null);
  await db.prepare('UPDATE recs SET status = ?, wake = ?, updated_at = ? WHERE id = ?').run(status, wake, now, row.id);
  await db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, now, action, arg == null ? null : String(arg), row.status, status, actor);
}

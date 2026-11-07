// Rec writes shared by the app's rec action path and the MCP tools.
import { tx, parseJson as parse } from './db.mjs';
import { OWNERS } from '../shared/rec-links.mjs';
import { ToolError } from '../tools/errors.mjs';

export function visibleRecRow(db, id) {
  const row = db.prepare('SELECT * FROM recs WHERE id = ?').get(id);
  if (!row || row.status === 'hidden') throw new ToolError('not_found', 'no such recommendation');
  return row;
}

export function writeRec(db, id, kind, value, { now, actor = 'ui', onWrite } = {}) {
  return tx(db, () => {
    const row = visibleRecRow(db, id);
    const def = parse(row.def, {});
    if (kind === 'step') {
      if (def.question?.primary) throw new ToolError('conflict', 'save the answers to update this recommendation');
      const tasks = Array.isArray(def.tasks) ? def.tasks : [];
      if (!Number.isInteger(value.index) || value.index < 0 || value.index >= tasks.length || typeof value.checked !== 'boolean') {
        throw new ToolError('bad_input', `task index must be 0 to ${tasks.length - 1} and checked must be true or false`);
      }
      const done = parse(row.tasks_done, []);
      const next = tasks.map((_, k) => !!done[k]);
      next[value.index] = value.checked;
      db.prepare('UPDATE recs SET tasks_done = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), now, id);
    } else if (kind === 'owner') {
      if (!OWNERS.includes(value)) throw new ToolError('bad_input', 'unknown recommendation owner');
      setRecOwner(db, row, value, { ts: now, actor, action: 'set_owner' });
    } else if (kind === 'status') {
      if (!['doing', 'done', 'dismissed', 'snoozed', 'proposed'].includes(value.status)) throw new ToolError('bad_input', 'unknown recommendation status');
      if (def.question?.primary && value.status === 'done') throw new ToolError('bad_input', 'Save the answers before completing this recommendation.');
      if (value.wake != null && (typeof value.wake !== 'string' || value.wake.length > 200)) throw new ToolError('bad_input', 'snooze label is too long or not text');
      const wake = value.status === 'snoozed' ? value.wake || 'Next month' : def.wake ?? null;
      db.prepare('UPDATE recs SET status = ?, wake = ?, updated_at = ? WHERE id = ?').run(value.status, wake, now, id);
    } else throw new ToolError('bad_input', 'unknown recommendation change');
    const after = visibleRecRow(db, id);
    if (kind !== 'owner') db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, now, kind === 'step' ? 'task' : 'set_status', kind === 'step' ? String(value.index) : value.wake ?? null, row.status, after.status, actor);
    onWrite?.(row, after);
    return after;
  });
}

// Sets who acts on a rec and marks it the owner's choice (owner_override = 1), so the planner never
// changes it again, and records the change in rec history without a status change. Callers hold
// the transaction and validate the owner. action/actor: 'owner'/'ui' from the app, 'set_owner'/'tool'
// over MCP.
export function setRecOwner(db, row, owner, { ts, action, actor }) {
  db.prepare('UPDATE recs SET owner = ?, owner_override = 1, updated_at = ? WHERE id = ?').run(owner, ts, row.id);
  db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, ts, action, owner, row.status, row.status, actor);
}

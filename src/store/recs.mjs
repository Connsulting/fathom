// Rec writes shared by the app's rec action path and the MCP tools.

// Sets who acts on a rec and marks it the owner's choice (owner_override = 1), so the planner never
// changes it again, and records the change in rec history without a status change. Callers hold
// the transaction and validate the owner. action/actor: 'owner'/'ui' from the app, 'set_owner'/'tool'
// over MCP.
export function setRecOwner(db, row, owner, { ts, action, actor }) {
  db.prepare('UPDATE recs SET owner = ?, owner_override = 1, updated_at = ? WHERE id = ?').run(owner, ts, row.id);
  db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, ts, action, owner, row.status, row.status, actor);
}

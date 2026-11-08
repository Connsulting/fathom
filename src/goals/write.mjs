import { randomBytes } from 'node:crypto';
import { tx, parseJson as parse } from '../store/db.mjs';
import { loadFigures } from '../scenario/build.mjs';
import { validateGoal, kindOf, KIND_FIELDS, ALL_KIND_FIELDS } from '../shared/goals.mjs';
import { captureGoalPath, goalPathChanged } from '../pace/build.mjs';
import { ToolError } from '../tools/errors.mjs';

function valid(db, fields, partial, previous = null) {
  const result = validateGoal(fields, { partial, previous, accounts: db.prepare('SELECT id, kind FROM accounts').all(), figures: loadFigures(db) });
  if (!result.ok) throw new ToolError('bad_input', result.error);
  return result.value;
}

// Kinds whose pace runs on a captured path (balance on its target, range on its low end).
const PATH_KINDS = ['balance', 'range'];

// The def to store for a kind: no status (a column, never def text) and no field of another kind.
function defFor(base, kind) {
  const def = { ...base, kind };
  delete def.status;
  for (const k of ALL_KIND_FIELDS) if (!KIND_FIELDS[kind].includes(k)) delete def[k];
  return def;
}

// The checks createGoal (id null) or updateGoal (id set) run before writing, without writing.
export function checkGoal(db, fields, id = null) {
  if (id === null) return valid(db, fields, false);
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!row) throw new ToolError('not_found', 'no such goal');
  if (row.origin !== 'owner') throw new ToolError('conflict', 'this goal came with the demo and cannot be edited; archive it or add your own');
  return valid(db, fields, true, parse(row.def, {}));
}

export function createGoal(db, fields, { now, onWrite } = {}) {
  return tx(db, () => {
    const value = valid(db, fields, false);
    if (db.prepare('SELECT count(*) n FROM goals').get().n >= 200) throw new ToolError('conflict', 'at most 200 goals');
    const id = 'g' + randomBytes(6).toString('hex');
    const { status, ...rest } = value;
    const def = defFor({ id, ...rest, note: rest.note || '' }, kindOf(rest));
    def.pace = PATH_KINDS.includes(def.kind) ? captureGoalPath(db, def, now.slice(0, 10)) : null;
    const sort = db.prepare('SELECT coalesce(max(sort), -1) + 1 s FROM goals').get().s;
    db.prepare("INSERT INTO goals (id, def, sort, origin, created_at, updated_at, archived_at, done_at) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?)")
      .run(id, JSON.stringify(def), sort, now, now, status === 'archived' ? now : null, status === 'done' ? now : null);
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    onWrite?.(null, row);
    return row;
  });
}

export function updateGoal(db, id, fields, { now, onWrite } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!row) throw new ToolError('not_found', 'no such goal');
    if (row.origin !== 'owner') throw new ToolError('conflict', 'this goal came with the demo and cannot be edited; archive it or add your own');
    const previous = parse(row.def, {});
    const value = valid(db, fields, true, previous);
    const { status, ...rest } = value;
    const def = defFor({ ...previous, ...rest, id }, kindOf({ ...previous, ...rest }));
    if (!PATH_KINDS.includes(def.kind)) def.pace = null;
    else if (!previous.pace || goalPathChanged(previous, def)) def.pace = captureGoalPath(db, def, now.slice(0, 10));
    // status open clears done and archived; done keeps the first done time; archived keeps done_at.
    let archivedAt = row.archived_at ?? null, doneAt = row.done_at ?? null;
    if (status === 'open') { archivedAt = null; doneAt = null; }
    else if (status === 'done') { archivedAt = null; doneAt = row.done_at || now; }
    else if (status === 'archived') archivedAt = row.archived_at || now;
    db.prepare('UPDATE goals SET def = ?, updated_at = ?, archived_at = ?, done_at = ? WHERE id = ?')
      .run(JSON.stringify(def), now, archivedAt, doneAt, id);
    const after = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    onWrite?.(row, after);
    return after;
  });
}

function goalRow(db, id) {
  const row = typeof id === 'string' ? db.prepare('SELECT * FROM goals WHERE id = ?').get(id) : null;
  if (!row) throw new ToolError('not_found', 'no such goal');
  return row;
}

export function archiveGoal(db, id, { archived = true, now, onWrite } = {}) {
  if (typeof archived !== 'boolean') throw new ToolError('bad_input', 'archived must be true or false');
  return tx(db, () => {
    const before = goalRow(db, id);
    db.prepare('UPDATE goals SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? before.archived_at || now : null, now, id);
    const after = goalRow(db, id);
    onWrite?.(before, after);
    return after;
  });
}

export function deleteGoal(db, id, { ownerOnly = false, onWrite } = {}) {
  return tx(db, () => {
    const before = goalRow(db, id);
    if (ownerOnly && before.origin !== 'owner') throw new ToolError('conflict', 'only your own goals can be deleted with this tool');
    db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    onWrite?.(before, null);
    return before;
  });
}

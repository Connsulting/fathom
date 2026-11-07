import { randomBytes } from 'node:crypto';
import { tx, parseJson as parse } from '../store/db.mjs';
import { loadFigures } from '../scenario/build.mjs';
import { validateGoal } from '../shared/goals.mjs';
import { captureGoalPath, goalPathChanged } from '../pace/build.mjs';
import { ToolError } from '../tools/errors.mjs';

function valid(db, fields, partial) {
  const result = validateGoal(fields, { partial, accounts: db.prepare('SELECT id, kind FROM accounts').all(), figures: loadFigures(db) });
  if (!result.ok) throw new ToolError('bad_input', result.error);
  return result.value;
}

export function createGoal(db, fields, { now, onWrite } = {}) {
  return tx(db, () => {
    const value = valid(db, fields, false);
    if (db.prepare('SELECT count(*) n FROM goals').get().n >= 200) throw new ToolError('conflict', 'at most 200 goals');
    const id = 'g' + randomBytes(6).toString('hex');
    const def = { id, title: value.title, note: value.note || '', horizon: value.horizon, target: value.target,
      targetDate: value.targetDate, track: value.track };
    def.pace = captureGoalPath(db, def, now.slice(0, 10));
    const sort = db.prepare('SELECT coalesce(max(sort), -1) + 1 s FROM goals').get().s;
    db.prepare("INSERT INTO goals (id, def, sort, origin, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)")
      .run(id, JSON.stringify(def), sort, now, now);
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
    const value = valid(db, fields, true);
    const previous = parse(row.def, {});
    const def = { ...previous, ...value, id };
    if (!previous.pace || goalPathChanged(previous, def)) def.pace = captureGoalPath(db, def, now.slice(0, 10));
    db.prepare('UPDATE goals SET def = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(def), now, id);
    const after = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    onWrite?.(row, after);
    return after;
  });
}

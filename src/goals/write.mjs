import { randomBytes } from 'node:crypto';
import { tx, parseJson as parse, getSetting, setSetting } from '../store/db.mjs';
import { loadFigures, loadGoals } from '../scenario/build.mjs';
import { buildSuggestions, SUGGEST_SETTING } from '../suggest/build.mjs';
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

export function createGoal(db, fields, { now, clock, onWrite } = {}) {
  return tx(db, () => {
    const value = valid(db, fields, false);
    if (db.prepare('SELECT count(*) n FROM goals').get().n >= 200) throw new ToolError('conflict', 'at most 200 goals');
    const id = 'g' + randomBytes(6).toString('hex');
    const { status, ...rest } = value;
    const def = defFor({ id, ...rest, note: rest.note || '' }, kindOf(rest));
    def.pace = PATH_KINDS.includes(def.kind) ? captureGoalPath(db, def, now.slice(0, 10)) : null;
    const sort = db.prepare('SELECT coalesce(max(sort), -1) + 1 s FROM goals').get().s;
    db.prepare("INSERT INTO goals (id, def, sort, origin, created_at, updated_at, archived_at, done_at) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?)")
      .run(id, JSON.stringify(def), sort, now, now, status === 'archived' || status === 'done' ? now : null, status === 'done' ? now : null);
    // Fathom sets the calculator's target before the receipt sees the row, so Undo matches it.
    adoptIn(db, { now, clock, only: id });
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    onWrite?.(null, row);
    return row;
  });
}

export function updateGoal(db, id, fields, { now, clock, onWrite } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!row) throw new ToolError('not_found', 'no such goal');
    if (row.origin !== 'owner') throw new ToolError('conflict', 'this goal came with the demo and cannot be edited; archive it or add your own');
    const previous = parse(row.def, {});
    const value = valid(db, fields, true, previous);
    const { status, ...rest } = value;
    const def = defFor({ ...previous, ...rest, id }, kindOf({ ...previous, ...rest }));
    // The owner changing a target Fathom set takes it over (and a goal that is no longer a balance
    // goal has no suggestion); a new date or tracking is kept on later passes, with the target still
    // Fathom's. Clearing a target declines the suggestion.
    if (def.adopted) {
      if (def.kind !== 'balance' || (def.target ?? null) !== (previous.target ?? null)) delete def.adopted;
      else {
        const kept = new Set(Array.isArray(def.adopted.kept) ? def.adopted.kept : []);
        if ((def.targetDate ?? null) !== (previous.targetDate ?? null)) kept.add('targetDate');
        if (trackKey(def.track) !== trackKey(previous.track)) kept.add('track');
        if (kept.size) def.adopted = { ...def.adopted, kept: [...kept].sort() };
      }
    }
    if (Number.isFinite(previous.target) && Object.hasOwn(fields, 'target') && fields.target == null) declineSuggestion(db, id);
    if (!PATH_KINDS.includes(def.kind)) def.pace = null;
    else if (!previous.pace || goalPathChanged(previous, def)) def.pace = captureGoalPath(db, def, now.slice(0, 10));
    // status open clears done and archived; done keeps the first done time; archived keeps done_at.
    let archivedAt = row.archived_at ?? null, doneAt = row.done_at ?? null;
    if (status === 'open') { archivedAt = null; doneAt = null; }
    // A done goal archives itself.
    else if (status === 'done') { archivedAt = row.archived_at || now; doneAt = row.done_at || now; }
    else if (status === 'archived') archivedAt = row.archived_at || now;
    db.prepare('UPDATE goals SET def = ?, updated_at = ?, archived_at = ?, done_at = ? WHERE id = ?')
      .run(JSON.stringify(def), now, archivedAt, doneAt, id);
    adoptIn(db, { now, clock, only: id });
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

export function archiveGoal(db, id, { archived = true, now, clock, onWrite } = {}) {
  if (typeof archived !== 'boolean') throw new ToolError('bad_input', 'archived must be true or false');
  return tx(db, () => {
    const before = goalRow(db, id);
    if (archived) db.prepare('UPDATE goals SET archived_at = ?, updated_at = ? WHERE id = ?').run(before.archived_at || now, now, id);
    else {
      db.prepare('UPDATE goals SET archived_at = NULL, done_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
      adoptIn(db, { now, clock, only: id });
    }
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

// ---------------------------------------------------------------- adopted targets
// Fathom sets a suggested target by itself (src/suggest/build.mjs). The goal def records it as
// adopted = {at, previous: {target, targetDate, track}, figure, kept?}: previous is what the owner
// had before the first adoption (what Undo restores), figure the calc:targets figure the target came
// from, kept the fields the owner changed since (targetDate, track), which later passes and Undo
// leave as the owner set them. A target Fathom set follows the calculator on later passes; one the owner typed never
// changes. Undo restores previous and declines the suggestion: settings 'goals.suggestions'
// {<goalId>: {declined: true}}, and a declined suggestion is never adopted again.

const trackKey = t => JSON.stringify(t && Array.isArray(t.accounts) ? { accounts: [...t.accounts].sort() } : t && t.figure ? { figure: t.figure } : null);

function suggestSettings(db) {
  const stored = getSetting(db, SUGGEST_SETTING, null);
  const ids = new Set(db.prepare('SELECT id FROM goals').all().map(r => r.id));
  return Object.fromEntries(Object.entries(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}).filter(([id]) => ids.has(id)));
}

// Marks a goal's suggestion declined. Runs inside the caller's transaction.
function declineSuggestion(db, id) {
  const next = suggestSettings(db);
  next[id] = { declined: true };
  setSetting(db, SUGGEST_SETTING, next);
}

function writeDef(db, row, previous, def, now) {
  if (PATH_KINDS.includes(def.kind) && (!previous.pace || goalPathChanged(previous, def))) def.pace = captureGoalPath(db, def, now.slice(0, 10));
  db.prepare('UPDATE goals SET def = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(def), now, row.id);
}

// The planner pass: adopt every live suggestion that is not declined, and move a target Fathom set
// to the calculator's current value. Returns the ids of the goals it changed.
export function adoptSuggestions(db, { now, clock } = {}) {
  return tx(db, () => adoptIn(db, { now, clock }));
}

// The pass itself, inside the caller's transaction; `only` limits it to one goal.
function adoptIn(db, { now, clock, only = null }) {
  const settings = suggestSettings(db);
  const goals = loadGoals(db).filter(g => only === null || g.id === only).map(g => (g.adopted ? { ...g, target: null } : g));
  const { suggestions, figures } = buildSuggestions(db, { clock, goals });
  const changed = [];
  {
    for (const rec of suggestions) {
      if (rec.state !== 'suggested' || !rec.accept || settings[rec.goalId]?.declined) continue;
      const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(rec.goalId);
      const previous = parse(row.def, {});
      const a = rec.accept;
      const kept = previous.adopted && Array.isArray(previous.adopted.kept) ? previous.adopted.kept : [];
      const plan = {
        target: a.target,
        targetDate: kept.includes('targetDate') ? previous.targetDate ?? null : a.targetDate ?? null,
        track: kept.includes('track') ? previous.track ?? null : a.track ?? null,
      };
      if (previous.adopted && (previous.target ?? null) === plan.target && (previous.targetDate ?? null) === plan.targetDate && trackKey(previous.track) === trackKey(plan.track)) continue;
      const before = previous.adopted ? previous.adopted.previous
        : { target: previous.target ?? null, targetDate: previous.targetDate ?? null, track: previous.track ?? null };
      const def = { ...previous, ...plan, adopted: { at: now, previous: before, figure: figures[`suggest.${rec.goalId}.target`] ?? null, ...(kept.length ? { kept } : {}) } };
      if (def.track === null) delete def.track;
      if (def.targetDate === null) delete def.targetDate;
      writeDef(db, row, previous, def, now);
      changed.push(rec.goalId);
    }
  }
  return changed;
}

// Undo: the goal's values from before Fathom set its target, and the suggestion declined.
export function undoAdoption(db, id, { now, onWrite } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!row) throw new ToolError('not_found', 'no such goal');
    const previous = parse(row.def, {});
    if (!previous.adopted) throw new ToolError('conflict', 'Fathom did not set this target, so there is nothing to undo');
    const setting = () => db.prepare('SELECT * FROM settings WHERE key = ?').get(SUGGEST_SETTING) ?? null;
    const before = { goal: row, setting: setting() };
    const p = previous.adopted.previous || {};
    // A date or tracking the owner changed after adoption stays theirs.
    const kept = Array.isArray(previous.adopted.kept) ? previous.adopted.kept : [];
    const def = { ...previous, target: p.target ?? null };
    for (const k of ['targetDate', 'track']) def[k] = kept.includes(k) ? previous[k] ?? null : p[k] ?? null;
    delete def.adopted;
    for (const k of ['target', 'targetDate', 'track']) if (def[k] === null) delete def[k];
    writeDef(db, row, previous, def, now);
    declineSuggestion(db, id);
    const after = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    onWrite?.(before, { goal: after, setting: setting() });
    return after;
  });
}

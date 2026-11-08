// Generic per-answer change log (plan D1). captureChanges records every row change a function
// makes, through TEMP triggers on every ordinary main table except the bookkeeping ones, as
// {table, op, rowid, before, after} with row images as json_object(...) text over the table's
// columns. revertChanges walks a log backwards, first requiring each touched row to still equal
// its recorded after image (or to be still absent after a delete), and restores it. Updates on a
// FIELD_LEVEL table are checked and restored column by column: only the columns the update changed
// must still hold their after values, and only those are restored, so later writes to other
// columns of the row stay. Any mismatch throws ConfirmError('final', 'changed_since'); the caller's
// transaction then rolls back the partial restore. Both run inside the caller's open transaction.

import { ConfirmError } from './confirm.mjs';

// Tables never logged: the logs themselves and bookkeeping a revert must not touch.
export const UNTRACKED = Object.freeze(['confirm_undo', 'confirm_guesses', 'ingest_epoch', 'schema_migrations', 'spend_ledger']);

// Tables whose updates are reverted column by column (accounts: source_id, mirror, fig_key, owner
// and kind are written by different imports and answers).
export const FIELD_LEVEL = Object.freeze(['accounts']);

const ident = (name) => `"${String(name).replaceAll('"', '""')}"`;
const literal = (text) => `'${String(text).replaceAll("'", "''")}'`;

const tablesOf = async (db) => (await db.tables()).filter((name) => !UNTRACKED.includes(name));
const columnsOf = async (db, table) => (await db.columns(table)).map((c) => c.name);
// The row image: the same expression as the capture triggers', so equal rows give equal text.
const image = (alias, columns) => `json_object(${columns.map((c) => `${literal(c)}, ${alias}.${ident(c)}`).join(', ')})`;

// Run fn(handle) on transaction handle db and return {result, changes}; the capture is removed
// before returning, also when fn throws.
export async function captureChanges(db, fn) {
  return await db.capture(fn);
}

const changedSince = () => new ConfirmError('final', 'changed_since');

// Undo a captured log. Throws ConfirmError('final', 'changed_since') when any touched row no
// longer matches what the log left behind, or its table or columns changed since.
export async function revertChanges(db, changes) {
  const known = new Set(await tablesOf(db));
  const shape = new Map();
  const shapeOf = async (table) => {
    if (!shape.has(table)) {
      const cols = await columnsOf(db, table);
      shape.set(table, {
        cols,
        current: db.prepare(`SELECT ${image('t', cols)} AS img FROM main.${ident(table)} AS t WHERE t.rowid = ?`),
      });
    }
    return shape.get(table);
  };
  const sameColumns = (cols, img) => {
    const keys = Object.keys(JSON.parse(img));
    return keys.length === cols.length && keys.every((k, i) => k === cols[i]);
  };
  const values = (cols) => cols.map((c) => `json_extract(?, ${literal(`$."${c}"`)})`).join(', ');

  for (const c of [...changes].reverse()) {
    if (!known.has(c.table) || c.movedFrom !== undefined) throw changedSince();
    const { cols, current } = await shapeOf(c.table);
    const now = current.get(c.rowid)?.img;
    if (c.op === 'delete') {
      if (now !== undefined || !sameColumns(cols, c.before)) throw changedSince();
      await db.prepare(`INSERT INTO main.${ident(c.table)} (rowid, ${cols.map(ident).join(', ')}) VALUES (?, ${values(cols)})`)
        .run(c.rowid, ...cols.map(() => c.before));
      continue;
    }
    if (c.op === 'update' && FIELD_LEVEL.includes(c.table)) {
      await revertColumns(db, c, cols, now);
      continue;
    }
    if (now !== c.after) throw changedSince();
    if (c.op === 'insert') {
      await db.prepare(`DELETE FROM main.${ident(c.table)} WHERE rowid = ?`).run(c.rowid);
    } else {
      await db.prepare(`UPDATE main.${ident(c.table)} SET ${cols.map((col) => `${ident(col)} = json_extract(?, ${literal(`$."${col}"`)})`).join(', ')} WHERE rowid = ?`)
        .run(...cols.map(() => c.before), c.rowid);
    }
  }
}

// A FIELD_LEVEL update: the row must still exist with its key, and every column the update changed
// must hold its after value; those columns get their before values back.
async function revertColumns(db, c, cols, now) {
  if (now === undefined) throw changedSince();
  const before = JSON.parse(c.before);
  const after = JSON.parse(c.after);
  const current = JSON.parse(now);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changed = Object.keys(after).filter((k) => !same(before[k], after[k]));
  if ('id' in after && !same(current.id, after.id)) throw changedSince();
  if (changed.some((k) => !cols.includes(k) || !(k in before) || !same(current[k], after[k]))) throw changedSince();
  if (!changed.length) return;
  await db.prepare(`UPDATE main.${ident(c.table)} SET ${changed.map((col) => `${ident(col)} = json_extract(?, ${literal(`$."${col}"`)})`).join(', ')} WHERE rowid = ?`)
    .run(...changed.map(() => c.before), c.rowid);
}

// Whether a log touched a table.
export const touches = (changes, table) => changes.some((c) => c.table === table);

// Generic per-answer change log (plan D1). captureChanges records every row change a function
// makes, through TEMP triggers on every ordinary main table except the bookkeeping ones, as
// {table, op, rowid, before, after} with row images as json_object(...) text over the table's
// columns. revertChanges walks a log backwards, first requiring each touched row to still equal
// its recorded after image (or to be still absent after a delete), and restores it. Any mismatch
// throws ConfirmError('final', 'changed_since'); the caller's transaction then rolls back the
// partial restore. Both run inside the caller's open transaction.

import { ConfirmError } from './confirm.mjs';

// Tables never logged: the logs themselves and bookkeeping a revert must not touch.
export const UNTRACKED = Object.freeze(['confirm_undo', 'confirm_guesses', 'ingest_epoch', 'schema_migrations', 'spend_ledger']);

const LOG = 'fathom_change_log';
const ident = (name) => `"${String(name).replaceAll('"', '""')}"`;
const literal = (text) => `'${String(text).replaceAll("'", "''")}'`;

const tablesOf = (db) => db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
  .all().map((r) => r.name).filter((name) => !UNTRACKED.includes(name));
const columnsOf = (db, table) => db.prepare(`PRAGMA main.table_info(${ident(table)})`).all().map((c) => c.name);
// The row image: the same expression in the triggers and in revert's checks, so equal rows give
// equal text.
const image = (alias, columns) => `json_object(${columns.map((c) => `${literal(c)}, ${alias}.${ident(c)}`).join(', ')})`;
const trigger = (i, op) => ident(`${LOG}_${i}_${op}`);

function dropLog(db, count) {
  for (let i = 0; i < count; i++) for (const op of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER IF EXISTS temp.${trigger(i, op)}`);
  db.exec(`DROP TABLE IF EXISTS temp.${LOG}`);
}

// Run fn() and return {result, changes}. The triggers and the temp log are dropped before
// returning, also when fn throws (the caller's rollback would undo them too).
export function captureChanges(db, fn) {
  const tables = tablesOf(db);
  dropLog(db, tables.length);
  db.exec(`CREATE TEMP TABLE ${LOG} (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, op TEXT NOT NULL, rowid_was INTEGER, rowid_now INTEGER, before TEXT, after TEXT)`);
  try {
    tables.forEach((table, i) => {
      const cols = columnsOf(db, table);
      const into = `INSERT INTO temp.${LOG} (tbl, op, rowid_was, rowid_now, before, after) VALUES (${literal(table)}`;
      db.exec(`CREATE TEMP TRIGGER ${trigger(i, 'insert')} AFTER INSERT ON main.${ident(table)} BEGIN
        ${into}, 'insert', NULL, NEW.rowid, NULL, ${image('NEW', cols)}); END`);
      db.exec(`CREATE TEMP TRIGGER ${trigger(i, 'update')} AFTER UPDATE ON main.${ident(table)} BEGIN
        ${into}, 'update', OLD.rowid, NEW.rowid, ${image('OLD', cols)}, ${image('NEW', cols)}); END`);
      db.exec(`CREATE TEMP TRIGGER ${trigger(i, 'delete')} AFTER DELETE ON main.${ident(table)} BEGIN
        ${into}, 'delete', OLD.rowid, NULL, ${image('OLD', cols)}, NULL); END`);
    });
    const result = fn();
    const changes = db.prepare(`SELECT tbl, op, rowid_was, rowid_now, before, after FROM temp.${LOG} ORDER BY seq`).all().map((r) => ({
      table: r.tbl,
      op: r.op,
      rowid: r.op === 'delete' ? r.rowid_was : r.rowid_now,
      // An update that moved a row to another rowid cannot be checked by rowid; revert refuses it.
      ...(r.op === 'update' && r.rowid_was !== r.rowid_now ? { movedFrom: r.rowid_was } : {}),
      before: r.before,
      after: r.after,
    }));
    return { result, changes };
  } finally {
    dropLog(db, tables.length);
  }
}

const changedSince = () => new ConfirmError('final', 'changed_since');

// Undo a captured log. Throws ConfirmError('final', 'changed_since') when any touched row no
// longer matches what the log left behind, or its table or columns changed since.
export function revertChanges(db, changes) {
  const known = new Set(tablesOf(db));
  const shape = new Map();
  const shapeOf = (table) => {
    if (!shape.has(table)) {
      const cols = columnsOf(db, table);
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
    const { cols, current } = shapeOf(c.table);
    const now = current.get(c.rowid)?.img;
    if (c.op === 'delete') {
      if (now !== undefined || !sameColumns(cols, c.before)) throw changedSince();
      db.prepare(`INSERT INTO main.${ident(c.table)} (rowid, ${cols.map(ident).join(', ')}) VALUES (?, ${values(cols)})`)
        .run(c.rowid, ...cols.map(() => c.before));
      continue;
    }
    if (now !== c.after) throw changedSince();
    if (c.op === 'insert') {
      db.prepare(`DELETE FROM main.${ident(c.table)} WHERE rowid = ?`).run(c.rowid);
    } else {
      db.prepare(`UPDATE main.${ident(c.table)} SET ${cols.map((col) => `${ident(col)} = json_extract(?, ${literal(`$."${col}"`)})`).join(', ')} WHERE rowid = ?`)
        .run(...cols.map(() => c.before), c.rowid);
    }
  }
}

// Whether a log touched a table.
export const touches = (changes, table) => changes.some((c) => c.table === table);

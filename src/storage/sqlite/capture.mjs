// Change capture for Confirm undo: TEMP triggers on every ordinary main table except the
// bookkeeping ones log {table, op, rowid, before, after}, with row images as json_object(...) text
// over the table's declared columns. Installed and removed inside the caller's transaction.

const UNTRACKED = Object.freeze(['confirm_undo', 'confirm_guesses', 'ingest_epoch', 'schema_migrations', 'spend_ledger']);
const ident = name => `"${String(name).replaceAll('"', '""')}"`;
const literal = text => `'${String(text).replaceAll("'", "''")}'`;
export const image = (alias, columns) => `json_object(${columns.map(c => `${literal(c)}, ${alias}.${ident(c)}`).join(', ')})`;
const trigger = (log, i, op) => ident(`${log}_${i}_${op}`);
let sequence = 0;

const tablesOf = db => db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
  .all().map(r => r.name).filter(name => !UNTRACKED.includes(name));
const columnsOf = (db, table) => db.prepare(`PRAGMA main.table_info(${ident(table)})`).all().map(c => c.name);

export function captureDrop(db, { log, count }) {
  for (let i = 0; i < count; i++) for (const op of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER IF EXISTS temp.${trigger(log, i, op)}`);
  db.exec(`DROP TABLE IF EXISTS temp.${log}`);
}

export function captureBegin(db) {
  const tables = tablesOf(db);
  const log = `fathom_change_log_${++sequence}`;
  const active = { log, count: tables.length };
  db.exec(`CREATE TEMP TABLE ${log} (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, op TEXT NOT NULL, rowid_was INTEGER, rowid_now INTEGER, before TEXT, after TEXT)`);
  try {
    tables.forEach((table, i) => {
      const cols = columnsOf(db, table);
      const into = `INSERT INTO temp.${log} (tbl, op, rowid_was, rowid_now, before, after) VALUES (${literal(table)}`;
      db.exec(`CREATE TEMP TRIGGER ${trigger(log, i, 'insert')} AFTER INSERT ON main.${ident(table)} BEGIN
        ${into}, 'insert', NULL, NEW.rowid, NULL, ${image('NEW', cols)}); END`);
      db.exec(`CREATE TEMP TRIGGER ${trigger(log, i, 'update')} AFTER UPDATE ON main.${ident(table)} BEGIN
        ${into}, 'update', OLD.rowid, NEW.rowid, ${image('OLD', cols)}, ${image('NEW', cols)}); END`);
      db.exec(`CREATE TEMP TRIGGER ${trigger(log, i, 'delete')} AFTER DELETE ON main.${ident(table)} BEGIN
        ${into}, 'delete', OLD.rowid, NULL, ${image('OLD', cols)}, NULL); END`);
    });
  } catch (error) {
    captureDrop(db, active);
    throw error;
  }
  return active;
}

// The captured changes in order; removes the triggers and log.
export function captureEnd(db, active) {
  try {
    return db.prepare(`SELECT tbl, op, rowid_was, rowid_now, before, after FROM temp.${active.log} ORDER BY seq`).all().map(r => ({
      table: r.tbl,
      op: r.op,
      rowid: r.op === 'delete' ? r.rowid_was : r.rowid_now,
      // An update that moved a row to another rowid cannot be checked by rowid; revert refuses it.
      ...(r.op === 'update' && r.rowid_was !== r.rowid_now ? { movedFrom: r.rowid_was } : {}),
      before: r.before,
      after: r.after,
    }));
  } finally {
    captureDrop(db, active);
  }
}

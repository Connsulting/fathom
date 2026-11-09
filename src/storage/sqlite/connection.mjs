import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sqliteError, storageError } from '../errors.mjs';
import { queryShape } from '../sql.mjs';
import { row, safeInteger } from '../values.mjs';
import { migrateDatabase } from './migrations.mjs';
import { captureBegin, captureEnd, captureDrop } from './capture.mjs';

const ident = name => `"${String(name).replaceAll('"', '""')}"`;
const JOURNALS = new Set(['wal', 'delete']);
const INSPECT = new Set(['table_info', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_keys', 'journal_mode']);

// One physical SQLite connection. Options: readOnly; journal ('wal' default, 'delete', or null to
// leave the file's mode); busyTimeout (ms, default 5000); foreignKeys (default true); queryOnly;
// exclusive (take and keep an exclusive lock, failing at once when another connection holds one).
export async function openConnection({ path, readOnly = false, journal = 'wal', busyTimeout = 5000, foreignKeys = true, queryOnly = false, exclusive = false } = {}) {
  if (journal !== null && !JOURNALS.has(journal)) throw storageError();
  if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 0) throw storageError();
  let db;
  try {
    db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${exclusive ? 0 : busyTimeout}`);
    if (exclusive) {
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      db.exec('COMMIT');
    }
    if (journal && !readOnly) db.exec(`PRAGMA journal_mode = ${journal.toUpperCase()}`);
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    if (queryOnly) db.exec('PRAGMA query_only = ON');
  } catch (error) {
    try { db?.close(); } catch { /* not open */ }
    throw storageError(exclusive && [5, 6].includes(error?.errcode & 255) ? 'storage_busy' : 'storage_unavailable');
  }
  const cache = new Map();
  const captures = [];
  function driver(action) {
    try { return action(); } catch (error) { throw sqliteError(error); }
  }
  const pragmaRows = text => driver(() => db.prepare(text).all()).map(row);
  return {
    async query(text, method, args) {
      const shape = queryShape(text);
      if (args.length !== shape.parameters) throw storageError();
      const key = createHash('sha256').update(text).digest('hex');
      let statement = cache.get(key);
      if (!statement) {
        statement = driver(() => db.prepare(text));
        statement.setReadBigInts(true);
        statement.setAllowBareNamedParameters(false);
        if (cache.size === 256) {
          const oldest = cache.keys().next().value;
          driver(() => cache.get(oldest).close());
          cache.delete(oldest);
        }
      } else cache.delete(key);
      cache.set(key, statement);
      if (method === 'get') return row(driver(() => statement.get(...args)));
      if (method === 'all') return driver(() => statement.all(...args)).map(row);
      const result = driver(() => statement.run(...args));
      return { changes: shape.kind === 'SELECT' ? 0 : safeInteger(result.changes) };
    },
    async begin() { driver(() => db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')); },
    async commit() { driver(() => db.exec('COMMIT')); },
    async rollback() { driver(() => db.exec('ROLLBACK')); },
    async savepoint(name) { driver(() => db.exec(`SAVEPOINT ${name}`)); },
    async release(name) { driver(() => db.exec(`RELEASE SAVEPOINT ${name}`)); },
    async rollbackTo(name) { driver(() => db.exec(`ROLLBACK TO SAVEPOINT ${name}`)); },
    // Lifecycle and metadata operations; none takes application SQL.
    async tables() {
      return pragmaRows("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").map(r => r.name);
    },
    async hasTable(name) {
      return Boolean(driver(() => db.prepare("SELECT 1 AS x FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name)));
    },
    async columns(table) {
      return pragmaRows(`PRAGMA main.table_info(${ident(table)})`)
        .map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
    },
    // Read-only schema metadata, as the matching PRAGMA reports it (SQLite-specific tests only).
    async inspect(kind, name) {
      if (!INSPECT.has(kind) || (name !== undefined && typeof name !== 'string')) throw storageError();
      return pragmaRows(name === undefined ? `PRAGMA ${kind}` : `PRAGMA ${kind}(${ident(name)})`);
    },
    async integrityCheck() { return pragmaRows('PRAGMA integrity_check').map(r => r.integrity_check); },
    async foreignKeyCheck(table) { return pragmaRows(table === undefined ? 'PRAGMA foreign_key_check' : `PRAGMA foreign_key_check(${ident(table)})`); },
    async checkpoint() { driver(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)')); },
    async sizeBytes() {
      const pages = pragmaRows('PRAGMA page_count')[0].page_count;
      const size = pragmaRows('PRAGMA page_size')[0].page_size;
      return pages * size;
    },
    // Trusted schema DDL from the application's own files (never request input).
    async applySchema(sql) { driver(() => db.exec(sql)); },
    async migrate(options) { return migrateDatabase(db, options); },
    async backupTo(target) {
      try { await backup(db, target); } catch (error) { throw sqliteError(error); }
    },
    async captureBegin() {
      captures.push(driver(() => captureBegin(db)));
    },
    async captureEnd() {
      const active = captures.pop();
      return driver(() => captureEnd(db, active));
    },
    async captureDrop() {
      const active = captures.pop();
      if (active) driver(() => captureDrop(db, active));
    },
    async close() {
      driver(() => {
        for (const statement of cache.values()) statement.close();
        cache.clear();
        db.close();
      });
    },
  };
}

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sqliteError, storageError } from '../errors.mjs';
import { queryShape } from '../sql.mjs';
import { row, safeInteger } from '../values.mjs';

export async function openConnection({ path }) {
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
  } catch {
    db?.close();
    throw storageError('storage_unavailable');
  }
  const cache = new Map();
  function driver(action) {
    try { return action(); } catch (error) { throw sqliteError(error); }
  }
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
    async begin() { driver(() => db.exec('BEGIN IMMEDIATE')); },
    async commit() { driver(() => db.exec('COMMIT')); },
    async rollback() { driver(() => db.exec('ROLLBACK')); },
    async savepoint(name) { driver(() => db.exec(`SAVEPOINT ${name}`)); },
    async release(name) { driver(() => db.exec(`RELEASE SAVEPOINT ${name}`)); },
    async rollbackTo(name) { driver(() => db.exec(`ROLLBACK TO SAVEPOINT ${name}`)); },
    async close() {
      driver(() => {
        for (const statement of cache.values()) statement.close();
        cache.clear();
        db.close();
      });
    },
  };
}

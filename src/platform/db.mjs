// Platform database (platform.sqlite): households, accounts, memberships, operator grants,
// credentials and sessions, beside the financial store (fathom.sqlite) in the data directory.
// Migrations are src/platform/migrations/NNN-name.sql, applied by the store's migrate().

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, setSetting, MIGRATIONS_DIR, DB_FILE } from '../store/db.mjs';
import { fsyncDir } from './fsutil.mjs';

export const PLATFORM_FILE = 'platform.sqlite';
export const PLATFORM_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url)).replace(/[\\/]$/, '');
export const LOCK_FILE = 'platform-migration.lock';
export const JOURNAL_FILE = 'platform-migration.json';

// The store_identity DDL, read from migration 021 so the offline migration's marker and the
// migration create the table with identical text.
export const STORE_IDENTITY_DDL = (() => {
  const sql = readFileSync(join(MIGRATIONS_DIR, '021-platform-identity.sql'), 'utf8');
  const m = /^CREATE TABLE IF NOT EXISTS store_identity [^;]*;/m.exec(sql);
  if (!m) throw new Error('migration 021 has no store_identity DDL');
  return m[0];
})();

export const newHouseholdId = () => `hh-${randomUUID()}`;
export const newOperationId = () => `op-${randomUUID()}`;

// An Error carrying a fixed, log-safe code (also the message).
export function codeError(code, Kind = Error) {
  const err = new Kind(code);
  err.code = code;
  return err;
}

// Open platform.sqlite and apply pending platform migrations; closes it again on failure.
export function openPlatform(file) {
  const db = openDb(file);
  try {
    migrate(db, { dir: PLATFORM_MIGRATIONS_DIR });
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

const sideFiles = file => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];

// Build a SQLite file at a temporary name with fn(db), checkpointed and closed, so the caller can
// rename it into place whole.
function buildTemp(tmp, fn) {
  for (const f of sideFiles(tmp)) rmSync(f, { force: true });
  const db = openDb(tmp);
  try {
    fn(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function insertServedHousehold(platform, { id, mode, now, operationId, kind }) {
  platform.prepare(`INSERT INTO households (id, status, mode, display_name, serves_store, created_at, updated_at)
    VALUES (?, 'active', ?, NULL, 1, ?, ?)`).run(id, mode, now, now);
  platform.prepare(`INSERT INTO platform_operations (id, kind, phase, status, started_at, updated_at, detail)
    VALUES (?, ?, 'complete', 'done', ?, ?, '{}')`).run(operationId, kind, now, now);
}

// Create platform.sqlite atomically with one served, active household. Returns the open handle.
export function createPlatformFile(file, { householdId, mode, operationId = newOperationId(), kind = 'create-instance', now = Date.now() }) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    buildTemp(tmp, db => {
      migrate(db, { dir: PLATFORM_MIGRATIONS_DIR });
      db.exec('BEGIN');
      try {
        insertServedHousehold(db, { id: householdId, mode, now, operationId, kind });
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    });
    renameSync(tmp, file);
    fsyncDir(file);
  } finally {
    for (const f of sideFiles(tmp)) rmSync(f, { force: true });
  }
  return openPlatform(file);
}

// A fresh instance: platform.sqlite with one served household of `mode` and a migrated
// fathom.sqlite whose store_identity names it, with init(db) run on the store before it is
// published. Both are built at temporary names; the store is renamed into place first and the
// platform last (a store with store_identity and no platform is recovered by the platform
// migration, or automatically for a demo store). Refuses when either file exists. Returns open
// handles { db, platform, householdId }; the caller closes both.
export function createInstance(dataDir, { mode, init = () => {} } = {}) {
  if (mode !== 'real' && mode !== 'demo') throw new TypeError('createInstance mode must be real or demo');
  mkdirSync(dataDir, { recursive: true });
  const storeFile = join(dataDir, DB_FILE);
  const platformFile = join(dataDir, PLATFORM_FILE);
  if (existsSync(storeFile) || existsSync(platformFile)) throw codeError('instance_exists');
  const householdId = newHouseholdId();
  const operationId = newOperationId();
  const now = Date.now();
  const storeTmp = `${storeFile}.tmp-${process.pid}`;
  const platformTmp = `${platformFile}.tmp-${process.pid}`;
  try {
    buildTemp(platformTmp, db => {
      migrate(db, { dir: PLATFORM_MIGRATIONS_DIR });
      db.exec('BEGIN');
      try {
        insertServedHousehold(db, { id: householdId, mode, now, operationId, kind: 'create-instance' });
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    });
    buildTemp(storeTmp, db => {
      migrate(db);
      setSetting(db, 'mode', mode);
      init(db);
      db.exec(STORE_IDENTITY_DDL);
      db.prepare('INSERT INTO store_identity (id, household_id, platform_operation) VALUES (1, ?, ?)').run(householdId, operationId);
    });
    if (existsSync(storeFile) || existsSync(platformFile)) throw codeError('instance_exists');
    renameSync(storeTmp, storeFile);
    renameSync(platformTmp, platformFile);
    fsyncDir(platformFile);
  } finally {
    for (const f of [...sideFiles(storeTmp), ...sideFiles(platformTmp)]) rmSync(f, { force: true });
  }
  const db = openDb(storeFile);
  let platform;
  try {
    platform = openPlatform(platformFile);
  } catch (e) {
    db.close();
    throw e;
  }
  return { db, platform, householdId };
}

// The household the singleton store serves, or null.
export function servedHousehold(platform) {
  const row = platform.prepare('SELECT id, mode, status FROM households WHERE serves_store = 1').get();
  return row ? { id: row.id, mode: row.mode, status: row.status } : null;
}

// The store_identity row of an open store, or null when the table or row is absent.
export function storeIdentity(db) {
  const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'store_identity'").get();
  if (!has) return null;
  const row = db.prepare('SELECT household_id, platform_operation FROM store_identity WHERE id = 1').get();
  return row ? { householdId: row.household_id, operationId: row.platform_operation } : null;
}

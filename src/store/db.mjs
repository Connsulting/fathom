// Financial store: open, migrate, list tables, JSON settings, on the asynchronous storage port
// (src/storage). Migrations are src/store/migrations/NNN-name.sql, applied in numeric order, each in
// its own transaction, and recorded in schema_migrations.

import { existsSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openScope, rehearse } from '../storage/index.mjs';
import { listMigrations as listMigrationFiles } from '../storage/sqlite/migrations.mjs';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url)).replace(/[\\/]$/, '');
export const DB_FILE = 'fathom.sqlite';

// Open a store file read-write in WAL mode with foreign keys on and a 5000 ms busy timeout. The
// busy timeout comes first, so switching to WAL waits out another process's lock.
export function openDb(path, options = {}) {
  return openScope({ path, ...options });
}

// Migrations in `dir` (default: the financial store's), in numeric order.
export function listMigrations(dir = MIGRATIONS_DIR) {
  return listMigrationFiles(dir);
}

// Apply pending migrations from `dir` with ids up to `through` (the offline platform migration
// stops the financial store just before the platform migration, 022, extracts accounts).
export function migrate(db, { dir = MIGRATIONS_DIR, through = Infinity } = {}) {
  return db.migrate({ dir, through });
}

export async function schemaVersion(db) {
  const r = await db.prepare('SELECT max(id) AS id FROM schema_migrations').get();
  return r && r.id != null ? r.id : 0;
}

export function listTables(db) {
  return db.tables();
}

// JSON text to a value, or `fallback` when it is null or malformed.
export function parseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export async function getSetting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return parseJson(row && row.value, fallback);
}

export async function setSetting(db, key, value) {
  await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), new Date().toISOString());
}

// Open an existing store and apply pending migrations; closes it again if a migration fails.
export async function openMigrated(path) {
  const db = await openDb(path);
  try {
    await migrate(db);
  } catch (e) {
    await db.close();
    throw e;
  }
  return db;
}

// Run fn(handle) inside a write transaction on scope db; rolls back on throw. fn must use the handle
// it receives for every statement.
export function tx(db, fn) {
  return db.transaction(fn);
}

// A view of a request or tool context whose db is the transaction handle; every other property
// (and every write) goes to ctx itself.
function withHandle(ctx, db) {
  return new Proxy(ctx, {
    get: (target, key, receiver) => (key === 'db' ? db : Reflect.get(target, key, receiver)),
    getOwnPropertyDescriptor: (target, key) => {
      const d = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'db' && d ? { ...d, value: db } : d;
    },
  });
}

// tx and actionTx over ctx.db: fn receives a context whose db is the transaction handle.
export function txWith(ctx, fn) {
  return ctx.db.transaction(db => fn(withHandle(ctx, db)));
}

// rehearse over ctx.db: fn's writes are always rolled back.
export function rehearseWith(ctx, fn) {
  return rehearse(ctx.db, db => fn(withHandle(ctx, db)));
}

export function actionTxWith(ctx, fn) {
  return ctx.db.transaction ? txWith(ctx, fn) : fn(ctx);
}

// The store mode recorded at creation: 'demo' | 'real' | null when the file does not exist.
// A file with no settings table or no mode row is 'real'. Opens read-only and changes nothing.
export async function readStoreMode(file) {
  if (!existsSync(file)) return null;
  const db = await openDb(file, { readOnly: true, journal: null });
  try {
    if (!await db.hasTable('settings')) return 'real';
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'mode'").get();
    return parseJson(row && row.value, null) === 'demo' ? 'demo' : 'real';
  } finally {
    await db.close();
  }
}

// Run fn atomically: in a new transaction on a scope, or directly inside the caller's open one.
export function actionTx(db, fn) {
  return db.transaction ? db.transaction(fn) : fn(db);
}

// Create a new store file atomically: migrate and initialise a temporary file, then rename it
// into place, so a crash never leaves a half-built store that a restart would misread.
export async function createStoreFile(file, init) {
  const tmp = `${file}.tmp-${process.pid}`;
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) rmSync(f, { force: true });
  try {
    const db = await openDb(tmp);
    try {
      await migrate(db);
      await init(db);
      await db.checkpoint();
    } finally {
      await db.close();
    }
    renameSync(tmp, file);
  } finally {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) rmSync(f, { force: true });
  }
  return openDb(file);
}

// Money in dollars rounded to cents.
export const cents = n => (n == null || !Number.isFinite(Number(n)) ? n : Math.round(Number(n) * 100) / 100);

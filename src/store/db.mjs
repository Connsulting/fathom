// SQLite store: open, migrate, list tables, JSON settings. Built on node:sqlite (DatabaseSync).
// Migrations are src/store/migrations/NNN-name.sql, applied in numeric order, each in its own
// transaction, and recorded in schema_migrations.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url)).replace(/[\\/]$/, '');
export const DB_FILE = 'fathom.sqlite';

const MIGRATION_FILE = /^(\d{3})-([a-z0-9-]+)\.sql$/;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .map(f => MIGRATION_FILE.exec(f))
    .filter(Boolean)
    .map(m => ({ id: Number(m[1]), name: m[2], file: join(MIGRATIONS_DIR, m[0]) }))
    .sort((a, b) => a.id - b.id);
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
  const applied = [];
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of listMigrations()) {
    if (done.has(m.id)) continue;
    const sql = readFileSync(m.file, 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      record.run(m.id, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id}-${m.name} failed: ${e.message}`);
    }
    applied.push(m.id);
  }
  return { applied };
}

export function schemaVersion(db) {
  const r = db.prepare('SELECT max(id) AS id FROM schema_migrations').get();
  return r && r.id != null ? r.id : 0;
}

export function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .all().map(r => r.name);
}

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || row.value == null) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), new Date().toISOString());
}

// Run fn inside a transaction; rolls back on throw.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The store mode recorded at creation: 'demo' | 'real' | null when the file does not exist.
// A file with no settings table or no mode row is 'real'. Opens read-only and changes nothing.
export function readStoreMode(file) {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const hasSettings = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
    if (!hasSettings) return 'real';
    const row = db.prepare("SELECT value FROM settings WHERE key = 'mode'").get();
    let mode = null;
    try { mode = row ? JSON.parse(row.value) : null; } catch { mode = null; }
    return mode === 'demo' ? 'demo' : 'real';
  } finally {
    db.close();
  }
}

// Create a new store file atomically: migrate and initialise a temporary file, then rename it
// into place, so a crash never leaves a half-built store that a restart would misread.
export function createStoreFile(file, init) {
  const tmp = `${file}.tmp-${process.pid}`;
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) rmSync(f, { force: true });
  try {
    const db = openDb(tmp);
    try {
      migrate(db);
      init(db);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    renameSync(tmp, file);
  } finally {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) rmSync(f, { force: true });
  }
  return openDb(file);
}

// Money in dollars rounded to cents.
export const cents = n => (n == null || !Number.isFinite(Number(n)) ? n : Math.round(Number(n) * 100) / 100);

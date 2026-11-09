// SQLite migration runner: dir/NNN-name.sql, applied in numeric order, each in its own transaction,
// and recorded in schema_migrations. Runs on the adapter's own connection only.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_FILE = /^(\d{3})-([a-z0-9-]+)\.sql$/;
const REBUILDS_TABLE = /^-- REBUILDS_TABLE\b/m;

// Migrations in `dir`, in numeric order.
export function listMigrations(dir) {
  return readdirSync(dir)
    .map(f => MIGRATION_FILE.exec(f))
    .filter(Boolean)
    .map(m => ({ id: Number(m[1]), name: m[2], file: join(dir, m[0]) }))
    .sort((a, b) => a.id - b.id);
}

// Apply pending migrations from `dir` with ids up to `through`. A failed migration throws
// `migration <id>-<name> failed: <reason>` after rolling back.
export function migrateDatabase(db, { dir, through = Infinity } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
  const applied = [];
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of listMigrations(dir)) {
    if (m.id > through) break;
    if (done.has(m.id)) continue;
    const sql = readFileSync(m.file, 'utf8');
    // A migration that rebuilds a table other tables reference (SQLite cannot alter a CHECK) opens
    // with REBUILDS_TABLE. Foreign keys cannot be switched off inside a transaction, so they are off
    // around it, and foreign_key_check must come back clean before it commits.
    const rebuild = REBUILDS_TABLE.test(sql);
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      try {
        db.exec(sql);
        if (rebuild) {
          const bad = db.prepare('PRAGMA foreign_key_check').all();
          if (bad.length) throw new Error(`foreign key check found ${bad.length} violation(s), first in ${bad[0].table}`);
        }
        record.run(m.id, m.name, new Date().toISOString());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`migration ${m.id}-${m.name} failed: ${e.message}`);
      }
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON');
    }
    applied.push(m.id);
  }
  return { applied };
}

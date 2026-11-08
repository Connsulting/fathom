// Instance readiness: the only way the server and CLIs open an existing instance.
//
// openInstance(config) -> { platform, mode } for an instance on the household-root layout, or null
// when the data directory holds no instance at all (the caller creates one). In order:
// 1. platform-migration.lock refuses platform_migration_in_progress; tenancy-migration.lock refuses
//    tenancy_migration_in_progress.
// 2. No platform.sqlite: a root fathom.sqlite refuses platform_migration_required (real) or
//    demo_store_outdated (demo); neither is a fresh directory (null).
// 3. The original household (households.serves_store) or any active household without a
//    storage_root refuses tenancy_migration_required (real) or demo_store_outdated (demo), checked
//    before the platform is migrated or written. A provisioning household whose storage failed has
//    no root and is simply never served.
// 4. The platform is opened and migrated; a root fathom.sqlite still beside it refuses
//    tenancy_layout_conflict.
// `mode` is the original household's mode (instance mode: demo or real). Financial stores are
// opened per household by src/platform/runtime.mjs openHouseholdDb.
// Refusals are StartupError with a fixed `.code` that also leads the message; no path or value.
//
// openOperatorPlatform(env) -> the opened, migrated platform.sqlite of FATHOM_DATA (default
// ./data) for an OS-operator command that touches only the platform (scripts/operator.mjs,
// scripts/model-budget.mjs, scripts/reconcile-spend.mjs). Refuses while either migration lock
// exists and platform_migration_required without a platform. The caller closes it.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readStoreMode, DB_FILE } from '../store/db.mjs';
import { PLATFORM_FILE, LOCK_FILE, householdRootRel, openPlatform, servedHousehold, storeIdentity } from './db.mjs';
import { LOCK_FILE as TENANCY_LOCK_FILE } from './migrate-tenancy.mjs';

export class StartupError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'StartupError';
    this.code = code;
  }
}

const MESSAGES = {
  platform_migration_in_progress: 'an offline platform migration is in progress or was interrupted; finish it with node scripts/migrate-platform.mjs before starting',
  platform_migration_required: 'this real store has no platform database yet; stop every Fathom process, set FATHOM_BACKUP_KEY_FILE and run node scripts/migrate-platform.mjs',
  tenancy_migration_in_progress: 'an offline tenancy migration is in progress or was interrupted; finish it with node scripts/migrate-tenancy.mjs before starting',
  tenancy_migration_required: 'this real instance still uses the single-store layout; stop every Fathom process, set FATHOM_BACKUP_KEY_FILE, FATHOM_DATA_KEY_FILE, FATHOM_PLATFORM_KEY_FILE and FATHOM_MCP_SECRET_FILE and run node scripts/migrate-tenancy.mjs',
  tenancy_layout_conflict: 'a single-store fathom.sqlite is still in the data directory beside migrated household roots; move it aside before starting, nothing was changed',
  demo_store_outdated: 'this demo data directory predates household roots; remove the demo data directory and a fresh demo is created on start',
  household_store_mismatch: 'the store is not bound to the household the platform database serves; refusing to start, nothing was changed',
  household_required: 'name the household with --household <id>',
  household_unavailable: 'that household is not active or has no storage on this instance',
};

export const refuse = code => new StartupError(code, MESSAGES[code] || '');

// Households that must have a root before the instance is served: the original household (any
// status but deleted) and every active household. Read-only; a platform from before migration
// 003 has no storage_root column, so every such household lacks one.
function rootlessHouseholds(platformFile) {
  const db = new DatabaseSync(platformFile, { readOnly: true });
  try {
    const columns = db.prepare('PRAGMA table_info(households)').all().map(c => c.name);
    const where = "(serves_store = 1 AND status != 'deleted') OR status = 'active'";
    if (!columns.includes('storage_root')) return db.prepare(`SELECT count(*) AS n FROM households WHERE ${where}`).get().n;
    return db.prepare(`SELECT count(*) AS n FROM households WHERE (${where}) AND storage_root IS NULL`).get().n;
  } finally {
    db.close();
  }
}

function modeOf(platformFile) {
  const db = new DatabaseSync(platformFile, { readOnly: true });
  try {
    return db.prepare('SELECT mode FROM households WHERE serves_store = 1').get()?.mode ?? null;
  } finally {
    db.close();
  }
}

export function openInstance(config) {
  const dataDir = config.dataDir;
  if (existsSync(join(dataDir, LOCK_FILE))) throw refuse('platform_migration_in_progress');
  if (existsSync(join(dataDir, TENANCY_LOCK_FILE))) throw refuse('tenancy_migration_in_progress');
  const platformFile = join(dataDir, PLATFORM_FILE);
  const rootStore = join(dataDir, DB_FILE);
  if (!existsSync(platformFile)) {
    const legacy = readStoreMode(rootStore);
    if (legacy === null) return null;
    throw refuse(legacy === 'demo' ? 'demo_store_outdated' : 'platform_migration_required');
  }
  const mode = modeOf(platformFile);
  if (mode !== 'real' && mode !== 'demo') throw refuse('household_store_mismatch');
  if (rootlessHouseholds(platformFile) > 0) throw refuse(mode === 'demo' ? 'demo_store_outdated' : 'tenancy_migration_required');
  if (existsSync(rootStore)) throw refuse('tenancy_layout_conflict');
  const platform = openPlatform(platformFile);
  try {
    const served = servedHousehold(platform);
    if (!served || served.mode !== mode) throw refuse('household_store_mismatch');
    return { platform, mode };
  } catch (e) {
    try { platform.close(); } catch { /* already closed */ }
    throw e;
  }
}


// Columns scripts/category-eval.mjs reads; a store without them refuses store_schema_required.
export function openOperatorPlatform(env = process.env) {
  const dataDir = resolve(env.FATHOM_DATA == null || env.FATHOM_DATA === '' ? 'data' : env.FATHOM_DATA);
  if (existsSync(join(dataDir, LOCK_FILE))) throw refuse('platform_migration_in_progress');
  if (existsSync(join(dataDir, TENANCY_LOCK_FILE))) throw refuse('tenancy_migration_in_progress');
  const file = join(dataDir, PLATFORM_FILE);
  if (!existsSync(file)) throw refuse('platform_migration_required');
  return openPlatform(file);
}

const EVAL_COLUMNS = Object.freeze({
  transactions: ['id', 'account_id', 'date', 'amount', 'description', 'category', 'parser'],
  accounts: ['id', 'kind', 'mask'],
  facts: ['key', 'value'],
  transaction_category_imports: ['transaction_id', 'category', 'parser'],
});

// openReadOnlyHousehold(config, householdId) -> { db, platform, householdId } for offline
// evaluation: the platform and that household's store under its storage root, both opened
// read-only (query_only), never migrated or written. Refuses while either migration lock exists,
// platform_migration_required without a platform, household_unavailable unless the household is
// active with its own root, store_missing, household_store_mismatch when the store's identity or
// mode differs, and store_schema_required without the evaluation columns. The caller closes both.
export function openReadOnlyHousehold({ dataDir }, householdId) {
  if (existsSync(join(dataDir, LOCK_FILE))) throw refuse('platform_migration_in_progress');
  if (existsSync(join(dataDir, TENANCY_LOCK_FILE))) throw refuse('tenancy_migration_in_progress');
  const platformFile = join(dataDir, PLATFORM_FILE);
  if (!existsSync(platformFile)) throw refuse('platform_migration_required');
  let db;
  let platform;
  try {
    platform = new DatabaseSync(platformFile, { readOnly: true });
    platform.exec('PRAGMA query_only = ON');
    const row = platform.prepare('SELECT status, mode, storage_root FROM households WHERE id = ?').get(householdId);
    if (!row || row.status !== 'active' || row.storage_root !== householdRootRel(householdId)) throw refuse('household_unavailable');
    const file = join(dataDir, row.storage_root, DB_FILE);
    if (!existsSync(file)) throw refuse('store_missing');
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    const mode = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'mode'").get()?.value ?? 'null');
    if (mode !== row.mode || storeIdentity(db)?.householdId !== householdId) throw refuse('household_store_mismatch');
    for (const [table, columns] of Object.entries(EVAL_COLUMNS)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      if (columns.some(c => !have.has(c))) throw refuse('store_schema_required');
    }
    return { db, platform, householdId };
  } catch (error) {
    try { db?.close(); } catch { /* already closed */ }
    try { platform?.close(); } catch { /* already closed */ }
    throw error;
  }
}

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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readStoreMode, DB_FILE } from '../store/db.mjs';
import { PLATFORM_FILE, LOCK_FILE, openPlatform, servedHousehold } from './db.mjs';
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

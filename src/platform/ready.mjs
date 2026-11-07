// Real-store readiness: the only way the server and CLIs open an existing instance.
//
// 1. A platform-migration.lock in the data directory refuses platform_migration_in_progress.
// 2. No platform.sqlite: a real store refuses platform_migration_required (before the store is
//    opened or migrated); a demo store gets its synthetic platform created here.
// 3. The platform is opened and migrated, the store opened and migrated, and store_identity must
//    name the platform's served household of the same mode, else household_store_mismatch.
// Refusals are StartupError with a fixed `.code` that also leads the message; no path or value.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, migrate, readStoreMode, DB_FILE } from '../store/db.mjs';
import {
  PLATFORM_FILE, LOCK_FILE, STORE_IDENTITY_DDL, createPlatformFile, openPlatform, newHouseholdId, servedHousehold, storeIdentity,
} from './db.mjs';

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
  household_store_mismatch: 'the store is not bound to the household the platform database serves; refusing to start, nothing was changed',
  store_missing: 'there is no store in the data directory',
};

export const refuse = code => new StartupError(code, MESSAGES[code] || '');

// Bind a demo store that predates the platform (or lost it) to a new synthetic platform. The
// store marker is written before the platform is published, so a crash in between is recovered
// by the next start.
function createDemoPlatform(storeFile, platformFile) {
  const db = openDb(storeFile);
  let householdId;
  try {
    const identity = storeIdentity(db);
    householdId = identity?.householdId ?? newHouseholdId();
    if (!identity) {
      db.exec(STORE_IDENTITY_DDL);
      db.prepare('INSERT INTO store_identity (id, household_id, platform_operation) VALUES (1, ?, NULL)').run(householdId);
    }
  } finally {
    db.close();
  }
  return createPlatformFile(platformFile, { householdId, mode: 'demo', kind: 'create-demo-platform' });
}

// Open an existing instance under config.dataDir. Returns { db, platform, householdId }; the
// caller closes both handles.
export function openServedStore(config) {
  const dataDir = config.dataDir;
  if (existsSync(join(dataDir, LOCK_FILE))) throw refuse('platform_migration_in_progress');
  const storeFile = join(dataDir, DB_FILE);
  const platformFile = join(dataDir, PLATFORM_FILE);
  const mode = readStoreMode(storeFile);
  if (mode === null) throw refuse('store_missing');
  let platform;
  if (existsSync(platformFile)) platform = openPlatform(platformFile);
  else if (mode === 'demo') platform = createDemoPlatform(storeFile, platformFile);
  else throw refuse('platform_migration_required');

  let db;
  try {
    const household = servedHousehold(platform);
    if (!household || household.mode !== mode) throw refuse('household_store_mismatch');
    db = openDb(storeFile);
    const before = storeIdentity(db);
    if (before ? before.householdId !== household.id : mode !== 'demo') throw refuse('household_store_mismatch');
    // A pre-platform demo store gets its marker so migration 021 can drop the empty account tables.
    if (!before && mode === 'demo') {
      db.exec(STORE_IDENTITY_DDL);
      db.prepare('INSERT INTO store_identity (id, household_id, platform_operation) VALUES (1, ?, NULL)').run(household.id);
    }
    migrate(db);
    const identity = storeIdentity(db);
    if (!identity || identity.householdId !== household.id) throw refuse('household_store_mismatch');
    return { db, platform, householdId: household.id };
  } catch (e) {
    try { db?.close(); } catch { /* already closed */ }
    try { platform.close(); } catch { /* already closed */ }
    throw e;
  }
}

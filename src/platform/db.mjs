// Platform database (platform.sqlite): households, accounts, memberships, operator grants,
// credentials, sessions, MCP keys and outbound flags. Each household's financial store lives in its
// own root, `<dataDir>/households/<householdId>/fathom.sqlite` (households.storage_root).
// Migrations are src/platform/migrations/NNN-name.sql, applied by the store's migrate().

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, setSetting, MIGRATIONS_DIR, DB_FILE } from '../store/db.mjs';
import { fsyncDir } from './fsutil.mjs';
import { wrapDataKey } from './household-vault.mjs';
import { initOutbound } from './outbound.mjs';

export const PLATFORM_FILE = 'platform.sqlite';
export const PLATFORM_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url)).replace(/[\\/]$/, '');
export const LOCK_FILE = 'platform-migration.lock';
export const JOURNAL_FILE = 'platform-migration.json';

// The store_identity DDL, read from migration 022 so the offline migration's marker and the
// migration create the table with identical text.
export const STORE_IDENTITY_DDL = (() => {
  const sql = readFileSync(join(MIGRATIONS_DIR, '022-platform-identity.sql'), 'utf8');
  const m = /^CREATE TABLE IF NOT EXISTS store_identity [^;]*;/m.exec(sql);
  if (!m) throw new Error('migration 022 has no store_identity DDL');
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
export async function openPlatform(file) {
  const db = await openDb(file);
  try {
    await migrate(db, { dir: PLATFORM_MIGRATIONS_DIR });
  } catch (e) {
    await db.close();
    throw e;
  }
  return db;
}

const sideFiles = file => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];

// Build a SQLite file at a temporary name with fn(db), checkpointed and closed, so the caller can
// rename it into place whole.
async function buildTemp(tmp, fn) {
  for (const f of sideFiles(tmp)) rmSync(f, { force: true });
  const db = await openDb(tmp);
  try {
    await fn(db);
    await db.checkpoint();
  } finally {
    await db.close();
  }
}

async function insertServedHousehold(platform, { id, mode, now, operationId, kind }) {
  await platform.prepare(`INSERT INTO households (id, status, mode, display_name, serves_store, created_at, updated_at)
    VALUES (?, 'active', ?, NULL, 1, ?, ?)`).run(id, mode, now, now);
  await platform.prepare(`INSERT INTO platform_operations (id, kind, phase, status, started_at, updated_at, detail)
    VALUES (?, ?, 'complete', 'done', ?, ?, '{}')`).run(operationId, kind, now, now);
}

// Create platform.sqlite atomically with one served, active household. Returns the open handle.
export async function createPlatformFile(file, { householdId, mode, operationId = newOperationId(), kind = 'create-instance', now = Date.now() }) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await buildTemp(tmp, async db => {
      await migrate(db, { dir: PLATFORM_MIGRATIONS_DIR });
      await db.transaction(async db => {
        await insertServedHousehold(db, { id: householdId, mode, now, operationId, kind });
      });
    });
    renameSync(tmp, file);
    fsyncDir(file);
  } finally {
    for (const f of sideFiles(tmp)) rmSync(f, { force: true });
  }
  return await openPlatform(file);
}

export const HOUSEHOLDS_DIR = 'households';
// The household root relative to the data directory, as households.storage_root records it.
export const householdRootRel = householdId => `${HOUSEHOLDS_DIR}/${householdId}`;

// A private directory (0700), created when missing; an existing one must be a private directory.
function privateDir(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if (e?.code !== 'EEXIST') throw codeError('household_root_invalid');
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0) throw codeError('household_root_invalid');
}

// Wrap a fresh random data key under the platform key and insert it as the household's active
// version 1 (inside the caller's transaction).
async function insertDataKey(platform, householdId, platformKey, now) {
  const key = randomBytes(32);
  try {
    const wrapped = wrapDataKey(platformKey, { householdId, version: 1, key });
    await platform.prepare(`INSERT INTO household_data_keys (household_id, key_version, wrapped_key, status, created_at)
      VALUES (?, 1, ?, 'active', ?)`).run(householdId, wrapped, now);
  } finally {
    key.fill(0);
  }
}

// Build `<root>/fathom.sqlite` at a temporary name inside the root (migrated, settings.mode,
// init(db), store_identity naming the household) and rename it into place. The root must exist.
async function buildHouseholdStore(rootPath, { householdId, mode, operationId = null, init = () => {} }) {
  const storeFile = join(rootPath, DB_FILE);
  if (existsSync(storeFile)) throw codeError('instance_exists');
  const tmp = `${storeFile}.tmp-${process.pid}`;
  try {
    await buildTemp(tmp, async db => {
      await migrate(db);
      await setSetting(db, 'mode', mode);
      init(db);
      await db.applySchema(STORE_IDENTITY_DDL);
      await db.prepare('INSERT INTO store_identity (id, household_id, platform_operation) VALUES (1, ?, ?)').run(householdId, operationId);
    });
    renameSync(tmp, storeFile);
    fsyncDir(storeFile);
  } finally {
    for (const f of sideFiles(tmp)) rmSync(f, { force: true });
  }
  return storeFile;
}

// The platform key from `secrets`, or null when none is available (the vault provisions lazily).
function availableKey(secrets) {
  try {
    return secrets ? secrets.platformKey() : null;
  } catch {
    return null;
  }
}

// A fresh instance: platform.sqlite with one served, active household of `mode` whose root
// households/<id> (0700) holds a migrated fathom.sqlite bound to it by store_identity, with
// init(db) run on the store before it is published. The platform row records storage_root and
// generation 1, an all-enabled household_outbound row (nothing was ever sent from a fresh
// instance) and, when `platformKey` is given, the household's wrapped data key. The store is
// renamed into place first and the platform last. Refuses instance_exists when the platform, a
// root store or any household root already exists. Returns { db, platform, householdId, root }
// (root: the absolute household root path); the caller closes both handles.
export async function createInstance(dataDir, { mode, init = () => {}, platformKey = null } = {}) {
  if (mode !== 'real' && mode !== 'demo') throw new TypeError('createInstance mode must be real or demo');
  mkdirSync(dataDir, { recursive: true });
  const platformFile = join(dataDir, PLATFORM_FILE);
  const householdsDir = join(dataDir, HOUSEHOLDS_DIR);
  const occupied = () => existsSync(platformFile) || existsSync(join(dataDir, DB_FILE))
    || (existsSync(householdsDir) && readdirSync(householdsDir).length > 0);
  if (occupied()) throw codeError('instance_exists');
  const householdId = newHouseholdId();
  const operationId = newOperationId();
  const now = Date.now();
  const relativeRoot = householdRootRel(householdId);
  const root = join(dataDir, relativeRoot);
  const platformTmp = `${platformFile}.tmp-${process.pid}`;
  try {
    await buildTemp(platformTmp, async db => {
      await migrate(db, { dir: PLATFORM_MIGRATIONS_DIR });
      await db.transaction(async db => {
        await insertServedHousehold(db, { id: householdId, mode, now, operationId, kind: 'create-instance' });
        await db.prepare('UPDATE households SET storage_root = ?, generation = 1 WHERE id = ?').run(relativeRoot, householdId);
        await initOutbound(db, householdId, { enabled: true, now });
        if (platformKey) await insertDataKey(db, householdId, platformKey, now);
      });
    });
    privateDir(householdsDir);
    privateDir(root);
    await buildHouseholdStore(root, { householdId, mode, operationId, init });
    if (existsSync(platformFile)) throw codeError('instance_exists');
    renameSync(platformTmp, platformFile);
    fsyncDir(platformFile);
  } finally {
    for (const f of sideFiles(platformTmp)) rmSync(f, { force: true });
  }
  const db = await openDb(join(root, DB_FILE));
  let platform;
  try {
    platform = await openPlatform(platformFile);
  } catch (e) {
    await db.close();
    throw e;
  }
  return { db, platform, householdId, root };
}

// Storage for a household the platform already holds (MT-01 provisioning): its root
// households/<id> (0700, must not exist yet), a migrated empty store bound to it with
// settings.mode, then in one platform transaction the data key (when `secrets` yields a platform
// key; otherwise the vault provisions it lazily on first use), an all-paused outbound row (or
// all-enabled with `enabled`), storage_root and generation 1. The household keeps its status.
// Refuses household_unavailable for an unknown, deleted or already rooted household and
// target_exists when the root directory exists. Returns { householdId, root }.
export async function createHouseholdStorage({ platform, dataDir, householdId, mode, secrets = null, enabled = false, now = Date.now() } = {}) {
  if (mode !== 'real' && mode !== 'demo') throw new TypeError('createHouseholdStorage mode must be real or demo');
  const row = typeof householdId === 'string' ? await platform.prepare('SELECT status, storage_root FROM households WHERE id = ?').get(householdId) : null;
  if (!row || row.status === 'deleted' || row.storage_root != null) throw codeError('household_unavailable');
  const relativeRoot = householdRootRel(householdId);
  const root = join(dataDir, relativeRoot);
  if (existsSync(root)) throw codeError('target_exists');
  privateDir(join(dataDir, HOUSEHOLDS_DIR));
  privateDir(root);
  await buildHouseholdStore(root, { householdId, mode });
  const platformKey = availableKey(secrets);
  try {
    await platform.transaction(async platform => {
      const fresh = await platform.prepare('SELECT status, storage_root FROM households WHERE id = ?').get(householdId);
      if (!fresh || fresh.status === 'deleted' || fresh.storage_root != null) throw codeError('household_unavailable');
      if (platformKey && !await platform.prepare('SELECT 1 AS x FROM household_data_keys WHERE household_id = ?').get(householdId)) {
        await insertDataKey(platform, householdId, platformKey, now);
      }
      if (!await platform.prepare('SELECT 1 AS x FROM household_outbound WHERE household_id = ?').get(householdId)) {
        await initOutbound(platform, householdId, { enabled, now });
      }
      await platform.prepare('UPDATE households SET storage_root = ?, generation = 1, updated_at = ? WHERE id = ?').run(relativeRoot, now, householdId);
    });
  } finally {
    platformKey?.fill(0);
  }
  return { householdId, root };
}

// The household the singleton store serves, or null.
export async function servedHousehold(platform) {
  const row = await platform.prepare('SELECT id, mode, status FROM households WHERE serves_store = 1').get();
  return row ? { id: row.id, mode: row.mode, status: row.status } : null;
}

// The store_identity row of an open store, or null when the table or row is absent.
export async function storeIdentity(db) {
  if (!await db.hasTable('store_identity')) return null;
  const row = await db.prepare('SELECT household_id, platform_operation FROM store_identity WHERE id = 1').get();
  return row ? { householdId: row.household_id, operationId: row.platform_operation } : null;
}

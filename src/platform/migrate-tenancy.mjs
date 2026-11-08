// Offline tenancy migration (MT-03): moves the original household's financial data from the
// MT-02 layout (fathom.sqlite, api-key-secret, files/, packs/, outbox/ at the data root) into its
// own root `households/<householdId>/`, converts its FTHM1 vault to FTHM2 under a household data
// key, moves its MCP keys into platform.sqlite (store migration 027 then drops the store table),
// and publishes the root with one platform transaction. Run by scripts/migrate-tenancy.mjs with
// every Fathom process stopped.
//
// Exclusion: the root store is held on one connection with SQLite's exclusive lock until the
// retire phase (source_in_use when another process has it open). tenancy-migration.lock is the
// advisory marker the server and CLIs refuse to start under; tenancy-migration.json is the journal
// (ids, phase, counts and digests only; never a row value, key or path). Both are written only
// after a fresh preflight passes. Lock and journal helpers are the platform migration's
// (src/platform/migrate.mjs).
//
// Phases, each followed by `await onPhase(name)` (an error it throws rejects the run unchanged):
//   preflight      read-only checks; nothing is written before they pass
//   snapshot       snapshots/tenancy-<op>.fsnap: store, platform.sqlite, api-key-secret, files/,
//                  packs/, outbox/ under the backup key (an existing one is authenticated and adopted)
//   source-schema  store migrations up to 26 on the source (027 refuses while keys remain)
//   stage          households/staging-<op>: a page copy of the store, packs/ and outbox/ copies, the
//                  vault converted under the household data key (an existing key row is reused),
//                  the converted SimpleFIN secret written, the store's api_keys rows deleted after
//                  their digest is journaled, then migrate() (027 drops the table)
//   verify         integrity and foreign keys; rowid-aware row digests of every source table but
//                  api_keys equal (schema_migrations on id <= 26, simplefin_connection without its
//                  blob); every vault object opens to its recorded plaintext hash; files equal
//   root-published staging renamed to households/<householdId>
//   before-manifest  fired immediately before the publication
//   manifest       one platform transaction: api_keys rows (an ownerless key binds to the only
//                  active admin, else is revoked with migration_no_creator), an all-paused
//                  household_outbound row, every session, challenge and link token deleted, live
//                  invitations revoked, storage_root and generation set, the operation row recorded;
//                  checked by digest before COMMIT. This is the single publication point. Before it
//                  and again before COMMIT the passkeys must equal the journal's fingerprint
//                  (passkeys_changed otherwise); the source store and its files/, packs/ and
//                  outbox/ trees must equal their digests journaled at source-schema
//                  (source_changed otherwise); and the supplied MCP secret must still equal the
//                  source api-key-secret (mcp_secret_mismatch otherwise), since a rerun may differ.
//   retire         root store (+ side files), api-key-secret, files/, packs/, outbox/ renamed into
//                  legacy-<op>/ (renames only)
//   complete       the operation marked done, the lock removed
//
// Recovery (a journal or lock exists) follows observed state, never the fresh-source checks its own
// later phases invalidate: operation row and storage_root present -> the manifest is done, the
// root is re-verified and retirement resumes (an entry is moved only when its source exists and
// its target does not; both present refuses retire_conflict); the final root present without
// them -> re-verify the root against the journal, then publish; neither -> this operation's staging
// is removed and the run restages from a fresh preflight. A journal-less run that finds a root,
// storage_root or legacy-* directory refuses target_exists unless the platform row and the root
// prove a completed migration. Refusals are Errors with a fixed `.code`; nothing logs values.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, listTables, migrate, openDb } from '../store/db.mjs';
import {
  LOCK_FILE as PLATFORM_LOCK_FILE, PLATFORM_FILE, codeError, householdRootRel, newOperationId, openPlatform, storeIdentity,
} from './db.mjs';
import { loadBackupKey, loadPlatformKey } from './backup-key.mjs';
import { loadMcpSecretFile } from './secrets.mjs';
import { initOutbound } from './outbound.mjs';
import { LEGACY_SIMPLEFIN_AAD, decrypt as legacyDecrypt, loadLegacyKey } from './legacy-vault.mjs';
import { logicalDigest, quoteIdent, rowsDigest } from './digest.mjs';
import {
  PRE_TENANCY_SCHEMA, SNAPSHOT_DIR, hasTable, markOperationDone, readJson, removeLock, storeMode, writeJournal, writeLock,
} from './migrate.mjs';
import { SECRET_FILE, copyDatabase, createSourceSnapshot, openSourceExclusive, partialName, readSnapshotFile, SNAPSHOT_EXT } from './snapshot.mjs';
import { SIMPLEFIN_FILE, convertHouseholdVault } from './vault-convert.mjs';
import {
  PURPOSES, householdRoot, openConnectionSecret, provisionDataKey, readObject, readRegularFile, unwrapDataKey,
} from './household-vault.mjs';
import { fsyncDir, fsyncFile } from './fsutil.mjs';

export const PHASES = Object.freeze(['preflight', 'snapshot', 'source-schema', 'stage', 'verify', 'root-published', 'before-manifest',
  'manifest', 'retire', 'complete']);
export const JOURNAL_FILE = 'tenancy-migration.json';
export const LOCK_FILE = 'tenancy-migration.lock';
export const OPERATION_KIND = 'tenancy-migration';

const HOUSEHOLDS = 'households';
const TREES = Object.freeze(['packs', 'outbox']);
// Retired from the data root, in this order. The store's side files travel with it.
const RETIRED = Object.freeze([DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`, SECRET_FILE, 'files', 'packs', 'outbox']);
const MOVED_TABLE = 'api_keys';

// The server reads these two files after the migration; one inside an entry the retire phase
// renames away would vanish under the running server, so it refuses before any change.
function refuseRetiredSecrets(dataDir, files) {
  const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
  for (const file of files) {
    if (typeof file !== 'string' || !file) continue;
    const target = real(file);
    for (const name of RETIRED) {
      const rel = relative(real(join(dataDir, name)), target);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw refuse('secret_in_retired_entry');
    }
  }
}
const MIB = 1024 * 1024;

const refuse = code => codeError(code);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const lstatOrNull = path => lstatSync(path, { throwIfNoEntry: false }) ?? null;
const stagingName = operationId => `staging-${operationId}`;
const legacyName = operationId => `legacy-${operationId}`;
const snapshotRel = operationId => `${SNAPSHOT_DIR}/tenancy-${operationId}${SNAPSHOT_EXT}`;
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(c => c.name);

// --------------------------------------------------------------------------- digests

function hasRowid(db, table) {
  try {
    db.prepare(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 0`).all();
    return true;
  } catch {
    return false;
  }
}

// Digest rules: the moved table is gone after staging, schema_migrations is compared on the ids
// before the cutover, the SimpleFIN secret changes envelope (its plaintext is checked apart), store
// migration 028 adds two nullable columns to preferences and store migration 031 adds the nullable
// spend_ledger.round_id; migration 032 adds accounts.archived_at and files.removed_at,
// and migration 033 adds preferences.definition_id. The schema-26 source lacks these columns.
const TABLE_RULES = Object.freeze({
  schema_migrations: { where: `id <= ${PRE_TENANCY_SCHEMA}` },
  simplefin_connection: { omit: ['access_blob'] },
  preferences: { omit: ['origin', 'conversation_key', 'definition_id'] },
  spend_ledger: { omit: ['round_id'] },
  accounts: { omit: ['archived_at'] },
  files: { omit: ['removed_at'] },
  column_mappings: { omit: ['schema_version', 'mapping_version', 'approval_status', 'approved_by', 'approved_at', 'structural_context', 'header_signature'] },
});

// { count, sha256 } of a table, every row carrying its rowid (as __rowid) when the table has one.
function tableDigest(db, table) {
  const { omit = [], where = null } = TABLE_RULES[table] ?? {};
  const rowid = hasRowid(db, table);
  const rows = db.prepare(`SELECT ${rowid ? 'rowid AS __rowid, ' : ''}* FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ''}`).all()
    .map(r => {
      const out = { ...r };
      for (const c of omit) delete out[c];
      return out;
    });
  return rowsDigest(rows);
}

function storeDigests(db, tables) {
  return Object.fromEntries(tables.map(t => [t, tableDigest(db, t)]));
}

const sameDigest = (a, b) => !!a && !!b && a.count === b.count && a.sha256 === b.sha256;
const sameDigestMap = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(k => sameDigest(a[k], b[k]));

// Regular files of a tree as relative path -> sha256 (empty when absent); symlinks and special
// files refuse.
function treeHashes(dir, prefix = '') {
  const out = {};
  const st = lstatOrNull(dir);
  if (!st) return out;
  if (st.isSymbolicLink()) throw refuse('symlink_refused');
  if (!st.isDirectory()) throw refuse('special_file_refused');
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const s = lstatSync(path);
    if (s.isSymbolicLink()) throw refuse('symlink_refused');
    if (s.isDirectory()) Object.assign(out, treeHashes(path, rel));
    else if (s.isFile()) out[rel] = sha256(readFileSync(path));
    else throw refuse('special_file_refused');
  }
  return out;
}

// Paths stay out of the journal: only the count and one digest over the sorted (path, hash) pairs.
function hashesDigest(map) {
  const lines = Object.keys(map).sort().map(k => `${k}\u0000${map[k]}`);
  return { count: lines.length, sha256: sha256(lines.join('\n')) };
}

function treeSize(path) {
  const st = lstatOrNull(path);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const name of readdirSync(path)) n += treeSize(join(path, name));
  return n;
}

function defaultDiskFree(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity; // unknown: let the writes fail instead
  }
}

// --------------------------------------------------------------------------- files

function privateDir(path) {
  const st = lstatOrNull(path);
  if (!st) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw refuse('target_exists');
}

// Copy a tree of regular files (0600) and directories (0700); symlinks and special files refuse.
function copyTree(from, to) {
  const st = lstatOrNull(from);
  if (!st) return;
  if (st.isSymbolicLink()) throw refuse('symlink_refused');
  if (!st.isDirectory()) throw refuse('special_file_refused');
  mkdirSync(to, { mode: 0o700 });
  chmodSync(to, 0o700);
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name);
    const dst = join(to, name);
    const s = lstatSync(src);
    if (s.isSymbolicLink()) throw refuse('symlink_refused');
    if (s.isDirectory()) copyTree(src, dst);
    else if (s.isFile()) {
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      chmodSync(dst, 0o600);
      fsyncFile(dst);
    } else throw refuse('special_file_refused');
  }
  fsyncFile(to);
}

function fsyncTree(path) {
  const st = lstatSync(path);
  if (st.isDirectory()) for (const name of readdirSync(path)) fsyncTree(join(path, name));
  fsyncFile(path);
}

// The MCP HMAC secret of the source (`<dataDir>/api-key-secret`, 64 hex characters), or null.
function sourceSecret(dataDir) {
  const path = join(dataDir, SECRET_FILE);
  const st = lstatOrNull(path);
  if (!st) return null;
  if (!st.isFile()) throw refuse('mcp_secret_mismatch');
  const text = readFileSync(path, 'latin1').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw refuse('mcp_secret_mismatch');
  return Buffer.from(text, 'hex');
}

// --------------------------------------------------------------------------- platform reads

function singleHousehold(platform) {
  const rows = platform.prepare('SELECT * FROM households').all();
  if (rows.length !== 1) throw refuse('ambiguous_household');
  return rows[0];
}

// The completed tenancy-migration operation of the household, when the platform and root prove it.
function completedOperation(platform, dataDir, householdId) {
  if (!columnsOf(platform, 'households').includes('storage_root')) return null;
  const hh = platform.prepare('SELECT storage_root FROM households WHERE id = ?').get(householdId);
  const ops = platform.prepare("SELECT id FROM platform_operations WHERE kind = ? AND status = 'done'").all(OPERATION_KIND);
  if (!hh || hh.storage_root !== householdRootRel(householdId) || ops.length !== 1) return null;
  const file = join(dataDir, householdRootRel(householdId), DB_FILE);
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file);
  try {
    return storeIdentity(db)?.householdId === householdId ? ops[0].id : null;
  } finally {
    db.close();
  }
}

// The manifest transaction committed for this operation.
function manifestCommitted(platform, journal) {
  if (!columnsOf(platform, 'households').includes('storage_root')) return false;
  const op = platform.prepare('SELECT 1 AS x FROM platform_operations WHERE id = ? AND kind = ?').get(journal.operationId, OPERATION_KIND);
  const hh = platform.prepare('SELECT storage_root FROM households WHERE id = ?').get(journal.householdId);
  return !!op && hh?.storage_root === householdRootRel(journal.householdId);
}

// --------------------------------------------------------------------------- preflight

// Every check a fresh source must pass. Read-only (a rerun removes its own staging dir first).
function preflight({ dataDir, platform, source, legacyKey, mcpSecret, diskFree }) {
  if (platform.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'households'").get() == null) throw refuse('platform_invalid');
  const hh = singleHousehold(platform);
  if (hh.mode !== 'real') throw refuse('not_real_store');
  if (hh.status !== 'active' || hh.serves_store !== 1) throw refuse('household_not_active');
  if (hh.storage_root != null) throw refuse('target_exists');
  for (const table of ['household_memberships', 'household_invitations', 'auth_sessions']) {
    const n = platform.prepare(`SELECT count(*) AS n FROM ${table} WHERE household_id IS NOT NULL AND household_id != ?`).get(hh.id).n;
    if (n > 0) throw refuse('ambiguous_household');
  }

  if (storeMode(source) !== 'real') throw refuse('not_real_store');
  const identity = storeIdentity(source);
  if (!identity || identity.householdId !== hh.id) throw refuse('household_store_mismatch');

  const households = join(dataDir, HOUSEHOLDS);
  const hst = lstatOrNull(households);
  if (hst && (!hst.isDirectory() || readdirSync(households).length > 0)) throw refuse('target_exists');
  if (readdirSync(dataDir).some(n => n.startsWith('legacy-'))) throw refuse('target_exists');

  checkLegacyKey(dataDir, source, legacyKey);

  checkMcpSecret(dataDir, source, mcpSecret);

  const store = treeSize(join(dataDir, DB_FILE)) + treeSize(join(dataDir, `${DB_FILE}-wal`));
  const trees = ['files', ...TREES].reduce((n, t) => n + treeSize(join(dataDir, t)), 0);
  if (!(Number(diskFree(dataDir)) >= store * 3 + trees * 2 + 16 * MIB)) throw refuse('insufficient_space');
  return hh;
}

// The supplied MCP secret must equal the source's api-key-secret, so moved MCP keys keep verifying.
// Checked in preflight and again before every manifest attempt (a rerun may supply another file).
function checkMcpSecret(dataDir, source, mcpSecret) {
  const keys = hasTable(source, MOVED_TABLE) ? source.prepare(`SELECT count(*) AS n FROM ${MOVED_TABLE}`).get().n : 0;
  const secret = sourceSecret(dataDir);
  if (secret ? !timingSafeEqual(secret, mcpSecret) : keys > 0) throw refuse('mcp_secret_mismatch');
}

// The source's file trees (vault blobs, packs, outbox) as one digest each: recorded with the source
// digest and rechecked before publication, since a store-only digest misses a changed file.
const SOURCE_TREES = Object.freeze(['files', ...TREES]);
function sourceTrees(dataDir) {
  return Object.fromEntries(SOURCE_TREES.map(t => [t, hashesDigest(treeHashes(join(dataDir, t)))]));
}
function sameSourceTrees(dataDir, recorded) {
  if (!recorded || typeof recorded !== 'object') return false;
  const now = sourceTrees(dataDir);
  return SOURCE_TREES.every(t => sameDigest(now[t], recorded[t]));
}

// The legacy key must open the first vault object, if there is one.
function checkLegacyKey(dataDir, db, legacyKey) {
  const file = db.prepare('SELECT id FROM files WHERE stored_path IS NOT NULL ORDER BY id LIMIT 1').get()
    ?? db.prepare('SELECT id FROM advisor_packets ORDER BY id LIMIT 1').get();
  try {
    if (file) legacyDecrypt(legacyKey, readRegularFile(join(dataDir, 'files', `${file.id}.bin`)), file.id);
    else {
      const conn = db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get();
      if (conn) legacyDecrypt(legacyKey, Buffer.from(String(conn.access_blob), 'base64'), LEGACY_SIMPLEFIN_AAD);
    }
  } catch {
    throw refuse('legacy_key_invalid');
  }
}

// --------------------------------------------------------------------------- snapshot

async function snapshot(ctx) {
  const { dataDir, journal, backupKey, source, platform } = ctx;
  const rel = snapshotRel(journal.operationId);
  const final = join(dataDir, rel);
  const dir = join(dataDir, SNAPSHOT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (name.includes(`.partial-${journal.operationId}`) || name.includes(`.copy-${journal.operationId}`)) rmSync(join(dir, name), { force: true });
  }
  rmSync(partialName(final, journal.operationId), { force: true });
  let record;
  if (existsSync(final)) {
    let snap;
    try { snap = readSnapshotFile(final, backupKey); } catch { throw refuse('snapshot_mismatch'); }
    if (snap.manifest.operationId !== journal.operationId || (journal.snapshot && journal.snapshot.sha256 !== snap.sha256)) throw refuse('snapshot_mismatch');
    record = { file: rel, sha256: snap.sha256, logicalDigest: snap.manifest.logicalDigest };
  } else {
    const made = await createSourceSnapshot({
      db: source, dataDir, key: backupKey, out: final, operationId: journal.operationId,
      files: [DB_FILE, SECRET_FILE, 'files', ...TREES], databases: { [PLATFORM_FILE]: platform },
    });
    record = { file: rel, sha256: made.sha256, logicalDigest: made.logicalDigest };
  }
  journal.snapshot = record;
}

// --------------------------------------------------------------------------- stage and verify

async function dataKey(platform, householdId, platformKey) {
  const row = platform.prepare("SELECT 1 AS x FROM household_data_keys WHERE household_id = ? AND status = 'active'").get(householdId);
  return row ? unwrapDataKey(platform, { householdId, platformKey }) : provisionDataKey(platform, { householdId, platformKey });
}

const keyRows = db => db.prepare(`SELECT * FROM ${MOVED_TABLE} ORDER BY id`).all().map(r => ({ ...r }));
const keyDigest = rows => rowsDigest(rows);

// The plaintext sha256 of the source's SimpleFIN secret, or null without a connection.
function legacySecretHash(db, legacyKey) {
  const conn = db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get();
  if (!conn) return null;
  try {
    return sha256(legacyDecrypt(legacyKey, Buffer.from(String(conn.access_blob), 'base64'), LEGACY_SIMPLEFIN_AAD));
  } catch {
    throw refuse('legacy_key_invalid');
  }
}

async function stage(ctx) {
  const { dataDir, journal, source, platform, platformKey, legacyKey } = ctx;
  const op = journal.operationId;
  privateDir(join(dataDir, HOUSEHOLDS));
  const stagingRel = `${HOUSEHOLDS}/${stagingName(op)}`;
  const staging = join(dataDir, stagingRel);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);

  const storeFile = join(staging, DB_FILE);
  await copyDatabase(source, storeFile);
  for (const t of TREES) copyTree(join(dataDir, t), join(staging, t));

  const handle = await dataKey(platform, journal.householdId, platformKey);
  const root = await householdRoot({ dataRoot: dataDir, householdId: journal.householdId, relativeRoot: stagingRel });
  const staged = openDb(storeFile);
  try {
    const bundle = await convertHouseholdVault({ db: staged, sourceDir: dataDir, legacyKey, root, handle, operationId: op });
    const bundleDir = join(staging, bundle.path);
    const filesDir = join(staging, 'files');
    mkdirSync(filesDir, { mode: 0o700 });
    const bundleFiles = join(bundleDir, 'files');
    for (const name of readdirSync(bundleFiles)) renameSync(join(bundleFiles, name), join(filesDir, name));
    fsyncFile(filesDir);
    if (bundle.simplefin) {
      const text = readRegularFile(join(bundleDir, SIMPLEFIN_FILE)).toString('latin1');
      staged.prepare('UPDATE simplefin_connection SET access_blob = ? WHERE id = 1').run(text);
    }
    rmSync(bundleDir, { recursive: true, force: true });
    fsyncFile(join(staging, 'work'));

    const keys = hasTable(staged, MOVED_TABLE) ? keyRows(staged) : [];
    journal.apiKeys = keyDigest(keys);
    writeJournal(ctx.journalFile, journal);
    if (hasTable(staged, MOVED_TABLE)) staged.exec(`DELETE FROM ${MOVED_TABLE}`);
    migrate(staged);
    if (hasTable(staged, MOVED_TABLE)) throw refuse('staging_invalid');
    staged.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    staged.close();
  }
  fsyncTree(staging);
  return staging;
}

// Every check of a household root that holds the migrated store, against `expected` (the source's
// figures on first verification, the journal's on a rerun). Returns the figures it found.
async function verifyRoot(ctx, relativeRoot, expected) {
  const { dataDir, journal, platform, platformKey } = ctx;
  const rootPath = join(dataDir, relativeRoot);
  // A plain open would create a missing file.
  if (!lstatOrNull(join(rootPath, DB_FILE))?.isFile()) throw refuse('household_root_missing');
  const db = new DatabaseSync(join(rootPath, DB_FILE));
  let found;
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw refuse('staging_invalid');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw refuse('staging_invalid');
    if (hasTable(db, MOVED_TABLE)) throw refuse('staging_invalid');
    if (storeIdentity(db)?.householdId !== journal.householdId) throw refuse('household_store_mismatch');
    const present = new Set(listTables(db));
    if (!Object.keys(expected.tables).every(t => present.has(t))) throw refuse('staging_invalid');
    const tables = storeDigests(db, Object.keys(expected.tables));

    const handle = await unwrapDataKey(platform, { householdId: journal.householdId, platformKey });
    const root = await householdRoot({ dataRoot: dataDir, householdId: journal.householdId, relativeRoot });
    const objects = [
      ...db.prepare('SELECT id, stored_path, sha256 FROM files WHERE stored_path IS NOT NULL ORDER BY id').all().map(r => ({ ...r, purpose: PURPOSES.upload })),
      ...db.prepare('SELECT id, stored_path, sha256 FROM advisor_packets ORDER BY id').all().map(r => ({ ...r, purpose: PURPOSES.advisorPacket })),
    ];
    for (const o of objects) {
      let plain;
      try {
        plain = await readObject({ root, handle, purpose: o.purpose, objectId: o.id, storedPath: o.stored_path });
      } catch {
        throw refuse('staging_invalid');
      }
      if (sha256(plain) !== o.sha256) throw refuse('staging_invalid');
    }
    const blobs = readdirSync(join(rootPath, 'files')).filter(n => n.endsWith('.bin')).sort();
    if (blobs.join('/') !== objects.map(o => `${o.id}.bin`).sort().join('/')) throw refuse('staging_invalid');
    const conn = db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get();
    let simplefin = null;
    if (conn) {
      try { simplefin = sha256(openConnectionSecret(handle, String(conn.access_blob))); } catch { throw refuse('staging_invalid'); }
    }
    found = {
      tables,
      objects: rowsDigest(objects.map(o => ({ purpose: o.purpose, id: o.id, sha256: o.sha256 }))),
      simplefin,
      trees: Object.fromEntries(TREES.map(t => [t, hashesDigest(treeHashes(join(rootPath, t)))])),
    };
  } finally {
    db.close();
  }
  const same = sameDigestMap(found.tables, expected.tables) && sameDigest(found.objects, expected.objects ?? found.objects)
    && found.simplefin === expected.simplefin && TREES.every(t => sameDigest(found.trees[t], expected.trees[t]));
  if (!same) throw refuse('staging_invalid');
  return found;
}

// The source's figures that the staged root must reproduce.
function sourceFigures(ctx) {
  const { source, dataDir, legacyKey } = ctx;
  const tables = listTables(source).filter(t => t !== MOVED_TABLE);
  return {
    tables: storeDigests(source, tables),
    simplefin: legacySecretHash(source, legacyKey),
    trees: Object.fromEntries(TREES.map(t => [t, hashesDigest(treeHashes(join(dataDir, t)))])),
  };
}

// --------------------------------------------------------------------------- manifest

// The platform api_keys rows for the source rows: user_id kept when that account exists, an
// ownerless key bound to the only active admin, else kept unbound and revoked.
function platformKeys(platform, journal, rows) {
  const admins = platform.prepare(`SELECT m.user_id FROM household_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.household_id = ? AND m.role = 'admin' AND m.status = 'active'`).all(journal.householdId).map(r => r.user_id);
  const userExists = platform.prepare('SELECT 1 AS x FROM users WHERE id = ?');
  const revokedAt = new Date(journal.startedAt).toISOString();
  return rows.map(r => {
    const owner = r.user_id != null && userExists.get(r.user_id) ? r.user_id : (admins.length === 1 ? admins[0] : null);
    const member = owner === null ? null : platform.prepare('SELECT version, status FROM household_memberships WHERE household_id = ? AND user_id = ?').get(journal.householdId, owner);
    const unbound = (owner === null || member?.status !== 'active') && r.revoked_at == null;
    return {
      id: r.id, household_id: journal.householdId, user_id: owner, name: r.name, key_hash: r.key_hash, scopes: r.scopes,
      created_at: r.created_at, last_used_at: r.last_used_at ?? null,
      revoked_at: unbound ? revokedAt : (r.revoked_at ?? null), revoked_code: unbound ? (owner === null ? 'migration_no_creator' : 'migration_inactive_creator') : null,
      household_generation: 1,
      membership_version: member?.version ?? null,
    };
  });
}

// No passkey may be lost. The journal records, before any change, the passkey count, a digest of
// the set of credential ids and a digest of every row byte for byte (credential id, user, public
// key, sign counter, transports, name, times). Publication checks the platform against it before
// the manifest transaction and again inside it before COMMIT; any difference refuses
// passkeys_changed with nothing published.
function passkeyFingerprint(platform) {
  const rows = platform.prepare('SELECT * FROM passkeys').all();
  return { count: rows.length, ids: sha256(rows.map(r => r.id).sort().join('\n')), rows: rowsDigest(rows).sha256 };
}

function checkPasskeys(platform, journal) {
  const was = journal.passkeys;
  if (!was || !Number.isInteger(was.count) || typeof was.ids !== 'string' || typeof was.rows !== 'string') throw refuse('journal_invalid');
  const now = passkeyFingerprint(platform);
  if (now.count !== was.count || now.ids !== was.ids || now.rows !== was.rows) throw refuse('passkeys_changed');
}

const KEY_COLUMNS = ['id', 'household_id', 'user_id', 'name', 'key_hash', 'scopes', 'created_at', 'last_used_at', 'revoked_at', 'revoked_code', 'household_generation', 'membership_version'];

function publishManifest(ctx) {
  const { platform, source, journal } = ctx;
  // The published root was verified against the journal; a source that changed since the journal
  // recorded it (a write between a crash and this rerun) refuses rather than being retired unseen.
  if (!journal.sourceDigest || logicalDigest(source) !== journal.sourceDigest) throw refuse('source_changed');
  if (!sameSourceTrees(ctx.dataDir, journal.sourceTrees)) throw refuse('source_changed');
  checkMcpSecret(ctx.dataDir, source, ctx.mcpSecret);
  const rows = hasTable(source, MOVED_TABLE) ? keyRows(source) : [];
  if (!sameDigest(keyDigest(rows), journal.apiKeys)) throw refuse('source_changed');
  checkPasskeys(platform, journal);
  const keys = platformKeys(platform, journal, rows);
  const now = Date.now();
  const hh = journal.householdId;
  platform.exec('BEGIN IMMEDIATE');
  try {
    const insert = platform.prepare(`INSERT INTO api_keys (${KEY_COLUMNS.join(', ')}) VALUES (${KEY_COLUMNS.map(() => '?').join(', ')})`);
    for (const k of keys) insert.run(...KEY_COLUMNS.map(c => k[c]));
    initOutbound(platform, hh, { enabled: false, now });
    platform.exec('DELETE FROM auth_challenges');
    platform.exec('DELETE FROM auth_sessions');
    platform.exec('DELETE FROM auth_tokens');
    platform.prepare('UPDATE household_invitations SET revoked_at = ? WHERE consumed_at IS NULL AND revoked_at IS NULL').run(now);
    const set = platform.prepare('UPDATE households SET storage_root = ?, generation = 1, updated_at = ? WHERE id = ? AND storage_root IS NULL')
      .run(householdRootRel(hh), now, hh);
    if (Number(set.changes) !== 1) throw refuse('target_exists');
    const detail = { apiKeys: keys.length, revoked: keys.filter(k => k.revoked_code).length, tables: Object.keys(journal.figures.tables).length };
    platform.prepare(`INSERT INTO platform_operations (id, kind, phase, status, started_at, updated_at, detail)
      VALUES (?, ?, 'manifest', 'running', ?, ?, ?)`).run(journal.operationId, OPERATION_KIND, journal.startedAt, now, JSON.stringify(detail));

    const written = platform.prepare(`SELECT ${KEY_COLUMNS.join(', ')} FROM api_keys WHERE household_id = ? ORDER BY id`).all(hh).map(r => ({ ...r }));
    const outbound = platform.prepare('SELECT jobs + email + simplefin + engine AS n FROM household_outbound WHERE household_id = ?').get(hh);
    const live = platform.prepare(`SELECT (SELECT count(*) FROM auth_sessions) + (SELECT count(*) FROM auth_challenges)
      + (SELECT count(*) FROM auth_tokens) + (SELECT count(*) FROM household_invitations WHERE consumed_at IS NULL AND revoked_at IS NULL) AS n`).get();
    if (!sameDigest(rowsDigest(written), rowsDigest(keys)) || outbound?.n !== 0 || live.n !== 0) throw refuse('manifest_invalid');
    checkPasskeys(platform, journal);
    platform.exec('COMMIT');
  } catch (e) {
    platform.exec('ROLLBACK');
    throw e;
  }
}

// --------------------------------------------------------------------------- retire

function retire(dataDir, operationId) {
  const legacy = join(dataDir, legacyName(operationId));
  privateDir(legacy);
  for (const name of RETIRED) {
    const from = join(dataDir, name);
    const to = join(legacy, name);
    const src = lstatOrNull(from);
    const dst = lstatOrNull(to);
    if (src && dst) throw refuse('retire_conflict');
    if (src) renameSync(from, to);
  }
  fsyncFile(legacy);
  fsyncFile(dataDir);
}

// --------------------------------------------------------------------------- run

// Journal `name` as the last phase reached (with whatever the phase recorded), then the hook.
async function nextPhase(ctx, name) {
  ctx.journal.phase = name;
  writeJournal(ctx.journalFile, ctx.journal);
  await ctx.onPhase(name);
}

function finish(ctx) {
  markOperationDone(ctx.platformFile, ctx.journal.operationId);
  return { status: 'complete', operationId: ctx.journal.operationId, householdId: ctx.journal.householdId };
}

export async function migrateTenancy({
  dataDir, backupKeyFile, legacyKeyFile, platformKeyFile, mcpSecretFile, onPhase = async () => {}, diskFree = defaultDiskFree,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw refuse('not_real_store');
  const root = resolve(dataDir);
  const platformFile = join(root, PLATFORM_FILE);
  const journalFile = join(root, JOURNAL_FILE);
  const lockFile = join(root, LOCK_FILE);
  if (existsSync(join(root, PLATFORM_LOCK_FILE))) throw refuse('platform_migration_in_progress');
  if (!existsSync(platformFile)) throw refuse('platform_migration_required');
  refuseRetiredSecrets(root, [mcpSecretFile, platformKeyFile]);

  const journal = readJson(journalFile, 'journal_invalid');
  const lock = readJson(lockFile, 'stale_lock_mismatch');
  if (lock && (!journal || lock.operationId !== journal.operationId)) throw refuse('stale_lock_mismatch');
  const backupKey = loadBackupKey(backupKeyFile);
  const platformKey = loadPlatformKey(platformKeyFile);
  const legacyKey = loadLegacyKey(legacyKeyFile);
  const mcpSecret = loadMcpSecretFile(mcpSecretFile);

  const ctx = { dataDir: root, platformFile, journalFile, lockFile, journal, backupKey, platformKey, legacyKey, mcpSecret, onPhase, source: null, platform: null };
  ctx.platform = new DatabaseSync(platformFile);
  try {
    ctx.platform.exec('PRAGMA busy_timeout = 5000');
    ctx.platform.exec('PRAGMA foreign_keys = ON');
    if (journal) return await resume(ctx, { mcpSecret, diskFree });

    // A journal-less run: a completed migration is reconciled; any other trace of one refuses.
    const hh = singleHousehold(ctx.platform);
    const done = completedOperation(ctx.platform, root, hh.id);
    if (done) {
      markOperationDone(platformFile, done);
      return { status: 'complete', operationId: done, householdId: hh.id };
    }
    ctx.source = openSourceExclusive(join(root, DB_FILE));
    preflight({ dataDir: root, platform: ctx.platform, source: ctx.source, legacyKey, mcpSecret, diskFree });
    ctx.journal = {
      version: 1, operationId: newOperationId(), householdId: hh.id, startedAt: Date.now(), phase: 'preflight',
      passkeys: passkeyFingerprint(ctx.platform),
    };
    writeJournal(journalFile, ctx.journal);
    writeLock(lockFile, ctx.journal.operationId);
    await onPhase('preflight');
    return await fromSnapshot(ctx);
  } finally {
    try { ctx.source?.close(); } catch { /* already closed */ }
    try { ctx.platform?.close(); } catch { /* already closed */ }
  }
}

// A run with a journal: resume from observed state.
async function resume(ctx, { mcpSecret, diskFree }) {
  const { dataDir, journal, platform } = ctx;
  writeLock(ctx.lockFile, journal.operationId);
  if (journal.phase === 'complete') {
    if (!manifestCommitted(platform, journal)) throw refuse('journal_invalid');
    const r = finish(ctx);
    removeLock(ctx.lockFile, journal.operationId);
    return r;
  }
  const rootRel = householdRootRel(journal.householdId);
  if (manifestCommitted(platform, journal)) {
    reopenPlatform(ctx);
    await verifyRoot(ctx, rootRel, journal.figures);
    await ctx.onPhase('manifest');
    return afterManifest(ctx);
  }
  const staging = join(dataDir, HOUSEHOLDS, stagingName(journal.operationId));
  ctx.source = openSourceExclusive(join(dataDir, DB_FILE));
  if (existsSync(join(dataDir, rootRel))) {
    if (!journal.figures) throw refuse('journal_invalid');
    rmSync(staging, { recursive: true, force: true });
    reopenPlatform(ctx);
    await verifyRoot(ctx, rootRel, journal.figures);
    await nextPhase(ctx, 'root-published');
    return publishAndFinish(ctx);
  }
  rmSync(staging, { recursive: true, force: true });
  if (lstatOrNull(join(dataDir, HOUSEHOLDS))) fsyncFile(join(dataDir, HOUSEHOLDS));
  const hh = preflight({ dataDir, platform, source: ctx.source, legacyKey: ctx.legacyKey, mcpSecret, diskFree });
  if (hh.id !== journal.householdId) throw refuse('household_store_mismatch');
  await ctx.onPhase('preflight');
  return fromSnapshot(ctx);
}

// The platform on a connection with every platform migration (003 adds the runtime tables).
function reopenPlatform(ctx) {
  ctx.platform.close();
  ctx.platform = null;
  ctx.platform = openPlatform(ctx.platformFile);
}

async function fromSnapshot(ctx) {
  const { journal } = ctx;
  await snapshot(ctx);
  await nextPhase(ctx, 'snapshot');

  migrate(ctx.source, { through: PRE_TENANCY_SCHEMA });
  const digest = logicalDigest(ctx.source);
  const trees = sourceTrees(ctx.dataDir);
  if (journal.sourceDigest && (journal.sourceDigest !== digest || !sameSourceTrees(ctx.dataDir, journal.sourceTrees))) throw refuse('source_changed');
  journal.sourceDigest = digest;
  journal.sourceTrees = trees;
  await nextPhase(ctx, 'source-schema');

  reopenPlatform(ctx);
  const staging = await stage(ctx);
  await nextPhase(ctx, 'stage');

  const expected = sourceFigures(ctx);
  const stagingRel = `${HOUSEHOLDS}/${stagingName(journal.operationId)}`;
  const found = await verifyRoot(ctx, stagingRel, expected);
  journal.figures = { ...expected, objects: found.objects };
  await nextPhase(ctx, 'verify');

  const final = join(ctx.dataDir, householdRootRel(journal.householdId));
  if (lstatOrNull(final)) throw refuse('target_exists');
  renameSync(staging, final);
  fsyncDir(final);
  await nextPhase(ctx, 'root-published');
  return publishAndFinish(ctx);
}

async function publishAndFinish(ctx) {
  await ctx.onPhase('before-manifest');
  publishManifest(ctx);
  await nextPhase(ctx, 'manifest');
  return afterManifest(ctx);
}

async function afterManifest(ctx) {
  // The source closes first so its WAL is checkpointed and it moves as one file.
  try { ctx.source?.close(); } catch { /* already closed */ }
  ctx.source = null;
  retire(ctx.dataDir, ctx.journal.operationId);
  await nextPhase(ctx, 'retire');
  const r = finish(ctx);
  await nextPhase(ctx, 'complete');
  removeLock(ctx.lockFile, ctx.journal.operationId);
  return r;
}


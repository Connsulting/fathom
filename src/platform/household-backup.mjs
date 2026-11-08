import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, getSetting, listMigrations, openDb, schemaVersion } from '../store/db.mjs';
import { codeError, newOperationId, storeIdentity } from './db.mjs';
import { checkHouseholdRoot } from './runtime.mjs';
import { loadBackupKey, loadPlatformKey } from './backup-key.mjs';
import { createSourceSnapshot, openSourceExclusive, readSnapshotFile, sha256File } from './snapshot.mjs';
import { fsyncDir, fsyncFile, writeFileAtomic } from './fsutil.mjs';
import { dataKeyHandle, isId, openConnectionSecret, openObject, PURPOSES, readRegularFile, unwrapWrappedKey } from './household-vault.mjs';

const FORMAT = 'fathom-household-backup/1';
const TREES = ['files', 'packs', 'outbox'];
const retentionMs = config => (config.backupRetentionDays ?? 7) * 86400000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const instanceId = platform => JSON.parse(platform.prepare("SELECT value FROM platform_settings WHERE key = 'backup_instance_id'").get().value);
const operation = (p, id) => p.prepare('SELECT * FROM household_backup_operations WHERE id = ?').get(id);
const household = (p, id) => p.prepare('SELECT * FROM households WHERE id = ?').get(id);
const memberships = (p, id) => p.prepare('SELECT user_id AS userId, role, status, version FROM household_memberships WHERE household_id = ? ORDER BY user_id').all(id).map(r => ({ ...r }));
const safeFile = path => path === DB_FILE || /^(files|packs|outbox)\/(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]+$/.test(path);
const inDir = (parent, path) => { const r = relative(parent, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const assert = (ok, code) => { if (!ok) throw codeError(code); };
const transaction = (p, fn) => {
  p.exec('BEGIN IMMEDIATE');
  try { const r = fn(); p.exec('COMMIT'); return r; }
  catch (e) { p.exec('ROLLBACK'); throw e; }
};
const phase = (p, id, name) => p.prepare('UPDATE household_backup_operations SET phase = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
const result = row => ({ operationId: row.id, status: row.status, code: row.code, fileCount: row.file_count, byteCount: row.byte_count });
const availableBytes = path => { const s = statfsSync(path); return Number(s.bavail) * Number(s.bsize); };
function spaceFor(path, bytes, space = availableBytes) { assert(space(path) >= bytes, 'backup_space_required'); }

function activeHousehold(platform, id) {
  const row = isId(id) ? household(platform, id) : null;
  assert(row?.status === 'active' && row.storage_root, 'household_unavailable');
  assert(!platform.prepare("SELECT 1 FROM household_backup_operations WHERE household_id = ? AND status IN ('queued', 'running')").get(id), 'household_operation_busy');
  return row;
}

function destination(config) {
  assert(typeof config.backupDestination === 'string' && isAbsolute(config.backupDestination), 'backup_destination_invalid');
  const path = resolve(config.backupDestination);
  let st;
  try { st = lstatSync(path); } catch { throw codeError('backup_destination_invalid'); }
  assert(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && realpathSync(path) === path, 'backup_destination_invalid');
  assert(!inDir(join(resolve(config.dataDir), 'households'), path), 'backup_destination_invalid');
  return path;
}

function treeBytes(root, path) {
  if (!existsSync(path)) {
    assert(!lstatSync(path, { throwIfNoEntry: false }), 'snapshot_source_invalid');
    return 0;
  }
  const st = lstatSync(path);
  assert(!st.isSymbolicLink(), 'snapshot_source_invalid');
  if (st.isFile()) return st.size;
  assert(st.isDirectory(), 'snapshot_source_invalid');
  return readdirSync(path).reduce((n, name) => n + treeBytes(root, join(path, name)), 0);
}

function syncTree(path) {
  const st = lstatSync(path);
  assert(!st.isSymbolicLink() && (st.isDirectory() || st.isFile()), 'backup_inventory_invalid');
  if (st.isDirectory()) for (const name of readdirSync(path)) syncTree(join(path, name));
  fsyncFile(path);
}

function keyMetadata(platform, id) {
  const rows = platform.prepare('SELECT key_version, wrapped_key, status FROM household_data_keys WHERE household_id = ? ORDER BY key_version').all(id);
  assert(rows.length && rows.some(r => r.status === 'active'), 'data_key_missing');
  return rows.map(r => ({ version: r.key_version, wrappedKey: Buffer.from(r.wrapped_key).toString('base64'), status: r.status }));
}

function keyHandles(platform, config, id, keys) {
  const master = loadPlatformKey(config.platformKeyFile);
  try {
    return new Map(keys.map(k => {
      const current = platform.prepare('SELECT wrapped_key FROM household_data_keys WHERE household_id = ? AND key_version = ?').get(id, k.version);
      assert(current, 'data_key_missing');
      const raw = unwrapWrappedKey(master, { householdId: id, version: k.version, wrapped: current.wrapped_key });
      try {
        const saved = unwrapWrappedKey(master, { householdId: id, version: k.version, wrapped: Buffer.from(k.wrappedKey, 'base64') });
        try { assert(raw.equals(saved), 'data_key_invalid'); } finally { saved.fill(0); }
        return [k.version, dataKeyHandle({ householdId: id, version: k.version, key: raw })];
      } finally { raw.fill(0); }
    }));
  } finally { master.fill(0); }
}

function validateStore(db, id, mode, version) {
  assert(storeIdentity(db)?.householdId === id && getSetting(db, 'mode') === mode, 'backup_identity_mismatch');
  const expected = listMigrations().map(m => ({ id: m.id, name: m.name }));
  const actual = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all().map(r => ({ ...r }));
  assert(schemaVersion(db) === version && JSON.stringify(expected) === JSON.stringify(actual), 'backup_schema_mismatch');
  assert(db.prepare('PRAGMA integrity_check').all().every(r => r.integrity_check === 'ok') && !db.prepare('PRAGMA foreign_key_check').all().length, 'backup_store_invalid');
}

function validateVault(db, files, handles) {
  const known = new Set();
  for (const [table, purpose, size] of [['files', PURPOSES.upload, 'size'], ['advisor_packets', PURPOSES.advisorPacket, 'bytes']]) {
    for (const row of db.prepare(`SELECT id, stored_path, sha256, ${size} AS size FROM ${table} WHERE stored_path IS NOT NULL`).all()) {
      assert(isId(row.id) && row.stored_path === `files/${row.id}.bin`, 'vault_stored_path_invalid');
      const blob = files.get(row.stored_path);
      assert(blob?.length >= 9, 'vault_object_missing');
      const handle = handles.get(blob.readUInt32BE(5));
      assert(handle, 'data_key_missing');
      const plain = openObject(handle, { purpose, objectId: row.id, blob });
      assert(plain.length === row.size && sha(plain) === row.sha256, 'backup_vault_invalid');
      known.add(row.stored_path);
    }
  }
  for (const [path, blob] of files) {
    if (!path.startsWith('files/') || known.has(path)) continue;
    const match = /^files\/([A-Za-z0-9_-]+)\.bin$/.exec(path);
    assert(match && blob.length >= 9, 'backup_vault_invalid');
    const handle = handles.get(blob.readUInt32BE(5));
    assert(handle, 'data_key_missing');
    let valid = false;
    for (const purpose of [PURPOSES.upload, PURPOSES.advisorPacket]) {
      try { openObject(handle, { purpose, objectId: match[1], blob }); valid = true; break; } catch { /* try the other object purpose */ }
    }
    assert(valid, 'backup_vault_invalid');
  }
  const conn = db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get();
  if (conn) {
    const blob = Buffer.from(conn.access_blob, 'base64');
    assert(blob.length >= 9 && handles.has(blob.readUInt32BE(5)), 'data_key_missing');
    openConnectionSecret(handles.get(blob.readUInt32BE(5)), conn.access_blob);
  }
}

function readVault(root) {
  const path = join(root, 'files');
  if (!existsSync(path)) return new Map();
  assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'snapshot_source_invalid');
  return new Map(readdirSync(path).map(n => [`files/${n}`, readRegularFile(join(path, n))]));
}

function preflight(platform, config, row) {
  const root = checkHouseholdRoot(config.dataDir, row.storage_root);
  const db = new DatabaseSync(join(root, DB_FILE), { readOnly: true });
  try {
    const keys = keyMetadata(platform, row.id);
    const version = listMigrations().at(-1).id;
    validateStore(db, row.id, row.mode, version);
    validateVault(db, readVault(root), keyHandles(platform, config, row.id, keys));
    const bytes = Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size)
      + TREES.reduce((n, name) => n + treeBytes(root, join(root, name)), 0);
    return { root, bytes, metadata: { format: FORMAT, instanceId: instanceId(platform), householdId: row.id,
      generation: row.generation, mode: row.mode, schemaVersion: version, keys, memberships: memberships(platform, row.id) } };
  } finally { db.close(); }
}

function insertOperation(platform, row, { id, kind, file, target = null, hash = null, count = 0, bytes = 0, retention = 7 * 86400000 }) {
  platform.prepare(`INSERT INTO household_backup_operations
    (id, household_id, kind, status, phase, bundle_file, bundle_hash, source_root, source_generation, target_root, file_count, byte_count, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, row.id, kind, kind === 'backup' ? 'queued' : 'running', kind === 'backup' ? 'queued' : 'validated', file, hash, row.storage_root,
      row.generation, target, count, bytes, Date.now(), Date.now(), Date.now() + retention);
}

async function suspend({ platform, config, runtimes }, op) {
  transaction(platform, () => {
    const row = household(platform, op.household_id);
    assert(row.storage_root === op.source_root && row.generation === op.source_generation && ['active', 'suspended'].includes(row.status), 'restore_source_changed');
    platform.prepare("UPDATE households SET status = 'suspended', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
    phase(platform, op.id, 'suspended');
  });
  await runtimes?.quiesce(op.household_id);
  return openSourceExclusive(join(checkHouseholdRoot(config.dataDir, op.source_root), DB_FILE));
}

export async function backupHousehold({ platform, config, runtimes = null, householdId, operationId = null, space = availableBytes } = {}) {
  const key = loadBackupKey(config.backupKeyFile);
  let op;
  let db;
  try {
    const dest = destination(config);
    let source;
    if (operationId) {
      op = operation(platform, operationId);
      assert(op?.kind === 'backup' && op.status === 'queued' && op.household_id === householdId, 'backup_operation_invalid');
      source = household(platform, householdId);
      assert(source?.status === 'active' && source.storage_root === op.source_root && source.generation === op.source_generation, 'household_unavailable');
    } else source = activeHousehold(platform, householdId);
    const frozen = preflight(platform, config, source);
    spaceFor(dest, frozen.bytes * 3 + 1048576, space);
    if (!op) {
      const id = newOperationId();
      insertOperation(platform, source, { id, kind: 'backup', file: join(dest, `${id}.fsnap`), retention: retentionMs(config) });
      op = operation(platform, id);
    }
    platform.prepare("UPDATE household_backup_operations SET status = 'running' WHERE id = ?").run(op.id);
    db = await suspend({ platform, config, runtimes }, op);
    validateStore(db, householdId, source.mode, frozen.metadata.schemaVersion);
    validateVault(db, readVault(frozen.root), keyHandles(platform, config, householdId, frozen.metadata.keys));
    const snap = await createSourceSnapshot({ db, dataDir: frozen.root, key, out: op.bundle_file, files: [DB_FILE, ...TREES], operationId: op.id,
      householdBackup: { ...frozen.metadata, memberships: memberships(platform, householdId) } });
    const opened = readSnapshotFile(snap.file, key);
    db.close(); db = null;
    transaction(platform, () => {
      platform.prepare("UPDATE household_backup_operations SET status = 'done', phase = 'complete', bundle_hash = ?, file_count = ?, byte_count = ?, updated_at = ? WHERE id = ?")
        .run(snap.sha256, opened.files.size, readFileSync(snap.file).length, Date.now(), op.id);
      platform.prepare("UPDATE households SET status = 'active', updated_at = ? WHERE id = ? AND storage_root = ? AND generation = ? AND status = 'suspended'")
        .run(Date.now(), householdId, op.source_root, op.source_generation);
      platform.prepare("INSERT INTO audit_events (at, household_id, action, outcome) VALUES (?, ?, 'household.backup', 'ok')").run(Date.now(), householdId);
    });
    return { ...result(operation(platform, op.id)), file: snap.file };
  } catch (err) {
    db?.close(); db = null;
    if (op) transaction(platform, () => {
      platform.prepare("UPDATE household_backup_operations SET status = 'failed', code = 'backup_failed', updated_at = ? WHERE id = ?").run(Date.now(), op.id);
      platform.prepare("UPDATE households SET status = 'active', updated_at = ? WHERE id = ? AND storage_root = ? AND generation = ? AND status = 'suspended'")
        .run(Date.now(), householdId, op.source_root, op.source_generation);
    });
    throw err;
  } finally {
    db?.close(); key.fill(0);
  }
}

function openBundle(platform, config, id, file) {
  const key = loadBackupKey(config.backupKeyFile);
  let bundle;
  try { bundle = readSnapshotFile(file, key); } finally { key.fill(0); }
  const meta = bundle.manifest.householdBackup;
  assert(meta?.format === FORMAT && meta.householdId === id && meta.instanceId === instanceId(platform), 'backup_identity_mismatch');
  assert(meta.mode === household(platform, id)?.mode, 'backup_identity_mismatch');
  assert(meta.schemaVersion === listMigrations().at(-1).id, 'backup_schema_mismatch');
  assert(Array.isArray(meta.keys) && meta.keys.length && Array.isArray(meta.memberships), 'backup_metadata_invalid');
  assert(bundle.files.has(DB_FILE) && [...bundle.files.keys()].every(safeFile), 'backup_inventory_invalid');
  return { ...bundle, meta, handles: keyHandles(platform, config, id, meta.keys) };
}

function validateStage(root, bundle, { compare = true } = {}) {
  treeBytes(root, root);
  if (compare) for (const [path, data] of bundle.files) {
    assert(readRegularFile(join(root, path)).equals(data), 'backup_inventory_invalid');
  }
  const db = new DatabaseSync(join(root, DB_FILE), { readOnly: true });
  try {
    validateStore(db, bundle.meta.householdId, bundle.meta.mode, bundle.meta.schemaVersion);
    validateVault(db, readVault(root), bundle.handles);
  } finally { db.close(); }
}

function reconcileStore(platform, sourceRoot, targetRoot, id) {
  const source = new DatabaseSync(join(sourceRoot, DB_FILE), { readOnly: true });
  const db = openDb(join(targetRoot, DB_FILE));
  try {
    assert(storeIdentity(source)?.householdId === id && storeIdentity(db)?.householdId === id, 'backup_identity_mismatch');
    transaction(db, () => {
      db.exec('DELETE FROM spend_ledger');
      const insert = db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens, round_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const legacy = source.prepare('SELECT * FROM spend_ledger WHERE round_id IS NULL').all();
      const carried = platform.prepare("SELECT * FROM model_rounds WHERE household_id = ? AND kind = 'carry'").all(id);
      const carryMonths = new Set(carried.map(r => r.month));
      for (const r of legacy) if (!carryMonths.has(r.yyyymm)) insert.run(r.ts, r.yyyymm, r.purpose, r.cost_usd, r.model, r.tokens, null);
      for (const r of platform.prepare('SELECT * FROM model_rounds WHERE household_id = ?').all(id)) {
        const cost = r.state === 'settled' ? r.cost_usd : Math.max(r.reserved_usd, r.cost_usd ?? 0);
        insert.run(new Date(r.reserved_at).toISOString(), r.month, r.purpose ?? 'carry', cost, r.model, '{}', r.id);
      }
      db.prepare("UPDATE job_runs SET status = 'interrupted', finished_at = ?, note = 'household_restored' WHERE status = 'running'").run(new Date().toISOString());
      db.exec('DELETE FROM job_lock');
      db.exec("UPDATE simplefin_connection SET status = 'error', error_code = 'restored_confirmation_required'");
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { source.close(); db.close(); }
  fsyncFile(join(targetRoot, DB_FILE)); fsyncDir(join(targetRoot, DB_FILE));
}

async function continueRestore(options, id, onPhase = () => {}) {
  const { platform, config, runtimes } = options;
  let op = operation(platform, id);
  if (op.status === 'done') return { ...result(op), membershipDrift: op.membership_drift, rollbackExpiresAt: op.rollback_expires_at };
  const bundle = openBundle(platform, config, op.household_id, op.bundle_file);
  assert(bundle.sha256 === op.bundle_hash, 'backup_inventory_invalid');
  const root = checkHouseholdRoot(config.dataDir, op.target_root);
  validateStage(root, bundle, { compare: ['validated', 'suspended'].includes(op.phase) });
  if (['validated', 'suspended'].includes(op.phase)) {
    const source = await suspend(options, op);
    source.close();
    await onPhase('suspended');
    transaction(platform, () => {
      const current = household(platform, op.household_id);
      assert(current.status === 'suspended' && current.storage_root === op.source_root && current.generation === op.source_generation, 'restore_source_changed');
      const drift = JSON.stringify(memberships(platform, op.household_id)) === JSON.stringify(bundle.meta.memberships) ? 0 : 1;
      platform.prepare('UPDATE households SET storage_root = ?, generation = generation + 1, updated_at = ? WHERE id = ?').run(op.target_root, Date.now(), op.household_id);
      platform.prepare("UPDATE api_keys SET revoked_at = coalesce(revoked_at, ?), revoked_code = CASE WHEN revoked_at IS NULL THEN 'household_restored' ELSE revoked_code END WHERE household_id = ?")
        .run(new Date().toISOString(), op.household_id);
      platform.prepare('DELETE FROM auth_sessions WHERE household_id = ?').run(op.household_id);
      platform.prepare('UPDATE household_outbound SET jobs = 0, email = 0, simplefin = 0, engine = 0, updated_at = ? WHERE household_id = ?').run(Date.now(), op.household_id);
      platform.prepare("UPDATE household_backup_operations SET phase = 'switched', membership_drift = ?, rollback_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(drift, op.expires_at, Date.now(), id);
    });
    await onPhase('switched');
    op = operation(platform, id);
  }
  const current = household(platform, op.household_id);
  assert(current.status === 'suspended' && current.storage_root === op.target_root && current.generation === op.source_generation + 1, 'restore_source_changed');
  await runtimes?.quiesce(op.household_id);
  if (op.phase === 'switched') {
    reconcileStore(platform, checkHouseholdRoot(config.dataDir, op.source_root), root, op.household_id);
    phase(platform, id, 'finalized');
    await onPhase('finalized');
  }
  transaction(platform, () => {
    platform.prepare("UPDATE households SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), op.household_id);
    platform.prepare("UPDATE household_backup_operations SET status = 'done', phase = 'complete', updated_at = ? WHERE id = ?").run(Date.now(), id);
    platform.prepare("INSERT INTO audit_events (at, household_id, action, outcome) VALUES (?, ?, 'household.restore', 'ok')").run(Date.now(), op.household_id);
  });
  op = operation(platform, id);
  return { ...result(op), membershipDrift: op.membership_drift, rollbackExpiresAt: op.rollback_expires_at };
}

export async function restoreHousehold({ platform, config, runtimes = null, householdId, confirmation, file, onPhase = () => {}, space = availableBytes } = {}) {
  assert(confirmation === householdId && isId(householdId), 'restore_confirmation_required');
  const pending = platform.prepare("SELECT * FROM household_backup_operations WHERE household_id = ? AND kind = 'restore' AND status = 'running'").get(householdId);
  if (pending) {
    assert(sha256File(file) === pending.bundle_hash, 'backup_inventory_invalid');
    return continueRestore({ platform, config, runtimes }, pending.id, onPhase);
  }
  const row = activeHousehold(platform, householdId);
  const bundle = openBundle(platform, config, householdId, file);
  const source = preflight(platform, config, row);
  const bytes = [...bundle.files.values()].reduce((n, b) => n + b.length, 0);
  spaceFor(config.dataDir, bytes * 2 + source.bytes + 1048576, space);
  const id = newOperationId();
  const target = `households/${id}`;
  const root = join(config.dataDir, target);
  mkdirSync(root, { mode: 0o700 });
  let recorded = false;
  try {
    for (const [path, data] of bundle.files) {
      const output = join(root, path);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileAtomic(output, data);
    }
    validateStage(root, bundle);
    syncTree(root); fsyncDir(root);
    insertOperation(platform, row, { id, kind: 'restore', file: resolve(file), target, hash: bundle.sha256, count: bundle.files.size, bytes, retention: retentionMs(config) });
    recorded = true;
    await onPhase('validated');
    return await continueRestore({ platform, config, runtimes }, id, onPhase);
  } catch (err) {
    if (!recorded) rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

export async function recoverHouseholdOperations({ platform, config, runtimes = null } = {}) {
  const operations = platform.prepare("SELECT * FROM household_backup_operations WHERE status = 'running' ORDER BY created_at").all();
  for (const op of operations) {
    if (op.kind === 'restore') {
      try { await continueRestore({ platform, config, runtimes }, op.id); }
      catch { console.error('fathom: restore recovery blocked', 'restore_recovery_required'); }
    }
    else transaction(platform, () => {
      platform.prepare("UPDATE households SET status = 'active' WHERE id = ? AND storage_root = ? AND generation = ? AND status = 'suspended'")
        .run(op.household_id, op.source_root, op.source_generation);
      platform.prepare("UPDATE household_backup_operations SET status = 'failed', code = 'backup_interrupted', updated_at = ? WHERE id = ?").run(Date.now(), op.id);
    });
  }
}

const PUBLIC_CODES = new Set(['backup_key_invalid', 'backup_destination_invalid', 'household_unavailable', 'household_operation_busy', 'backup_space_required']);
export function createBackupRunner({ platform, config, runtimes }) {
  let pending = Promise.resolve();
  let stopped = false;
  const code = err => PUBLIC_CODES.has(err?.code) ? err.code : 'backup_failed';
  const run = op => {
    pending = pending.then(async () => {
      if (stopped) return;
      try { await backupHousehold({ platform, config, runtimes, householdId: op.household_id, operationId: op.id }); }
      catch (err) {
        platform.prepare("UPDATE household_backup_operations SET status = 'failed', code = ?, updated_at = ? WHERE id = ?").run(code(err), Date.now(), op.id);
      }
    });
  };
  for (const op of platform.prepare("SELECT * FROM household_backup_operations WHERE kind = 'backup' AND status = 'queued' ORDER BY created_at").all()) run(op);
  return {
    code,
    queue(id) {
      const row = activeHousehold(platform, id);
      const key = loadBackupKey(config.backupKeyFile); key.fill(0);
      const dest = destination(config);
      const operationId = newOperationId();
      insertOperation(platform, row, { id: operationId, kind: 'backup', file: join(dest, `${operationId}.fsnap`), retention: retentionMs(config) });
      setImmediate(() => { if (!stopped) run(operation(platform, operationId)); });
      return { operationId, status: 'queued' };
    },
    status(id, operationId) {
      const row = platform.prepare("SELECT * FROM household_backup_operations WHERE household_id = ? AND id = ? AND kind = 'backup'").get(id, operationId);
      return row ? result(row) : null;
    },
    async idle() { await new Promise(done => setImmediate(done)); await pending; },
    async close() { stopped = true; await pending; },
  };
}

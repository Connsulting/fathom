// Offline platform migration (MT-01): moves accounts, credentials, links, sessions, challenges and
// rate limits out of a real fathom.sqlite into a new platform.sqlite, then marks the store with
// store_identity and applies migration 022, which drops the account tables.
//
// Exclusion: the store is opened on one connection holding SQLite's exclusive lock for the whole
// run (source_in_use when any other process has it open), and every source read and write goes
// through it. platform-migration.lock is an advisory marker so the server and CLIs refuse to start
// mid-operation; platform-migration.json is the journal (ids, phase, file names, counts, digests;
// never row values). Both are written only after preflight passes, and the ids are never
// regenerated once the journal exists.
//
// Phases (onPhase(name) is awaited after each): preflight, snapshot (snapshot-partial and
// snapshot-published inside it), source-schema, stage, verify, publish, mark, cleanup, complete.
// A rerun resumes from observed state checked against the journal: account tables already gone
// means only the mark/cleanup checks apply; a published platform.sqlite is never rebuilt and is
// re-verified against the still-present source rows; a store changed between runs before staging
// gets a new snapshot. Source account rows are dropped only by 022, after the platform database
// has been verified and published and the store marked.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, parseJson, DB_FILE } from '../store/db.mjs';
import {
  PLATFORM_FILE, PLATFORM_MIGRATIONS_DIR, LOCK_FILE, JOURNAL_FILE, STORE_IDENTITY_DDL, codeError, newHouseholdId, newOperationId,
  storeIdentity,
} from './db.mjs';
import { loadBackupKey } from './backup-key.mjs';
import { rowsDigest, tableRows, logicalDigest } from './digest.mjs';
import { createSourceSnapshot, openSourceExclusive, readSnapshotFile, partialName, sha256File, SNAPSHOT_EXT } from './snapshot.mjs';
import { fsyncDir, fsyncFile, writeAll, writeFileAtomic } from './fsutil.mjs';

export const PHASES = Object.freeze(['preflight', 'snapshot-partial', 'snapshot-published', 'snapshot', 'source-schema', 'stage',
  'verify', 'publish', 'mark', 'cleanup', 'complete']);
export const STAGING_FILE = `${PLATFORM_FILE}.staging`;
export const SNAPSHOT_DIR = 'snapshots';
const OPERATION_KIND = 'platform-migration';
const LEGACY_SCHEMA = 21;
// Store migration 025 moves api_keys to the platform and refuses while the store holds keys; only
// the tenancy migration (src/platform/migrate-tenancy.mjs) applies it.
export const PRE_TENANCY_SCHEMA = 24;
const INVITE_TTL = 20 * 60 * 1000;
const LEGACY_AUTH_TABLES = ['users', 'households', 'passkeys', 'auth_tokens', 'auth_sessions', 'auth_challenges', 'auth_rate_limits'];
const SOURCE_TABLES = ['users', 'passkeys', 'auth_tokens', 'auth_sessions', 'auth_challenges', 'auth_rate_limits'];

// Platform tables the migration fills, with every column it writes (and verifies).
const COLUMNS = Object.freeze({
  households: ['id', 'status', 'mode', 'display_name', 'serves_store', 'created_at', 'updated_at'],
  users: ['id', 'email', 'user_handle', 'created_at', 'enrolled_at'],
  household_memberships: ['user_id', 'household_id', 'role', 'status', 'version', 'created_at', 'updated_at'],
  household_invitations: ['hash', 'household_id', 'email', 'role', 'user_id', 'inviter_user_id', 'created_at', 'expires_at', 'consumed_at', 'revoked_at'],
  auth_tokens: ['hash', 'user_id', 'purpose', 'expires_at'],
  passkeys: ['id', 'user_id', 'public_key', 'counter', 'transports', 'name', 'created_at'],
  auth_sessions: ['hash', 'user_id', 'signed_in_at', 'expires_at', 'household_id', 'context_version'],
  auth_challenges: ['hash', 'ceremony', 'user_id', 'token_hash', 'session_hash', 'invitation_hash', 'challenge', 'expires_at'],
  auth_rate_limits: ['key_hash', 'window_start', 'expires_at', 'attempts'],
});

const refuse = code => codeError(code);
export const hasTable = (db, name) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const count = (db, sql) => db.prepare(sql).get().n;

// --------------------------------------------------------------------------- journal and lock

// A journal or lock file's JSON (it must name an operationId), null when absent, else `code`.
export function readJson(file, code) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value.operationId !== 'string') throw new Error('shape');
    return value;
  } catch {
    throw refuse(code);
  }
}

export function writeJournal(file, journal) {
  journal.updatedAt = Date.now();
  writeFileAtomic(file, JSON.stringify(journal, null, 2) + '\n');
}

// Create the advisory lock for `operationId`; an existing lock must name the same operation.
export function writeLock(file, operationId) {
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      if (readJson(file, 'stale_lock_mismatch').operationId !== operationId) throw refuse('stale_lock_mismatch');
      return;
    }
    throw e;
  }
  try {
    writeAll(fd, Buffer.from(JSON.stringify({ operationId }) + '\n'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(file);
}

export function removeLock(file, operationId) {
  if (!existsSync(file)) return;
  if (readJson(file, 'stale_lock_mismatch').operationId !== operationId) throw refuse('stale_lock_mismatch');
  rmSync(file, { force: true });
  fsyncDir(file);
}

// --------------------------------------------------------------------------- source checks

export function storeMode(db) {
  if (!hasTable(db, 'settings')) return 'real';
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mode'").get();
  return parseJson(row && row.value, null) === 'demo' ? 'demo' : 'real';
}

function preflightSource(db, dataDir) {
  if (hasTable(db, 'households') && count(db, 'SELECT count(*) AS n FROM households') > 1) throw refuse('ambiguous_household');
  if (hasTable(db, 'users') && count(db, 'SELECT count(*) AS n FROM users WHERE household_id IS NOT 1') > 0) throw refuse('ambiguous_household');
  for (const t of LEGACY_AUTH_TABLES) {
    if (hasTable(db, t) && db.prepare(`PRAGMA foreign_key_check("${t}")`).all().length) throw refuse('orphan_auth_rows');
  }
  let bytes = 0;
  for (const f of [DB_FILE, `${DB_FILE}-wal`]) {
    try { bytes += statSync(join(dataDir, f)).size; } catch { /* absent */ }
  }
  let free = Infinity;
  try {
    const s = statfsSync(dataDir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch { /* unknown: let the writes fail instead */ }
  // A VACUUM copy and the archive of the store, the staging database, and headroom.
  if (free < bytes * 3 + 8 * 1024 * 1024) throw refuse('insufficient_space');
}

function readSource(db) {
  const out = {};
  for (const t of SOURCE_TABLES) out[t] = hasTable(db, t) ? db.prepare(`SELECT * FROM "${t}"`).all() : [];
  return out;
}

// The platform rows for the source rows: deterministic for a given source and journal.
function platformRows(src, { householdId: hh, operationId, startedAt }) {
  const enrolled = new Set(src.users.filter(u => u.enrolled_at !== null).map(u => u.id));
  const byId = new Map(src.users.map(u => [u.id, u]));
  const invites = src.auth_tokens.filter(t => t.purpose === 'invite');
  const inviteHashes = new Set(invites.map(t => t.hash));
  const invited = new Set(invites.map(t => t.user_id));
  const invitation = (hash, u, createdAt, expiresAt) => ({
    hash, household_id: hh, email: u.email, role: u.role, user_id: u.id, inviter_user_id: null,
    created_at: createdAt, expires_at: expiresAt, consumed_at: null, revoked_at: null,
  });
  return {
    households: [{ id: hh, status: 'active', mode: 'real', display_name: null, serves_store: 1, created_at: startedAt, updated_at: startedAt }],
    users: src.users.map(u => ({ id: u.id, email: u.email, user_handle: u.user_handle, created_at: u.created_at, enrolled_at: u.enrolled_at })),
    household_memberships: src.users.filter(u => enrolled.has(u.id)).map(u => ({
      user_id: u.id, household_id: hh, role: u.role, status: 'active', version: 1, created_at: u.enrolled_at, updated_at: u.enrolled_at,
    })),
    household_invitations: [
      ...invites.map(t => invitation(t.hash, byId.get(t.user_id), t.expires_at - INVITE_TTL, t.expires_at)),
      // A pending invitee with no link keeps an already-expired invitation so it stays listed.
      ...src.users.filter(u => !enrolled.has(u.id) && !invited.has(u.id)).map(u => invitation(
        createHash('sha256').update(`fathom-lapsed-invitation:${operationId}:${u.id}`).digest('hex'), u, u.created_at, u.created_at)),
    ],
    auth_tokens: src.auth_tokens.filter(t => t.purpose !== 'invite').map(t => ({ hash: t.hash, user_id: t.user_id, purpose: t.purpose, expires_at: t.expires_at })),
    passkeys: src.passkeys.map(p => ({ id: p.id, user_id: p.user_id, public_key: p.public_key, counter: p.counter, transports: p.transports, name: p.name, created_at: p.created_at })),
    auth_sessions: src.auth_sessions.map(s => ({
      hash: s.hash, user_id: s.user_id, signed_in_at: s.signed_in_at, expires_at: s.expires_at,
      household_id: enrolled.has(s.user_id) ? hh : null, context_version: 1,
    })),
    auth_challenges: src.auth_challenges.map(c => ({
      hash: c.hash, ceremony: c.ceremony, user_id: c.user_id,
      token_hash: inviteHashes.has(c.token_hash) ? null : c.token_hash, session_hash: c.session_hash,
      invitation_hash: inviteHashes.has(c.token_hash) ? c.token_hash : null, challenge: c.challenge, expires_at: c.expires_at,
    })),
    auth_rate_limits: src.auth_rate_limits.map(r => ({ key_hash: r.key_hash, window_start: r.window_start, expires_at: r.expires_at, attempts: r.attempts })),
  };
}

const digestsOfRows = rows => Object.fromEntries(Object.keys(COLUMNS).map(t => [t, rowsDigest(rows[t])]));
const digestsOfDb = db => Object.fromEntries(Object.entries(COLUMNS).map(([t, cols]) => [t, rowsDigest(tableRows(db, t, cols))]));
const sameDigests = (a, b) => !!a && !!b && Object.keys(COLUMNS).every(t => a[t] && b[t] && a[t].count === b[t].count && a[t].sha256 === b[t].sha256);
const countsOf = digests => Object.fromEntries(Object.entries(digests).map(([t, d]) => [t, d.count]));

// --------------------------------------------------------------------------- staging

function buildStaging(file, rows, journal) {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, { dir: PLATFORM_MIGRATIONS_DIR });
    db.exec('BEGIN');
    try {
      for (const [table, cols] of Object.entries(COLUMNS)) {
        const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const row of rows[table]) insert.run(...cols.map(c => row[c]));
      }
      const now = Date.now();
      db.prepare(`INSERT INTO platform_operations (id, kind, phase, status, started_at, updated_at, detail)
        VALUES (?, ?, 'stage', 'running', ?, ?, ?)`)
        .run(journal.operationId, OPERATION_KIND, journal.startedAt, now, JSON.stringify({ counts: countsOf(digestsOfRows(rows)) }));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

function verifyFile(file, expected) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw refuse('staging_invalid');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw refuse('staging_invalid');
    if (!sameDigests(digestsOfDb(db), expected)) throw refuse('staging_invalid');
  } finally {
    db.close();
  }
}

// The platform operation row (of `kind`, any when null) and served household of a published
// platform.sqlite must be this journal's.
function checkPublished(file, journal, kind = OPERATION_KIND) {
  // A plain connection: after a server has run, the file is in WAL mode, which a read-only open
  // cannot always attach to.
  const db = new DatabaseSync(file);
  try {
    const op = db.prepare('SELECT id FROM platform_operations WHERE id = ? AND kind = coalesce(?, kind)').get(journal.operationId, kind);
    const hh = db.prepare('SELECT id FROM households WHERE serves_store = 1').get();
    if (!op || !hh || hh.id !== journal.householdId) throw refuse('store_identity_mismatch');
    return digestsOfDb(db);
  } finally {
    db.close();
  }
}

export function markOperationDone(file, operationId) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(`UPDATE platform_operations SET status = 'done', phase = 'complete', updated_at = ?
      WHERE id = ? AND (status != 'done' OR phase != 'complete')`).run(Date.now(), operationId);
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------- snapshots

const snapshotName = (operationId, n) => `platform-${operationId}${n ? `-${n + 1}` : ''}${SNAPSHOT_EXT}`;

// Take (or adopt a published but unjournaled) snapshot number n and record it in the journal.
async function takeSnapshot(ctx, n, hooks) {
  const { db, dataDir, key, journal, journalFile } = ctx;
  const rel = `${SNAPSHOT_DIR}/${snapshotName(journal.operationId, n)}`;
  const final = join(dataDir, rel);
  let record;
  if (existsSync(final)) {
    let snap;
    try { snap = readSnapshotFile(final, key); } catch { throw refuse('snapshot_mismatch'); }
    if (snap.manifest.operationId !== journal.operationId || typeof snap.manifest.logicalDigest !== 'string') throw refuse('snapshot_mismatch');
    rmSync(partialName(final, journal.operationId), { force: true });
    record = { file: rel, sha256: snap.sha256, logicalDigest: snap.manifest.logicalDigest };
  } else {
    const made = await createSourceSnapshot({
      db, dataDir, key, out: final, operationId: journal.operationId,
      onPartial: hooks ? () => hooks('snapshot-partial') : undefined,
      onPublished: hooks ? () => hooks('snapshot-published') : undefined,
    });
    record = { file: rel, sha256: made.sha256, logicalDigest: made.logicalDigest };
  }
  journal.snapshots.push(record);
  journal.sourceDigest = record.logicalDigest;
  writeJournal(journalFile, journal);
}

function clearSnapshotLeftovers(dir, operationId) {
  for (const name of readdirSync(dir)) {
    if (name.includes(`.partial-${operationId}`) || name.includes(`.copy-${operationId}`)) rmSync(join(dir, name), { force: true });
  }
}

// --------------------------------------------------------------------------- run

// A completed migration: verify it still holds, mark the operation done and drop a leftover lock.
function reconcile(ctx) {
  const { db, journal, platformFile, lockFile } = ctx;
  if (!existsSync(platformFile)) throw refuse('store_identity_mismatch');
  checkPublished(platformFile, journal);
  const identity = storeIdentity(db);
  if (!identity || identity.householdId !== journal.householdId || identity.operationId !== journal.operationId) throw refuse('store_identity_mismatch');
  if (hasTable(db, 'users')) throw refuse('store_identity_mismatch');
  markOperationDone(platformFile, journal.operationId);
  removeLock(lockFile, journal.operationId);
  return { status: 'complete', operationId: journal.operationId, householdId: journal.householdId };
}

export async function migratePlatform({ dataDir, backupKeyFile, onPhase = async () => {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw refuse('not_real_store');
  const storeFile = join(dataDir, DB_FILE);
  const platformFile = join(dataDir, PLATFORM_FILE);
  const stagingFile = join(dataDir, STAGING_FILE);
  const journalFile = join(dataDir, JOURNAL_FILE);
  const lockFile = join(dataDir, LOCK_FILE);

  let journal = readJson(journalFile, 'journal_invalid');
  const lock = readJson(lockFile, 'stale_lock_mismatch');
  if (lock && (!journal || lock.operationId !== journal.operationId)) throw refuse('stale_lock_mismatch');
  const key = loadBackupKey(backupKeyFile);
  if (!existsSync(storeFile)) throw refuse('not_real_store');
  const db = openSourceExclusive(storeFile);
  try {
    if (storeMode(db) !== 'real') throw refuse('not_real_store');
    const ctx = { db, dataDir, key, journal, journalFile, platformFile, lockFile };
    if (journal?.phase === 'complete') return reconcile(ctx);

    // A store with store_identity and no account tables was created already bound to a household.
    const identity = storeIdentity(db);
    const bound = !!identity && !hasTable(db, 'users');
    let published = existsSync(platformFile);
    if (!journal) {
      if (bound && published) {
        checkPublished(platformFile, { operationId: identity.operationId, householdId: identity.householdId }, null);
        return { status: 'complete', operationId: identity.operationId, householdId: identity.householdId };
      }
      if (published || (identity && !bound)) throw refuse('store_identity_mismatch');
      if (bound && !identity.operationId) throw refuse('store_identity_mismatch');
    }

    // ---- preflight
    if (!published && !bound) preflightSource(db, dataDir);
    await onPhase('preflight');
    if (!journal) {
      journal = {
        version: 1,
        operationId: bound ? identity.operationId : newOperationId(),
        householdId: bound ? identity.householdId : newHouseholdId(),
        // A store bound by createInstance whose platform file never landed: rebuilt with no accounts.
        recovery: bound,
        startedAt: Date.now(),
        phase: 'preflight',
        snapshots: [],
      };
      writeJournal(journalFile, journal);
      ctx.journal = journal;
    }
    writeLock(lockFile, journal.operationId);

    // ---- snapshot
    const snapDir = join(dataDir, SNAPSHOT_DIR);
    mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    clearSnapshotLeftovers(snapDir, journal.operationId);
    if (!journal.snapshots.length) await takeSnapshot(ctx, 0, onPhase);
    else {
      for (const s of journal.snapshots) {
        let sha;
        try { sha = sha256File(join(dataDir, s.file)); } catch { throw refuse('snapshot_mismatch'); }
        if (sha !== s.sha256) throw refuse('snapshot_mismatch');
      }
      // The store changed while unlocked between runs: snapshot it again before staging.
      if (!published && !bound && logicalDigest(db) !== journal.sourceDigest) await takeSnapshot(ctx, journal.snapshots.length, null);
    }
    journal.phase = journal.phase === 'preflight' ? 'snapshot' : journal.phase;
    writeJournal(journalFile, journal);
    await onPhase('snapshot');

    // ---- source-schema
    if (!bound && !hasTable(db, 'store_identity')) {
      const { applied } = migrate(db, { through: LEGACY_SCHEMA });
      if (applied.length) {
        journal.sourceDigest = logicalDigest(db);
        writeJournal(journalFile, journal);
      }
    }
    await onPhase('source-schema');

    // ---- stage, verify, publish
    const accountsPresent = hasTable(db, 'users');
    published = existsSync(platformFile);
    if (!published) {
      if (!accountsPresent && !journal.recovery) throw refuse('source_changed_after_publish');
      const rows = platformRows(readSource(db), journal);
      buildStaging(stagingFile, rows, journal);
      journal.phase = 'stage';
      writeJournal(journalFile, journal);
      await onPhase('stage');

      const expected = digestsOfRows(rows);
      verifyFile(stagingFile, expected);
      journal.digests = expected;
      journal.counts = countsOf(expected);
      journal.phase = 'verify';
      writeJournal(journalFile, journal);
      await onPhase('verify');

      fsyncFile(stagingFile);
      renameSync(stagingFile, platformFile);
      fsyncDir(platformFile);
      journal.phase = 'publish';
      writeJournal(journalFile, journal);
      await onPhase('publish');
    } else {
      // Never rebuilt once published: re-verify against the source rows that are still present.
      rmSync(stagingFile, { force: true });
      const inPlatform = checkPublished(platformFile, journal);
      if (accountsPresent) {
        const fromSource = digestsOfRows(platformRows(readSource(db), journal));
        if (!sameDigests(fromSource, journal.digests) || !sameDigests(inPlatform, journal.digests)) throw refuse('source_changed_after_publish');
      }
      if (['preflight', 'snapshot', 'stage', 'verify'].includes(journal.phase)) {
        journal.phase = 'publish';
        writeJournal(journalFile, journal);
      }
      await onPhase('stage');
      await onPhase('verify');
      await onPhase('publish');
    }

    // ---- mark
    db.exec(STORE_IDENTITY_DDL);
    const marked = storeIdentity(db);
    if (marked) {
      if (marked.householdId !== journal.householdId || marked.operationId !== journal.operationId) throw refuse('store_identity_mismatch');
    } else {
      db.prepare('INSERT INTO store_identity (id, household_id, platform_operation) VALUES (1, ?, ?)').run(journal.householdId, journal.operationId);
    }
    journal.phase = 'mark';
    writeJournal(journalFile, journal);
    await onPhase('mark');

    // ---- cleanup: 022 drops the account tables (and later migrations up to the tenancy cutover apply).
    migrate(db, { through: PRE_TENANCY_SCHEMA });
    if (LEGACY_AUTH_TABLES.some(t => hasTable(db, t))) throw refuse('store_identity_mismatch');
    journal.phase = 'cleanup';
    writeJournal(journalFile, journal);
    await onPhase('cleanup');

    // ---- complete
    markOperationDone(platformFile, journal.operationId);
    journal.phase = 'complete';
    writeJournal(journalFile, journal);
    await onPhase('complete');
    removeLock(lockFile, journal.operationId);
    return { status: 'complete', operationId: journal.operationId, householdId: journal.householdId };
  } finally {
    db.close();
  }
}

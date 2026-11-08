// Offline encrypted source snapshots (FTHMSNAP1) of a stopped instance's financial store, MCP key
// secret and (for the tenancy migration) platform database and household file trees, under the
// backup key from FATHOM_BACKUP_KEY_FILE (src/platform/backup-key.mjs).
//
// Archive: 'FTHMSNAP1' (9 bytes) + 12 byte random nonce, then AES-256-GCM ciphertext and a 16 byte
// tag, with the 21 byte header as additional authenticated data. Plaintext: a 4 byte big-endian
// manifest length, the JSON manifest { format, operationId, createdAt, logicalDigest, files:
// [{ path, size, sha256 }] }, then each file's bytes in manifest order. SQLite databases (the store
// on the caller's exclusively locked connection, and any extra open `databases`) are copied with
// node:sqlite backup(), a page copy that keeps every rowid; other files byte for byte. A directory
// named in `files` contributes every regular file below it (a symlink or special file refuses).
//
// A snapshot is written to `<final>.partial-<operationId>` (exclusive create, fsynced, mode 0400),
// published with link() so an existing final name is never replaced, and the partial unlinked.
// Restore and rollback authenticate everything before writing, build the output at a temporary
// sibling and rename it into place, and refuse an existing output. Errors carry fixed codes only.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync, copyFileSync, chmodSync, constants, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openScope } from '../storage/index.mjs';
import { DB_FILE } from '../store/db.mjs';
import { codeError } from './db.mjs';
import { loadBackupKey } from './backup-key.mjs';
import { logicalDigest } from './digest.mjs';
import { fsyncDir, writeAll } from './fsutil.mjs';

export const SNAPSHOT_MAGIC = Buffer.from('FTHMSNAP1', 'latin1');
export const SNAPSHOT_EXT = '.fsnap';
export const SECRET_FILE = 'api-key-secret';
export const DEFAULT_FILES = Object.freeze([DB_FILE, SECRET_FILE]);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = SNAPSHOT_MAGIC.length + NONCE_BYTES;
// Relative archive paths: segments of letters, digits, '.', '_' and '-' (a leading dot allowed for
// the temporary names pack builds leave), never '.' or '..'.
const SAFE_SEGMENT = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const safePath = rel => typeof rel === 'string' && rel.split('/').every(seg => SAFE_SEGMENT.test(seg) && seg !== '.' && seg !== '..');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// Open fathom.sqlite on one connection holding SQLite's exclusive lock for as long as it stays
// open. Any other open connection (an idle server or CLI holds a shared lock in WAL mode) makes
// this fail at once with source_in_use and nothing is changed.
export async function openSourceExclusive(file) {
  if (!existsSync(file)) throw codeError('store_missing');
  try {
    return await openScope({ path: file, journal: null, exclusive: true });
  } catch (e) {
    if (e?.code === 'storage_busy') throw codeError('source_in_use');
    throw codeError('source_unreadable');
  }
}

const sideFiles = file => [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];

// Page copy of the open database `db` into the new file `target` (created 0600 before SQLite opens
// it, so the copy is private from the start), rowids kept. The closed copy at `target` is the
// caller's; on failure nothing is left there.
export async function copyDatabase(db, target) {
  for (const f of sideFiles(target)) rmSync(f, { force: true });
  closeSync(openSync(target, 'wx', 0o600));
  try {
    await db.backupTo(target);
  } catch {
    for (const f of sideFiles(target)) rmSync(f, { force: true });
    throw codeError('database_copy_failed');
  }
}

async function databaseBytes(db, target) {
  await copyDatabase(db, target);
  try {
    return readFileSync(target);
  } finally {
    for (const f of sideFiles(target)) rmSync(f, { force: true });
  }
}

// Regular files under `dataDir/rel` as [{ path, data }] in path order; [] when it is absent. A
// symlink, special file or unsafe name refuses snapshot_source_invalid.
function treeEntries(dataDir, rel) {
  const path = join(dataDir, rel);
  let st;
  try { st = lstatSync(path); } catch { return []; }
  if (!safePath(rel)) throw codeError('snapshot_source_invalid');
  if (st.isFile()) return [{ path: rel, data: readFileSync(path) }];
  if (!st.isDirectory()) throw codeError('snapshot_source_invalid');
  const out = [];
  for (const name of readdirSync(path).sort()) out.push(...treeEntries(dataDir, `${rel}/${name}`));
  return out;
}

// Plaintext archive body for `entries` [{ path, data }].
function pack(manifestBase, entries) {
  const manifest = { format: 1, ...manifestBase, files: entries.map(e => ({ path: e.path, size: e.data.length, sha256: sha256(e.data) })) };
  const json = Buffer.from(JSON.stringify(manifest));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return { manifest, plain: Buffer.concat([len, json, ...entries.map(e => e.data)]) };
}

function encrypt(key, plain) {
  const header = Buffer.concat([SNAPSHOT_MAGIC, randomBytes(NONCE_BYTES)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(SNAPSHOT_MAGIC.length));
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

// Authenticate and unpack an archive. Returns { manifest, files: Map(path -> Buffer) }.
export function openSnapshot(bytes, key) {
  const bad = () => codeError('snapshot_invalid');
  if (!Buffer.isBuffer(bytes) || bytes.length < HEADER_BYTES + TAG_BYTES + 4) throw bad();
  const header = bytes.subarray(0, HEADER_BYTES);
  if (!header.subarray(0, SNAPSHOT_MAGIC.length).equals(SNAPSHOT_MAGIC)) throw bad();
  let plain;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(SNAPSHOT_MAGIC.length));
    decipher.setAAD(header);
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    plain = Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw bad();
  }
  let manifest;
  try {
    const len = plain.readUInt32BE(0);
    manifest = JSON.parse(plain.subarray(4, 4 + len).toString('utf8'));
    let off = 4 + len;
    const files = new Map();
    if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw bad();
    for (const f of manifest.files) {
      if (!safePath(f.path) || files.has(f.path)) throw bad();
      if (!Number.isInteger(f.size) || f.size < 0 || off + f.size > plain.length) throw bad();
      const data = plain.subarray(off, off + f.size);
      if (sha256(data) !== f.sha256) throw bad();
      files.set(f.path, Buffer.from(data));
      off += f.size;
    }
    if (off !== plain.length) throw bad();
    return { manifest, files };
  } catch {
    throw bad();
  }
}

export function readSnapshotFile(file, key) {
  let bytes;
  try { bytes = readFileSync(file); } catch { throw codeError('snapshot_invalid'); }
  return { ...openSnapshot(bytes, key), sha256: sha256(bytes) };
}

export const sha256File = file => sha256(readFileSync(file));
export const partialName = (final, operationId) => `${final}.partial-${operationId}`;

// Write an encrypted snapshot of the store (through `db`, or an exclusively locked connection of
// its own), the extra open `databases` ({ relPath: DatabaseSync }) and the other `files` (regular
// files or directory trees) present under dataDir to the final path `out`. The awaited hooks fire
// after the partial is durable (onPartial) and after it is published (onPublished). The published
// file is read-only (0400) unless `mode` says otherwise (an ad hoc snapshot the operator moves off
// the host). Returns { file, sha256, logicalDigest (of the store), manifest }.
export async function createSourceSnapshot({
  db, dataDir, keyFile, key, out, files = DEFAULT_FILES, databases = {}, operationId, onPartial, onPublished, mode = 0o400,
  householdBackup = null,
}) {
  const k = key ?? loadBackupKey(keyFile);
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(operationId)) throw codeError('operation_invalid');
  if (existsSync(out)) throw codeError('snapshot_exists');
  const own = db ? null : await openSourceExclusive(join(dataDir, DB_FILE));
  const source = db ?? own;
  let archive;
  let digest;
  let manifest;
  try {
    const entries = [];
    const copyTarget = `${out}.copy-${operationId}`;
    for (const rel of files) {
      if (rel === DB_FILE) entries.push({ path: rel, data: await databaseBytes(source, copyTarget) });
      else entries.push(...treeEntries(dataDir, rel));
    }
    for (const [rel, handle] of Object.entries(databases)) {
      if (!safePath(rel) || rel === DB_FILE) throw codeError('snapshot_source_invalid');
      entries.push({ path: rel, data: await databaseBytes(handle, copyTarget) });
    }
    if (new Set(entries.map(e => e.path)).size !== entries.length) throw codeError('snapshot_source_invalid');
    digest = await logicalDigest(source);
    const packed = pack({ operationId, createdAt: new Date().toISOString(), logicalDigest: digest,
      ...(householdBackup ? { householdBackup } : {}), }, entries);
    manifest = packed.manifest;
    archive = encrypt(k, packed.plain);
  } finally {
    own?.close();
  }
  const partial = partialName(out, operationId);
  rmSync(partial, { force: true });
  const fd = openSync(partial, 'wx', 0o600);
  try {
    writeAll(fd, archive);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(partial);
  if (onPartial) await onPartial();
  try {
    linkSync(partial, out);
  } catch (e) {
    if (e && e.code === 'EEXIST') throw codeError('snapshot_exists');
    throw codeError('snapshot_write_failed');
  }
  fsyncDir(out);
  unlinkSync(partial);
  fsyncDir(out);
  if (onPublished) await onPublished();
  return { file: out, sha256: sha256(archive), logicalDigest: digest, manifest };
}

// Build a directory at a temporary sibling of `out` with fill(tmp), then rename it into place.
function buildDir(out, fill) {
  if (existsSync(out)) throw codeError('out_exists');
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  mkdirSync(tmp, { mode: 0o700 });
  try {
    fill(tmp);
    if (existsSync(out)) throw codeError('out_exists');
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  fsyncDir(out);
}

function writePrivate(dir, rel, data) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Authenticate a snapshot and write its files into the new directory `out`.
export function restoreSourceSnapshot({ file, keyFile, key, out }) {
  const k = key ?? loadBackupKey(keyFile);
  if (existsSync(out)) throw codeError('out_exists');
  const { files } = readSnapshotFile(file, k);
  buildDir(out, tmp => { for (const [rel, data] of files) writePrivate(tmp, rel, data); });
  return { files: files.size };
}

// Top-level entries of a migrated data directory that a rollback leaves behind.
const NOT_CARRIED = [/^platform\.sqlite/, /^platform-migration\./, /^snapshots$/, /^fathom\.sqlite(-wal|-shm|-journal|\.tmp-.*)?$/, /\.fsnap$/, /\.partial-/];

// The real path of `p`; a missing tail is resolved against its nearest existing ancestor.
function realPath(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch (e) {
    if (e.code !== 'ENOENT' || dirname(abs) === abs) throw e;
    return join(realPath(dirname(abs)), basename(abs));
  }
}
const within = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Refuse an output that is the source, lies inside it, or contains it, before anything is created.
// An unresolvable `from` is left to the from_invalid check.
function refuseNested(from, out) {
  let src;
  try { src = realpathSync(resolve(from)); } catch { return; }
  const dst = join(realPath(dirname(resolve(out))), basename(resolve(out)));
  if (within(dst, src)) throw codeError('out_inside_source');
  if (within(src, dst)) throw codeError('source_inside_out');
}

// A new data directory for the previous release: every retained file of `from` copied byte for
// byte (symlinks refused), without the platform database, migration journal and lock, snapshots,
// the store's WAL files and any top-level entry the snapshot holds, then every file of the
// authenticated snapshot.
export function rollbackFromSnapshot({ snapshot, keyFile, key, from, out }) {
  const k = key ?? loadBackupKey(keyFile);
  refuseNested(from, out);
  if (existsSync(out)) throw codeError('out_exists');
  let fromStat;
  try { fromStat = statSync(from); } catch { throw codeError('from_invalid'); }
  if (!fromStat.isDirectory()) throw codeError('from_invalid');
  const { files } = readSnapshotFile(snapshot, k);
  // A top-level entry the snapshot holds (a file, or the first segment of a tree) comes from it.
  const fromSnapshot = new Set([...files.keys()].map(rel => rel.split('/')[0]));
  buildDir(out, tmp => {
    const copy = (srcDir, dstDir, top) => {
      for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
        if (top && (NOT_CARRIED.some(re => re.test(ent.name)) || fromSnapshot.has(ent.name))) continue;
        const src = join(srcDir, ent.name);
        const dst = join(dstDir, ent.name);
        const st = lstatSync(src);
        if (st.isSymbolicLink()) throw codeError('symlink_refused');
        if (st.isDirectory()) {
          mkdirSync(dst, { mode: st.mode & 0o777 });
          copy(src, dst, false);
          chmodSync(dst, st.mode & 0o777);
        } else if (st.isFile()) {
          copyFileSync(src, dst, constants.COPYFILE_EXCL);
          chmodSync(dst, st.mode & 0o777);
        } else {
          throw codeError('special_file_refused');
        }
      }
    };
    copy(from, tmp, true);
    for (const [rel, data] of files) writePrivate(tmp, rel, data);
  });
  return { files: files.size };
}

// File name for an ad hoc snapshot written by `source-snapshot create`.
export function adHocSnapshotName(operationId) {
  return `fathom-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${operationId}${SNAPSHOT_EXT}`;
}

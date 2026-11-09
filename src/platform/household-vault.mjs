// Household-bound vault (MT-02): per-household data keys wrapped under the platform key, the FTHM2
// envelope and contained household roots. The running server stays on FTHM1 (src/ingest/vault.mjs)
// until the MT-03 cutover; only the offline conversion (src/platform/vault-convert.mjs) imports
// this module. Errors carry fixed codes only. Raw keys live in a module-private WeakMap keyed by the
// frozen handle, never on the handle itself.
//
// FTHM2 blob: 'FTHM2', key version (uint32 BE), 12 byte nonce, ciphertext, 16 byte GCM tag. The
// additional data is length-prefixed 'fathom-vault/2', household id, purpose, object id, key
// version and the header bytes, so a changed magic, version or nonce fails authentication.
// Wrapped data key: 'FTHMK1', 12 byte nonce, 32 byte ciphertext, 16 byte tag under the platform key,
// with length-prefixed 'fathom-dek/1', household id, key version and the header as additional data.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { codeError } from './db.mjs';
import { fsyncDir, writeAll } from './fsutil.mjs';

const MAGIC = Buffer.from('FTHM2', 'latin1');
const KEY_MAGIC = Buffer.from('FTHMK1', 'latin1');
const NONCE = 12;
const TAG = 16;
const KEY_BYTES = 32;
const HEADER = MAGIC.length + 4 + NONCE;
const WRAPPED = KEY_MAGIC.length + NONCE + KEY_BYTES + TAG;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ROOT_SEGMENTS = 4;

export const VAULT_MAGIC = Buffer.from(MAGIC);
export const PURPOSES = Object.freeze({ upload: 'upload', advisorPacket: 'advisor-packet', simplefinAccess: 'simplefin-access' });
export const SIMPLEFIN_OBJECT_ID = 'connection-1';

const KEYS = new WeakMap(); // data key handle -> raw key
const ROOTS = new WeakMap(); // household root -> { base: real data root, segments }

const isBytes = v => v instanceof Uint8Array;
export const isId = v => typeof v === 'string' && ID.test(v);
const isVersion = v => Number.isInteger(v) && v >= 1 && v <= 0xffffffff;
const isPurpose = v => Object.values(PURPOSES).includes(v);
const view = b => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
function check(ok, code = 'vault_invalid_input') {
  if (!ok) throw codeError(code);
}

// Unambiguous additional data: each field as its uint32 BE byte length, then its bytes.
function fields(...parts) {
  return Buffer.concat(parts.flatMap(p => {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8');
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return [n, b];
  }));
}

function gcmSeal(key, nonce, aad, bytes) {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  c.setAAD(aad);
  return Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()]);
}

// The plaintext, or null when authentication fails.
function gcmOpen(key, nonce, aad, body) {
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
    d.setAAD(aad);
    d.setAuthTag(body.subarray(body.length - TAG));
    return Buffer.concat([d.update(body.subarray(0, body.length - TAG)), d.final()]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- data keys

const checkPlatformKey = k => check(isBytes(k) && k.length === KEY_BYTES, 'platform_key_invalid');

export function wrapDataKey(platformKey, { householdId, version, key } = {}) {
  checkPlatformKey(platformKey);
  check(isId(householdId) && isVersion(version));
  check(isBytes(key) && key.length === KEY_BYTES, 'data_key_invalid');
  const header = Buffer.concat([KEY_MAGIC, randomBytes(NONCE)]);
  const aad = fields('fathom-dek/1', householdId, version, header);
  return Buffer.concat([header, gcmSeal(platformKey, header.subarray(KEY_MAGIC.length), aad, key)]);
}

// The raw 32 byte key, or data_key_invalid when the wrapped bytes do not authenticate.
export function unwrapWrappedKey(platformKey, { householdId, version, wrapped } = {}) {
  checkPlatformKey(platformKey);
  check(isId(householdId) && isVersion(version));
  const buf = isBytes(wrapped) ? view(wrapped) : Buffer.alloc(0);
  const header = buf.subarray(0, KEY_MAGIC.length + NONCE);
  const key = buf.length === WRAPPED && header.subarray(0, KEY_MAGIC.length).equals(KEY_MAGIC)
    ? gcmOpen(platformKey, header.subarray(KEY_MAGIC.length), fields('fathom-dek/1', householdId, version, header), buf.subarray(header.length))
    : null;
  check(key !== null, 'data_key_invalid');
  return key;
}

// A frozen { householdId, version } handle; the key is held privately.
export function dataKeyHandle({ householdId, version, key } = {}) {
  check(isId(householdId) && isVersion(version));
  check(isBytes(key) && key.length === KEY_BYTES, 'data_key_invalid');
  const handle = Object.freeze({ householdId, version });
  KEYS.set(handle, Buffer.from(key));
  return handle;
}

function keyOf(handle) {
  const key = handle !== null && typeof handle === 'object' ? KEYS.get(handle) : undefined;
  check(key);
  return key;
}

// Generate, wrap and store version 1 of the household's data key. data_key_exists when the
// household already has any key row; the household must exist (foreign key).
export async function provisionDataKey(platform, { householdId, platformKey, now = Date.now() } = {}) {
  checkPlatformKey(platformKey);
  check(isId(householdId) && Number.isSafeInteger(now));
  const key = randomBytes(KEY_BYTES);
  const wrapped = wrapDataKey(platformKey, { householdId, version: 1, key });
  await platform.transaction(async platform => {
    check(!await platform.prepare('SELECT 1 AS x FROM household_data_keys WHERE household_id = ?').get(householdId), 'data_key_exists');
    await platform.prepare(`INSERT INTO household_data_keys (household_id, key_version, wrapped_key, status, created_at)
      VALUES (?, 1, ?, 'active', ?)`).run(householdId, wrapped, now);
  });
  const handle = dataKeyHandle({ householdId, version: 1, key });
  key.fill(0);
  return handle;
}

// The handle for `version`, or for the active version when omitted.
export async function unwrapDataKey(platform, { householdId, platformKey, version } = {}) {
  checkPlatformKey(platformKey);
  check(isId(householdId) && (version == null || isVersion(version)));
  const row = version == null
    ? await platform.prepare("SELECT key_version, wrapped_key FROM household_data_keys WHERE household_id = ? AND status = 'active'").get(householdId)
    : await platform.prepare('SELECT key_version, wrapped_key FROM household_data_keys WHERE household_id = ? AND key_version = ?').get(householdId, version);
  check(row, 'data_key_missing');
  const v = Number(row.key_version);
  const key = unwrapWrappedKey(platformKey, { householdId, version: v, wrapped: row.wrapped_key });
  const handle = dataKeyHandle({ householdId, version: v, key });
  key.fill(0);
  return handle;
}

// ---------------------------------------------------------------- FTHM2 envelope

const aadOf = (handle, purpose, objectId, header) => fields('fathom-vault/2', handle.householdId, purpose, objectId, handle.version, header);

export function sealObject(handle, { purpose, objectId, bytes } = {}) {
  const key = keyOf(handle);
  check(isPurpose(purpose) && isId(objectId) && isBytes(bytes));
  const version = Buffer.alloc(4);
  version.writeUInt32BE(handle.version);
  const nonce = randomBytes(NONCE);
  const header = Buffer.concat([MAGIC, version, nonce]);
  return Buffer.concat([header, gcmSeal(key, nonce, aadOf(handle, purpose, objectId, header), bytes)]);
}

// The plaintext; vault_auth_failed for any other household, purpose, object, version or byte.
export function openObject(handle, { purpose, objectId, blob } = {}) {
  const key = keyOf(handle);
  check(isPurpose(purpose) && isId(objectId));
  const buf = isBytes(blob) ? view(blob) : Buffer.alloc(0);
  const header = buf.subarray(0, HEADER);
  const plain = buf.length >= HEADER + TAG && header.subarray(0, MAGIC.length).equals(MAGIC) && header.readUInt32BE(MAGIC.length) === handle.version
    ? gcmOpen(key, header.subarray(MAGIC.length + 4), aadOf(handle, purpose, objectId, header), buf.subarray(HEADER))
    : null;
  check(plain !== null, 'vault_auth_failed');
  return plain;
}

// The SimpleFIN access URL as base64 text (the form the connection column stores).
export function sealConnectionSecret(handle, accessUrl) {
  check(typeof accessUrl === 'string');
  return sealObject(handle, { purpose: PURPOSES.simplefinAccess, objectId: SIMPLEFIN_OBJECT_ID, bytes: Buffer.from(accessUrl, 'utf8') }).toString('base64');
}

export function openConnectionSecret(handle, text) {
  check(typeof text === 'string');
  return openObject(handle, { purpose: PURPOSES.simplefinAccess, objectId: SIMPLEFIN_OBJECT_ID, blob: Buffer.from(text, 'base64') }).toString('utf8');
}

// ---------------------------------------------------------------- contained roots

function lstatOrNull(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) ?? null;
  } catch {
    throw codeError('household_root_invalid');
  }
}

// One directory segment: never a symlink, a directory, no group or other bits. Created 0700 when
// `create`; false when missing and not created. An existing segment is never re-permissioned.
function checkSegment(path, create) {
  let st = lstatOrNull(path);
  if (!st && create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (e) {
      if (e?.code !== 'EEXIST') throw codeError('household_root_invalid');
    }
    st = lstatOrNull(path);
  }
  if (!st) return false;
  check(!st.isSymbolicLink(), 'household_root_symlink');
  check(st.isDirectory(), 'household_root_invalid');
  check((st.mode & 0o077) === 0, 'household_root_not_private');
  return true;
}

function walk(base, segments, create) {
  let path = base;
  for (const seg of segments) {
    path = join(path, seg);
    check(checkSegment(path, create), 'household_root_missing');
  }
  let real;
  try {
    real = realpathSync(path);
  } catch {
    throw codeError('household_root_missing');
  }
  check(real === path, 'household_root_symlink');
  return path;
}

// A frozen { householdId, path } for `<dataRoot>/<relativeRoot>`, where relativeRoot is
// households/<seg>[/<seg>...] (at most 4 segments below households) and every segment is checked.
export async function householdRoot({ dataRoot, householdId, relativeRoot, create = false } = {}) {
  const segments = typeof relativeRoot === 'string' ? relativeRoot.split('/') : [];
  check(segments[0] === 'households' && segments.length >= 2 && segments.length <= MAX_ROOT_SEGMENTS + 1
    && segments.slice(1).every(s => ID.test(s)), 'household_root_invalid');
  check(isId(householdId));
  check(typeof dataRoot === 'string' && dataRoot !== '', 'household_root_invalid');
  let base;
  try {
    base = realpathSync(dataRoot);
  } catch {
    throw codeError('household_root_missing');
  }
  const root = Object.freeze({ householdId, path: walk(base, segments, create) });
  ROOTS.set(root, { base, segments });
  return root;
}

// Both must be genuine, and of one household (vault_household_mismatch otherwise).
export function assertSameHousehold(root, handle) {
  keyOf(handle);
  check(root !== null && typeof root === 'object' && ROOTS.has(root));
  check(root.householdId === handle.householdId, 'vault_household_mismatch');
}

// `<root>/<name>` after rechecking every root segment: a private directory, never a symlink.
// Created 0700 when `create`; null when missing and not created.
export function containedDir(root, name, { create = false } = {}) {
  const r = root !== null && typeof root === 'object' ? ROOTS.get(root) : undefined;
  check(r && isId(name));
  const path = join(walk(r.base, r.segments, false), name);
  return checkSegment(path, create) ? path : null;
}

// A regular file read without following a final symlink: vault_object_missing when absent,
// vault_object_unreadable for a symlink, a non-regular file or a read error.
export function readRegularFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw codeError(e?.code === 'ENOENT' ? 'vault_object_missing' : 'vault_object_unreadable');
  }
  try {
    check(fstatSync(fd).isFile(), 'vault_object_unreadable');
    return readFileSync(fd);
  } catch {
    throw codeError('vault_object_unreadable');
  } finally {
    closeSync(fd);
  }
}

// Create `path` exclusively (0600, never through a symlink), write and fsync it; removed again
// when the write fails.
export function writePrivateFile(path, bytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw codeError('vault_write_failed');
  }
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    rmSync(path, { force: true });
    throw codeError('vault_write_failed');
  }
  closeSync(fd);
}

// ---------------------------------------------------------------- objects on disk

// Seal and write `<root>/files/<objectId>.bin` atomically (exclusive temp, fsync, rename, directory
// fsync). Returns the stored path `files/<objectId>.bin`. A refused call writes nothing.
export async function storeObject({ root, handle, purpose, objectId, bytes } = {}) {
  assertSameHousehold(root, handle);
  const blob = sealObject(handle, { purpose, objectId, bytes });
  const dir = containedDir(root, 'files', { create: true });
  const final = join(dir, `${objectId}.bin`);
  const tmp = join(dir, `.${objectId}.${randomBytes(6).toString('hex')}.tmp`);
  writePrivateFile(tmp, blob); // removes tmp itself when the write or fsync fails
  try {
    renameSync(tmp, final);
    fsyncDir(final);
  } catch {
    rmSync(tmp, { force: true });
    throw codeError('vault_write_failed');
  }
  return `files/${objectId}.bin`;
}

export async function readObject({ root, handle, purpose, objectId, storedPath } = {}) {
  assertSameHousehold(root, handle);
  check(isPurpose(purpose) && isId(objectId));
  check(storedPath === `files/${objectId}.bin`, 'vault_stored_path_invalid');
  const dir = containedDir(root, 'files');
  check(dir, 'vault_object_missing');
  return openObject(handle, { purpose, objectId, blob: readRegularFile(join(dir, `${objectId}.bin`)) });
}

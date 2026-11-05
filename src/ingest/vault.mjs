// Encryption at rest for uploaded files: AES-256-GCM under a 32 byte data key.
// Blob layout: 'FTHM1' (5 bytes) + 12 byte random IV + ciphertext + 16 byte GCM tag; the file id is
// bound as additional authenticated data. Key material and file contents never reach logs or errors.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MAGIC = Buffer.from('FTHM1', 'latin1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STORED_PATH = /^files\/([A-Za-z0-9_-]{1,128})\.bin$/;
const MAX_KEY_FILE = 4096;

const KEY_LENGTH = 'data key must be 32 bytes';
const AUTH_FAILED = 'file failed authentication';
const REAL_NEEDS_KEY = 'uploads need FATHOM_DATA_KEY_FILE: set it to a file holding a 32 byte key';

export class VaultError extends Error {
  constructor(message) { super(message); this.name = 'VaultError'; }
}

const filesDir = (dataDir) => join(dataDir, 'files');

async function ensureFilesDir(dataDir) {
  const dir = filesDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

// Read a regular file without following a final symlink. Errors carry no path or content.
async function readPrivate(path, limit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new VaultError('data key file must be a regular file');
    if (limit != null && stat.size > limit) throw new VaultError(KEY_LENGTH);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof VaultError) throw error;
    if (error && error.code === 'ELOOP') throw new VaultError('data key file must not be a symlink');
    throw new VaultError('data key file could not be read');
  } finally {
    await handle?.close();
  }
}

// 32 raw bytes, or text that trims to 64 hex characters or to base64 of 32 bytes. A 32 byte file
// made only of hex or base64 characters is a text key of the wrong length, not a raw key (a random
// raw key lands entirely in that alphabet with negligible probability).
const KEY_TEXT = /^[A-Za-z0-9+/=_\s-]*$/;
function parseKey(buf) {
  const text = buf.toString('latin1');
  if (buf.length === KEY_BYTES && !KEY_TEXT.test(text)) return Buffer.from(buf);
  return parseTextKey(text.trim());
}

function parseTextKey(text) {
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(text) || /^[A-Za-z0-9_-]{43}$/.test(text)) {
    const key = Buffer.from(text, text.includes('+') || text.includes('/') || text.endsWith('=') ? 'base64' : 'base64url');
    if (key.length === KEY_BYTES) return key;
  }
  throw new VaultError(KEY_LENGTH);
}

function checkKey(key) {
  if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) throw new VaultError(KEY_LENGTH);
  if (key.length !== KEY_BYTES) throw new VaultError(KEY_LENGTH);
  return Buffer.from(key);
}

export async function loadDataKey({ dataDir, keyFile, mode } = {}) {
  if (keyFile) return parseKey(await readPrivate(keyFile, MAX_KEY_FILE));
  if (mode !== 'demo') throw new VaultError(REAL_NEEDS_KEY);
  if (!dataDir) throw new VaultError('a data directory is required for the demo key');
  const dir = await ensureFilesDir(dataDir);
  const file = join(dir, 'demo.key');
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') return parseKey(await readPrivate(file, MAX_KEY_FILE));
    throw new VaultError('demo key could not be created');
  }
  const key = randomBytes(KEY_BYTES);
  try {
    await handle.writeFile(key);
    await handle.sync();
  } catch {
    await handle.close().catch(() => {});
    await rm(file, { force: true });
    throw new VaultError('demo key could not be created');
  }
  await handle.close();
  return key;
}

export function encrypt(key, bytes, aad) {
  const k = checkKey(key);
  if (typeof aad !== 'string' || aad === '') throw new VaultError('a file id is required');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function decrypt(key, blob, aad) {
  const k = checkKey(key);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
  if (typeof aad !== 'string' || buf.length < MAGIC.length + IV_BYTES + TAG_BYTES
    || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new VaultError(AUTH_FAILED);
  try {
    const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(MAGIC.length + IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new VaultError(AUTH_FAILED);
  }
}

// Writes $dataDir/files/<id>.bin atomically (temp file, fsync, rename) with mode 0600 in a 0700
// directory. Returns the relative stored path.
export async function storeFile({ dataDir, key, id, bytes } = {}) {
  if (!ID.test(String(id))) throw new VaultError('invalid file id');
  const blob = encrypt(key, bytes, id);
  const dir = await ensureFilesDir(dataDir);
  const final = join(dir, `${id}.bin`);
  const tmp = join(dir, `${id}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let handle;
  try {
    handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(blob);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, final);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true });
    if (error instanceof VaultError) throw error;
    throw new VaultError('file could not be stored');
  }
  return `files/${id}.bin`;
}

export async function readStoredFile({ dataDir, key, id, storedPath } = {}) {
  const m = STORED_PATH.exec(String(storedPath));
  if (!m) throw new VaultError('invalid stored path');
  let blob;
  let handle;
  try {
    handle = await open(join(filesDir(dataDir), `${m[1]}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a file');
    blob = await handle.readFile();
  } catch {
    throw new VaultError('stored file could not be read');
  } finally {
    await handle?.close();
  }
  return decrypt(key, blob, String(id));
}

// Removes stored uploads (*.bin) only; the demo key and anything else stay.
export async function clearStoredFiles(dataDir) {
  let entries;
  try {
    entries = await readdir(filesDir(dataDir), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { removed: 0 };
    throw new VaultError('stored files could not be listed');
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith('.bin') || entry.isDirectory()) continue;
    await unlink(join(filesDir(dataDir), entry.name));
    removed += 1;
  }
  return { removed };
}

// The legacy FTHM1 upload vault codec, kept only for the offline cutover: the MT-02 conversion
// (src/platform/vault-convert.mjs) and the MT-03 tenancy migration (src/platform/migrate-tenancy.mjs)
// are its only importers. The running server reads and writes FTHM2 (src/platform/household-vault.mjs).
//
// FTHM1 blob: 'FTHM1' (5 bytes), a 12 byte random IV, the AES-256-GCM ciphertext and the 16 byte tag,
// with the object id (or LEGACY_SIMPLEFIN_AAD for the SimpleFIN access secret) as additional data.
// The legacy data key file (FATHOM_DATA_KEY_FILE) holds 32 raw bytes, 64 hex characters or base64 /
// base64url of 32 bytes. Errors carry fixed codes only: no path, key material or content.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { codeError } from './db.mjs';

export const LEGACY_SIMPLEFIN_AAD = 'simplefin:access';

const MAGIC = Buffer.from('FTHM1', 'latin1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_KEY_FILE = 4096;
// A 32 byte file made only of hex or base64 characters is a text key of the wrong length, not a raw
// key (a random raw key lands entirely in that alphabet with negligible probability).
const KEY_TEXT = /^[A-Za-z0-9+/=_\s-]*$/;

// The 32 byte key in a key file's bytes, or legacy_key_invalid.
export function parseLegacyKey(buf) {
  const text = Buffer.from(buf).toString('latin1');
  if (buf.length === KEY_BYTES && !KEY_TEXT.test(text)) return Buffer.from(buf);
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(t) || /^[A-Za-z0-9_-]{43}$/.test(t)) {
    const key = Buffer.from(t, t.includes('+') || t.includes('/') || t.endsWith('=') ? 'base64' : 'base64url');
    if (key.length === KEY_BYTES) return key;
  }
  throw codeError('legacy_key_invalid');
}

// The legacy data key from `file`: a regular file (a final symlink is refused) of at most 4 KiB.
// Any failure is legacy_key_invalid.
export function loadLegacyKey(file) {
  if (typeof file !== 'string' || file === '') throw codeError('legacy_key_invalid');
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw codeError('legacy_key_invalid');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_KEY_FILE) throw new Error('invalid key file');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return parseLegacyKey(buf.subarray(0, off));
  } catch {
    throw codeError('legacy_key_invalid');
  } finally {
    closeSync(fd);
  }
}

function checkKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw codeError('legacy_key_invalid');
  return Buffer.from(key);
}

// An FTHM1 blob of `bytes` bound to `aad`. Used by the conversion's tests to build legacy fixtures.
export function encrypt(key, bytes, aad) {
  const k = checkKey(key);
  if (typeof aad !== 'string' || aad === '') throw codeError('legacy_aad_invalid');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

// The plaintext of an FTHM1 blob, or legacy_auth_failed for a wrong key, id or byte.
export function decrypt(key, blob, aad) {
  const k = checkKey(key);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
  if (typeof aad !== 'string' || buf.length < MAGIC.length + IV_BYTES + TAG_BYTES
    || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw codeError('legacy_auth_failed');
  try {
    const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(MAGIC.length + IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw codeError('legacy_auth_failed');
  }
}

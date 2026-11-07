// The offline backup key (FATHOM_BACKUP_KEY_FILE): a private regular file (no group or other
// permission bits, not a symlink) holding a 32 byte key in the formats the upload vault accepts
// (src/ingest/vault.mjs): 32 raw bytes, 64 hex characters, or base64/base64url of 32 bytes.
// Every failure is the fixed code backup_key_invalid; no path or key material reaches an error.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { codeError } from './db.mjs';

const KEY_BYTES = 32;
const MAX_KEY_FILE = 4096;
const KEY_TEXT = /^[A-Za-z0-9+/=_\s-]*$/;

const invalid = () => codeError('backup_key_invalid');

// Mirrors the vault parser: a 32 byte file made only of text-key characters is a text key.
function parseKey(buf) {
  const text = buf.toString('latin1');
  if (buf.length === KEY_BYTES && !KEY_TEXT.test(text)) return Buffer.from(buf);
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(t) || /^[A-Za-z0-9_-]{43}$/.test(t)) {
    const key = Buffer.from(t, t.includes('+') || t.includes('/') || t.endsWith('=') ? 'base64' : 'base64url');
    if (key.length === KEY_BYTES) return key;
  }
  throw invalid();
}

export function loadBackupKey(file) {
  if (typeof file !== 'string' || file === '') throw invalid();
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw invalid();
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > MAX_KEY_FILE) throw invalid();
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return parseKey(buf.subarray(0, off));
  } catch (e) {
    if (e && e.code === 'backup_key_invalid') throw e;
    throw invalid();
  } finally {
    closeSync(fd);
  }
}

// The backup key file named by the environment, or a backup_key_invalid refusal.
export const backupKeyFromEnv = (env = process.env) => loadBackupKey(env.FATHOM_BACKUP_KEY_FILE);

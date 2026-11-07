// Offline key files: a private regular file (no group or other permission bits, not a symlink)
// holding a 32 byte key in the formats the upload vault accepts (src/ingest/vault.mjs): 32 raw
// bytes, 64 hex characters, or base64/base64url of 32 bytes. The backup key
// (FATHOM_BACKUP_KEY_FILE) encrypts source snapshots; the platform key (FATHOM_PLATFORM_KEY_FILE)
// wraps household data keys (src/platform/household-vault.mjs) and is read by no server path until
// MT-03. Every failure is the caller's fixed code; no path or key material reaches an error.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { codeError } from './db.mjs';

const KEY_BYTES = 32;
const MAX_KEY_FILE = 4096;
const KEY_TEXT = /^[A-Za-z0-9+/=_\s-]*$/;

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
  return null;
}

// The 32 byte key in `file`, or an Error whose fixed code is `code`.
export function loadKeyFile(file, code) {
  const invalid = () => codeError(code);
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
    const key = parseKey(buf.subarray(0, off));
    if (!key) throw invalid();
    return key;
  } catch {
    throw invalid();
  } finally {
    closeSync(fd);
  }
}

export const loadBackupKey = file => loadKeyFile(file, 'backup_key_invalid');
export const loadPlatformKey = file => loadKeyFile(file, 'platform_key_invalid');

// The key files named by the environment, or the matching fixed-code refusal.
export const backupKeyFromEnv = (env = process.env) => loadBackupKey(env.FATHOM_BACKUP_KEY_FILE);
export const platformKeyFromEnv = (env = process.env) => loadPlatformKey(env.FATHOM_PLATFORM_KEY_FILE);

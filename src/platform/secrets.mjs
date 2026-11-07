// Instance secrets: the platform key (wraps every household data key, src/platform/household-vault.mjs)
// and the MCP secret (the HMAC key of MCP API key hashes, src/mcp/keys.mjs).
//
// createInstanceSecrets({ config, mode }) -> { platformKey(): Buffer, mcpSecret(): Buffer }
// Real instances read config.platformKeyFile (FATHOM_PLATFORM_KEY_FILE, any key format
// loadPlatformKey accepts) and config.mcpSecretFile (FATHOM_MCP_SECRET_FILE, 64 hex characters);
// both must be private regular files, never symlinks. A missing secret is never generated.
// Demo instances keep synthetic secrets in <dataDir>/platform-secrets/{platform.key,mcp.secret}
// (directory 0700, files 0600), created exclusively the first time they are needed.
// Reads are lazy and only a success is cached, so a fixed file is picked up by the next call.
// Refusals are codeError with platform_key_missing | platform_key_invalid | mcp_secret_missing |
// mcp_secret_invalid; no path or key material reaches an error.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeError } from './db.mjs';
import { loadPlatformKey } from './backup-key.mjs';

export const DEMO_SECRETS_DIR = 'platform-secrets';
export const DEMO_PLATFORM_KEY = 'platform.key';
export const DEMO_MCP_SECRET = 'mcp.secret';
const MAX_SECRET_FILE = 4096;

// True when `file` names nothing on disk (a dangling symlink is not missing; it is invalid).
function absent(file) {
  if (typeof file !== 'string' || file === '') return true;
  try {
    return !lstatSync(file, { throwIfNoEntry: false });
  } catch {
    return false;
  }
}

// The trimmed text of a private regular file, or null when it cannot be read as one.
function readPrivateText(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > MAX_SECRET_FILE) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('latin1').trim();
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function loadPlatformKeyFile(file) {
  if (absent(file)) throw codeError('platform_key_missing');
  return loadPlatformKey(file);
}

export function loadMcpSecretFile(file) {
  if (absent(file)) throw codeError('mcp_secret_missing');
  const text = readPrivateText(file);
  if (text === null || !/^[0-9a-fA-F]{64}$/.test(text)) throw codeError('mcp_secret_invalid');
  return Buffer.from(text, 'hex');
}

// Write 32 random bytes as hex to `file` (0600) unless it already exists.
function createExclusive(file) {
  try {
    writeFileSync(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
  }
}

// The demo secrets directory, created 0700, and both files inside it.
export function ensureDemoSecrets(dataDir) {
  const dir = join(dataDir, DEMO_SECRETS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const platformKeyFile = join(dir, DEMO_PLATFORM_KEY);
  const mcpSecretFile = join(dir, DEMO_MCP_SECRET);
  createExclusive(platformKeyFile);
  createExclusive(mcpSecretFile);
  return { platformKeyFile, mcpSecretFile };
}

export function createInstanceSecrets({ config, mode } = {}) {
  if (!config || typeof config.dataDir !== 'string') throw new TypeError('createInstanceSecrets needs the config');
  if (mode !== 'real' && mode !== 'demo') throw new TypeError('createInstanceSecrets mode must be real or demo');
  const files = () => (mode === 'demo'
    ? ensureDemoSecrets(config.dataDir)
    : { platformKeyFile: config.platformKeyFile, mcpSecretFile: config.mcpSecretFile });
  let platformKey = null;
  let mcpSecret = null;
  return Object.freeze({
    mode,
    platformKey() {
      platformKey ??= loadPlatformKeyFile(files().platformKeyFile);
      return Buffer.from(platformKey);
    },
    mcpSecret() {
      mcpSecret ??= loadMcpSecretFile(files().mcpSecretFile);
      return Buffer.from(mcpSecret);
    },
  });
}

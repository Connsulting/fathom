// Encryption at rest for a household's stored objects (uploads, advisor packets, the SimpleFIN
// access URL): the FTHM2 envelope of src/platform/household-vault.mjs under the household's own
// data key, inside its contained root. The server reads and writes only FTHM2; the FTHM1 codec
// lives in src/platform/legacy-vault.mjs for the offline migration and is never imported here.
//
// `vault` is what `await household.vault()` resolves to: { root, handle }, the household's checked
// root and its data key handle. Every refusal is a VaultError with a fixed `.code` and a fixed
// message; key material, file contents and paths never reach errors or logs.
//
// openVault(household) -> vault (a key refusal, platform_key_missing, platform_key_invalid or
//   data_key_missing, becomes a VaultError whose message names FATHOM_PLATFORM_KEY_FILE; HTTP callers answer any VaultError 409 with its message)
// storeFile({ vault, id, bytes, purpose }) -> 'files/<id>.bin'
// readStoredFile({ vault, id, storedPath, purpose }) -> plaintext bytes
// clearStoredFiles(vault) -> { removed }
// workDir(vault) -> '<root>/work' (private, created when missing) for build intermediates
// sealAccess(vault, url) -> base64 text; openAccess(vault, text) -> url

import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  PURPOSES, storeObject, readObject, containedDir, assertSameHousehold, sealConnectionSecret, openConnectionSecret,
} from '../platform/household-vault.mjs';

export { PURPOSES };

const KEY_MESSAGE = 'the household vault needs FATHOM_PLATFORM_KEY_FILE: set it to a file holding the 32 byte platform key';

const MESSAGES = Object.freeze({
  platform_key_missing: KEY_MESSAGE,
  platform_key_invalid: KEY_MESSAGE,
  data_key_missing: 'the household data key is unavailable: check FATHOM_PLATFORM_KEY_FILE',
  vault_auth_failed: 'stored object failed authentication',
  vault_object_missing: 'stored object could not be read',
  vault_object_unreadable: 'stored object could not be read',
  vault_stored_path_invalid: 'invalid stored path',
  vault_write_failed: 'stored object could not be written',
  vault_household_mismatch: 'stored object belongs to another household',
  vault_invalid_input: 'invalid vault request',
});

export class VaultError extends Error {
  constructor(code, message = MESSAGES[code] ?? 'vault operation failed') {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

// Any refusal as a VaultError carrying the same code (an unknown failure becomes vault_failed).
function asVaultError(error) {
  if (error instanceof VaultError) return error;
  const code = typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'vault_failed';
  return new VaultError(code);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (error) {
    throw asVaultError(error);
  }
}

// The household's { root, handle }, resolved by its context; a refusal keeps its code.
export function openVault(household) {
  if (!household || typeof household.vault !== 'function') throw new TypeError('openVault needs a household context');
  return guarded(() => household.vault());
}

// Seal and write <root>/files/<id>.bin atomically (0600 in a 0700 directory). Returns the stored path.
export function storeFile({ vault, id, bytes, purpose } = {}) {
  return guarded(() => storeObject({ root: vault?.root, handle: vault?.handle, purpose, objectId: id, bytes }));
}

export function readStoredFile({ vault, id, storedPath, purpose } = {}) {
  return guarded(() => readObject({ root: vault?.root, handle: vault?.handle, purpose, objectId: String(id), storedPath }));
}

// Removes the household's stored objects (files/*.bin) only; nothing outside its root is touched.
export function clearStoredFiles(vault) {
  return guarded(() => {
    assertSameHousehold(vault?.root, vault?.handle);
    const dir = containedDir(vault.root, 'files');
    if (!dir) return { removed: 0 };
    let removed = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
      unlinkSync(join(dir, entry.name));
      removed += 1;
    }
    return { removed };
  });
}

// The household's private scratch directory for packet intermediates (0700, never a symlink).
export function workDir(vault) {
  try {
    assertSameHousehold(vault?.root, vault?.handle);
    return containedDir(vault.root, 'work', { create: true });
  } catch (error) {
    throw asVaultError(error);
  }
}

// The SimpleFIN access URL sealed for the connection row, and opened again for a sync.
export function sealAccess(vault, url) {
  try {
    return sealConnectionSecret(vault?.handle, url);
  } catch (error) {
    throw asVaultError(error);
  }
}

export function openAccess(vault, text) {
  try {
    return openConnectionSecret(vault?.handle, text);
  } catch (error) {
    throw asVaultError(error);
  }
}

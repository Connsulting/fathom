// Migration-only conversion of one household's legacy vault into an FTHM2 bundle (MT-02). Offline
// tooling for the MT-03 cutover; nothing imports it yet. This is the only reader of the legacy
// FTHM1 blobs and the fixed-AAD SimpleFIN secret outside the running server.
//
// The legacy store is only SELECTed from and legacy files are only read. Every vault object
// (uploads in `files`, `advisor_packets`, the `simplefin_connection` secret) is decrypted, checked
// against its recorded hash and size, sealed under the household data key and staged in
// <root>/work/vault-<operationId>.partial. Every staged object is read back from disk and opened
// through the new codec before manifest.json is written, then the partial is published by one
// rename. On any failure this call removes only what it created. Moving the bundle into the active
// root and updating the store is MT-03's journaled step.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt } from '../ingest/vault.mjs';
import { codeError } from './db.mjs';
import { fsyncFile } from './fsutil.mjs';
import {
  PURPOSES, SIMPLEFIN_OBJECT_ID, assertSameHousehold, containedDir, isId, openObject, readRegularFile, sealObject, writePrivateFile,
} from './household-vault.mjs';

const LEGACY_SIMPLEFIN_AAD = 'simplefin:access';
const SIMPLEFIN_FILE = 'simplefin-access.fthm2';
const FORMAT = 'fathom-vault-bundle/1';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Where and in what form each staged object is kept: the SimpleFIN secret as the base64 text its
// column stores, every other object as raw FTHM2 bytes at files/<id>.bin.
const storedForm = o => (o.purpose === PURPOSES.simplefinAccess
  ? { file: SIMPLEFIN_FILE, encode: blob => Buffer.from(blob.toString('base64')), decode: bytes => Buffer.from(bytes.toString('latin1'), 'base64') }
  : { file: `files/${o.objectId}.bin`, encode: blob => blob, decode: bytes => bytes });

// Run a filesystem step; its raw error (which names paths) becomes `code`.
function fsStep(fn, code = 'vault_write_failed') {
  try {
    return fn();
  } catch {
    throw codeError(code);
  }
}
const lstatOrNull = path => fsStep(() => lstatSync(path, { throwIfNoEntry: false }) ?? null);
const syncDir = dir => fsStep(() => fsyncFile(dir));

function legacyOpen(key, blob, aad) {
  try {
    return decrypt(key, blob, aad);
  } catch {
    throw codeError('vault_legacy_auth_failed');
  }
}

// Every vault reader's object, from SELECTs only.
function inventory(db) {
  const rows = [
    ...db.prepare('SELECT id, stored_path, sha256, size FROM files WHERE stored_path IS NOT NULL ORDER BY id').all()
      .map(r => ({ ...r, purpose: PURPOSES.upload })),
    ...db.prepare('SELECT id, stored_path, sha256, bytes AS size FROM advisor_packets ORDER BY id').all()
      .map(r => ({ ...r, purpose: PURPOSES.advisorPacket })),
  ];
  for (const r of rows) {
    if (!isId(r.id) || r.stored_path !== `files/${r.id}.bin`) throw codeError('vault_stored_path_invalid');
  }
  const conn = db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get();
  return { rows, secret: conn ? String(conn.access_blob) : null };
}

// Returns { path (relative to the root), uploads, packets, simplefin, unreferenced, objects }, where
// each object is { purpose, objectId, sha256 (plaintext), ciphertextSha256 (the FTHM2 blob) }.
export async function convertHouseholdVault({ db, sourceDir, legacyKey, root, handle, operationId, onPhase = async () => {} } = {}) {
  if (!isId(operationId) || typeof sourceDir !== 'string'
    || !(legacyKey instanceof Uint8Array) || legacyKey.length !== 32) throw codeError('vault_invalid_input');
  assertSameHousehold(root, handle);
  const { rows, secret } = inventory(db);

  const legacyDir = join(sourceDir, 'files');
  const legacyStat = lstatOrNull(legacyDir);
  if (legacyStat && (legacyStat.isSymbolicLink() || !legacyStat.isDirectory())) throw codeError('vault_object_unreadable');
  const referenced = new Set(rows.map(r => r.id));
  const unreferenced = legacyStat
    ? fsStep(() => readdirSync(legacyDir), 'vault_object_unreadable').filter(n => n.endsWith('.bin') && !referenced.has(n.slice(0, -4))).length
    : 0;

  const hadWork = containedDir(root, 'work') !== null;
  const work = containedDir(root, 'work', { create: true });
  const final = join(work, `vault-${operationId}`);
  const partial = `${final}.partial`;
  if (lstatOrNull(final)) throw codeError('vault_output_exists');
  if (lstatOrNull(partial)) throw codeError('vault_staging_exists');

  let created = null;
  try {
    try {
      mkdirSync(partial, { mode: 0o700 });
    } catch (e) {
      throw codeError(e?.code === 'EEXIST' ? 'vault_staging_exists' : 'vault_write_failed');
    }
    created = partial;
    const filesDir = join(partial, 'files');
    fsStep(() => mkdirSync(filesDir, { mode: 0o700 }));

    const objects = [];
    const stage = (purpose, objectId, plain, plainSha) => {
      const blob = sealObject(handle, { purpose, objectId, bytes: plain });
      const o = { purpose, objectId, sha256: plainSha, ciphertextSha256: sha256(blob) };
      writePrivateFile(join(partial, storedForm(o).file), storedForm(o).encode(blob));
      objects.push(o);
    };
    for (const r of rows) {
      const plain = legacyOpen(legacyKey, readRegularFile(join(legacyDir, `${r.id}.bin`)), r.id);
      const plainSha = sha256(plain);
      if (plainSha !== r.sha256 || plain.length !== r.size) throw codeError('vault_plaintext_mismatch');
      stage(r.purpose, r.id, plain, plainSha);
    }
    if (secret !== null) {
      const plain = legacyOpen(legacyKey, Buffer.from(secret, 'base64'), LEGACY_SIMPLEFIN_AAD);
      stage(PURPOSES.simplefinAccess, SIMPLEFIN_OBJECT_ID, plain, sha256(plain));
    }
    syncDir(filesDir);
    syncDir(partial);
    await onPhase('staged');

    // Validate before publish: every staged object, read back from disk, opens to the legacy plaintext.
    for (const o of objects) {
      const form = storedForm(o);
      const blob = form.decode(readRegularFile(join(partial, form.file)));
      if (sha256(blob) !== o.ciphertextSha256
        || sha256(openObject(handle, { purpose: o.purpose, objectId: o.objectId, blob })) !== o.sha256) throw codeError('vault_plaintext_mismatch');
    }
    await onPhase('validated');

    const counts = {
      uploads: objects.filter(o => o.purpose === PURPOSES.upload).length,
      packets: objects.filter(o => o.purpose === PURPOSES.advisorPacket).length,
      simplefin: secret !== null ? 1 : 0,
      unreferenced,
    };
    const manifest = { format: FORMAT, householdId: handle.householdId, keyVersion: handle.version, operationId, counts, objects };
    writePrivateFile(join(partial, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    syncDir(partial);
    await onPhase('manifest');

    if (lstatOrNull(final)) throw codeError('vault_output_exists');
    fsStep(() => renameSync(partial, final));
    created = final;
    await onPhase('renamed');
    syncDir(work);
    return { path: `work/vault-${operationId}`, ...counts, objects };
  } catch (e) {
    try {
      if (created) rmSync(created, { recursive: true, force: true });
      if (!hadWork) rmdirSync(work);
    } catch { /* keep the original failure */ }
    throw e;
  }
}

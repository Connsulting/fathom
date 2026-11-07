// AC2 (MT-03): uploaded files are encrypted at rest in the household's own root with the FTHM2
// envelope (src/platform/household-vault.mjs) under that household's data key, which is wrapped by
// the instance platform key (FATHOM_PLATFORM_KEY_FILE). src/ingest/vault.mjs is the server's only vault
// API: storeFile, readStoredFile and clearStoredFiles over `await household.vault()`.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, existsSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { src, tempDir, tempInstance, householdContext } from '../helpers/server.mjs';

let V;
let A;
let B;
const cleanup = [];
before(async () => {
  V = await src('src/ingest/vault.mjs');
  A = await tempInstance({ mode: 'real' });
  B = await tempInstance({ mode: 'real' });
});
after(() => {
  for (const s of [A, B]) {
    if (!s) continue;
    s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  }
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

const KEY_MESSAGE = 'the household vault needs FATHOM_PLATFORM_KEY_FILE: set it to a file holding the 32 byte platform key';
const isVault = (code, message) => (err) => {
  assert.ok(err instanceof V.VaultError, `VaultError, got ${err && err.name}: ${err && err.message}`);
  if (code) assert.equal(err.code, code);
  if (message) assert.equal(err.message, message);
  return true;
};

const vaultOf = async s => (await s.household()).vault();

describe('the household vault', () => {
  test('storeFile writes <root>/files/<id>.bin atomically as FTHM2 with private modes; readStoredFile opens it', async () => {
    const vault = await vaultOf(A);
    const id = 'f-0123456789abcdef01234567';
    const bytes = Buffer.from('Description,Amount\nSYNTHETIC-STORE-CANARY,9134.62\n');
    const storedPath = await V.storeFile({ vault, id, bytes, purpose: 'upload' });
    assert.equal(storedPath, `files/${id}.bin`);
    const abs = join(A.root, storedPath);
    assert.equal(statSync(abs).mode & 0o777, 0o600);
    assert.equal(statSync(join(A.root, 'files')).mode & 0o777, 0o700);
    assert.ok(!existsSync(join(A.dataDir, 'files')), 'nothing is written at the data root');
    const blob = readFileSync(abs);
    assert.equal(blob.subarray(0, 5).toString('latin1'), 'FTHM2');
    assert.ok(!blob.includes(Buffer.from('SYNTHETIC-STORE-CANARY')), 'stored blob does not contain plaintext');
    assert.ok(!blob.includes(Buffer.from('9134.62')));
    assert.deepEqual(readdirSync(join(A.root, 'files')).sort(), [`${id}.bin`], 'no temp files left behind');
    const back = await V.readStoredFile({ vault, id, storedPath, purpose: 'upload' });
    assert.ok(Buffer.from(back).equals(bytes));
    const again = await V.storeFile({ vault, id: 'f-0123456789abcdef01234568', bytes, purpose: 'upload' });
    assert.ok(!readFileSync(join(A.root, again)).subarray(5).equals(blob.subarray(5)), 'a fresh nonce each time');
  });

  test('another object id, another purpose or a tampered blob fails authentication', async () => {
    const vault = await vaultOf(A);
    const id = 'f-aaaaaaaaaaaaaaaaaaaaaaaa';
    const bytes = Buffer.from('SYNTHETIC-PURPOSE-CANARY');
    const storedPath = await V.storeFile({ vault, id, bytes, purpose: 'upload' });
    await assert.rejects(V.readStoredFile({ vault, id, storedPath, purpose: 'advisor-packet' }), isVault('vault_auth_failed'));
    // The same blob under another object id's path.
    const other = 'f-bbbbbbbbbbbbbbbbbbbbbbbb';
    copyFileSync(join(A.root, storedPath), join(A.root, 'files', `${other}.bin`));
    await assert.rejects(V.readStoredFile({ vault, id: other, storedPath: `files/${other}.bin`, purpose: 'upload' }), isVault('vault_auth_failed'));
    // A stored path that does not name the object.
    await assert.rejects(V.readStoredFile({ vault, id, storedPath: `files/${other}.bin`, purpose: 'upload' }), isVault('vault_stored_path_invalid'));
    const abs = join(A.root, storedPath);
    const blob = readFileSync(abs);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    writeFileSync(abs, tampered);
    await assert.rejects(V.readStoredFile({ vault, id, storedPath, purpose: 'upload' }), isVault('vault_auth_failed'));
    writeFileSync(abs, blob);
    assert.ok(Buffer.from(await V.readStoredFile({ vault, id, storedPath, purpose: 'upload' })).equals(bytes), 'the untouched blob still opens');
  });

  test('another household cannot read an object or write into a root with its key', async () => {
    const a = await vaultOf(A);
    const b = await vaultOf(B);
    const id = 'f-cccccccccccccccccccccccc';
    const storedPath = await V.storeFile({ vault: a, id, bytes: Buffer.from('SYNTHETIC-HOUSEHOLD-CANARY'), purpose: 'upload' });
    // A's blob copied into B's root does not open under B's data key.
    mkdirSync(join(B.root, 'files'), { recursive: true, mode: 0o700 });
    copyFileSync(join(A.root, storedPath), join(B.root, storedPath));
    await assert.rejects(V.readStoredFile({ vault: b, id, storedPath, purpose: 'upload' }), isVault('vault_auth_failed'));
    // A root paired with another household's key is refused before anything is written.
    const mixed = { root: b.root, handle: a.handle };
    await assert.rejects(V.storeFile({ vault: mixed, id: 'f-dddddddddddddddddddddddd', bytes: Buffer.from('x'), purpose: 'upload' }), isVault('vault_household_mismatch'));
    await assert.rejects(V.readStoredFile({ vault: mixed, id, storedPath, purpose: 'upload' }), isVault('vault_household_mismatch'));
    assert.ok(!existsSync(join(B.root, 'files', 'f-dddddddddddddddddddddddd.bin')));
  });

  test('clearStoredFiles removes only that household\'s *.bin files', async () => {
    const a = await vaultOf(A);
    const b = await vaultOf(B);
    await V.storeFile({ vault: a, id: 'f-111111111111111111111111', bytes: Buffer.from('one'), purpose: 'upload' });
    await V.storeFile({ vault: a, id: 'f-222222222222222222222222', bytes: Buffer.from('two'), purpose: 'upload' });
    const kept = await V.storeFile({ vault: b, id: 'f-333333333333333333333333', bytes: Buffer.from('three'), purpose: 'upload' });
    writeFileSync(join(A.root, 'files', 'keep.txt'), 'not a stored upload');
    const out = await V.clearStoredFiles(a);
    assert.ok(out.removed >= 2);
    assert.deepEqual(readdirSync(join(A.root, 'files')).sort(), ['keep.txt']);
    assert.ok(existsSync(join(B.root, kept)), 'the other household keeps its objects');
    assert.ok(Buffer.from(await V.readStoredFile({ vault: b, id: 'f-333333333333333333333333', storedPath: kept, purpose: 'upload' })).equals(Buffer.from('three')));
  });
});

describe('the platform key', () => {
  async function contextWith(s, platformKeyFile) {
    const { createInstanceSecrets } = await src('src/platform/secrets.mjs');
    const config = { dataDir: s.dataDir, platformKeyFile, mcpSecretFile: null };
    return householdContext({ db: s.db, platform: s.platform, householdId: s.householdId, mode: 'real', config, secrets: createInstanceSecrets({ config, mode: 'real' }) });
  }

  test('without FATHOM_PLATFORM_KEY_FILE the vault refuses with the message naming it and writes nothing', async () => {
    const household = await contextWith(A, null);
    await assert.rejects(V.openVault(household), isVault('platform_key_missing', KEY_MESSAGE));
    const listing = () => (existsSync(join(A.root, 'files')) ? readdirSync(join(A.root, 'files')).sort() : []);
    const before = listing();
    await assert.rejects(V.openVault(household), isVault('platform_key_missing'), 'a refusal is not cached as a success');
    assert.deepEqual(listing(), before);
  });

  test('another platform key refuses as platform_key_invalid; the configured one still opens', async () => {
    const dir = await tempDir('fathom-vault-key-');
    cleanup.push(dir);
    const wrong = join(dir, 'platform.key');
    writeFileSync(wrong, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    const household = await contextWith(A, wrong);
    await assert.rejects(V.openVault(household), isVault('platform_key_invalid', KEY_MESSAGE));
    const right = await contextWith(A, A.keys.platformKeyFile);
    const vault = await V.openVault(right);
    assert.equal(vault.root.householdId, A.householdId);
  });
});

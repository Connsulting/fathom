// AC2: uploaded files are encrypted at rest with AES-256-GCM under a 32 byte data key.
// Real mode needs FATHOM_DATA_KEY_FILE; demo mode generates its own key once.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, existsSync, symlinkSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { src, tempDir } from '../helpers/server.mjs';

let V;
let dir;
before(async () => {
  V = await src('src/ingest/vault.mjs');
  dir = await tempDir('fathom-vault-');
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const REAL_MESSAGE = 'uploads need FATHOM_DATA_KEY_FILE: set it to a file holding a 32 byte key';
const isVault = (message) => (err) => {
  assert.ok(err instanceof V.VaultError, `VaultError, got ${err && err.name}: ${err && err.message}`);
  if (message) assert.equal(err.message, message);
  return true;
};

function keyFile(name, content) {
  const file = join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

describe('loadDataKey', () => {
  test('accepts exactly 32 raw bytes', async () => {
    const raw = randomBytes(32);
    const key = await V.loadDataKey({ dataDir: dir, keyFile: keyFile('raw.key', raw), mode: 'real' });
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, 32);
    assert.ok(key.equals(raw));
  });

  test('accepts 64 hex characters (trimmed)', async () => {
    const raw = randomBytes(32);
    const key = await V.loadDataKey({ dataDir: dir, keyFile: keyFile('hex.key', `  ${raw.toString('hex')}\n`), mode: 'real' });
    assert.ok(key.equals(raw));
  });

  test('accepts base64 of 32 bytes (trimmed)', async () => {
    const raw = randomBytes(32);
    const key = await V.loadDataKey({ dataDir: dir, keyFile: keyFile('b64.key', `${raw.toString('base64')}\n`), mode: 'real' });
    assert.ok(key.equals(raw));
  });

  test('refuses a key of the wrong length without echoing it', async () => {
    const short = randomBytes(31);
    await assert.rejects(async () => V.loadDataKey({ dataDir: dir, keyFile: keyFile('short.key', short), mode: 'real' }), isVault('data key must be 32 bytes'));
    const hex16 = randomBytes(16).toString('hex');
    await assert.rejects(async () => V.loadDataKey({ dataDir: dir, keyFile: keyFile('hex16.key', hex16), mode: 'real' }), (err) => {
      isVault('data key must be 32 bytes')(err);
      assert.ok(!String(err.stack).includes(hex16), 'the key text never appears in the error');
      return true;
    });
    await assert.rejects(async () => V.loadDataKey({ dataDir: dir, keyFile: keyFile('long.key', randomBytes(33)), mode: 'real' }), isVault('data key must be 32 bytes'));
  });

  test('refuses a symlinked key file; the same key as a regular file is accepted', async () => {
    const raw = randomBytes(32);
    const target = keyFile('target.key', raw);
    const link = join(dir, 'link.key');
    symlinkSync(target, link);
    await assert.rejects(async () => V.loadDataKey({ dataDir: dir, keyFile: link, mode: 'real' }), isVault());
    const key = await V.loadDataKey({ dataDir: dir, keyFile: target, mode: 'real' });
    assert.ok(key.equals(raw));
  });

  test('real mode without a key file throws the clear error and writes nothing', async () => {
    const dataDir = await tempDir('fathom-vault-real-');
    try {
      await assert.rejects(async () => V.loadDataKey({ dataDir, keyFile: null, mode: 'real' }), isVault(REAL_MESSAGE));
      const files = join(dataDir, 'files');
      assert.ok(!existsSync(files) || readdirSync(files).length === 0, 'nothing written under files/');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('demo mode generates files/demo.key once with mode 0600 and reuses it', async () => {
    const dataDir = await tempDir('fathom-vault-demo-');
    try {
      const first = await V.loadDataKey({ dataDir, keyFile: null, mode: 'demo' });
      const file = join(dataDir, 'files', 'demo.key');
      assert.ok(existsSync(file));
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(first.length, 32);
      const onDisk = readFileSync(file);
      const second = await V.loadDataKey({ dataDir, keyFile: null, mode: 'demo' });
      assert.ok(second.equals(first), 'same key on the second call');
      assert.ok(readFileSync(file).equals(onDisk), 'key file unchanged');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('encrypt and decrypt', () => {
  const key = randomBytes(32);
  const plain = Buffer.from('Date,Amount\n2032-03-01,SYNTHETIC-VAULT-CANARY 4821.17\n');

  test('round trip with the FTHM1 header, a 12 byte IV and a 16 byte tag', () => {
    const blob = V.encrypt(key, plain, 'f-aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.ok(Buffer.isBuffer(blob));
    assert.equal(blob.subarray(0, 5).toString('latin1'), 'FTHM1');
    assert.equal(blob.length, 5 + 12 + plain.length + 16);
    assert.ok(!blob.includes(Buffer.from('SYNTHETIC-VAULT-CANARY')), 'ciphertext does not contain the plaintext');
    assert.ok(V.decrypt(key, blob, 'f-aaaaaaaaaaaaaaaaaaaaaaaa').equals(plain));
    const again = V.encrypt(key, plain, 'f-aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.ok(!again.equals(blob), 'a fresh IV each time');
  });

  test('wrong key, wrong aad and tampering fail authentication', () => {
    const aad = 'f-bbbbbbbbbbbbbbbbbbbbbbbb';
    const blob = V.encrypt(key, plain, aad);
    const auth = isVault('file failed authentication');
    assert.throws(() => V.decrypt(randomBytes(32), blob, aad), auth);
    assert.throws(() => V.decrypt(key, blob, 'f-cccccccccccccccccccccccc'), auth);
    const body = Buffer.from(blob); body[5 + 12 + 3] ^= 0x01;
    assert.throws(() => V.decrypt(key, body, aad), auth);
    const tag = Buffer.from(blob); tag[tag.length - 1] ^= 0x01;
    assert.throws(() => V.decrypt(key, tag, aad), auth);
    const iv = Buffer.from(blob); iv[6] ^= 0x01;
    assert.throws(() => V.decrypt(key, iv, aad), auth);
    assert.ok(V.decrypt(key, blob, aad).equals(plain), 'the untouched blob still decrypts');
  });
});

describe('stored files', () => {
  test('storeFile writes files/<id>.bin atomically with private modes; readStoredFile decrypts it', async () => {
    const dataDir = await tempDir('fathom-vault-store-');
    try {
      const key = randomBytes(32);
      const id = 'f-0123456789abcdef01234567';
      const bytes = Buffer.from('Description,Amount\nSYNTHETIC-STORE-CANARY,9134.62\n');
      const storedPath = await V.storeFile({ dataDir, key, id, bytes });
      assert.equal(storedPath, `files/${id}.bin`);
      const abs = join(dataDir, storedPath);
      assert.equal(statSync(abs).mode & 0o777, 0o600);
      assert.equal(statSync(join(dataDir, 'files')).mode & 0o777, 0o700);
      const blob = readFileSync(abs);
      assert.ok(!blob.includes(Buffer.from('SYNTHETIC-STORE-CANARY')), 'stored blob does not contain plaintext');
      assert.ok(!blob.includes(Buffer.from('9134.62')));
      assert.deepEqual(readdirSync(join(dataDir, 'files')).sort(), [`${id}.bin`], 'no temp files left behind');
      const back = await V.readStoredFile({ dataDir, key, id, storedPath });
      assert.ok(Buffer.from(back).equals(bytes));
      await assert.rejects(async () => V.readStoredFile({ dataDir, key, id: 'f-ffffffffffffffffffffffff', storedPath }), isVault('file failed authentication'));
      await assert.rejects(async () => V.readStoredFile({ dataDir, key: randomBytes(32), id, storedPath }), isVault('file failed authentication'));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('clearStoredFiles removes only *.bin and keeps the demo key', async () => {
    const dataDir = await tempDir('fathom-vault-clear-');
    try {
      const key = await V.loadDataKey({ dataDir, keyFile: null, mode: 'demo' });
      await V.storeFile({ dataDir, key, id: 'f-111111111111111111111111', bytes: Buffer.from('one') });
      await V.storeFile({ dataDir, key, id: 'f-222222222222222222222222', bytes: Buffer.from('two') });
      mkdirSync(join(dataDir, 'files'), { recursive: true });
      writeFileSync(join(dataDir, 'files', 'keep.txt'), 'not a stored upload');
      await V.clearStoredFiles(dataDir);
      assert.deepEqual(readdirSync(join(dataDir, 'files')).sort(), ['demo.key', 'keep.txt']);
      const again = await V.loadDataKey({ dataDir, keyFile: null, mode: 'demo' });
      assert.ok(again.equals(key), 'demo key survives');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

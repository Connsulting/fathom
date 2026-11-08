// MT-02 AC1: upload, advisor packet and connection ciphertext decrypt only with the correct
// household, purpose, object and key version; wrong roots and symlinks are refused.
//
// Covers src/platform/household-vault.mjs (per-household wrapped data keys, the FTHM2 envelope,
// contained household roots), the platform key file loader in src/platform/backup-key.mjs,
// platform migration 002, and the MT-03 cutover: the running server reads and writes FTHM2 only, and
// FTHM1 is reachable only from the offline tenancy migration.
// Every household id, key, path and byte here is synthetic. Refusals are asserted on their fixed
// `.code`, never on message text.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ROOT, src } from './helpers/server.mjs';
import { realStore, aggregatorFile, offEngine } from './helpers/ingest.mjs';
import { openPlatform, createInstance } from '../src/platform/db.mjs';
import * as LegacyVault from '../src/platform/legacy-vault.mjs';
import * as IngestVault from '../src/ingest/vault.mjs';

const A = 'hh-synthetic-a';
const B = 'hh-synthetic-b';
const NOW_MS = Date.parse('2032-03-10T12:00:00.000Z');
const MAGIC2 = Buffer.from('FTHM2', 'latin1');
const HEADER = 5 + 4 + 12;
const TAG = 16;
const CSV = Buffer.from('Date,Description,Amount\n2032-02-01,Synthetic grocery,-25.00\n2032-02-02,Synthetic client payment,900.00\n', 'utf8');
const HTML = Buffer.from('<!doctype html><html><body><h1>Synthetic advisor packet</h1><p>Synthetic figures only.</p></body></html>\n', 'utf8');
const ACCESS_URL = 'https://synthetic-user:synthetic-pass-123@bridge.example.test/simplefin';

let HV;
let BK;
let base;
let platform;
let platformKey;
let hA;
let hB;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Every refusal: an Error whose fixed code is `code`. Works for sync throws and async rejections.
async function refuses(fn, code, label) {
  await assert.rejects(async () => fn(), err => {
    assert.ok(err instanceof Error, `${label ?? code}: an Error`);
    assert.equal(err.code, code, label);
    return true;
  });
}

async function addHousehold(db, id) {
  await db.prepare(`INSERT INTO households (id, status, mode, display_name, serves_store, created_at, updated_at)
    VALUES (?, 'active', 'real', NULL, 0, ?, ?)`).run(id, NOW_MS, NOW_MS);
}

async function tempDir(t, prefix = 'fathom-hv-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const privateDir = path => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; };
const modeOf = path => lstatSync(path).mode & 0o777;
const flip = (buf, at) => { const out = Buffer.from(buf); out[at] ^= 0x01; return out; };

// FTHM2 layout: magic, uint32 BE key version, 12 byte nonce, ciphertext, 16 byte tag.
function assertLayout(blob, plaintext, version) {
  assert.ok(Buffer.isBuffer(blob), 'a Buffer');
  assert.ok(blob.subarray(0, 5).equals(MAGIC2), 'starts with FTHM2');
  assert.equal(blob.readUInt32BE(5), version, 'header carries the key version');
  assert.equal(blob.length, HEADER + plaintext.length + TAG, 'header + ciphertext + tag');
}

before(async () => {
  HV = await src('src/platform/household-vault.mjs');
  BK = await src('src/platform/backup-key.mjs');
  base = await mkdtemp(join(tmpdir(), 'fathom-hv-platform-'));
  platform = await openPlatform(join(base, 'platform.sqlite'));
  await addHousehold(platform, A);
  await addHousehold(platform, B);
  platformKey = randomBytes(32);
  hA = await HV.provisionDataKey(platform, { householdId: A, platformKey, now: NOW_MS });
  hB = await HV.provisionDataKey(platform, { householdId: B, platformKey, now: NOW_MS });
});

after(async () => {
  try { await platform?.close(); } catch { /* already closed */ }
  if (base) rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1. round trip per purpose

test('each purpose round-trips under its household handle: upload and advisor packet on disk, the connection secret as text', async t => {
  assert.deepEqual({ ...HV.PURPOSES }, { upload: 'upload', advisorPacket: 'advisor-packet', simplefinAccess: 'simplefin-access' });
  assert.ok(Object.isFrozen(HV.PURPOSES));
  assert.equal(HV.SIMPLEFIN_OBJECT_ID, 'connection-1');
  assert.ok(Buffer.isBuffer(HV.VAULT_MAGIC) && HV.VAULT_MAGIC.equals(MAGIC2));

  const root = await HV.householdRoot({ dataRoot: await tempDir(t), householdId: A, relativeRoot: 'households/a', create: true });
  const cases = [
    [HV.PURPOSES.upload, 'f-0123456789abcdef01234567', CSV, 'Synthetic grocery'],
    [HV.PURPOSES.advisorPacket, 'advpkt-0123456789abcdef', HTML, 'Synthetic advisor packet'],
  ];
  for (const [purpose, objectId, bytes, marker] of cases) {
    const stored = await HV.storeObject({ root, handle: hA, purpose, objectId, bytes });
    assert.equal(stored, `files/${objectId}.bin`, purpose);
    const file = join(root.path, stored);
    const blob = readFileSync(file);
    assertLayout(blob, bytes, 1);
    assert.ok(!blob.includes(Buffer.from(marker)), `${purpose}: stored bytes are encrypted`);
    assert.equal(modeOf(file), 0o600, `${purpose}: object file is 0600`);
    assert.equal(modeOf(join(root.path, 'files')), 0o700, 'files dir is 0700');
    const back = await HV.readObject({ root, handle: hA, purpose, objectId, storedPath: stored });
    assert.ok(Buffer.from(back).equals(bytes), `${purpose}: plaintext round-trips`);
    assert.ok(Buffer.from(HV.openObject(hA, { purpose, objectId, blob })).equals(bytes), `${purpose}: openObject agrees`);
  }

  const text = HV.sealConnectionSecret(hA, ACCESS_URL);
  assert.equal(typeof text, 'string');
  assert.match(text, /^[A-Za-z0-9+/]+={0,2}$/, 'base64 text');
  assert.ok(!text.includes('synthetic-pass-123') && !Buffer.from(text, 'base64').includes(Buffer.from('synthetic-pass-123')), 'credentials are encrypted');
  assertLayout(Buffer.from(text, 'base64'), Buffer.from(ACCESS_URL), 1);
  assert.equal(HV.openConnectionSecret(hA, text), ACCESS_URL);
  // The connection secret is an FTHM2 object of purpose simplefin-access and object connection-1.
  const opened = HV.openObject(hA, { purpose: HV.PURPOSES.simplefinAccess, objectId: HV.SIMPLEFIN_OBJECT_ID, blob: Buffer.from(text, 'base64') });
  assert.equal(Buffer.from(opened).toString('utf8'), ACCESS_URL);
});

// ---------------------------------------------------------------- 2. wrong household

test('a blob sealed for household A fails authentication under household B with the same purpose and object id', async () => {
  const objectId = 'f-wronghousehold00000000';
  const blob = HV.sealObject(hA, { purpose: HV.PURPOSES.upload, objectId, bytes: CSV });
  assert.ok(Buffer.from(HV.openObject(hA, { purpose: HV.PURPOSES.upload, objectId, blob })).equals(CSV), 'liveness: A opens it');
  await refuses(() => HV.openObject(hB, { purpose: HV.PURPOSES.upload, objectId, blob }), 'vault_auth_failed', 'provisioned handle of B');
  await refuses(() => HV.openConnectionSecret(hB, HV.sealConnectionSecret(hA, ACCESS_URL)), 'vault_auth_failed', 'connection secret under B');

  // The household id itself is authenticated: the same raw key under two household ids still refuses.
  const key = randomBytes(32);
  const kA = HV.dataKeyHandle({ householdId: A, version: 1, key });
  const kB = HV.dataKeyHandle({ householdId: B, version: 1, key });
  const shared = HV.sealObject(kA, { purpose: HV.PURPOSES.upload, objectId, bytes: CSV });
  assert.ok(Buffer.from(HV.openObject(kA, { purpose: HV.PURPOSES.upload, objectId, blob: shared })).equals(CSV));
  await refuses(() => HV.openObject(kB, { purpose: HV.PURPOSES.upload, objectId, blob: shared }), 'vault_auth_failed', 'same raw key, other household');
  await refuses(() => HV.openConnectionSecret(kB, HV.sealConnectionSecret(kA, ACCESS_URL)), 'vault_auth_failed', 'connection secret, same raw key');
});

// ---------------------------------------------------------------- 3. risk probe

test('RISK PROBE: household B\'s equal-id upload copied over household A\'s file fails authentication when A reads it', async t => {
  const dataRoot = await tempDir(t);
  const rootA = await HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/a', create: true });
  const rootB = await HV.householdRoot({ dataRoot, householdId: B, relativeRoot: 'households/b', create: true });
  const key = randomBytes(32);
  const pairs = [
    ['provisioned keys', hA, hB, 'f-riskprobe00000000000001'],
    ['one raw key under both household ids', HV.dataKeyHandle({ householdId: A, version: 1, key }), HV.dataKeyHandle({ householdId: B, version: 1, key }), 'f-riskprobe00000000000002'],
  ];
  for (const [label, handleA, handleB, objectId] of pairs) {
    const bytesA = Buffer.from(`synthetic household A upload ${label}\n`);
    const bytesB = Buffer.from(`synthetic household B upload ${label}\n`);
    const storedA = await HV.storeObject({ root: rootA, handle: handleA, purpose: HV.PURPOSES.upload, objectId, bytes: bytesA });
    const storedB = await HV.storeObject({ root: rootB, handle: handleB, purpose: HV.PURPOSES.upload, objectId, bytes: bytesB });
    assert.equal(storedA, storedB, 'equal id, equal stored path');
    assert.ok(Buffer.from(await HV.readObject({ root: rootA, handle: handleA, purpose: HV.PURPOSES.upload, objectId, storedPath: storedA })).equals(bytesA), `${label}: liveness, A reads its own`);

    copyFileSync(join(rootB.path, storedB), join(rootA.path, storedA));
    await refuses(() => HV.readObject({ root: rootA, handle: handleA, purpose: HV.PURPOSES.upload, objectId, storedPath: storedA }), 'vault_auth_failed', label);
    assert.ok(Buffer.from(await HV.readObject({ root: rootB, handle: handleB, purpose: HV.PURPOSES.upload, objectId, storedPath: storedB })).equals(bytesB), `${label}: B still reads its own`);
  }
});

// ---------------------------------------------------------------- 4. purpose, object, version, tampering

test('wrong purpose, object id or key version, any tampered byte, and an FTHM1 blob all fail authentication', async () => {
  const key = randomBytes(32);
  const k1 = HV.dataKeyHandle({ householdId: A, version: 1, key });
  const k2 = HV.dataKeyHandle({ householdId: A, version: 2, key });
  const objectId = 'f-tamper000000000000000001';
  const purpose = HV.PURPOSES.upload;
  const blob = HV.sealObject(k1, { purpose, objectId, bytes: CSV });
  assertLayout(blob, CSV, 1);
  assert.ok(Buffer.from(HV.openObject(k1, { purpose, objectId, blob })).equals(CSV), 'liveness: the untouched blob opens');

  const open = (handle, over = {}) => () => HV.openObject(handle, { purpose, objectId, blob, ...over });
  await refuses(open(k1, { purpose: HV.PURPOSES.advisorPacket }), 'vault_auth_failed', 'upload opened as advisor-packet');
  await refuses(open(k1, { purpose: HV.PURPOSES.simplefinAccess }), 'vault_auth_failed', 'upload opened as simplefin-access');
  await refuses(open(k1, { objectId: 'f-tamper000000000000000002' }), 'vault_auth_failed', 'other object id');
  await refuses(open(k2), 'vault_auth_failed', 'same raw key, handle at version 2');

  const v2 = Buffer.from(blob);
  v2.writeUInt32BE(2, 5);
  await refuses(open(k1, { blob: v2 }), 'vault_auth_failed', 'header version byte changed, version 1 handle');
  await refuses(open(k2, { blob: v2 }), 'vault_auth_failed', 'header version byte changed to 2, version 2 handle');
  await refuses(open(k1, { blob: flip(blob, 8) }), 'vault_auth_failed', 'header version low byte flipped');
  await refuses(open(k1, { blob: flip(blob, 0) }), 'vault_auth_failed', 'magic changed');
  await refuses(open(k1, { blob: flip(blob, 9) }), 'vault_auth_failed', 'nonce changed');
  await refuses(open(k1, { blob: flip(blob, HEADER) }), 'vault_auth_failed', 'first ciphertext byte changed');
  await refuses(open(k1, { blob: flip(blob, blob.length - TAG - 1) }), 'vault_auth_failed', 'last ciphertext byte changed');
  await refuses(open(k1, { blob: flip(blob, blob.length - 1) }), 'vault_auth_failed', 'tag changed');
  await refuses(open(k1, { blob: blob.subarray(0, blob.length - 1) }), 'vault_auth_failed', 'truncated');
  await refuses(open(k1, { blob: blob.subarray(0, 10) }), 'vault_auth_failed', 'header only');
  await refuses(open(k1, { blob: Buffer.alloc(0) }), 'vault_auth_failed', 'empty');

  // The server's FTHM1 envelope under the same raw key and the same object id is not an FTHM2 blob.
  const legacy = LegacyVault.encrypt(key, CSV, objectId);
  assert.ok(legacy.subarray(0, 5).equals(Buffer.from('FTHM1')));
  await refuses(open(k1, { blob: legacy }), 'vault_auth_failed', 'FTHM1 blob');
  await refuses(() => HV.openConnectionSecret(k1, LegacyVault.encrypt(key, Buffer.from(ACCESS_URL), 'simplefin:access').toString('base64')), 'vault_auth_failed', 'legacy fixed-AAD connection secret');

  // Fresh nonce per seal.
  const again = HV.sealObject(k1, { purpose, objectId, bytes: CSV });
  assert.ok(!again.equals(blob), 'sealing the same plaintext twice gives different blobs');
  assert.ok(!again.subarray(9, HEADER).equals(blob.subarray(9, HEADER)), 'different nonces');
  assert.ok(Buffer.from(HV.openObject(k1, { purpose, objectId, blob: again })).equals(CSV));
  assert.notEqual(HV.sealConnectionSecret(k1, ACCESS_URL), HV.sealConnectionSecret(k1, ACCESS_URL));

  // A version 2 handle seals version 2 into the header.
  assert.equal(HV.sealObject(k2, { purpose, objectId, bytes: CSV }).readUInt32BE(5), 2);
});

test('an unknown purpose or a malformed object id is refused as invalid input', async t => {
  const blob = HV.sealObject(hA, { purpose: HV.PURPOSES.upload, objectId: 'f-input', bytes: CSV });
  for (const purpose of ['uploads', 'UPLOAD', '', 'simplefin:access', undefined]) {
    await refuses(() => HV.sealObject(hA, { purpose, objectId: 'f-input', bytes: CSV }), 'vault_invalid_input', `seal purpose ${purpose}`);
    await refuses(() => HV.openObject(hA, { purpose, objectId: 'f-input', blob }), 'vault_invalid_input', `open purpose ${purpose}`);
  }
  const root = await HV.householdRoot({ dataRoot: await tempDir(t), householdId: A, relativeRoot: 'households/a', create: true });
  for (const objectId of ['', '../escape', 'a/b', 'f-input.bin', 'x'.repeat(129), 'f input', 'f-\u00e9', undefined]) {
    await refuses(() => HV.sealObject(hA, { purpose: HV.PURPOSES.upload, objectId, bytes: CSV }), 'vault_invalid_input', `seal id ${objectId}`);
    await refuses(() => HV.openObject(hA, { purpose: HV.PURPOSES.upload, objectId, blob }), 'vault_invalid_input', `open id ${objectId}`);
    await refuses(() => HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, bytes: CSV }), 'vault_invalid_input', `store id ${objectId}`);
  }
  assert.ok(!existsSync(join(root.path, '..', 'escape.bin')) && !existsSync(join(root.path, 'escape.bin')), 'nothing written outside files/');
  assert.ok(HV.sealObject(hA, { purpose: HV.PURPOSES.upload, objectId: 'x'.repeat(128), bytes: CSV }), 'liveness: a 128 character id is accepted');
});

test('a data key handle exposes only household id and version; a key of the wrong length is refused', async () => {
  const key = randomBytes(32);
  const handle = HV.dataKeyHandle({ householdId: A, version: 3, key });
  assert.ok(Object.isFrozen(handle));
  assert.deepEqual({ ...handle }, { householdId: A, version: 3 });
  const json = JSON.stringify(handle);
  for (const enc of ['hex', 'base64', 'base64url']) assert.ok(!json.includes(key.toString(enc)), `JSON has no ${enc} key`);
  assert.ok(!json.includes(JSON.stringify([...key]).slice(1, 40)), 'JSON has no key byte list');
  for (const k of Reflect.ownKeys(handle)) {
    const v = handle[k];
    assert.ok(!(v instanceof Uint8Array), `own property ${String(k)} is not key material`);
  }
  for (const v of Object.values(handle)) assert.ok(typeof v === 'string' || typeof v === 'number');
  for (const bad of [randomBytes(31), randomBytes(33), Buffer.alloc(0), undefined]) {
    await refuses(() => HV.dataKeyHandle({ householdId: A, version: 1, key: bad }), 'data_key_invalid', `key length ${bad?.length}`);
  }
});

// ---------------------------------------------------------------- 5. wrapped keys

test('wrapDataKey authenticates household id, version and platform key', async () => {
  const pk = randomBytes(32);
  const key = randomBytes(32);
  const wrapped = HV.wrapDataKey(pk, { householdId: A, version: 1, key });
  assert.ok(Buffer.isBuffer(wrapped));
  assert.ok(!wrapped.includes(key), 'the raw key is not in the wrapped bytes');
  assert.ok(Buffer.from(HV.unwrapWrappedKey(pk, { householdId: A, version: 1, wrapped })).equals(key), 'liveness: unwraps');
  assert.ok(!HV.wrapDataKey(pk, { householdId: A, version: 1, key }).equals(wrapped), 'fresh nonce per wrap');
  const unwrap = over => () => HV.unwrapWrappedKey(pk, { householdId: A, version: 1, wrapped, ...over });
  await refuses(unwrap({ householdId: B }), 'data_key_invalid', 'other household');
  await refuses(unwrap({ version: 2 }), 'data_key_invalid', 'other version');
  await refuses(() => HV.unwrapWrappedKey(randomBytes(32), { householdId: A, version: 1, wrapped }), 'data_key_invalid', 'other platform key');
  for (const at of [0, 8, wrapped.length - 20, wrapped.length - 1]) await refuses(unwrap({ wrapped: flip(wrapped, at) }), 'data_key_invalid', `byte ${at} flipped`);
  await refuses(unwrap({ wrapped: wrapped.subarray(0, wrapped.length - 1) }), 'data_key_invalid', 'truncated');
});

test('provisioned keys: swapped wrapped rows, a wrong platform key, a second provision and a missing row are refused; one active key per household', async t => {
  const dir = await tempDir(t);
  const p = await openPlatform(join(dir, 'platform.sqlite'));
  t.after(async () => await p.close());
  const C = 'hh-synthetic-c';
  for (const id of [A, B, C]) await addHousehold(p, id);
  const pk = randomBytes(32);
  const ha = await HV.provisionDataKey(p, { householdId: A, platformKey: pk, now: NOW_MS });
  const hb = await HV.provisionDataKey(p, { householdId: B, platformKey: pk, now: NOW_MS });
  assert.deepEqual({ ...ha }, { householdId: A, version: 1 });
  assert.deepEqual({ ...hb }, { householdId: B, version: 1 });

  const rowsOf = async () => (await p.prepare('SELECT * FROM household_data_keys ORDER BY household_id, key_version').all()).map(r => ({ ...r }));
  const rows = await rowsOf();
  assert.deepEqual(rows.map(r => [r.household_id, r.key_version, r.status, r.created_at]), [[A, 1, 'active', NOW_MS], [B, 1, 'active', NOW_MS]]);
  for (const r of rows) {
    const raw = HV.unwrapWrappedKey(pk, { householdId: r.household_id, version: 1, wrapped: Buffer.from(r.wrapped_key) });
    assert.equal(raw.length, 32);
    assert.ok(!Buffer.from(r.wrapped_key).includes(Buffer.from(raw)), 'the platform DB holds no raw data key');
  }
  assert.ok(!Buffer.from(rows[0].wrapped_key).equals(Buffer.from(rows[1].wrapped_key)), 'each household has its own key');

  // Liveness: an unwrapped handle opens what the provisioned handle sealed.
  const objectId = 'f-provisioned000000000001';
  const sealed = HV.sealObject(ha, { purpose: HV.PURPOSES.upload, objectId, bytes: CSV });
  const ua = await HV.unwrapDataKey(p, { householdId: A, platformKey: pk });
  assert.deepEqual({ ...ua }, { householdId: A, version: 1 });
  assert.ok(Buffer.from(HV.openObject(ua, { purpose: HV.PURPOSES.upload, objectId, blob: sealed })).equals(CSV));
  const ua1 = await HV.unwrapDataKey(p, { householdId: A, platformKey: pk, version: 1 });
  assert.ok(Buffer.from(HV.openObject(ua1, { purpose: HV.PURPOSES.upload, objectId, blob: sealed })).equals(CSV));
  const ub = await HV.unwrapDataKey(p, { householdId: B, platformKey: pk });
  await refuses(() => HV.openObject(ub, { purpose: HV.PURPOSES.upload, objectId, blob: sealed }), 'vault_auth_failed', 'B cannot open A');

  await refuses(() => HV.unwrapDataKey(p, { householdId: A, platformKey: randomBytes(32) }), 'data_key_invalid', 'wrong platform key');
  await refuses(() => HV.provisionDataKey(p, { householdId: A, platformKey: pk, now: NOW_MS }), 'data_key_exists', 'second provision');
  assert.deepEqual(await rowsOf(), rows, 'a refused provision writes nothing');
  await refuses(() => HV.unwrapDataKey(p, { householdId: C, platformKey: pk }), 'data_key_missing', 'household without a key');
  await refuses(() => HV.unwrapDataKey(p, { householdId: A, platformKey: pk, version: 2 }), 'data_key_missing', 'version without a row');

  // The unique active index allows one active row per household; a retired row is fine.
  const insert = p.prepare('INSERT INTO household_data_keys (household_id, key_version, wrapped_key, status, created_at) VALUES (?, ?, ?, ?, ?)');
  assert.throws(async () => await insert.run(A, 2, randomBytes(64), 'active', NOW_MS), err => err.code === 'ERR_SQLITE_ERROR' && /UNIQUE/i.test(err.message));
  assert.throws(async () => await insert.run(A, 1, randomBytes(64), 'retired', NOW_MS), err => err.code === 'ERR_SQLITE_ERROR', 'primary key (household_id, key_version)');
  await insert.run(A, 2, randomBytes(64), 'retired', NOW_MS);
  const active = await HV.unwrapDataKey(p, { householdId: A, platformKey: pk });
  assert.equal(active.version, 1, 'the active version is chosen when none is named');
  await refuses(() => HV.unwrapDataKey(p, { householdId: A, platformKey: pk, version: 2 }), 'data_key_invalid', 'garbage retired row');
  await p.prepare('DELETE FROM household_data_keys WHERE household_id = ? AND key_version = 2').run(A);

  // Swap the wrapped keys of A and B: both refuse; swapping back restores both.
  const wa = Buffer.from(rows[0].wrapped_key);
  const wb = Buffer.from(rows[1].wrapped_key);
  const setWrapped = p.prepare('UPDATE household_data_keys SET wrapped_key = ? WHERE household_id = ? AND key_version = 1');
  await setWrapped.run(wb, A);
  await setWrapped.run(wa, B);
  await refuses(() => HV.unwrapDataKey(p, { householdId: A, platformKey: pk }), 'data_key_invalid', 'A with B\'s wrapped key');
  await refuses(() => HV.unwrapDataKey(p, { householdId: B, platformKey: pk }), 'data_key_invalid', 'B with A\'s wrapped key');
  await setWrapped.run(wa, A);
  await setWrapped.run(wb, B);
  assert.equal((await HV.unwrapDataKey(p, { householdId: B, platformKey: pk })).householdId, B, 'liveness after restoring');
});

// ---------------------------------------------------------------- 6. contained roots

test('a root of household B with household A\'s handle is refused on read and on store before touching disk', async t => {
  const dataRoot = await tempDir(t);
  const rootB = await HV.householdRoot({ dataRoot, householdId: B, relativeRoot: 'households/b', create: true });
  const objectId = 'f-mismatch00000000000001';
  const stored = await HV.storeObject({ root: rootB, handle: hB, purpose: HV.PURPOSES.upload, objectId, bytes: CSV });
  const file = join(rootB.path, stored);
  const before = readFileSync(file);
  const listing = readdirSync(join(rootB.path, 'files')).sort();

  await refuses(() => HV.readObject({ root: rootB, handle: hA, purpose: HV.PURPOSES.upload, objectId, storedPath: stored }), 'vault_household_mismatch', 'read');
  await refuses(() => HV.storeObject({ root: rootB, handle: hA, purpose: HV.PURPOSES.upload, objectId, bytes: Buffer.from('synthetic overwrite\n') }), 'vault_household_mismatch', 'store');
  assert.ok(readFileSync(file).equals(before), 'B\'s equal-id ciphertext is byte-identical');
  assert.deepEqual(readdirSync(join(rootB.path, 'files')).sort(), listing, 'no temp or new file in B');
  assert.ok(Buffer.from(await HV.readObject({ root: rootB, handle: hB, purpose: HV.PURPOSES.upload, objectId, storedPath: stored })).equals(CSV), 'B still reads it');

  // A fresh root of B gains no files dir from a mismatched store.
  const fresh = await HV.householdRoot({ dataRoot, householdId: B, relativeRoot: 'households/b2', create: true });
  await refuses(() => HV.storeObject({ root: fresh, handle: hA, purpose: HV.PURPOSES.upload, objectId, bytes: CSV }), 'vault_household_mismatch', 'store into a fresh root');
  assert.ok(!existsSync(join(fresh.path, 'files')), 'no files dir created');
});

test('every invalid relative root form is refused before anything is created', async t => {
  const dataRoot = await tempDir(t);
  const bad = [
    '', 'households', 'households/', 'households//a', 'households/a/', 'households/../a', 'households/a/../b', 'households/./a',
    'households/.', 'households/..', '../households/a', './households/a', '/households/a', join(dataRoot, 'households/a'),
    'households\\a', 'households/a\\b', 'other/a', 'Households/a', 'households/a b', 'households/a.b', `households/${'x'.repeat(129)}`,
    'households/a/b/c/d/e/f', undefined,
  ];
  for (const relativeRoot of bad) {
    await refuses(() => HV.householdRoot({ dataRoot, householdId: A, relativeRoot, create: true }), 'household_root_invalid', `relativeRoot ${JSON.stringify(relativeRoot)}`);
  }
  assert.deepEqual(readdirSync(dataRoot), [], 'nothing created under the data root');
  const ok = await HV.householdRoot({ dataRoot, householdId: A, relativeRoot: `households/${'x'.repeat(128)}`, create: true });
  assert.equal(basename(ok.path), 'x'.repeat(128), 'liveness: a 128 character segment is accepted');
});

test('symlinks are refused: a root segment, the household directory, a root replaced after resolution, the files dir and an object file', async t => {
  // A symlinked `households` segment.
  {
    const dataRoot = await tempDir(t);
    privateDir(join(dataRoot, 'elsewhere', 'a'));
    symlinkSync(join(dataRoot, 'elsewhere'), join(dataRoot, 'households'));
    await refuses(() => HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/a', create: false }), 'household_root_symlink', 'symlinked households, create false');
    await refuses(() => HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/b', create: true }), 'household_root_symlink', 'symlinked households, create true');
    assert.deepEqual(readdirSync(join(dataRoot, 'elsewhere')), ['a'], 'nothing created through the link');
  }
  // A symlinked household directory (last segment).
  {
    const dataRoot = await tempDir(t);
    privateDir(join(dataRoot, 'households'));
    privateDir(join(dataRoot, 'outside'));
    symlinkSync(join(dataRoot, 'outside'), join(dataRoot, 'households', 'a'));
    await refuses(() => HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/a', create: true }), 'household_root_symlink', 'symlinked leaf');
  }
  // The root directory, then the `households` segment, replaced by a symlink after resolution.
  for (const replaced of ['households/a', 'households']) {
    const dataRoot = await tempDir(t);
    const root = await HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/a', create: true });
    const objectId = 'f-replaced00000000000001';
    const stored = await HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, bytes: CSV });
    const target = join(dataRoot, replaced);
    const moved = `${target}-moved`;
    renameSync(target, moved);
    symlinkSync(moved, target);
    await refuses(() => HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, storedPath: stored }), 'household_root_symlink', `read after ${replaced} replaced`);
    await refuses(() => HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: 'f-replaced00000000000002', bytes: CSV }), 'household_root_symlink', `store after ${replaced} replaced`);
    const movedFiles = replaced === 'households' ? join(moved, 'a', 'files') : join(moved, 'files');
    assert.deepEqual(readdirSync(movedFiles), [`${objectId}.bin`], 'nothing written through the link');
  }
  // A symlinked files dir.
  {
    const dataRoot = await tempDir(t);
    const root = await HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/a', create: true });
    const outside = privateDir(join(dataRoot, 'outside-files'));
    symlinkSync(outside, join(root.path, 'files'));
    const objectId = 'f-filesdirlink0000000001';
    await refuses(() => HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, bytes: CSV }), 'household_root_symlink', 'store into symlinked files dir');
    assert.deepEqual(readdirSync(outside), [], 'nothing written through the link');
    writeFileSync(join(outside, `${objectId}.bin`), HV.sealObject(hA, { purpose: HV.PURPOSES.upload, objectId, bytes: CSV }), { mode: 0o600 });
    await refuses(() => HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, storedPath: `files/${objectId}.bin` }), 'household_root_symlink', 'read through symlinked files dir');
  }
  // A symlinked or non-regular object file, and a missing one.
  {
    const dataRoot = await tempDir(t);
    const root = await HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/a', create: true });
    const linked = 'f-objectlink000000000001';
    const stored = await HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: linked, bytes: CSV });
    const outsideBlob = join(dataRoot, 'outside.bin');
    copyFileSync(join(root.path, stored), outsideBlob);
    unlinkSync(join(root.path, stored));
    symlinkSync(outsideBlob, join(root.path, stored));
    await refuses(() => HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: linked, storedPath: stored }), 'vault_object_unreadable', 'symlinked object file');
    const dirObject = 'f-objectdir0000000000001';
    privateDir(join(root.path, 'files', `${dirObject}.bin`));
    await refuses(() => HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: dirObject, storedPath: `files/${dirObject}.bin` }), 'vault_object_unreadable', 'directory in place of an object');
    const missing = 'f-objectmissing000000001';
    await refuses(() => HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: missing, storedPath: `files/${missing}.bin` }), 'vault_object_missing', 'missing object');
    const live = 'f-objectlive000000000001';
    const liveStored = await HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: live, bytes: CSV });
    assert.ok(Buffer.from(await HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: live, storedPath: liveStored })).equals(CSV), 'liveness: a regular object reads');
  }
});

test('roots must be private and present; create makes missing segments 0700; a valid private root resolves', async t => {
  const dataRoot = await tempDir(t);
  const relativeRoot = 'households/a/b';
  const root = await HV.householdRoot({ dataRoot, householdId: A, relativeRoot, create: true });
  assert.ok(Object.isFrozen(root));
  assert.equal(root.householdId, A);
  assert.equal(root.path, realpathSync(join(dataRoot, relativeRoot)));
  for (const seg of ['households', 'households/a', 'households/a/b']) assert.equal(modeOf(join(dataRoot, seg)), 0o700, `${seg} created 0700`);

  const again = await HV.householdRoot({ dataRoot, householdId: A, relativeRoot, create: false });
  assert.deepEqual({ ...again }, { ...root }, 'liveness: an existing private root resolves with create false');

  await refuses(() => HV.householdRoot({ dataRoot, householdId: A, relativeRoot: 'households/missing', create: false }), 'household_root_missing');
  assert.ok(!existsSync(join(dataRoot, 'households', 'missing')), 'create false creates nothing');

  for (const [seg, mode] of [['households/a/b', 0o750], ['households/a/b', 0o704], ['households/a', 0o701], ['households', 0o755]]) {
    const path = join(dataRoot, seg);
    chmodSync(path, mode);
    for (const create of [false, true]) {
      await refuses(() => HV.householdRoot({ dataRoot, householdId: A, relativeRoot, create }), 'household_root_not_private', `${seg} ${mode.toString(8)} create ${create}`);
    }
    assert.equal(modeOf(path), mode, 'a refused root is not silently re-permissioned');
    chmodSync(path, 0o700);
  }
  assert.equal((await HV.householdRoot({ dataRoot, householdId: A, relativeRoot, create: false })).path, root.path, 'liveness after restoring 0700');
});

test('a stored path must be exactly files/<objectId>.bin', async t => {
  const root = await HV.householdRoot({ dataRoot: await tempDir(t), householdId: A, relativeRoot: 'households/a', create: true });
  const objectId = 'f-storedpath000000000001';
  const other = 'f-storedpath000000000002';
  const stored = await HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, bytes: CSV });
  await HV.storeObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId: other, bytes: CSV });
  const bad = [
    'files/../x.bin', `files/../files/${objectId}.bin`, `files/${other}.bin`, join(root.path, stored), `/${stored}`, `./${stored}`,
    `${stored}/`, `files//${objectId}.bin`, `files/${objectId}`, `files/${objectId}.BIN`, `files\\${objectId}.bin`, `${objectId}.bin`, '', undefined,
  ];
  for (const storedPath of bad) {
    await refuses(() => HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, storedPath }), 'vault_stored_path_invalid', `storedPath ${JSON.stringify(storedPath)}`);
  }
  assert.ok(Buffer.from(await HV.readObject({ root, handle: hA, purpose: HV.PURPOSES.upload, objectId, storedPath: stored })).equals(CSV), 'liveness: the exact path reads');
});

// ---------------------------------------------------------------- 7. platform key files

test('loadPlatformKey accepts private hex, raw and base64 key files and refuses the rest with platform_key_invalid; loadBackupKey keeps backup_key_invalid', async t => {
  const dir = await tempDir(t);
  const write = (name, content, mode = 0o600) => {
    const file = join(dir, name);
    writeFileSync(file, content, { mode });
    chmodSync(file, mode);
    return file;
  };
  const key = randomBytes(32);
  // Raw key bytes outside the text-key alphabet, so they cannot be read as hex or base64 text.
  const rawKey = Buffer.concat([Buffer.from([0x00, 0xff, 0x80]), randomBytes(29)]);
  const hexFile = write('hex.key', `${key.toString('hex')}\n`);
  const accepted = [
    [hexFile, key],
    [write('raw.key', rawKey), rawKey],
    [write('b64.key', `${key.toString('base64')}\n`), key],
    [write('b64url.key', key.toString('base64url')), key],
  ];
  for (const [file, expected] of accepted) {
    const loaded = await BK.loadPlatformKey(file);
    assert.ok(Buffer.from(loaded).equals(expected), basename(file));
  }
  assert.ok(Buffer.from(await BK.platformKeyFromEnv({ FATHOM_PLATFORM_KEY_FILE: hexFile })).equals(key), 'platformKeyFromEnv reads FATHOM_PLATFORM_KEY_FILE');
  assert.ok(Buffer.from(await BK.loadKeyFile(hexFile, 'synthetic_key_invalid')).equals(key), 'loadKeyFile shares the parser');

  const link = join(dir, 'link.key');
  symlinkSync(hexFile, link);
  const sub = privateDir(join(dir, 'a-directory'));
  const refused = {
    symlink: link,
    'mode 0640': write('group.key', `${key.toString('hex')}\n`, 0o640),
    'mode 0604': write('world.key', `${key.toString('hex')}\n`, 0o604),
    'short hex': write('short.key', randomBytes(31).toString('hex')),
    'long raw': write('long.key', Buffer.concat([rawKey, Buffer.from([0x01])])),
    'empty file': write('empty.key', ''),
    'missing file': join(dir, 'absent.key'),
    directory: sub,
    'empty path': '',
    'unset path': undefined,
  };
  for (const [label, file] of Object.entries(refused)) {
    await refuses(() => BK.loadPlatformKey(file), 'platform_key_invalid', label);
  }
  await refuses(() => BK.platformKeyFromEnv({}), 'platform_key_invalid', 'env unset');
  await refuses(() => BK.platformKeyFromEnv({ FATHOM_PLATFORM_KEY_FILE: '' }), 'platform_key_invalid', 'env empty');
  await refuses(() => BK.platformKeyFromEnv({ FATHOM_PLATFORM_KEY_FILE: refused['mode 0640'] }), 'platform_key_invalid', 'env group-readable');
  await refuses(() => BK.loadKeyFile(refused['mode 0640'], 'synthetic_key_invalid'), 'synthetic_key_invalid', 'loadKeyFile carries the caller\'s code');

  assert.ok(Buffer.from(await BK.loadBackupKey(hexFile)).equals(key), 'loadBackupKey still accepts a private key');
  for (const label of ['symlink', 'mode 0640', 'short hex', 'empty path']) {
    await refuses(() => BK.loadBackupKey(refused[label]), 'backup_key_invalid', `backup ${label}`);
  }
});

// ---------------------------------------------------------------- 8. migration 002

test('platform migration 002 gives every fresh platform an empty household_data_keys table', async t => {
  const dir = await tempDir(t);
  const p = await openPlatform(join(dir, 'platform.sqlite'));
  t.after(async () => await p.close());
  const cols = (await p.prepare('PRAGMA table_info(household_data_keys)').all()).map(c => ({ ...c }));
  assert.deepEqual(cols.map(c => c.name), ['household_id', 'key_version', 'wrapped_key', 'status', 'created_at']);
  assert.deepEqual(cols.filter(c => c.pk > 0).sort((x, y) => x.pk - y.pk).map(c => c.name), ['household_id', 'key_version'], 'primary key (household_id, key_version)');
  assert.ok(cols.every(c => c.notnull === 1 || c.pk > 0), 'every column is NOT NULL');
  const fks = (await p.prepare('PRAGMA foreign_key_list(household_data_keys)').all()).map(f => [f.table, f.from, f.to]);
  assert.deepEqual(fks, [['households', 'household_id', 'id']]);
  const indexes = (await p.prepare('PRAGMA index_list(household_data_keys)').all()).map(i => ({ ...i }));
  assert.ok(indexes.some(i => i.unique === 1 && i.partial === 1), 'a unique partial index (one active key per household)');
  assert.ok(await p.prepare('SELECT 1 AS x FROM schema_migrations WHERE id = 2').get(), 'migration 002 recorded');
  assert.equal((await p.prepare('SELECT count(*) AS n FROM household_data_keys').get()).n, 0, 'empty after migration');
  assert.throws(async () => await p.prepare('INSERT INTO household_data_keys (household_id, key_version, wrapped_key, status, created_at) VALUES (?, 1, ?, ?, ?)')
    .run('hh-synthetic-unknown', randomBytes(64), 'active', NOW_MS), err => err.code === 'ERR_SQLITE_ERROR', 'household must exist');

  const instanceDir = await tempDir(t);
  const inst = await createInstance(instanceDir, { mode: 'demo' });
  try {
    assert.equal((await inst.platform.prepare('SELECT count(*) AS n FROM household_data_keys').get()).n, 0, 'createInstance platforms have the empty table');
  } finally {
    await inst.db.close();
    await inst.platform.close();
  }
});

// ---------------------------------------------------------------- 9. the server is on FTHM2 only

function mjsFiles(dir) {
  return readdirSync(dir, { recursive: true }).map(String).filter(rel => rel.endsWith('.mjs') && !rel.split(/[\\/]/).includes('node_modules')).map(rel => join(dir, rel));
}

// Files under src/ and scripts/ whose string literals reference `target` (relative specifiers
// resolved against the file; bare ones by basename).
function referencesTo(target) {
  const literal = /(['"`])([^'"`\n]*(?:legacy-vault|vault-convert)\.mjs)\1/g;
  const out = new Set();
  for (const file of [...mjsFiles(join(ROOT, 'src')), ...mjsFiles(join(ROOT, 'scripts'))]) {
    if (resolve(file) === target) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(literal)) {
      const spec = m[2];
      const hit = spec.startsWith('.') ? resolve(dirname(file), spec) === target : basename(spec) === basename(target);
      if (hit) out.add(relative(ROOT, file).split('\\').join('/'));
    }
  }
  return [...out].sort();
}

test('the running server has no FTHM1 path: only the offline migration reaches the legacy codec, and ingest writes FTHM2', async t => {
  const legacyCodec = resolve(ROOT, 'src/platform/legacy-vault.mjs');
  const convert = resolve(ROOT, 'src/platform/vault-convert.mjs');
  assert.deepEqual(referencesTo(legacyCodec), ['src/platform/migrate-tenancy.mjs', 'src/platform/vault-convert.mjs'], 'legacy-vault.mjs is imported only by the migration and its conversion');
  assert.deepEqual(referencesTo(convert), ['src/platform/migrate-tenancy.mjs'], 'vault-convert.mjs is imported only by the migration');

  // The server vault has no FTHM1 encrypt, decrypt or key loader.
  assert.deepEqual(Object.keys(IngestVault).sort(), ['PURPOSES', 'VaultError', 'clearStoredFiles', 'openAccess', 'openVault', 'readStoredFile', 'sealAccess', 'storeFile', 'workDir']);

  // An upload through the real ingest pipeline is stored FTHM2 under the household root.
  const s = await realStore();
  t.after(() => s.close());
  const { ingestFile } = await src('src/ingest/pipeline.mjs');
  const r = await ingestFile(s.db, aggregatorFile('synthetic-fthm2.csv', [{ date: '2032-02-01', amount: '12.00', description: 'Synthetic row' }]), s.opts(await offEngine()));
  const row = await s.db.prepare('SELECT stored_path, sha256 FROM files WHERE id = ?').get(r.fileId);
  assert.equal(row.stored_path, `files/${r.fileId}.bin`);
  const blob = readFileSync(join(s.root, row.stored_path));
  assert.ok(blob.subarray(0, 5).equals(Buffer.from('FTHM2')), 'the pipeline stores FTHM2');
  const vault = await IngestVault.openVault(s.household);
  const read = await IngestVault.readStoredFile({ vault, id: r.fileId, storedPath: row.stored_path, purpose: IngestVault.PURPOSES.upload });
  assert.equal(sha256(read), row.sha256, 'and the household vault opens it');

  // No dual reader: an FTHM1 blob under the same id in the household files dir does not read.
  writeFileSync(join(s.root, row.stored_path), LegacyVault.encrypt(randomBytes(32), CSV, r.fileId), { mode: 0o600 });
  await assert.rejects(IngestVault.readStoredFile({ vault, id: r.fileId, storedPath: row.stored_path, purpose: IngestVault.PURPOSES.upload }), err => err instanceof IngestVault.VaultError);
});

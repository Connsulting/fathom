// MT-02 AC2: old-format synthetic objects convert and validate without changing their plaintext;
// failed conversion publishes nothing.
//
// A synthetic legacy instance is built with the real producers: createInstance, uploads through
// the ingest pipeline (ingestFile), an advisor packet through storePacket and a SimpleFIN
// connection through connectSimplefin, all under a synthetic 32 byte legacy data key. The
// migration-only converter (src/platform/vault-convert.mjs) rewrites every vault object into a
// FTHM2 bundle under the household root's work area. Expected plaintexts are computed
// independently with the legacy reader (src/ingest/vault.mjs). Every value here is synthetic.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { src } from './helpers/server.mjs';
import { aggregatorFile, textFile, offEngine, NOW } from './helpers/ingest.mjs';
import { createInstance } from '../src/platform/db.mjs';
import { logicalDigest } from '../src/platform/digest.mjs';
import { setSetting } from '../src/store/db.mjs';
import { ingestFile } from '../src/ingest/pipeline.mjs';
import { decrypt, encrypt, readStoredFile, VaultError } from '../src/ingest/vault.mjs';
import { storePacket } from '../src/advisor/packet.mjs';
import { connectSimplefin, createFakeSimplefin, fakeToken } from '../src/ingest/simplefin.mjs';

const TODAY = NOW.slice(0, 10);
const NOW_MS = Date.parse(NOW);
const PHASES = ['staged', 'validated', 'manifest', 'renamed'];
const LEGACY_SIMPLEFIN_AAD = 'simplefin:access';
// The fake bridge's claim answer (createFakeSimplefin in src/ingest/simplefin.mjs, the same fake
// claim fetch test/ingest/simplefin.test.mjs uses and whose recorded access URL shape it asserts).
const ACCESS_URL = 'https://demo:fake-demo-password@bridge.simplefin.org/simplefin';
const PACKET_HTML = '<!doctype html><html><body><h1>Synthetic advisor packet</h1><p>Synthetic figures only.</p></body></html>\n';
const PLAN_TEXT = '# Synthetic household plan\n\nKeep a synthetic emergency fund of six months.\n';
const OP = 'op-synthetic-convert';

let HV;
let VC;
before(async () => {
  HV = await src('src/platform/household-vault.mjs');
  VC = await src('src/platform/vault-convert.mjs');
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function refuses(promiseFn, code, label) {
  await assert.rejects(async () => promiseFn(), err => {
    assert.ok(err instanceof Error, `${label ?? code}: an Error`);
    assert.equal(err.code, code, label);
    return true;
  });
}

function addHousehold(platform, id) {
  platform.prepare(`INSERT INTO households (id, status, mode, display_name, serves_store, created_at, updated_at)
    VALUES (?, 'active', 'real', NULL, 0, ?, ?)`).run(id, NOW_MS, NOW_MS);
}

// A synthetic legacy instance. content false: an empty instance (no files, packets or connection).
// Returns { dataDir, db, platform, householdId, legacyKey, platformKey, handle, root, uploads, packets }.
async function legacyInstance(t, { content = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fathom-vault-convert-'));
  const { db, platform, householdId } = createInstance(dataDir, { mode: 'real', init: d => setSetting(d, 'clock', TODAY) });
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    try { platform.close(); } catch { /* already closed */ }
    rmSync(dataDir, { recursive: true, force: true });
  });
  const legacyKey = randomBytes(32);
  const config = { dataDir, dataKeyFile: null, engine: 'off', clock: TODAY, demo: false, port: 0, host: '127.0.0.1', claudeCredentialFile: null, emailTransport: 'dev' };
  const fx = { dataDir, db, platform, householdId, legacyKey, uploads: [], packets: [] };
  if (content) {
    const opts = { engine: await offEngine(), config, key: legacyKey, now: NOW };
    const csv = await ingestFile(db, aggregatorFile('synthetic-checking.csv', [
      { date: '2032-02-01', amount: '25.00', description: 'Synthetic grocery' },
      { date: '2032-02-03', amount: '-900.00', description: 'Synthetic client payment' },
    ]), opts);
    const md = await ingestFile(db, textFile('synthetic-plan.md', PLAN_TEXT, 'text/markdown'), opts);
    fx.uploads = [csv.fileId, md.fileId];
    fx.packets = [await storePacket(db, { dataDir, key: legacyKey, html: PACKET_HTML, clock: TODAY, recIds: [], now: NOW })];
    await connectSimplefin(db, fakeToken(), { config, key: legacyKey, now: NOW, fetch: createFakeSimplefin({ today: () => TODAY }) });
    const stored = db.prepare('SELECT count(*) AS n FROM files WHERE stored_path IS NOT NULL').get().n;
    assert.equal(stored, 2, 'fixture: two stored uploads');
  }
  fx.platformKey = randomBytes(32);
  fx.handle = await HV.provisionDataKey(platform, { householdId, platformKey: fx.platformKey, now: NOW_MS });
  fx.root = await HV.householdRoot({ dataRoot: dataDir, householdId, relativeRoot: `households/${householdId}`, create: true });
  return fx;
}

const convert = (fx, over = {}) => VC.convertHouseholdVault({
  db: fx.db, sourceDir: fx.dataDir, legacyKey: fx.legacyKey, root: fx.root, handle: fx.handle, operationId: OP, ...over,
});

// Legacy plaintext of every vault object, decrypted independently with the legacy reader.
// Map of `${purpose}:${objectId}` -> Buffer.
async function legacyPlaintexts(fx) {
  const out = new Map();
  for (const r of fx.db.prepare('SELECT id, stored_path, sha256, size FROM files WHERE stored_path IS NOT NULL').all()) {
    const bytes = Buffer.from(await readStoredFile({ dataDir: fx.dataDir, key: fx.legacyKey, id: r.id, storedPath: r.stored_path }));
    assert.equal(sha256(bytes), r.sha256, 'fixture: files row hash matches its plaintext');
    assert.equal(bytes.length, r.size);
    out.set(`upload:${r.id}`, bytes);
  }
  for (const r of fx.db.prepare('SELECT id, stored_path, sha256, bytes FROM advisor_packets').all()) {
    const bytes = Buffer.from(await readStoredFile({ dataDir: fx.dataDir, key: fx.legacyKey, id: r.id, storedPath: r.stored_path }));
    assert.equal(sha256(bytes), r.sha256, 'fixture: packet row hash matches its plaintext');
    assert.equal(bytes.length, r.bytes);
    out.set(`advisor-packet:${r.id}`, bytes);
  }
  const c = fx.db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get();
  if (c) out.set(`simplefin-access:${HV.SIMPLEFIN_OBJECT_ID}`, Buffer.from(decrypt(fx.legacyKey, Buffer.from(c.access_blob, 'base64'), LEGACY_SIMPLEFIN_AAD)));
  return out;
}

// Every entry of the legacy files dir (name -> type, mode and content hash), or null when absent.
function legacyFiles(dataDir) {
  const dir = join(dataDir, 'files');
  if (!existsSync(dir)) return null;
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const st = lstatSync(join(dir, name));
    out[name] = { file: st.isFile(), mode: st.mode & 0o777, sha256: st.isFile() ? sha256(readFileSync(join(dir, name))) : null };
  }
  return out;
}

const legacyState = fx => ({ files: legacyFiles(fx.dataDir), digest: logicalDigest(fx.db) });
const bundleOf = (root, op = OP) => join(root.path, 'work', `vault-${op}`);
const partialOf = (root, op = OP) => `${bundleOf(root, op)}.partial`;

// Nothing published: no bundle, no partial, nothing left in the work area, no active files/ under
// any root, and the legacy files and DB exactly as before.
function assertUnpublished(fx, before, { roots = [fx.root], op = OP } = {}) {
  for (const root of roots) {
    assert.ok(!existsSync(bundleOf(root, op)), 'no final bundle dir');
    assert.ok(!existsSync(partialOf(root, op)), 'no partial dir');
    const work = join(root.path, 'work');
    assert.deepEqual(existsSync(work) ? readdirSync(work) : [], [], 'nothing left in the work area');
    assert.ok(!existsSync(join(root.path, 'files')), 'no <root>/files created');
  }
  assert.deepEqual(legacyState(fx), before, 'legacy files byte-identical and DB digest unchanged');
}

// ---------------------------------------------------------------- 1. successful conversion

test('a legacy instance converts every vault object to FTHM2 with byte-identical plaintext, in one validated bundle', async t => {
  const fx = await legacyInstance(t);
  const expected = await legacyPlaintexts(fx);
  assert.equal(expected.size, 4, 'fixture: two uploads, one packet, one connection');
  assert.equal(expected.get(`simplefin-access:${HV.SIMPLEFIN_OBJECT_ID}`).toString('utf8'), ACCESS_URL);
  const before = legacyState(fx);

  const seen = [];
  const r = await convert(fx, { onPhase: async name => { seen.push(name); } });
  assert.deepEqual(seen, PHASES, 'phases in order');
  assert.equal(r.path, `work/vault-${OP}`);
  assert.equal(r.uploads, 2);
  assert.equal(r.packets, 1);
  assert.equal(r.simplefin, 1);
  assert.equal(r.unreferenced, 0);
  assert.equal(r.objects.length, 4);

  const bundle = join(fx.root.path, r.path);
  assert.equal(bundle, bundleOf(fx.root));
  assert.ok(!existsSync(partialOf(fx.root)), 'the partial was renamed away');
  assert.equal(lstatSync(bundle).mode & 0o077, 0, 'bundle dir is private');
  assert.deepEqual(readdirSync(bundle).sort(), ['files', 'manifest.json', 'simplefin-access.fthm2']);
  const fileObjects = [...fx.uploads.map(id => ['upload', id]), ...fx.packets.map(id => ['advisor-packet', id])];
  assert.deepEqual(readdirSync(join(bundle, 'files')).sort(), fileObjects.map(([, id]) => `${id}.bin`).sort());

  // A handle unwrapped from the platform DB opens every converted object to the legacy plaintext.
  const handle = await HV.unwrapDataKey(fx.platform, { householdId: fx.householdId, platformKey: fx.platformKey });
  for (const [purpose, objectId] of fileObjects) {
    const file = join(bundle, 'files', `${objectId}.bin`);
    const blob = readFileSync(file);
    assert.ok(blob.subarray(0, 5).equals(Buffer.from('FTHM2')), `${objectId}: FTHM2`);
    assert.equal(blob.readUInt32BE(5), handle.version);
    assert.equal(lstatSync(file).mode & 0o077, 0, `${objectId}: private file`);
    const plain = Buffer.from(HV.openObject(handle, { purpose, objectId, blob }));
    const legacy = expected.get(`${purpose}:${objectId}`);
    assert.equal(sha256(plain), sha256(legacy), `${objectId}: plaintext unchanged`);
    assert.ok(plain.equals(legacy));
    const entry = r.objects.find(o => o.purpose === purpose && o.objectId === objectId);
    assert.ok(entry, `${objectId}: in the result`);
    assert.equal(entry.sha256, sha256(legacy));
    assert.equal(entry.ciphertextSha256, sha256(blob));
  }
  const secretText = readFileSync(join(bundle, 'simplefin-access.fthm2'), 'utf8');
  assert.equal(HV.openConnectionSecret(handle, secretText.trim()), ACCESS_URL, 'SimpleFIN access URL unchanged');
  const sfEntry = r.objects.find(o => o.purpose === 'simplefin-access');
  assert.equal(sfEntry.objectId, HV.SIMPLEFIN_OBJECT_ID);
  assert.equal(sfEntry.sha256, sha256(Buffer.from(ACCESS_URL, 'utf8')));

  const manifestText = readFileSync(join(bundle, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.ok(manifest && typeof manifest === 'object');
  assert.ok(manifestText.includes(fx.householdId), 'manifest names the household');
  for (const o of r.objects) {
    assert.ok(manifestText.includes(o.objectId), `manifest lists ${o.objectId}`);
    assert.ok(manifestText.includes(o.sha256), `manifest carries the plaintext hash of ${o.objectId}`);
  }
  for (const secret of ['fake-demo-password', fx.legacyKey.toString('hex'), fx.legacyKey.toString('base64'), 'Synthetic grocery', 'Synthetic advisor packet']) {
    assert.ok(!manifestText.includes(secret), 'manifest holds hashes and counts only');
  }

  assert.deepEqual(legacyState(fx), before, 'legacy files byte-identical and DB digest unchanged');
  assert.ok(!existsSync(join(fx.root.path, 'files')), 'the active files/ is not touched');
});

// ---------------------------------------------------------------- 2. failures publish nothing

const flipFile = (path, fromEnd = 20) => {
  const b = readFileSync(path);
  b[b.length - fromEnd] ^= 0x01;
  writeFileSync(path, b);
};
const legacyBlob = (fx, id) => join(fx.dataDir, 'files', `${id}.bin`);

// [label, expected code, setup(fx) -> overrides for convert or { roots } for the checks]
const FAILURES = [
  ['a tampered legacy upload blob', 'vault_legacy_auth_failed', fx => { flipFile(legacyBlob(fx, fx.uploads[0])); }],
  ['a tampered legacy advisor packet blob', 'vault_legacy_auth_failed', fx => { flipFile(legacyBlob(fx, fx.packets[0])); }],
  ['a tampered legacy SimpleFIN secret', 'vault_legacy_auth_failed', fx => {
    const blob = Buffer.from(fx.db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get().access_blob, 'base64');
    blob[blob.length - 20] ^= 0x01;
    fx.db.prepare('UPDATE simplefin_connection SET access_blob = ? WHERE id = 1').run(blob.toString('base64'));
  }],
  ['a missing legacy blob', 'vault_object_missing', fx => { unlinkSync(legacyBlob(fx, fx.uploads[1])); }],
  ['a files row whose recorded sha256 is wrong', 'vault_plaintext_mismatch', fx => {
    fx.db.prepare('UPDATE files SET sha256 = ? WHERE id = ?').run('0'.repeat(64), fx.uploads[0]);
  }],
  ['a files row whose recorded size is wrong', 'vault_plaintext_mismatch', fx => {
    fx.db.prepare('UPDATE files SET size = size + 1 WHERE id = ?').run(fx.uploads[1]);
  }],
  ['an advisor packet row whose recorded size is wrong', 'vault_plaintext_mismatch', fx => {
    fx.db.prepare('UPDATE advisor_packets SET bytes = bytes + 1 WHERE id = ?').run(fx.packets[0]);
  }],
  ['a stored path that traverses out of files/', 'vault_stored_path_invalid', fx => {
    fx.db.prepare('UPDATE files SET stored_path = ? WHERE id = ?').run('files/../fathom.sqlite', fx.uploads[0]);
  }],
  ['a stored path naming another object', 'vault_stored_path_invalid', fx => {
    fx.db.prepare('UPDATE files SET stored_path = ? WHERE id = ?').run(`files/${fx.uploads[1]}.bin`, fx.uploads[0]);
  }],
  ['the wrong legacy key', 'vault_legacy_auth_failed', () => ({ legacyKey: randomBytes(32) })],
  ['another household\'s handle with this household\'s root', 'vault_household_mismatch', async fx => {
    const other = 'hh-synthetic-other';
    addHousehold(fx.platform, other);
    return { handle: await HV.provisionDataKey(fx.platform, { householdId: other, platformKey: fx.platformKey, now: NOW_MS }) };
  }],
  ['another household\'s root with this household\'s handle', 'vault_household_mismatch', async fx => {
    const other = 'hh-synthetic-other';
    addHousehold(fx.platform, other);
    const root = await HV.householdRoot({ dataRoot: fx.dataDir, householdId: other, relativeRoot: `households/${other}`, create: true });
    return { root, checkRoots: [fx.root, root] };
  }],
];

for (const [label, code, setup] of FAILURES) {
  test(`a failed conversion publishes nothing: ${label} refuses ${code}`, async t => {
    const fx = await legacyInstance(t);
    const over = (await setup(fx)) ?? {};
    const { checkRoots, ...overrides } = over;
    const before = legacyState(fx);
    await refuses(() => convert(fx, overrides), code, label);
    assertUnpublished(fx, before, { roots: checkRoots ?? [fx.root] });
  });
}

test('a throw from onPhase at each phase aborts, removes what the call created and rethrows; a later run still converts', async t => {
  const fx = await legacyInstance(t);
  const before = legacyState(fx);
  for (const [i, phase] of PHASES.entries()) {
    const op = `op-synthetic-phase-${phase}`;
    const boom = new Error('synthetic phase failure');
    const seen = [];
    await assert.rejects(convert(fx, { operationId: op, onPhase: async name => { seen.push(name); if (name === phase) throw boom; } }), err => err === boom, phase);
    assert.deepEqual(seen, PHASES.slice(0, i + 1), `${phase}: phases up to the failure`);
    assertUnpublished(fx, before, { op });
  }
  const r = await convert(fx, { operationId: 'op-synthetic-after-failures' });
  assert.equal(r.path, 'work/vault-op-synthetic-after-failures', 'liveness: the same instance converts afterwards');
  assert.equal(r.objects.length, 4);
  assert.deepEqual(legacyState(fx), before);
});

// ---------------------------------------------------------------- 3. preexisting output

test('a preexisting final bundle or partial is refused and left byte-identical', async t => {
  const fx = await legacyInstance(t);
  const before = legacyState(fx);
  const work = join(fx.root.path, 'work');
  mkdirSync(work, { mode: 0o700 });
  chmodSync(work, 0o700);
  const seed = (dir, text) => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'keep.txt'), text, { mode: 0o600 });
  };
  const contents = dir => readdirSync(dir).sort().map(n => [n, readFileSync(join(dir, n), 'utf8')]);

  const taken = 'op-synthetic-taken';
  seed(bundleOf(fx.root, taken), 'synthetic earlier bundle\n');
  const takenBefore = contents(bundleOf(fx.root, taken));
  await refuses(() => convert(fx, { operationId: taken }), 'vault_output_exists', 'final exists');
  assert.deepEqual(contents(bundleOf(fx.root, taken)), takenBefore, 'final bundle unchanged');
  assert.ok(!existsSync(partialOf(fx.root, taken)), 'no partial created');

  const staged = 'op-synthetic-staged';
  seed(partialOf(fx.root, staged), 'synthetic interrupted partial\n');
  const stagedBefore = contents(partialOf(fx.root, staged));
  await refuses(() => convert(fx, { operationId: staged }), 'vault_staging_exists', 'partial exists');
  assert.deepEqual(contents(partialOf(fx.root, staged)), stagedBefore, 'partial unchanged');
  assert.ok(!existsSync(bundleOf(fx.root, staged)), 'no final published');

  assert.deepEqual(readdirSync(work).sort(), [`vault-${taken}`, `vault-${staged}.partial`].sort(), 'only the preexisting entries remain');
  assert.ok(!existsSync(join(fx.root.path, 'files')));
  assert.deepEqual(legacyState(fx), before);
});

// ---------------------------------------------------------------- 4. unreferenced legacy blobs

test('a legacy blob no row references is counted as unreferenced and not converted', async t => {
  const fx = await legacyInstance(t);
  const orphan = 'f-synthetic-orphan-000001';
  writeFileSync(legacyBlob(fx, orphan), encrypt(fx.legacyKey, Buffer.from('synthetic orphan bytes\n'), orphan), { mode: 0o600 });
  const before = legacyState(fx);
  const r = await convert(fx);
  assert.equal(r.unreferenced, 1);
  assert.equal(r.uploads, 2);
  assert.equal(r.packets, 1);
  assert.ok(!r.objects.some(o => o.objectId === orphan), 'not in the result');
  const bundle = bundleOf(fx.root);
  assert.ok(!existsSync(join(bundle, 'files', `${orphan}.bin`)), 'not in the bundle');
  assert.ok(!readFileSync(join(bundle, 'manifest.json'), 'utf8').includes(orphan), 'not in the manifest');
  assert.deepEqual(legacyState(fx), before, 'the orphan stays where it was');
});

// ---------------------------------------------------------------- 5. no dual reader

test('no dual reader: the converted SimpleFIN secret fails the legacy decrypt and the legacy secret fails the new codec', async t => {
  const fx = await legacyInstance(t);
  await convert(fx);
  const converted = readFileSync(join(bundleOf(fx.root), 'simplefin-access.fthm2'), 'utf8').trim();
  const legacy = fx.db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get().access_blob;
  assert.equal(HV.openConnectionSecret(fx.handle, converted), ACCESS_URL, 'liveness: the new codec reads the converted secret');
  assert.equal(decrypt(fx.legacyKey, Buffer.from(legacy, 'base64'), LEGACY_SIMPLEFIN_AAD).toString('utf8'), ACCESS_URL, 'liveness: the legacy reader reads the legacy secret');

  assert.throws(() => decrypt(fx.legacyKey, Buffer.from(converted, 'base64'), LEGACY_SIMPLEFIN_AAD), err => err instanceof VaultError, 'legacy reader, converted secret');
  await refuses(() => HV.openConnectionSecret(fx.handle, legacy), 'vault_auth_failed', 'new codec, legacy secret');
  // The formats differ, not just the keys: under one raw key neither reader accepts the other's blob.
  const sameKey = HV.dataKeyHandle({ householdId: fx.householdId, version: 1, key: fx.legacyKey });
  await refuses(() => HV.openConnectionSecret(sameKey, legacy), 'vault_auth_failed', 'new codec under the legacy key');
  assert.throws(() => decrypt(fx.legacyKey, Buffer.from(HV.sealConnectionSecret(sameKey, ACCESS_URL), 'base64'), LEGACY_SIMPLEFIN_AAD), err => err instanceof VaultError);
});

// ---------------------------------------------------------------- 6. edge cases

test('an empty legacy instance converts to a bundle with zero counts', async t => {
  const fx = await legacyInstance(t, { content: false });
  const before = legacyState(fx);
  const r = await convert(fx);
  assert.deepEqual({ uploads: r.uploads, packets: r.packets, simplefin: r.simplefin, unreferenced: r.unreferenced }, { uploads: 0, packets: 0, simplefin: 0, unreferenced: 0 });
  assert.deepEqual(r.objects, []);
  const bundle = join(fx.root.path, r.path);
  assert.equal(bundle, bundleOf(fx.root));
  assert.ok(existsSync(join(bundle, 'manifest.json')), 'manifest written');
  JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
  assert.ok(!existsSync(join(bundle, 'simplefin-access.fthm2')), 'no SimpleFIN file without a connection');
  const files = join(bundle, 'files');
  assert.ok(!existsSync(files) || readdirSync(files).length === 0, 'no converted objects');
  assert.ok(!existsSync(partialOf(fx.root)));
  assert.deepEqual(legacyState(fx), before);
});

test('a files row with no stored path is skipped, not refused', async t => {
  const fx = await legacyInstance(t);
  const skipped = 'f-synthetic-no-bytes-0001';
  fx.db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status)
    VALUES (?, 'synthetic-unstored.csv', 'text/csv', NULL, NULL, ?, NULL, 'error')`).run(skipped, NOW);
  const before = legacyState(fx);
  const r = await convert(fx);
  assert.equal(r.uploads, 2, 'only stored uploads convert');
  assert.equal(r.objects.length, 4);
  assert.ok(!r.objects.some(o => o.objectId === skipped));
  assert.ok(!existsSync(join(bundleOf(fx.root), 'files', `${skipped}.bin`)));
  assert.deepEqual(legacyState(fx), before);
});

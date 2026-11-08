// MT-03 AC2: the offline tenancy migration (src/platform/migrate-tenancy.mjs, CLI
// scripts/migrate-tenancy.mjs) preserves semantic row digests, figures, plaintext artifacts, valid
// key hashes and ownership; each phase failure resumes safely; source ambiguity refuses.
// Risk probe: interrupt immediately before manifest publication (a child process exiting inside
// onPhase('before-manifest')), restart twice, and the end state equals an uninterrupted run.
//
// Fixture (test/helpers/tenancy-runtime.mjs buildMigrationFixture): an MT-02-layout synthetic
// instance with every store table populated, FTHM1 uploads, an advisor packet, a FTHM1 SimpleFIN
// secret, a private pack, an outbox message, rowid gaps, an answered Confirm item whose undo log
// references a rowid, an owned and an ownerless MCP key. It is built once and copied per case, so
// every case starts from identical bytes and the same household id.
//
// Assumptions (the plan is silent; see the helper header for the fixture ones):
// 1. onPhase is called once per name in PHASES, in order, in an uninterrupted run (including
//    'before-manifest' and 'complete'), and an error thrown by onPhase rejects migrateTenancy with
//    that same error.
// 2. The manifest phase records exactly one platform_operations row of kind 'tenancy-migration'
//    whose id is the operationId; legacy entries retire to legacy-<operationId>/.
// 3. The scenario comparison ignores `engine` and `live.engine` (runtime engine state: the migrated
//    household starts with outbound engine work paused) and each `live.ingest.items[].createdAt`
//    (Confirm items queued when the scenario is read, stamped with the wall clock).
// 4. The pre-migration scenario is built in-process with src/api/handlers.mjs scenarioOf over a
//    rowid-preserving copy of the legacy store, with live packs refreshed as server startup does.
// 5. schema_migrations is compared on the ids the legacy fixture already had (all below 25): a
//    store migration between the fixture schema and 025 would be applied to the source by the
//    source-schema phase on both sides of the comparison only if it changes no existing rows.
// 6. A mid-retire interruption is simulated by exiting at onPhase('manifest') and then moving one
//    legacy entry (files/) into legacy-<operationId>/ by hand, the state a crash between two retire
//    renames leaves.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { src, tempDir, request, createSessionFixture, sessionClient, runCommand } from './helpers/server.mjs';
import {
  CLOCK, SIMPLEFIN_URL, buildMigrationFixture, copyFixture, recordExpectations, runMigration, migrationEnv, migrateCli,
  migrateExitingAt, migratedPlaintexts, endState, tableDigests, digestRules, withSqlite, startRuntime, startRefusal, stableHashes,
  writePrivate, mcp, DONE_AT,
} from './helpers/tenancy-runtime.mjs';
import { fileHashes, credentialFor, signIn } from './helpers/tenancy.mjs';
import { createAuthenticator } from './helpers/webauthn.mjs';

const T = { timeout: 600_000 };
const PHASES_PINNED = ['preflight', 'snapshot', 'source-schema', 'stage', 'verify', 'root-published', 'before-manifest', 'manifest', 'retire', 'complete'];
const RETIRED = ['api-key-secret', 'fathom.sqlite', 'files', 'outbox', 'packs'];

let scratch;
let template;
let expected;
let M;
let reference = null;
let runs = 0;

// A fresh copy of the built fixture.
function fresh() {
  const root = join(scratch, `run-${++runs}`);
  mkdirSync(root, { recursive: true });
  return copyFixture(template, root);
}

// The end state of an uninterrupted run on a fresh copy (the success case records it first).
async function referenceState() {
  if (!reference) {
    const fx = fresh();
    await runMigration(fx);
    reference = await endState(fx);
  }
  return reference;
}

const comparable = scenario => {
  const c = structuredClone(scenario);
  delete c.engine;
  if (c.live) delete c.live.engine;
  for (const item of c.live?.ingest?.items ?? []) delete item.createdAt;
  return c;
};

const operationOf = fx => withSqlite(join(fx.dataDir, 'platform.sqlite'), p => p.prepare("SELECT id FROM platform_operations WHERE kind = 'tenancy-migration'").all().map(r => r.id));

function noSecrets(text, secrets, label) {
  for (const s of secrets) assert.ok(!String(text).includes(s), `${label} carries no fixture secret`);
}

async function refuses(promise, code, label) {
  await assert.rejects(promise, err => {
    assert.ok(err instanceof Error, `${label}: an Error`);
    assert.equal(err.code, code, `${label}: ${err.code} ${err.message}`);
    return true;
  });
}

before(async () => {
  scratch = await tempDir('fathom-mt03-migration-');
  template = await buildMigrationFixture(join(scratch, 'template'));
  expected = await recordExpectations(template);
  M = await src('src/platform/migrate-tenancy.mjs');
});

after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

// ============================================================================================
// Module contract
// ============================================================================================

test('the migration module exports the pinned phases and file names', () => {
  assert.deepEqual([...M.PHASES], PHASES_PINNED);
  assert.equal(M.JOURNAL_FILE, 'tenancy-migration.json');
  assert.equal(M.LOCK_FILE, 'tenancy-migration.lock');
  assert.equal(typeof M.migrateTenancy, 'function');
});

// ============================================================================================
// 1. Success
// ============================================================================================

describe('a complete migration preserves the household', T, () => {
  let fx;
  let result;
  let seen;
  const journals = [];
  let server;

  before(async () => {
    fx = fresh();
    seen = [];
    result = await runMigration(fx, {
      onPhase: async name => {
        seen.push(name);
        const file = join(fx.dataDir, M.JOURNAL_FILE);
        if (existsSync(file)) journals.push(readFileSync(file, 'utf8'));
      },
    });
    reference = await endState(fx);
  });

  after(async () => { await server?.close(); });

  test('it reports complete for the one household, after every phase in order', () => {
    assert.deepEqual(seen, PHASES_PINNED);
    assert.equal(result.status, 'complete');
    assert.equal(result.householdId, fx.householdId);
    assert.equal(typeof result.operationId, 'string');
    assert.deepEqual(operationOf(fx), [result.operationId]);
  });

  test('every store table except api_keys keeps its semantic row digest, rowids included', () => {
    const published = join(fx.dataDir, 'households', fx.householdId, 'fathom.sqlite');
    assert.ok(existsSync(published), 'households/<id>/fathom.sqlite');
    const after = tableDigests(published, digestRules(expected.maxMigration));
    const added = ['import_batches', 'import_proposals', 'import_model_spend', 'source_changes'];
    assert.deepEqual(Object.keys(after).sort(), [...expected.tables.filter(t => t !== 'api_keys'), ...added].sort(),
      'only api_keys is removed and the model-import and source change tables are added');
    for (const table of added) assert.equal(after[table].count, 0, `${table} starts empty`);
    for (const t of expected.tables) {
      if (t === 'api_keys') continue;
      assert.deepEqual(after[t], expected.digests[t], `${t}: digest`);
    }
    assert.ok(expected.digests.accounts.count > 0 && expected.digests.files.count > 0, 'the comparison covers populated tables');
  });

  test('goals carry across with their done state (store migration 026, goals.done_at)', () => {
    const published = join(fx.dataDir, 'households', fx.householdId, 'fathom.sqlite');
    const goals = withSqlite(published, db => db.prepare('SELECT id, done_at FROM goals ORDER BY id').all().map(r => ({ ...r })));
    assert.deepEqual(goals, [{ id: 'g000000000001', done_at: null }, { id: 'g000000000002', done_at: DONE_AT }]);
  });

  test('every upload, packet and the SimpleFIN URL decrypt to the same plaintext; packs and outbox are byte-equal', async () => {
    const vault = await migratedPlaintexts(fx.dataDir, fx.householdId, fx.keys.platformKey);
    assert.deepEqual(vault.plaintexts, expected.plaintexts);
    assert.equal(vault.simplefinUrl, SIMPLEFIN_URL);
    const rootPath = join(fx.dataDir, 'households', fx.householdId);
    assert.deepEqual(fileHashes(join(rootPath, 'packs')), expected.packHashes);
    assert.deepEqual(fileHashes(join(rootPath, 'outbox')), expected.outboxHashes);
    const blobs = readdirSync(join(rootPath, 'files')).filter(n => n.endsWith('.bin')).sort();
    assert.deepEqual(blobs, Object.keys(expected.plaintexts).map(k => `${k.split(':')[1]}.bin`).sort());
    for (const name of blobs) {
      assert.ok(readFileSync(join(rootPath, 'files', name)).subarray(0, 5).equals(Buffer.from('FTHM2')), `${name}: FTHM2`);
    }
  });

  test('the legacy layout is retired, the snapshot published, and nothing is left staged or locked', () => {
    const op = result.operationId;
    const legacy = join(fx.dataDir, `legacy-${op}`);
    assert.deepEqual(readdirSync(legacy).filter(n => !/-(wal|shm)$/.test(n)).sort(), RETIRED);
    for (const name of RETIRED) assert.ok(!existsSync(join(fx.dataDir, name)), `${name} left the data root`);
    assert.ok(existsSync(join(fx.dataDir, 'snapshots', `tenancy-${op}.fsnap`)), 'snapshot');
    assert.deepEqual(readdirSync(join(fx.dataDir, 'households')), [fx.householdId], 'no staging dir remains');
    assert.ok(!existsSync(join(fx.dataDir, M.LOCK_FILE)), 'lock removed');
  });

  test('platform rows: keys keep hashes and bind to the single admin, sessions revoked, outbound all paused', () => {
    withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
      const keys = p.prepare('SELECT * FROM api_keys ORDER BY id').all().map(r => ({ ...r }));
      assert.equal(keys.length, expected.apiKeys.length);
      for (const legacyRow of expected.apiKeys) {
        const row = keys.find(k => k.id === legacyRow.id);
        assert.ok(row, `key ${legacyRow.name} moved`);
        assert.equal(row.key_hash, legacyRow.key_hash);
        assert.equal(row.scopes, legacyRow.scopes);
        assert.equal(row.name, legacyRow.name);
        assert.equal(row.created_at, legacyRow.created_at);
        assert.equal(row.household_id, fx.householdId);
        assert.equal(row.user_id, fx.admin.id, 'owned and ownerless keys bind to the single admin');
        assert.equal(row.revoked_at, null);
      }
      assert.equal(p.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
      assert.equal(p.prepare('SELECT count(*) AS n FROM auth_challenges').get().n, 0);
      assert.equal(p.prepare('SELECT count(*) AS n FROM auth_tokens').get().n, 0);
      assert.equal(p.prepare('SELECT count(*) AS n FROM household_invitations WHERE consumed_at IS NULL AND revoked_at IS NULL').get().n, 0);
      const outbound = { ...p.prepare('SELECT jobs, email, simplefin, engine FROM household_outbound WHERE household_id = ?').get(fx.householdId) };
      assert.deepEqual(outbound, { jobs: 0, email: 0, simplefin: 0, engine: 0 });
      const hh = p.prepare('SELECT status, storage_root, generation FROM households WHERE id = ?').get(fx.householdId);
      assert.deepEqual({ ...hh }, { status: 'active', storage_root: `households/${fx.householdId}`, generation: 1 });
    });
  });

  test('journal and operation records carry no fixture secret', () => {
    assert.ok(journals.length > 0, 'the journal was observed during the run');
    for (const text of journals) noSecrets(text, fx.secrets, 'tenancy-migration.json');
    const final = join(fx.dataDir, M.JOURNAL_FILE);
    if (existsSync(final)) noSecrets(readFileSync(final, 'utf8'), fx.secrets, 'final journal');
    withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
      for (const r of p.prepare('SELECT detail FROM platform_operations').all()) noSecrets(r.detail, fx.secrets, 'platform_operations.detail');
    });
  });

  test('the server starts on the migrated directory: same scenario, original MCP keys, reopenable Confirm item', async () => {
    server = await startRuntime({ dataDir: fx.dataDir, keys: fx.keys });
    const session = await createSessionFixture(server.app.platform, { email: fx.admin.email });
    const client = sessionClient(server.baseUrl, session);
    const scenario = await client.getScenario();
    assert.deepEqual(comparable(scenario), comparable(expected.scenario), 'scenario and figures equal');

    for (const k of [fx.ownedKey, fx.ownerlessKey]) {
      const r = await mcp(server.baseUrl, k.key, 'tools/list');
      assert.equal(r.status, 200, r.text.slice(0, 200));
      assert.ok(r.json.result.tools.some(t => t.name === 'household'));
    }
    assert.equal((await mcp(server.baseUrl, 'fathom_' + randomBytes(32).toString('base64url'), 'tools/list')).status, 401);

    const store = join(fx.dataDir, 'households', fx.householdId, 'fathom.sqlite');
    const accountKind = () => withSqlite(store, db => db.prepare('SELECT kind FROM accounts WHERE id = ?').get(fx.artifacts.confirmAccountId).kind);
    assert.equal(accountKind(), 'checking', 'the answered item applied');
    const reopened = await client.postJson(`/api/confirm/${fx.artifacts.confirmItemId}/reopen`, {});
    assert.equal(reopened.status, 200, reopened.text.slice(0, 300));
    assert.equal(accountKind(), null, 'reopening restored the prior row through its rowid');
    assert.equal(withSqlite(store, db => db.prepare('SELECT status FROM confirm_items WHERE id = ?').get(fx.artifacts.confirmItemId).status), 'pending');
  });
});

test('with two admins the ownerless key is revoked with migration_no_creator and the owned key stays bound', T, async () => {
  const fx = fresh();
  withSqlite(join(fx.dataDir, 'platform.sqlite'), p => p.prepare("UPDATE household_memberships SET role = 'admin' WHERE user_id = ?").run(fx.member.id));
  const r = await runMigration(fx);
  assert.equal(r.status, 'complete');
  withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
    const owned = { ...p.prepare('SELECT * FROM api_keys WHERE id = ?').get(fx.ownedKey.id) };
    const ownerless = { ...p.prepare('SELECT * FROM api_keys WHERE id = ?').get(fx.ownerlessKey.id) };
    assert.equal(owned.user_id, fx.admin.id);
    assert.equal(owned.revoked_at, null);
    assert.equal(owned.household_id, fx.householdId);
    assert.equal(ownerless.user_id, null, 'never guessed among admins');
    assert.notEqual(ownerless.revoked_at, null);
    assert.equal(ownerless.revoked_code, 'migration_no_creator');
    assert.equal(ownerless.household_id, fx.householdId);
    assert.equal(ownerless.key_hash, expected.apiKeys.find(k => k.id === fx.ownerlessKey.id).key_hash);
  });
});

test('migration refuses an inactive creator key while binding a new active admin', T, async () => {
  const fx = fresh();
  withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
    p.prepare("UPDATE household_memberships SET role = 'admin' WHERE user_id = ?").run(fx.member.id);
    p.prepare("UPDATE household_memberships SET status = 'removed', version = version + 1 WHERE user_id = ?").run(fx.admin.id);
  });
  assert.equal((await runMigration(fx)).status, 'complete');
  withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
    const owned = p.prepare('SELECT * FROM api_keys WHERE id = ?').get(fx.ownedKey.id);
    const ownerless = p.prepare('SELECT * FROM api_keys WHERE id = ?').get(fx.ownerlessKey.id);
    assert.equal(owned.user_id, fx.admin.id);
    assert.equal(owned.revoked_code, 'migration_inactive_creator');
    assert.ok(owned.revoked_at);
    assert.equal(ownerless.user_id, fx.member.id);
    assert.equal(ownerless.revoked_at, null);
    assert.equal(ownerless.household_generation, 1);
    assert.equal(ownerless.membership_version, 1);
  });
});

// The operator rollback: `scripts/source-snapshot.mjs restore` on the migration's own snapshot,
// with the backup key, rebuilds the exact pre-migration instance in a new directory.
test('the migration snapshot restores the exact pre-migration instance for a rollback', T, async () => {
  const fx = fresh();
  const tree = dir => fileHashes(dir);
  const before = {
    store: tableDigests(join(fx.dataDir, 'fathom.sqlite')),
    secret: readFileSync(join(fx.dataDir, 'api-key-secret'), 'utf8'),
    trees: ['files', 'packs', 'outbox'].map(d => tree(join(fx.dataDir, d))),
  };
  const r = await runMigration(fx);
  assert.equal(r.status, 'complete');
  const snapshot = join(fx.dataDir, 'snapshots', readdirSync(join(fx.dataDir, 'snapshots')).find(n => n === `tenancy-${operationOf(fx)[0]}.fsnap`));
  const out = join(fx.root, 'restored');
  const restored = await runCommand(process.execPath, ['scripts/source-snapshot.mjs', 'restore', '--snapshot', snapshot, '--out', out],
    { env: { FATHOM_BACKUP_KEY_FILE: fx.keys.backupKeyFile } });
  assert.equal(restored.code, 0, restored.stderr);
  noSecrets(restored.stdout + restored.stderr, fx.secrets, 'the restore output');
  assert.deepEqual(readdirSync(out).sort(), ['api-key-secret', 'fathom.sqlite', 'files', 'outbox', 'packs', 'platform.sqlite']);
  assert.deepEqual(tableDigests(join(out, 'fathom.sqlite')), before.store, 'every store row as before the migration');
  assert.equal(readFileSync(join(out, 'api-key-secret'), 'utf8'), before.secret);
  assert.deepEqual(['files', 'packs', 'outbox'].map(d => tree(join(out, d))), before.trees, 'vault objects, pack and outbox byte for byte');
  withSqlite(join(out, 'platform.sqlite'), p => {
    assert.equal(p.prepare('SELECT storage_root FROM households WHERE id = ?').get(fx.householdId).storage_root, null, 'the platform is the pre-migration one');
  });

  const wrongKey = writePrivate(join(fx.root, 'wrong-backup.key'), randomBytes(32).toString('hex') + '\n');
  const refused = await runCommand(process.execPath, ['scripts/source-snapshot.mjs', 'restore', '--snapshot', snapshot, '--out', join(fx.root, 'refused')],
    { env: { FATHOM_BACKUP_KEY_FILE: wrongKey } });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /snapshot_invalid/);
  assert.equal(existsSync(join(fx.root, 'refused')), false, 'a wrong key writes nothing');
});

// ============================================================================================
// No passkey is lost (the owner's hard requirement)
// ============================================================================================

const PLATFORM = fx => join(fx.dataDir, 'platform.sqlite');
const hexRow = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v]));
const passkeyRows = file => withSqlite(file, p => p.prepare('SELECT * FROM passkeys ORDER BY id').all().map(hexRow));
const identityRows = file => withSqlite(file, p => ({
  users: p.prepare('SELECT * FROM users ORDER BY id').all().map(hexRow),
  memberships: p.prepare('SELECT user_id, household_id, role, status FROM household_memberships ORDER BY user_id').all().map(hexRow),
}));

// Several users and passkeys: the fixture's admin and member credentials plus a second real
// credential for the admin, stored with its registration counter. Returns that device and id.
async function addSecondAdminPasskey(fx) {
  const device = createAuthenticator();
  const credential = await credentialFor(device, fx.admin.handle);
  withSqlite(PLATFORM(fx), p => p.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(credential.id, fx.admin.id, credential.publicKey, credential.counter, '["internal"]', 'Synthetic second device', Date.now()));
  return { device, credentialId: credential.id };
}

describe('no passkey is lost', T, () => {
  test('every passkey row survives byte for byte, users and memberships are unchanged, and pre-migration credentials sign in; the rollback snapshot carries the same rows', async () => {
    const fx = fresh();
    const second = await addSecondAdminPasskey(fx);
    const before = passkeyRows(PLATFORM(fx));
    assert.equal(before.length, 3, 'fixture: three passkeys over two enrolled users');
    const identityBefore = identityRows(PLATFORM(fx));

    const r = await runMigration(fx);
    assert.equal(r.status, 'complete');
    assert.deepEqual(passkeyRows(PLATFORM(fx)), before, 'credential id, user link, public key, sign counter and every other column unchanged');
    assert.deepEqual(identityRows(PLATFORM(fx)), identityBefore, 'users, enrolled users and memberships unchanged');

    const server = await startRuntime({ dataDir: fx.dataDir, keys: fx.keys });
    try {
      for (const [who, device, credentialId] of [
        [fx.admin, fx.admin.device, fx.admin.credentialId], [fx.admin, second.device, second.credentialId], [fx.member, fx.member.device, fx.member.credentialId],
      ]) {
        const signed = await signIn(server.baseUrl, device, credentialId);
        assert.equal(signed.verify.status, 200, `a pre-migration credential signs in: ${signed.verify.text}`);
        assert.equal(signed.verify.json.identity.email, who.email);
        assert.equal((await signed.client.get('/api/scenario')).status, 200);
      }
    } finally {
      await server.close();
    }

    // Rollback path: the migration snapshot restores the same passkey, user and membership rows.
    const snapshot = join(fx.dataDir, 'snapshots', `tenancy-${operationOf(fx)[0]}.fsnap`);
    const out = join(fx.root, 'rollback');
    const restored = await runCommand(process.execPath, ['scripts/source-snapshot.mjs', 'restore', '--snapshot', snapshot, '--out', out],
      { env: { FATHOM_BACKUP_KEY_FILE: fx.keys.backupKeyFile } });
    assert.equal(restored.code, 0, restored.stderr);
    assert.deepEqual(passkeyRows(join(out, 'platform.sqlite')), before, 'the rollback instance holds every passkey byte for byte');
    assert.deepEqual(identityRows(join(out, 'platform.sqlite')), identityBefore);
  });

  // [label, change(platform) -> undo(platform)] applied while the run waits at before-manifest.
  const CHANGES = [
    ['a passkey deleted', p => {
      const row = p.prepare('SELECT * FROM passkeys ORDER BY id LIMIT 1').get();
      p.prepare('DELETE FROM passkeys WHERE id = ?').run(row.id);
      return q => q.prepare(`INSERT INTO passkeys (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
    }],
    ['a credential id replaced (same count)', p => {
      const id = p.prepare('SELECT id FROM passkeys ORDER BY id LIMIT 1').get().id;
      p.prepare('UPDATE passkeys SET id = ? WHERE id = ?').run('synthetic-replaced-credential', id);
      return q => q.prepare("UPDATE passkeys SET id = ? WHERE id = 'synthetic-replaced-credential'").run(id);
    }],
    ['a sign counter changed', p => {
      const row = p.prepare('SELECT id, counter FROM passkeys ORDER BY id LIMIT 1').get();
      p.prepare('UPDATE passkeys SET counter = counter + 1 WHERE id = ?').run(row.id);
      return q => q.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(row.counter, row.id);
    }],
  ];

  for (const [label, change] of CHANGES) {
    test(`${label} before publication refuses passkeys_changed, publishes nothing, and the restored rerun completes`, async () => {
      const fx = fresh();
      const before = passkeyRows(PLATFORM(fx));
      let undo;
      await refuses(runMigration(fx, { onPhase: async name => {
        if (name === 'before-manifest') undo = withSqlite(PLATFORM(fx), change);
      } }), 'passkeys_changed', label);
      withSqlite(PLATFORM(fx), p => {
        assert.equal(p.prepare('SELECT storage_root FROM households WHERE id = ?').get(fx.householdId).storage_root ?? null, null, 'nothing published');
        assert.ok(p.prepare('SELECT count(*) AS n FROM auth_sessions').get().n > 0, 'the manifest transaction never ran');
        assert.equal(p.prepare("SELECT count(*) AS n FROM platform_operations WHERE kind = 'tenancy-migration'").get().n, 0);
      });
      assert.ok(existsSync(join(fx.dataDir, 'fathom.sqlite')), 'the source is not retired');

      // The CLI names the reason with its fixed code.
      const cli = await migrateCli(fx);
      assert.equal(cli.code, 1);
      assert.equal(cli.stderr.trim(), 'migrate-tenancy: passkeys_changed');

      withSqlite(PLATFORM(fx), undo);
      assert.deepEqual(passkeyRows(PLATFORM(fx)), before);
      const r = await runMigration(fx);
      assert.equal(r.status, 'complete');
      assert.deepEqual(passkeyRows(PLATFORM(fx)), before);
    });
  }
});

// ============================================================================================
// 2. A failure at every phase resumes to the uninterrupted end state
// ============================================================================================

describe('a failure at each phase, then a rerun, equals an uninterrupted run', T, () => {
  for (const phase of PHASES_PINNED.filter(p => p !== 'complete')) {
    test(`fails at ${phase}`, async () => {
      const fx = fresh();
      const boom = new Error('synthetic phase failure');
      await assert.rejects(runMigration(fx, { onPhase: async name => { if (name === phase) throw boom; } }), err => err === boom);
      const r = await runMigration(fx);
      assert.equal(r.status, 'complete');
      assert.equal(r.householdId, fx.householdId);
      assert.deepEqual(await endState(fx), await referenceState());
      assert.ok(!existsSync(join(fx.dataDir, M.LOCK_FILE)));
    });
  }
});

// ============================================================================================
// 3. Risk probe: process exits mid-migration
// ============================================================================================

describe('risk probe: the process dies mid-migration and restarts', T, () => {
  const startCodes = ['tenancy_migration_required', 'tenancy_migration_in_progress'];

  test('exit before manifest publication, restart twice (the second also dies there), then a clean run', async () => {
    const fx = fresh();
    const first = await migrateExitingAt(fx, 'before-manifest');
    assert.equal(first.code, 9, first.stderr);
    const refusedA = await startRefusal({ dataDir: fx.dataDir, keys: fx.keys });
    assert.ok(refusedA && startCodes.includes(refusedA.code), `server refuses: ${refusedA?.code}`);
    withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
      const row = p.prepare('SELECT * FROM households WHERE id = ?').get(fx.householdId);
      assert.equal(row.storage_root ?? null, null, 'nothing published before the manifest');
    });

    const second = await migrateExitingAt(fx, 'before-manifest');
    assert.equal(second.code, 9, second.stderr);
    const refusedB = await startRefusal({ dataDir: fx.dataDir, keys: fx.keys });
    assert.ok(refusedB && startCodes.includes(refusedB.code), `server still refuses: ${refusedB?.code}`);

    const r = await runMigration(fx);
    assert.equal(r.status, 'complete');
    assert.deepEqual(await endState(fx), await referenceState());
  });

  test('a source row changed between a crash before the manifest and the rerun refuses source_changed; restored, the rerun completes', async () => {
    const fx = fresh();
    const first = await migrateExitingAt(fx, 'before-manifest');
    assert.equal(first.code, 9, first.stderr);
    const store = join(fx.dataDir, 'fathom.sqlite');
    const original = withSqlite(store, db => db.prepare("SELECT value FROM content WHERE key = 'synthetic.note'").get().value);
    withSqlite(store, db => db.prepare("UPDATE content SET value = '\"Synthetic later edit\"' WHERE key = 'synthetic.note'").run());
    await refuses(runMigration(fx), 'source_changed', 'a changed source');
    withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
      assert.equal(p.prepare('SELECT storage_root FROM households WHERE id = ?').get(fx.householdId).storage_root ?? null, null, 'nothing published');
    });
    assert.ok(existsSync(store), 'the source is not retired');
    withSqlite(store, db => db.prepare("UPDATE content SET value = ? WHERE key = 'synthetic.note'").run(original));
    const r = await runMigration(fx);
    assert.equal(r.status, 'complete');
    assert.deepEqual(await endState(fx), await referenceState());
  });

  // A source file changed after a crash before the manifest: the store digest alone misses it, so
  // publication refuses source_changed with nothing published; restored, the rerun completes.
  const firstFile = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (e.isFile()) return path;
      if (e.isDirectory()) { const f = firstFile(path); if (f) return f; }
    }
    return null;
  };
  const TREE_CHANGES = [
    ['an edited source pack file', fx => {
      const path = firstFile(join(fx.dataDir, 'packs'));
      assert.ok(path, 'the fixture has a pack file');
      const was = readFileSync(path);
      writeFileSync(path, Buffer.concat([was, Buffer.from('\nsynthetic later edit\n')]));
      return () => writeFileSync(path, was);
    }],
    ['a file added to the source outbox', fx => {
      mkdirSync(join(fx.dataDir, 'outbox'), { recursive: true, mode: 0o700 });
      const path = join(fx.dataDir, 'outbox', 'synthetic-later.eml');
      writeFileSync(path, 'synthetic later message\n', { mode: 0o600 });
      return () => rmSync(path);
    }],
  ];
  for (const [label, change] of TREE_CHANGES) {
    test(`${label} between a crash before the manifest and the rerun refuses source_changed; restored, the rerun completes`, async () => {
      const fx = fresh();
      const first = await migrateExitingAt(fx, 'before-manifest');
      assert.equal(first.code, 9, first.stderr);
      const restore = change(fx);
      await refuses(runMigration(fx), 'source_changed', label);
      withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
        assert.equal(p.prepare('SELECT storage_root FROM households WHERE id = ?').get(fx.householdId).storage_root ?? null, null, 'nothing published');
      });
      assert.ok(existsSync(join(fx.dataDir, 'fathom.sqlite')), 'the source is not retired');
      restore();
      const r = await runMigration(fx);
      assert.equal(r.status, 'complete');
      assert.deepEqual(await endState(fx), await referenceState());
    });
  }

  test('another MCP secret on the rerun after a crash before the manifest refuses mcp_secret_mismatch; the right one completes', async () => {
    const fx = fresh();
    const first = await migrateExitingAt(fx, 'before-manifest');
    assert.equal(first.code, 9, first.stderr);
    const other = writePrivate(join(fx.root, 'other-keys', 'mcp-other.secret'), randomBytes(32).toString('hex') + '\n');
    await refuses(runMigration(fx, { mcpSecretFile: other }), 'mcp_secret_mismatch', 'another MCP secret');
    withSqlite(join(fx.dataDir, 'platform.sqlite'), p => {
      assert.equal(p.prepare('SELECT storage_root FROM households WHERE id = ?').get(fx.householdId).storage_root ?? null, null, 'nothing published');
      assert.equal(p.prepare('SELECT count(*) AS n FROM api_keys').get().n, 0, 'no key moved');
    });
    assert.ok(existsSync(join(fx.dataDir, 'api-key-secret')), 'the source secret is not retired');
    const r = await runMigration(fx);
    assert.equal(r.status, 'complete');
    assert.deepEqual(await endState(fx), await referenceState());
  });

  test('exit right after the root is published, then a rerun completes', async () => {
    const fx = fresh();
    const died = await migrateExitingAt(fx, 'root-published');
    assert.equal(died.code, 9, died.stderr);
    assert.ok(existsSync(join(fx.dataDir, 'households', fx.householdId, 'fathom.sqlite')), 'the root was published before the exit');
    const r = await runMigration(fx);
    assert.equal(r.status, 'complete');
    assert.deepEqual(await endState(fx), await referenceState());
  });

  test('exit during retirement (one legacy entry already moved), then a rerun completes', async () => {
    const fx = fresh();
    const died = await migrateExitingAt(fx, 'manifest');
    assert.equal(died.code, 9, died.stderr);
    const [op] = operationOf(fx);
    assert.ok(op, 'the manifest committed its operation row');
    const legacy = join(fx.dataDir, `legacy-${op}`);
    mkdirSync(legacy, { recursive: true, mode: 0o700 });
    if (existsSync(join(fx.dataDir, 'files'))) renameSync(join(fx.dataDir, 'files'), join(legacy, 'files'));
    const r = await runMigration(fx);
    assert.equal(r.status, 'complete');
    assert.equal(r.operationId, op);
    assert.deepEqual(await endState(fx), await referenceState());
  });
});

// ============================================================================================
// 4. Refusals change nothing
// ============================================================================================

describe('source ambiguity and missing prerequisites refuse before any change', T, () => {
  const now = Date.parse(`${CLOCK}T09:00:00.000Z`);
  const addHousehold = (fx, id, status = 'active') => withSqlite(join(fx.dataDir, 'platform.sqlite'), p => p.prepare(`INSERT INTO households
    (id, status, mode, display_name, serves_store, created_at, updated_at) VALUES (?, ?, 'real', NULL, 0, ?, ?)`).run(id, status, now, now));
  const otherKey = fx => writePrivate(join(fx.root, 'other-keys', `k-${randomBytes(4).toString('hex')}`), randomBytes(32).toString('hex') + '\n');
  const missing = fx => join(fx.root, 'absent', 'missing.key');

  // [label, code, setup(fx) -> migrateTenancy overrides]
  const CASES = [
    ['a second household on the platform', 'ambiguous_household', fx => { addHousehold(fx, 'hh-synthetic-second'); }],
    ['a store bound to another household', 'household_store_mismatch', fx => {
      withSqlite(join(fx.dataDir, 'fathom.sqlite'), db => db.prepare("UPDATE store_identity SET household_id = 'hh-synthetic-other'").run());
    }],
    ['a membership in another household', 'ambiguous_household', fx => {
      addHousehold(fx, 'hh-synthetic-other', 'provisioning');
      withSqlite(join(fx.dataDir, 'platform.sqlite'), p => p.prepare(`INSERT INTO household_memberships
        (user_id, household_id, role, status, version, created_at, updated_at) VALUES (?, 'hh-synthetic-other', 'member', 'active', 1, ?, ?)`).run(fx.member.id, now, now));
    }],
    ['a preexisting households/<x> directory', 'target_exists', fx => {
      mkdirSync(join(fx.dataDir, 'households', 'hh-synthetic-x'), { recursive: true, mode: 0o700 });
      writeFileSync(join(fx.dataDir, 'households', 'hh-synthetic-x', 'keep.txt'), 'synthetic\n', { mode: 0o600 });
    }],
    ['a missing legacy data key', 'legacy_key_invalid', fx => ({ legacyKeyFile: missing(fx) })],
    ['the wrong legacy data key', 'legacy_key_invalid', fx => ({ legacyKeyFile: otherKey(fx) })],
    ['an MCP secret file with other bytes', 'mcp_secret_mismatch', fx => ({ mcpSecretFile: otherKey(fx) })],
    ['the data directory\'s api-key-secret as the MCP secret file', 'secret_in_retired_entry', fx => ({ mcpSecretFile: join(fx.dataDir, 'api-key-secret') })],
    ['a platform key inside the retired files/ directory', 'secret_in_retired_entry', fx => ({
      platformKeyFile: writePrivate(join(fx.dataDir, 'files', 'platform.key'), readFileSync(fx.keys.platformKeyFile, 'utf8')),
    })],
    ['a missing platform key', 'platform_key_invalid', fx => ({ platformKeyFile: missing(fx) })],
    ['too little free space', 'insufficient_space', () => ({ diskFree: () => 0 })],
    ['a missing backup key', 'backup_key_invalid', fx => ({ backupKeyFile: missing(fx) })],
  ];

  for (const [label, code, setup] of CASES) {
    test(`${label} refuses ${code}`, async () => {
      const fx = fresh();
      const overrides = setup(fx) ?? {};
      const households = join(fx.dataDir, 'households');
      const entriesBefore = existsSync(households) ? readdirSync(households).sort() : [];
      const before = stableHashes(fx.dataDir);
      await refuses(runMigration(fx, overrides), code, label);
      assert.deepEqual(stableHashes(fx.dataDir), before, 'source files unchanged');
      assert.deepEqual(existsSync(households) ? readdirSync(households).sort() : [], entriesBefore, 'no household root published');
      assert.ok(!existsSync(join(fx.dataDir, M.LOCK_FILE)), 'no lock left');
    });
  }
});

// ============================================================================================
// 5. Startup gates
// ============================================================================================

test('startup refuses an unmigrated layout and a leftover root store after migration', T, async () => {
  const fx = fresh();
  const unmigrated = await startRefusal({ dataDir: fx.dataDir, keys: fx.keys });
  assert.ok(unmigrated, 'the server refused');
  assert.equal(unmigrated.code, 'tenancy_migration_required');
  assert.match(unmigrated.message, /node scripts\/migrate-tenancy\.mjs/);
  assert.ok(existsSync(join(fx.dataDir, 'fathom.sqlite')), 'the legacy store is untouched');

  const r = await runMigration(fx);
  copyFileSync(join(fx.dataDir, `legacy-${r.operationId}`, 'fathom.sqlite'), join(fx.dataDir, 'fathom.sqlite'));
  const conflict = await startRefusal({ dataDir: fx.dataDir, keys: fx.keys });
  assert.ok(conflict, 'the server refused');
  assert.equal(conflict.code, 'tenancy_layout_conflict');
});

// ============================================================================================
// 6. The CLI
// ============================================================================================

test('the CLI completes with one fixed line and refuses with a fixed code, printing no secret', T, async () => {
  const fx = fresh();
  const ok = await migrateCli(fx);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), `migrate-tenancy: complete ${fx.householdId}`);
  noSecrets(ok.stdout + ok.stderr, fx.secrets, 'CLI output');
  assert.ok(existsSync(join(fx.dataDir, 'households', fx.householdId, 'fathom.sqlite')));

  const bad = fresh();
  const refused = await migrateCli(bad, { ...migrationEnv(bad), FATHOM_PLATFORM_KEY_FILE: join(bad.root, 'absent.key') });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout + refused.stderr, /^migrate-tenancy: platform_key_invalid$/m);
  noSecrets(refused.stdout + refused.stderr, bad.secrets, 'CLI refusal output');
  assert.ok(existsSync(join(bad.dataDir, 'fathom.sqlite')), 'the refused source is untouched');
});

// ============================================================================================
// 7. Journal hygiene under failure
// ============================================================================================

test('journals written by an interrupted and a resumed run carry no fixture secret', T, async () => {
  const fx = fresh();
  const texts = [];
  const capture = () => {
    const file = join(fx.dataDir, M.JOURNAL_FILE);
    if (existsSync(file)) texts.push(readFileSync(file, 'utf8'));
  };
  await assert.rejects(runMigration(fx, { onPhase: async name => { capture(); if (name === 'verify') throw new Error('synthetic'); } }));
  await runMigration(fx, { onPhase: async () => { capture(); } });
  assert.ok(texts.length > 0);
  for (const text of texts) noSecrets(text, fx.secrets, 'journal');
  const db = new DatabaseSync(join(fx.dataDir, 'platform.sqlite'));
  try {
    for (const r of db.prepare('SELECT detail FROM platform_operations').all()) noSecrets(r.detail, fx.secrets, 'operation detail');
  } finally { db.close(); }
});

test('an anonymous request to a migrated instance gets no financial data', T, async () => {
  const fx = fresh();
  await runMigration(fx);
  const s = await startRuntime({ dataDir: fx.dataDir, keys: fx.keys });
  try {
    const r = await request(s.baseUrl, { path: '/api/scenario' });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

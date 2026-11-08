// MT-01: platform identity and household membership.
//
// AC1: existing user membership migrates once; duplicate invitations, email mismatch, replay, role
// escalation and last-admin/operator removal are refused; an operator without membership cannot
// read financial state.
// AC3: unmigrated real startup refuses with platform_migration_required; a second non-deleted real
// household, including one still provisioning, gets 409 multi_household_gated. The offline
// source-snapshot helper encrypts and round-trips the stopped source with a synthetic
// FATHOM_BACKUP_KEY_FILE.
// Migration safety: offline (source_in_use while another process holds the store), journaled and
// resumable after SIGKILL at every window, immutable encrypted snapshot, moved rows kept until
// verified extraction, and every passkey, live session, MCP key and pending link or challenge still
// works after migration.
//
// Everything runs against the real server, scripts and modules; every value is synthetic.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expectServerExit, runCommand, spawnServer, tempDir, migrateTenancyStore, servedStore, secretEnv, secretsFor,
} from './helpers/server.mjs';
import { createAuthenticator } from './helpers/webauthn.mjs';
import {
  REAL, CEREMONY, EXPIRED, MEMBERSHIP_REQUIRED, PLATFORM_FILE, LOCK_FILE, JOURNAL_FILE, STAGING_FILE, AUTH_TABLES,
  PLATFORM_TABLES, PHASES, BEFORE_PUBLISH,
  buildLegacyStore, writeBackupKey, migrateCli, snapshotCli, operatorCli, migrateWithFault, holdStore,
  fileHashes, snapshotsIn, partialsIn, withDb, rows, tableNames, dump, sourceAuthRows,
  browser, sessionBrowser, signIn, register, mcpList,
  platformModules, freshInstance, enrollMember, insertPasskey, count,
} from './helpers/tenancy.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const T = { timeout: 180_000 };
const CLOCK = '2026-11-05';
const MAGIC = Buffer.from('FTHMSNAP1', 'latin1');

// File hashes that ignore SQLite's shared-memory index and an empty WAL, which a read-only open
// may leave behind without changing the store.
const stable = dir => fileHashes(dir, rel => rel.endsWith('-shm') || (rel.endsWith('-wal') && statSync(join(dir, rel)).size === 0));
const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, row[k]]));
const sortBy = (list, key) => [...list].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
const hexOf = value => Buffer.from(value).toString('hex');
const noSecrets = (text, fx, label) => {
  for (const s of fx.secrets) assert.ok(!text.includes(s), `${label} carries no row value or secret`);
};

async function scratch(t, prefix = 'fathom-mt01-') {
  const root = await tempDir(prefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function legacyFixture(t, options) {
  const root = await scratch(t);
  const fx = await buildLegacyStore(join(root, 'data'), options);
  fx.root = root;
  fx.keyFile = writeBackupKey(join(root, 'keys'));
  return fx;
}

async function startServer(t, dataDir, env = REAL) {
  const server = await spawnServer({ dataDir, env });
  t.after(() => server.stop());
  return server;
}

// The complete migrated end state for a legacy fixture: platform rows equal the source rows,
// memberships exactly one per enrolled user with the source role, the store keeps every financial
// row and api key but no auth table, and only counts and hashes reach the journal.
async function assertMigrated(fx) {
  const { dataDir, file, legacy } = fx;
  const platformFile = join(dataDir, PLATFORM_FILE);
  assert.ok(existsSync(platformFile), 'platform.sqlite is published');
  assert.equal(existsSync(join(dataDir, LOCK_FILE)), false, 'no leftover lock file');
  assert.equal(existsSync(join(dataDir, STAGING_FILE)), false, 'no leftover staging file');
  assert.deepEqual(partialsIn(dataDir), [], 'no leftover partial snapshot');
  const snaps = snapshotsIn(dataDir);
  assert.equal(snaps.length, 1, `exactly one source snapshot: ${snaps}`);

  const p = await withDb(platformFile, async db => Object.fromEntries(await mapSeries(PLATFORM_TABLES, async t => [t, await rows(db, t)])));
  assert.equal(p.households.length, 1, 'one household');
  const household = p.households[0];
  assert.equal(typeof household.id, 'string');
  assert.ok(household.id.length > 0);
  assert.deepEqual(pick(household, ['status', 'mode', 'serves_store']), { status: 'active', mode: 'real', serves_store: 1 });
  const hh = household.id;

  const userKeys = ['id', 'email', 'user_handle', 'created_at', 'enrolled_at'];
  assert.deepEqual(sortBy(p.users.map(u => pick(u, userKeys)), 'id'), sortBy(legacy.users.map(u => pick(u, userKeys)), 'id'));
  assert.deepEqual(
    sortBy(p.household_memberships.map(m => pick(m, ['user_id', 'household_id', 'role', 'status'])), 'user_id'),
    sortBy(legacy.users.filter(u => u.enrolled_at !== null).map(u => ({ user_id: u.id, household_id: hh, role: u.role, status: 'active' })), 'user_id'),
    'exactly one active membership per enrolled user, with the source role');
  assert.deepEqual(p.instance_operators, [], 'the migration grants no operator');

  const passkey = r => ({ ...pick(r, ['id', 'user_id', 'counter', 'transports', 'name', 'created_at']), public_key: hexOf(r.public_key) });
  assert.deepEqual(sortBy(p.passkeys.map(passkey), 'id'), sortBy(legacy.passkeys.map(passkey), 'id'), 'passkeys copy byte for byte');

  const invites = legacy.auth_tokens.filter(r => r.purpose === 'invite');
  const inviteHashes = new Set(invites.map(r => r.hash));
  const tokenKeys = ['hash', 'user_id', 'purpose', 'expires_at'];
  assert.deepEqual(sortBy(p.auth_tokens.map(r => pick(r, tokenKeys)), 'hash'),
    sortBy(legacy.auth_tokens.filter(r => r.purpose !== 'invite').map(r => pick(r, tokenKeys)), 'hash'), 'recovery and add-passkey links copy');
  const userById = new Map(legacy.users.map(u => [u.id, u]));
  assert.deepEqual(
    sortBy(p.household_invitations.map(r => pick(r, ['hash', 'household_id', 'email', 'role', 'user_id', 'expires_at', 'consumed_at', 'revoked_at'])), 'hash'),
    sortBy(invites.map(r => ({ hash: r.hash, household_id: hh, email: userById.get(r.user_id).email, role: userById.get(r.user_id).role,
      user_id: r.user_id, expires_at: r.expires_at, consumed_at: null, revoked_at: null })), 'hash'),
    'invite links become household invitations with the same hash, expiry and role');

  assert.deepEqual(
    sortBy(p.auth_sessions.map(r => pick(r, ['hash', 'user_id', 'signed_in_at', 'expires_at', 'household_id', 'context_version'])), 'hash'),
    sortBy(legacy.auth_sessions.map(r => ({ ...pick(r, ['hash', 'user_id', 'signed_in_at', 'expires_at']), household_id: hh, context_version: 1 })), 'hash'),
    'live sessions copy, bound to the household at version 1');
  const challengeKeys = ['hash', 'ceremony', 'user_id', 'session_hash', 'challenge', 'expires_at'];
  assert.deepEqual(
    sortBy(p.auth_challenges.map(r => ({ ...pick(r, challengeKeys), invitation_hash: r.invitation_hash, token_hash: r.token_hash ?? null })), 'hash'),
    sortBy(legacy.auth_challenges.map(r => ({ ...pick(r, challengeKeys),
      invitation_hash: inviteHashes.has(r.token_hash) ? r.token_hash : null,
      token_hash: inviteHashes.has(r.token_hash) ? null : r.token_hash })), 'hash'),
    'pending challenges copy; an invite-bound challenge points at its invitation');
  assert.deepEqual(sortBy(p.auth_rate_limits, 'key_hash'), sortBy(legacy.auth_rate_limits, 'key_hash'));
  assert.equal(p.platform_operations.length, 1, 'one platform operation row');
  assert.equal(p.platform_operations[0].status, 'done');

  const storeTables = await tableNames(file);
  for (const t of AUTH_TABLES) assert.ok(!storeTables.includes(t), `the store no longer has ${t}`);
  assert.ok(storeTables.includes('api_keys') && storeTables.includes('store_identity'));
  const identity = await withDb(file, async db => await rows(db, 'store_identity'));
  assert.equal(identity.length, 1);
  assert.equal(identity[0].household_id, hh, 'store_identity names the platform household');
  const expected = Object.fromEntries(Object.entries(fx.preDump).filter(([t]) => !AUTH_TABLES.includes(t) && t !== 'schema_migrations'));
  const current = await dump(file, { except: ['schema_migrations', 'store_identity'] });
  for (const [table, entries] of Object.entries(current)) {
    if (!(table in expected)) {
      assert.deepEqual(entries, [], `new additive table ${table} starts empty`);
      delete current[table];
    }
  }
  assert.deepEqual(current, expected,
    'every existing financial row and every api_keys row (hash, scopes, creator) is unchanged');

  const journal = join(dataDir, JOURNAL_FILE);
  assert.ok(existsSync(journal), 'the operation journal is kept');
  const journalText = readFileSync(journal, 'utf8');
  JSON.parse(journalText);
  noSecrets(journalText, fx, 'the journal');

  const snapshot = join(dataDir, snaps[0]);
  const bytes = readFileSync(snapshot);
  assert.ok(bytes.subarray(0, MAGIC.length).equals(MAGIC), 'the snapshot is an FTHMSNAP1 archive');
  assert.equal(bytes.indexOf('SQLite format 3'), -1, 'the snapshot is not plaintext SQLite');
  noSecrets(bytes.toString('latin1'), fx, 'the snapshot');
  assert.equal(statSync(snapshot).mode & 0o777, 0o400, 'the published snapshot is read-only');
  return { householdId: hh, snapshot };
}

// ============================================================================================
// 1. Migration of a schema 020 real store
// ============================================================================================

describe('offline migration of a schema 020 real store (AC1, AC3)', () => {
  let root;
  let fx;
  let householdId;
  let server;
  before(async () => {
    root = await tempDir('fathom-mt01-main-');
    fx = await buildLegacyStore(join(root, 'data'));
    fx.keyFile = writeBackupKey(join(root, 'keys'));
  });
  after(async () => {
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test('unmigrated real startup refuses with platform_migration_required and changes nothing', T, async () => {
    const r = await expectServerExit({ dataDir: fx.dataDir, env: REAL });
    assert.equal(r.started, false, r.output);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /platform_migration_required/);
    assert.match(r.output, /scripts\/migrate-platform\.mjs/);
    noSecrets(r.output, fx, 'the refusal');
    assert.deepEqual(stable(fx.dataDir), fx.preHashes, 'the store and secret are byte-identical');
    assert.equal(existsSync(join(fx.dataDir, PLATFORM_FILE)), false);
    assert.deepEqual(await dump(fx.file), fx.preDump);
  });

  test('the script snapshots, moves every auth row into platform.sqlite and drops the auth tables from the store', T, async () => {
    const r = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(r.code, 0, r.stderr);
    noSecrets(r.stdout + r.stderr, fx, 'the script output');
    ({ householdId } = await assertMigrated(fx));
  });

  test('a rerun of a completed migration is a no-op: same platform rows, store rows and snapshot', T, async () => {
    const platformFile = join(fx.dataDir, PLATFORM_FILE);
    const before = { platform: await dump(platformFile), store: await dump(fx.file), snapshots: snapshotsIn(fx.dataDir) };
    const r = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual({ platform: await dump(platformFile), store: await dump(fx.file), snapshots: snapshotsIn(fx.dataDir) }, before);
    assert.equal(existsSync(join(fx.dataDir, LOCK_FILE)), false);
    await assertMigrated(fx);
  });

  test('the migration snapshot round-trips the stopped source with the synthetic backup key', T, async () => {
    const snapshot = join(fx.dataDir, snapshotsIn(fx.dataDir)[0]);
    const out = join(root, 'restored');
    const r = await snapshotCli(['restore', '--snapshot', snapshot, '--out', out], { FATHOM_BACKUP_KEY_FILE: fx.keyFile });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await dump(join(out, 'fathom.sqlite')), fx.preDump, 'the restored store equals the pre-migration store');
    assert.equal(readFileSync(join(out, 'api-key-secret'), 'utf8').trim(), fx.secretHex);
  });

  test('after both migrations the unchanged passkeys sign in and both MCP keys work; sessions and links are revoked', T, async () => {
    // Since MT-03 a platform-migrated instance also needs the tenancy migration before it serves,
    // and that migration's publication deletes every session, challenge and link token and revokes
    // live invitations (src/platform/migrate-tenancy.mjs, manifest phase).
    await migrateTenancyStore(fx.dataDir);
    server = await spawnServer({ dataDir: fx.dataDir, env: REAL });
    const base = server.baseUrl;

    assert.equal((await sessionBrowser(base, fx.admin.session).get('/api/scenario')).status, 401, 'the pre-migration session is revoked');
    assert.equal((await sessionBrowser(base, randomBytes(32).toString('base64url')).get('/api/scenario')).status, 401, 'an unknown session is refused');

    const admin = await signIn(base, fx.admin.device, fx.admin.credentialId);
    assert.equal(admin.verify.status, 200, admin.verify.text);
    const email = fx.admin.email;
    assert.deepEqual(admin.verify.json.identity, { id: fx.admin.id, email, login: email, name: email, householdId, role: 'admin',
      operator: false, memberships: [{ householdId, role: 'admin', name: null }], contextVersion: 1 });
    assert.ok(admin.client.session() && admin.client.session() !== fx.admin.session);
    assert.equal((await admin.client.get('/api/scenario')).status, 200);
    const member = await signIn(base, fx.member.device, fx.member.credentialId);
    assert.equal(member.verify.status, 200, member.verify.text);
    assert.deepEqual(pick(member.verify.json.identity, ['email', 'householdId', 'role']), { email: fx.member.email, householdId, role: 'member' });

    for (const token of [fx.inviteToken, fx.recoveryToken, fx.addPasskeyToken]) {
      const r = await browser(base).post('/api/auth/register/options', { token, name: 'Synthetic device' });
      assert.equal(r.status, 410, 'a pre-migration link no longer redeems');
      assert.deepEqual(r.json, EXPIRED);
    }
    await withDb(join(fx.dataDir, PLATFORM_FILE), async db => {
      assert.equal(await count(db, 'SELECT count(*) AS n FROM household_invitations WHERE consumed_at IS NULL AND revoked_at IS NULL'), 0, 'no live invitation');
      assert.equal(await count(db, 'SELECT count(*) AS n FROM household_memberships WHERE user_id = ?', fx.invitee.id), 0, 'the invitee did not join');
    });

    for (const key of [fx.ownedKey.key, fx.ownerlessKey.key]) {
      const r = await mcpList(base, key);
      assert.equal(r.status, 200, r.text.slice(0, 200));
      assert.ok(Array.isArray(r.json.result.tools) && r.json.result.tools.length > 0);
    }
    assert.equal((await mcpList(base, 'fathom_' + randomBytes(32).toString('base64url'))).status, 401, 'an unknown key is refused');
  });
});

describe('pre-migration challenges do not complete after both migrations (AC1)', () => {
  test('a sign-in challenge and an invite-bound registration challenge created before migration are refused after it', T, async t => {
    const fx = await legacyFixture(t);
    const r = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(r.code, 0, r.stderr);
    const { householdId } = await assertMigrated(fx);
    await migrateTenancyStore(fx.dataDir);
    const { baseUrl: base } = await startServer(t, fx.dataDir);
    const platformFile = join(fx.dataDir, PLATFORM_FILE);

    const signin = browser(base, { [CEREMONY]: fx.signinChallenge.cookie });
    const response = fx.admin.device.getAssertion({ challenge: fx.signinChallenge.challenge, rpId: 'localhost' },
      { origin: base, credentialId: fx.admin.credentialId });
    assert.equal((await signin.post('/api/auth/signin/verify', { response })).status, 400, 'the deleted sign-in challenge is refused');
    assert.equal((await signin.get('/api/scenario')).status, 401);

    const reg = browser(base, { [CEREMONY]: fx.registerChallenge.cookie });
    const credential = fx.invitee.device.createCredential(
      { rp: { id: 'localhost' }, user: { id: fx.invitee.handle }, challenge: fx.registerChallenge.challenge }, { origin: base });
    const enrolled = await reg.post('/api/auth/register/verify', { token: fx.inviteToken, name: 'Synthetic device', response: credential });
    assert.ok([400, 410].includes(enrolled.status), `the deleted registration challenge is refused: ${enrolled.status}`);
    assert.equal(await withDb(platformFile, async db => await count(db, "SELECT count(*) AS n FROM household_memberships WHERE household_id = ? AND user_id = ?", householdId, fx.invitee.id)), 0);

    // Liveness: a fresh sign-in ceremony with the same passkey succeeds.
    const fresh = await signIn(base, fx.admin.device, fx.admin.credentialId);
    assert.equal(fresh.verify.status, 200, fresh.verify.text);
  });
});

describe('the migration is offline (migration safety)', () => {
  test('a live instance holding the store open makes the script refuse source_in_use with nothing changed', T, async t => {
    const fx = await legacyFixture(t);
    const holder = await holdStore(fx.file);
    let listing;
    try {
      const before = stable(fx.dataDir);
      const mainBytes = readFileSync(fx.file);
      listing = readdirSync(fx.dataDir).sort();
      const r = await migrateCli(fx.dataDir, fx.keyFile);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /source_in_use/);
      noSecrets(r.stdout + r.stderr, fx, 'the refusal');
      assert.ok(readFileSync(fx.file).equals(mainBytes), 'fathom.sqlite is byte-identical');
      assert.deepEqual(stable(fx.dataDir), before);
      assert.deepEqual(readdirSync(fx.dataDir).sort(), listing, 'no journal, lock, staging, platform or snapshot file');
      for (const name of [PLATFORM_FILE, LOCK_FILE, JOURNAL_FILE, STAGING_FILE]) assert.equal(existsSync(join(fx.dataDir, name)), false, name);
    } finally {
      await holder.stop();
    }
    const again = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(again.code, 0, again.stderr);
    await assertMigrated(fx);
  });
});

describe('every caller refuses an unmigrated real store (AC3)', () => {
  const CLIS = ['src/jobs/plan-cli.mjs', 'src/jobs/guess-cli.mjs', 'scripts/build-your-plans.mjs'];
  for (const users of [true, false]) {
    test(`plan-cli, guess-cli and build-your-plans refuse platform_migration_required on a store ${users ? 'with' : 'without'} users`, T, async t => {
      const fx = await legacyFixture(t, { users });
      const env = { FATHOM_DATA: fx.dataDir, FATHOM_ENGINE: 'off', FATHOM_CLOCK: CLOCK, FATHOM_DEMO: '0' };
      // Since MT-03 every store-opening CLI names its household; before any migration no id exists,
      // so a synthetic one shows the readiness refusal comes from the instance, not the argument.
      for (const script of CLIS) {
        const r = await runCommand(process.execPath, [script, '--household', 'hh-synthetic-unknown'], { env });
        assert.notEqual(r.code, 0, `${script}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /platform_migration_required/, script);
        assert.deepEqual(stable(fx.dataDir), fx.preHashes, `${script} leaves the store unchanged`);
      }
      const migrated = await migrateCli(fx.dataDir, fx.keyFile);
      assert.equal(migrated.code, 0, migrated.stderr);
      await assertMigrated(fx);
      await migrateTenancyStore(fx.dataDir);
      const household = ['--household', (await servedStore(fx.dataDir)).householdId];
      const keyed = { ...env, ...secretEnv(secretsFor(fx.dataDir)) };
      // The migrated household starts with outbound jobs paused: both job CLIs get past every
      // readiness check and stop at the pause, never running around it.
      for (const script of CLIS.slice(0, 2)) {
        const r = await runCommand(process.execPath, [script, ...household], { env: keyed });
        assert.doesNotMatch(r.stderr, /migration_required/, script);
        assert.equal(r.code, 3, `${script} stops at the outbound pause: ${r.stderr}`);
        assert.match(r.stderr, /outbound jobs are paused/, script);
      }
      const plans = await runCommand(process.execPath, [CLIS[2], ...household], { env: keyed });
      assert.doesNotMatch(plans.stderr, /platform_migration/, 'build-your-plans gets past the readiness check');
    });
  }
});

describe('preflight refusals change nothing (migration safety)', () => {
  const unchanged = (fx, before) => {
    assert.deepEqual(stable(fx.dataDir), before, 'no lock, journal, platform, staging or snapshot file and the store is byte-identical');
  };

  test('a missing, insecure or malformed backup key refuses backup_key_invalid; a private 32-byte key proceeds', T, async t => {
    const fx = await legacyFixture(t);
    const keys = join(fx.root, 'keys');
    const cases = [
      ['unset', undefined],
      ['missing file', join(keys, 'absent.key')],
      ['world-readable', writeBackupKey(keys, { mode: 0o644, name: 'world.key' })],
      ['group-readable', writeBackupKey(keys, { mode: 0o640, name: 'group.key' })],
      ['16 bytes', writeBackupKey(keys, { bytes: 16, name: 'short.key' })],
      ['a directory', keys],
    ];
    for (const [label, keyFile] of cases) {
      const r = await migrateCli(fx.dataDir, keyFile);
      assert.equal(r.code, 1, `${label}: ${r.stderr}`);
      assert.match(r.stderr, /backup_key_invalid/, label);
      unchanged(fx, fx.preHashes);
    }
    const ok = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(ok.code, 0, ok.stderr);
    await assertMigrated(fx);
  });

  test('orphan auth rows refuse orphan_auth_rows; removing the orphan lets the migration run', T, async t => {
    const fx = await legacyFixture(t);
    await withDb(fx.file, async db => {
      await db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run('pk-orphan-synthetic', 'usr-missing-synthetic', Buffer.from('synthetic'), '["internal"]', 'Orphan', Date.now());
    }, { foreignKeys: false });
    const before = stable(fx.dataDir);
    const r = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /orphan_auth_rows/);
    unchanged(fx, before);
    await withDb(fx.file, async db => { await db.prepare("DELETE FROM passkeys WHERE id = 'pk-orphan-synthetic'").run(); });
    const ok = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(ok.code, 0, ok.stderr);
    await assertMigrated(fx);
  });

  test('two households refuse ambiguous_household; back to one household the migration runs', T, async t => {
    const fx = await legacyFixture(t);
    await withDb(fx.file, async db => {
      // 018 pins households to id 1; rebuild the table without that CHECK to hold a second one.
      await db.applySchema('CREATE TABLE households_rebuilt (id INTEGER PRIMARY KEY)');
      await db.applySchema('INSERT INTO households_rebuilt (id) SELECT id FROM households');
      await db.applySchema('DROP TABLE households');
      await db.applySchema('ALTER TABLE households_rebuilt RENAME TO households');
      await db.applySchema('INSERT INTO households (id) VALUES (2)');
      await db.prepare('INSERT INTO users (id, household_id, email, role, user_handle, created_at, enrolled_at) VALUES (?, 2, ?, ?, ?, ?, ?)')
        .run('usr-second-household', 'second-household@example.test', 'admin', randomBytes(32).toString('base64url'), Date.now(), Date.now());
      assert.deepEqual((await db.foreignKeyCheck()), []);
    }, { foreignKeys: false });
    const before = stable(fx.dataDir);
    const r = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /ambiguous_household/);
    assert.ok(!r.stderr.includes('second-household@example.test'));
    unchanged(fx, before);
    await withDb(fx.file, async db => {
      await db.prepare("DELETE FROM users WHERE id = 'usr-second-household'").run();
      await db.prepare('DELETE FROM households WHERE id = 2').run();
    });
    const ok = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(ok.code, 0, ok.stderr);
    await assertMigrated(fx);
  });

  test('a lock file with no journal refuses stale_lock_mismatch; without it the migration runs', T, async t => {
    const fx = await legacyFixture(t);
    writeFileSync(join(fx.dataDir, LOCK_FILE), JSON.stringify({ operationId: 'op-synthetic-stale' }));
    const before = stable(fx.dataDir);
    const r = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /stale_lock_mismatch/);
    unchanged(fx, before);
    rmSync(join(fx.dataDir, LOCK_FILE));
    const ok = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(ok.code, 0, ok.stderr);
    await assertMigrated(fx);
  });

  test('a demo store refuses not_real_store; the same store in real mode migrates', T, async t => {
    const fx = await legacyFixture(t);
    await withDb(fx.file, async db => { await db.prepare("UPDATE settings SET value = '\"demo\"' WHERE key = 'mode'").run(); });
    const before = stable(fx.dataDir);
    const r = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /not_real_store/);
    unchanged(fx, before);
    await withDb(fx.file, async db => { await db.prepare("UPDATE settings SET value = '\"real\"' WHERE key = 'mode'").run(); });
    const ok = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(ok.code, 0, ok.stderr);
    await assertMigrated(fx);
  });
});

describe('abrupt termination and phase faults resume to the same end state (migration safety)', { concurrency: 2 }, () => {
  for (const mode of ['kill', 'throw']) {
    for (const phase of PHASES) {
      test(`${mode === 'kill' ? 'SIGKILL' : 'an exception'} at ${phase}, then a rerun, ends migrated with no duplicates`, T, async t => {
        const fx = await legacyFixture(t);
        const r = await migrateWithFault(fx.dataDir, fx.keyFile, phase, mode);
        if (mode === 'kill') assert.equal(r.code, null, `the child dies by SIGKILL at ${phase}: ${r.stdout}${r.stderr}`);
        else {
          assert.equal(r.code, 7, `the fault at ${phase} rejects migratePlatform: ${r.stdout}${r.stderr}`);
          assert.match(r.stderr, /synthetic phase fault/);
        }
        if (BEFORE_PUBLISH.includes(phase)) {
          assert.equal(existsSync(join(fx.dataDir, PLATFORM_FILE)), false, 'nothing is published before verify completes');
          const source = await sourceAuthRows(fx.file);
          for (const table of AUTH_TABLES) assert.deepEqual(source[table], fx.legacy[table], `${table} rows are intact`);
        }
        if (mode === 'kill' && phase !== 'preflight') {
          assert.ok(existsSync(join(fx.dataDir, LOCK_FILE)), 'the advisory lock survives the kill');
          const refused = await expectServerExit({ dataDir: fx.dataDir, env: REAL });
          assert.equal(refused.started, false, refused.output);
          assert.equal(refused.code, 1);
          assert.match(refused.output, /platform_migration_in_progress/);
        }
        const again = await migrateCli(fx.dataDir, fx.keyFile);
        assert.equal(again.code, 0, again.stderr);
        await assertMigrated(fx);
        if (phase === 'complete') {
          await migrateTenancyStore(fx.dataDir);
          const server = await startServer(t, fx.dataDir);
          const admin = await signIn(server.baseUrl, fx.admin.device, fx.admin.credentialId);
          assert.equal(admin.verify.status, 200, admin.verify.text);
          assert.equal((await admin.client.get('/api/scenario')).status, 200);
        }
      });
    }
  }
});

// ============================================================================================
// 2. Membership over HTTP
// ============================================================================================

describe('household membership on a real instance (AC1)', () => {
  let root;
  let dataDir;
  let server;
  let base;
  let platform;
  let store;
  let hh;
  let admin;
  let member;
  let operator;
  const as = person => sessionBrowser(base, person.token);
  const membership = async id => await store.membership(id, hh);
  const storeFile = async () => (await servedStore(dataDir)).file;

  before(async () => {
    root = await tempDir('fathom-mt01-members-');
    dataDir = join(root, 'data');
    ({ householdId: hh } = await freshInstance(dataDir, 'real'));
    server = await spawnServer({ dataDir, env: REAL });
    base = server.baseUrl;
    const m = await platformModules();
    platform = m.openPlatform(join(dataDir, PLATFORM_FILE));
    store = m.createAuthStore(platform);
    admin = await enrollMember(store, hh, 'admin@example.test', 'admin');
    member = await enrollMember(store, hh, 'member@example.test', 'member');
    // An operator whose membership was removed: the account stays because of the operator grant.
    operator = await enrollMember(store, hh, 'operator@example.test', 'member');
    const granted = await operatorCli(['grant', operator.email], dataDir);
    assert.equal(granted.code, 0, granted.stderr);
    const removed = await as(admin).post(`/api/admin/users/${operator.id}/remove`, {});
    assert.equal(removed.status, 200, removed.text);
    operator.token = (await store.createSession(operator.id)).token;
  }, T);

  after(async () => {
    await platform?.close();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test('identity carries the opaque household id, the role, the operator flag and only the caller\'s memberships', T, async () => {
    assert.equal(typeof hh, 'string');
    const r = await as(admin).get('/api/identity');
    assert.equal(r.status, 200);
    const email = admin.email;
    const identity = { id: admin.id, email, login: email, name: email, householdId: hh, role: 'admin', operator: false,
      memberships: [{ householdId: hh, role: 'admin', name: null }], contextVersion: 1 };
    assert.deepEqual(r.json, { identity });
    assert.deepEqual((await as(admin).get('/api/auth/session')).json, { identity, demo: false });
    const m = await as(member).get('/api/identity');
    assert.deepEqual(pick(m.json.identity, ['householdId', 'role', 'operator', 'memberships']),
      { householdId: hh, role: 'member', operator: false, memberships: [{ householdId: hh, role: 'member', name: null }] });
  });

  test('inviting an active member is refused 409; inviting a new address succeeds', T, async () => {
    const dup = await as(admin).post('/api/admin/users/invite', { email: member.email, role: 'member' });
    assert.equal(dup.status, 409, dup.text);
    await assert.rejects(async () => store.invite(hh, member.email), err => err.status === 409);
    assert.deepEqual(pick(await membership(member.id), ['role', 'status']), { role: 'member', status: 'active' });
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM household_invitations WHERE email = ?', member.email), 1, 'only the original, consumed invitation');
    const fresh = await as(admin).post('/api/admin/users/invite', { email: 'fresh-invite@example.test', role: 'member' });
    assert.equal(fresh.status, 200, fresh.text);
    assert.deepEqual(fresh.json, { sent: true });
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM household_invitations WHERE email = ? AND consumed_at IS NULL AND revoked_at IS NULL',
      'fresh-invite@example.test'), 1);
  });

  test('re-inviting revokes the old link (410) and the new link enrolls', T, async () => {
    const email = 'reinvited@example.test';
    const first = await store.invite(hh, email, { role: 'member' });
    const second = await store.invite(hh, email, { role: 'member' });
    assert.equal(await store.invitation(first.token), null, 'the first link is revoked');
    assert.equal((await store.invitation(second.token)).email, email);
    const old = await browser(base).post('/api/auth/register/options', { token: first.token, name: 'Synthetic device' });
    assert.equal(old.status, 410);
    assert.deepEqual(old.json, EXPIRED);
    const client = browser(base);
    const { options, verify } = await register(base, client, createAuthenticator(), { token: second.token });
    assert.equal(options.status, 200, options.text);
    assert.equal(verify.status, 200, verify.text);
    assert.deepEqual(pick(await membership(second.user.id), ['role', 'status']), { role: 'member', status: 'active' });
    assert.equal((await client.get('/api/scenario')).status, 200);
  });

  test('accepting needs the invited email, takes the role from the invitation only and is single use', T, async () => {
    const joiner = await enrollMember(store, hh, 'joiner@example.test', 'member');
    await store.grantOperator(joiner.id);
    assert.equal((await as(admin).post(`/api/admin/users/${joiner.id}/remove`, {})).status, 200);
    assert.equal((await membership(joiner.id)).status, 'removed');
    const joinerSession = (await store.createSession(joiner.id)).token;
    const invitation = await store.invite(hh, joiner.email, { role: 'member' });
    assert.equal(invitation.user.id, joiner.id, 'the invitation targets the existing account');

    const wrong = await as(member).post('/api/auth/invitations/accept', { token: invitation.token });
    assert.equal(wrong.status, 403, wrong.text);
    assert.equal((await membership(joiner.id)).status, 'removed', 'no membership is created for a mismatched email');
    assert.deepEqual(pick(await membership(member.id), ['role', 'status']), { role: 'member', status: 'active' });
    assert.notEqual(await store.invitation(invitation.token), null, 'a refused accept leaves the invitation live');

    const accepted = await sessionBrowser(base, joinerSession).post('/api/auth/invitations/accept', { token: invitation.token, role: 'admin' });
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual(accepted.json.identity.memberships, [{ householdId: hh, role: 'member', name: null }]);
    assert.deepEqual(pick(await membership(joiner.id), ['role', 'status']), { role: 'member', status: 'active' }, 'a body role is ignored');
    assert.equal((await sessionBrowser(base, joinerSession).get('/api/scenario')).status, 200);

    const replay = await sessionBrowser(base, joinerSession).post('/api/auth/invitations/accept', { token: invitation.token });
    assert.equal(replay.status, 410);
    assert.deepEqual(replay.json, EXPIRED);
    const unknown = await sessionBrowser(base, joinerSession).post('/api/auth/invitations/accept', { token: randomBytes(32).toString('base64url') });
    assert.equal(unknown.status, 410);
    assert.equal((await browser(base).post('/api/auth/invitations/accept', { token: invitation.token })).status, 401, 'a session is required');
  });

  test('a member cannot invite or change any role (403); an admin can', T, async () => {
    const m = as(member);
    const invite = await m.post('/api/admin/users/invite', { email: 'by-member@example.test', role: 'admin' });
    assert.equal(invite.status, 403);
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM household_invitations WHERE email = ?', 'by-member@example.test'), 0);
    assert.equal((await m.post(`/api/admin/users/${member.id}/role`, { role: 'admin' })).status, 403, 'no self escalation');
    assert.equal((await m.post(`/api/admin/users/${admin.id}/role`, { role: 'member' })).status, 403);
    assert.equal((await membership(member.id)).role, 'member');
    assert.equal((await membership(admin.id)).role, 'admin');

    const target = await enrollMember(store, hh, 'role-liveness@example.test', 'member');
    const before = (await membership(target.id)).version;
    const promoted = await as(admin).post(`/api/admin/users/${target.id}/role`, { role: 'admin' });
    assert.equal(promoted.status, 200, promoted.text);
    assert.equal((await membership(target.id)).role, 'admin');
    assert.ok((await membership(target.id)).version > before, 'a role change bumps the membership version');
    assert.equal((await as(admin).post(`/api/admin/users/${target.id}/role`, { role: 'member' })).status, 200, 'a non-last admin can be demoted');
    assert.equal((await as(admin).post(`/api/admin/users/${target.id}/remove`, {})).status, 200);
  });

  test('the last admin cannot be demoted or removed (409)', T, async () => {
    assert.equal(await count(platform, "SELECT count(*) AS n FROM household_memberships WHERE household_id = ? AND role = 'admin' AND status = 'active'", hh), 1);
    const demote = await as(admin).post(`/api/admin/users/${admin.id}/role`, { role: 'member' });
    assert.equal(demote.status, 409, demote.text);
    const remove = await as(admin).post(`/api/admin/users/${admin.id}/remove`, {});
    assert.equal(remove.status, 409, remove.text);
    await assert.rejects(async () => await store.setRole(hh, admin.id, 'member'), err => err.status === 409);
    await assert.rejects(async () => await store.removeMember(hh, admin.id), err => err.status === 409);
    assert.deepEqual(pick(await membership(admin.id), ['role', 'status']), { role: 'admin', status: 'active' });
    assert.equal((await as(admin).get('/api/scenario')).status, 200);
  });

  test('an operator without membership gets 403 on financial routes and sees no household', T, async () => {
    const o = as(operator);
    const who = await o.get('/api/identity');
    assert.equal(who.status, 200);
    const email = operator.email;
    assert.deepEqual(who.json.identity, { id: operator.id, email, login: email, name: email, householdId: null, role: null,
      operator: true, memberships: [], contextVersion: 1 });
    for (const path of ['/api/scenario', '/api/keys', '/api/files', '/api/threads', '/api/pace']) {
      const r = await o.get(path);
      assert.equal(r.status, 403, path);
      assert.deepEqual(r.json, MEMBERSHIP_REQUIRED, path);
    }
    const keysBefore = await count(platform, 'SELECT count(*) AS n FROM api_keys');
    const key = await o.post('/api/keys', { name: 'Operator agent' });
    assert.equal(key.status, 403);
    assert.deepEqual(key.json, MEMBERSHIP_REQUIRED);
    const boundary = 'synthetic-operator-upload';
    const upload = await o.raw({ method: 'POST', path: '/api/files', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic.csv"\r\nContent-Type: text/csv\r\n\r\nDate,Amount\r\n2026-01-02,-1.00\r\n--${boundary}--\r\n` });
    assert.equal(upload.status, 403);
    assert.deepEqual(upload.json, MEMBERSHIP_REQUIRED);
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM api_keys'), keysBefore);
    assert.equal(await withDb(await storeFile(), async db => await count(db, 'SELECT count(*) AS n FROM files')), 0);
    for (const path of ['/api/scenario', '/api/keys', '/api/files']) assert.equal((await as(admin).get(path)).status, 200, `admin ${path}`);
  });

  test('an admin cannot list, re-role, remove or revoke passkeys of a user outside the household (404)', T, async () => {
    const pk = await insertPasskey(platform, operator.id);
    const before = {
      passkeys: await count(platform, 'SELECT count(*) AS n FROM passkeys WHERE user_id = ?', operator.id),
      sessions: await count(platform, 'SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?', operator.id),
    };
    const list = await as(admin).get('/api/admin/users');
    assert.equal(list.status, 200);
    const ids = list.json.users.map(u => u.id);
    assert.ok(ids.includes(admin.id) && ids.includes(member.id));
    assert.ok(!ids.includes(operator.id), 'a removed member is not listed');
    for (const [path, body] of [[`/api/admin/users/${operator.id}/role`, { role: 'member' }], [`/api/admin/users/${operator.id}/remove`, {}],
      [`/api/admin/users/${operator.id}/passkeys/${pk}/revoke`, {}]]) {
      const r = await as(admin).post(path, body);
      assert.equal(r.status, 404, path);
    }
    assert.deepEqual({
      passkeys: await count(platform, 'SELECT count(*) AS n FROM passkeys WHERE user_id = ?', operator.id),
      sessions: await count(platform, 'SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?', operator.id),
    }, before, 'the outsider keeps passkeys and sessions');
    assert.equal(await store.isOperator(operator.id), true);
    assert.equal((await as(operator).get('/api/identity')).status, 200);

    const target = await enrollMember(store, hh, 'passkey-target@example.test', 'member');
    const tpk = await insertPasskey(platform, target.id);
    const revoked = await as(admin).post(`/api/admin/users/${target.id}/passkeys/${tpk}/revoke`, {});
    assert.equal(revoked.status, 200, revoked.text);
    assert.deepEqual(revoked.json.passkeys, []);
  });

  test('the admin user list includes pending invitees with the invitation role', T, async () => {
    await store.invite(hh, 'pending-admin@example.test', { role: 'admin' });
    const list = await as(admin).get('/api/admin/users');
    const pending = list.json.users.find(u => u.email === 'pending-admin@example.test');
    assert.ok(pending, 'the pending invitee is listed');
    assert.deepEqual(pick(pending, ['role', 'enrolledAt']), { role: 'admin', enrolledAt: null });
  });

  test('removing a member revokes their sessions and MCP keys and deletes the account', T, async () => {
    const leaver = await enrollMember(store, hh, 'leaver@example.test', 'member');
    const created = await as(leaver).post('/api/keys', { name: 'Leaver agent' });
    assert.equal(created.status, 200, created.text);
    const adminKey = (await as(admin).post('/api/keys', { name: 'Admin agent' })).json.key;
    assert.equal((await mcpList(base, created.json.key)).status, 200);
    const removed = await as(admin).post(`/api/admin/users/${leaver.id}/remove`, {});
    assert.equal(removed.status, 200, removed.text);
    assert.equal((await as(leaver).get('/api/scenario')).status, 401, 'the session is revoked');
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?', leaver.id), 0);
    assert.equal((await mcpList(base, created.json.key)).status, 401, 'the MCP key no longer authenticates');
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM api_keys WHERE user_id = ?', leaver.id), 0, 'the key row is deleted');
    assert.equal(await store.getUser(leaver.id), null, 'no membership and no operator grant: the account is deleted');
    assert.equal((await mcpList(base, adminKey)).status, 200, 'other keys keep working');
  });

  test('an MCP key whose creator is no longer an active member is refused even if its row remains', T, async () => {
    const holder = await enrollMember(store, hh, 'key-holder@example.test', 'member');
    const created = await as(holder).post('/api/keys', { name: 'Holder agent' });
    assert.equal(created.status, 200, created.text);
    assert.equal((await mcpList(base, created.json.key)).status, 200);
    await platform.prepare("UPDATE household_memberships SET status = 'removed' WHERE user_id = ? AND household_id = ?").run(holder.id, hh);
    assert.equal((await mcpList(base, created.json.key)).status, 401);
    await platform.prepare("UPDATE household_memberships SET status = 'active' WHERE user_id = ? AND household_id = ?").run(holder.id, hh);
    assert.equal((await mcpList(base, created.json.key)).status, 200);
  });
});

// A pending invitation is not household presence: an admin's credential actions need an active
// membership of the target. Admin actions over HTTP and every passkey revocation are audited with
// ids only. Own instance so the per-household invitation limit of the suite above is not shared.
describe('admin credential scoping and audit attribution (AC1)', () => {
  let root;
  let dataDir;
  let server;
  let base;
  let platform;
  let store;
  let hh;
  let admin;
  const secrets = [];
  const as = person => sessionBrowser(base, person.token);
  const passkeysOf = async id => await count(platform, 'SELECT count(*) AS n FROM passkeys WHERE user_id = ?', id);
  const sessionsOf = async id => await count(platform, 'SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?', id);
  const openInvitations = async id => await count(platform,
    'SELECT count(*) AS n FROM household_invitations WHERE user_id = ? AND household_id = ? AND consumed_at IS NULL AND revoked_at IS NULL', id, hh);
  const lastAuditId = async () => (await platform.prepare('SELECT coalesce(max(id), 0) AS n FROM audit_events').get()).n;
  const auditSince = async id => (await platform.prepare('SELECT * FROM audit_events WHERE id > ? ORDER BY id').all(id)).map(r => ({ ...r }));
  const AUDIT_COLUMNS = ['action', 'actor_user_id', 'at', 'household_id', 'id', 'outcome', 'target_user_id'];
  const enroll = async (email, role = 'member') => {
    const person = await enrollMember(store, hh, email, role);
    secrets.push(email, person.token);
    return person;
  };

  // Every column of every row is an id, a fixed action string, a fixed outcome or a timestamp.
  function assertIdsOnly(list, userIds, start) {
    for (const row of list) {
      assert.deepEqual(Object.keys(row).sort(), AUDIT_COLUMNS, 'audit rows have only the fixed columns');
      assert.ok(Number.isInteger(row.id), 'id is a row id');
      assert.ok(Number.isInteger(row.at) && row.at >= start - 1000 && row.at <= Date.now() + 1000, 'at is a timestamp');
      for (const k of ['actor_user_id', 'target_user_id']) assert.ok(row[k] === null || userIds.includes(row[k]), `${k} is a user id`);
      assert.ok(row.household_id === null || row.household_id === hh, 'household_id is the household id');
      assert.match(row.action, /^[a-z]+(?:\.[a-z_-]+)+$/, 'action is a fixed action string');
      assert.match(row.outcome, /^[a-z_]{1,32}$/, 'outcome is a fixed outcome');
      for (const value of Object.values(row)) {
        const text = String(value);
        assert.ok(!text.includes('@'), 'no email in an audit row');
        for (const s of secrets) assert.ok(!text.includes(s), 'no email, token or name in an audit row');
      }
    }
  }
  const only = (list, action) => {
    const hits = list.filter(r => r.action === action);
    assert.equal(hits.length, 1, `exactly one ${action} row: ${JSON.stringify(list.map(r => r.action))}`);
    return hits[0];
  };

  before(async () => {
    root = await tempDir('fathom-mt01-scope-');
    dataDir = join(root, 'data');
    ({ householdId: hh } = await freshInstance(dataDir, 'real'));
    server = await spawnServer({ dataDir, env: REAL });
    base = server.baseUrl;
    const m = await platformModules();
    platform = m.openPlatform(join(dataDir, PLATFORM_FILE));
    store = m.createAuthStore(platform);
    admin = await enroll('scope-admin@example.test', 'admin');
  }, T);

  after(async () => {
    await platform?.close();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test('a pending invitation (live or expired) gives an admin no hold on an enrolled outsider\'s passkeys or sessions', T, async () => {
    // An enrolled operator who has never been a member of the household.
    const email = 'scope-outsider@example.test';
    const outsider = { id: `usr-${randomBytes(6).toString('hex')}`, email };
    await platform.prepare('INSERT INTO users (id, email, user_handle, created_at, enrolled_at) VALUES (?, ?, ?, ?, ?)')
      .run(outsider.id, email, randomBytes(32).toString('base64url'), Date.now() - 60_000, Date.now() - 60_000);
    await store.grantOperator(outsider.id);
    outsider.token = (await store.createSession(outsider.id)).token;
    const pk = await insertPasskey(platform, outsider.id);
    secrets.push(email, outsider.token, pk);
    const held = async () => ({ passkeys: await passkeysOf(outsider.id), sessions: await sessionsOf(outsider.id) });
    const kept = await held();
    assert.deepEqual(kept, { passkeys: 1, sessions: 1 });
    assert.equal(await store.membership(outsider.id, hh), null, 'no membership row in the household');

    for (const state of ['live', 'expired']) {
      const invited = await as(admin).post('/api/admin/users/invite', { email, role: 'member' });
      assert.equal(invited.status, 200, `${state}: ${invited.text}`);
      assert.equal(await openInvitations(outsider.id), 1, `${state}: one open invitation`);
      if (state === 'expired') {
        await platform.prepare('UPDATE household_invitations SET expires_at = ? WHERE user_id = ? AND household_id = ? AND consumed_at IS NULL AND revoked_at IS NULL')
          .run(Date.now() - 1000, outsider.id, hh);
      }

      const list = await as(admin).get('/api/admin/users');
      assert.equal(list.status, 200, list.text);
      const listed = list.json.users.find(u => u.id === outsider.id);
      assert.ok(listed, `${state}: the pending invitee is listed`);
      assert.equal(listed.role, 'member', `${state}: with the invitation role`);
      assert.deepEqual(listed.passkeys, [], `${state}: without the outsider's passkeys`);
      assert.ok(!list.text.includes(pk), `${state}: the outsider's credential id is not in the response`);

      const revoke = await as(admin).post(`/api/admin/users/${outsider.id}/passkeys/${pk}/revoke`, {});
      assert.equal(revoke.status, 404, `${state}: ${revoke.text}`);
      assert.deepEqual(await held(), kept, `${state}: passkeys and sessions unchanged by the refused revocation`);
      assert.equal((await as(outsider).get('/api/identity')).status, 200, `${state}: the outsider's session still works`);

      const removed = await as(admin).post(`/api/admin/users/${outsider.id}/remove`, {});
      assert.equal(removed.status, 200, `${state}: ${removed.text}`);
      assert.equal(await openInvitations(outsider.id), 0, `${state}: the invitation is revoked`);
      assert.notEqual(await store.getUser(outsider.id), null, `${state}: the account is kept`);
      assert.equal(await store.isOperator(outsider.id), true, `${state}: the operator grant is kept`);
      assert.deepEqual(await held(), kept, `${state}: removing the invitee leaves passkeys and global sessions untouched`);
      assert.equal(await store.membership(outsider.id, hh), null, `${state}: no membership is created`);
      const who = await as(outsider).get('/api/identity');
      assert.equal(who.status, 200, `${state}: the outsider is still signed in`);
      assert.equal(who.json.identity.operator, true);
      assert.ok(!(await as(admin).get('/api/admin/users')).json.users.some(u => u.id === outsider.id), `${state}: no longer listed`);
    }
  });

  test('removing a pending invitee who never enrolled revokes the invitation and deletes the new account', T, async () => {
    const email = 'scope-new-invitee@example.test';
    secrets.push(email);
    const invited = await as(admin).post('/api/admin/users/invite', { email, role: 'member' });
    assert.equal(invited.status, 200, invited.text);
    const user = await store.findUser(email);
    assert.ok(user && user.enrolledAt === null, 'a new, never-enrolled account');
    assert.equal(await openInvitations(user.id), 1);
    const listed = (await as(admin).get('/api/admin/users')).json.users.find(u => u.id === user.id);
    assert.deepEqual(pick(listed, ['role', 'enrolledAt', 'passkeys']), { role: 'member', enrolledAt: null, passkeys: [] });
    const removed = await as(admin).post(`/api/admin/users/${user.id}/remove`, {});
    assert.equal(removed.status, 200, removed.text);
    assert.equal(await store.getUser(user.id), null, 'the never-enrolled account is deleted');
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM household_invitations WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL', user.id), 0);
  });

  test('an admin lists and revokes an active member\'s passkeys; the revocation is audited with ids only', T, async () => {
    const start = Date.now();
    const member = await enroll('scope-member@example.test');
    const pk = await insertPasskey(platform, member.id);
    secrets.push(pk);
    const list = await as(admin).get('/api/admin/users');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.users.find(u => u.id === member.id).passkeys.map(p => p.id), [pk], 'an active member\'s passkeys are listed');

    const mark = await lastAuditId();
    const revoked = await as(admin).post(`/api/admin/users/${member.id}/passkeys/${pk}/revoke`, {});
    assert.equal(revoked.status, 200, revoked.text);
    assert.deepEqual(revoked.json.passkeys, []);
    assert.equal(await passkeysOf(member.id), 0);
    assert.equal(await sessionsOf(member.id), 0, 'the member\'s sessions are revoked with the passkey');
    const rowsNow = await auditSince(mark);
    assertIdsOnly(rowsNow, [admin.id, member.id], start);
    assert.deepEqual(pick(only(rowsNow, 'passkey.revoke'), ['actor_user_id', 'target_user_id', 'household_id', 'outcome']),
      { actor_user_id: admin.id, target_user_id: member.id, household_id: hh, outcome: 'ok' });
  });

  test('a user revoking their own passkey writes a passkey.revoke audit row with ids only', T, async () => {
    const start = Date.now();
    const user = await enroll('scope-self@example.test');
    const [keep, drop] = [await insertPasskey(platform, user.id), await insertPasskey(platform, user.id)];
    secrets.push(keep, drop);
    const mark = await lastAuditId();
    const revoked = await as(user).post(`/api/auth/passkeys/${drop}/revoke`, {});
    assert.equal(revoked.status, 200, revoked.text);
    assert.deepEqual(revoked.json.passkeys.map(p => p.id), [keep]);
    const rowsNow = await auditSince(mark);
    assertIdsOnly(rowsNow, [user.id], start);
    const row = only(rowsNow, 'passkey.revoke');
    assert.deepEqual(pick(row, ['actor_user_id', 'target_user_id', 'outcome']), { actor_user_id: user.id, target_user_id: user.id, outcome: 'ok' });
    // A passkey is global; the household is the session's household or none.
    assert.ok(row.household_id === hh || row.household_id === null, 'household_id is the session household or null');
  });

  test('role changes and member removals over HTTP record the acting admin, with ids only', T, async () => {
    const start = Date.now();
    const target = await enroll('scope-role@example.test');
    const leaver = await enroll('scope-leaver@example.test');

    let mark = await lastAuditId();
    const promoted = await as(admin).post(`/api/admin/users/${target.id}/role`, { role: 'admin' });
    assert.equal(promoted.status, 200, promoted.text);
    let rowsNow = await auditSince(mark);
    assertIdsOnly(rowsNow, [admin.id, target.id], start);
    assert.deepEqual(pick(only(rowsNow, 'membership.role'), ['actor_user_id', 'target_user_id', 'household_id', 'outcome']),
      { actor_user_id: admin.id, target_user_id: target.id, household_id: hh, outcome: 'ok' });

    mark = await lastAuditId();
    const removed = await as(admin).post(`/api/admin/users/${leaver.id}/remove`, {});
    assert.equal(removed.status, 200, removed.text);
    rowsNow = await auditSince(mark);
    assertIdsOnly(rowsNow, [admin.id, leaver.id], start);
    assert.deepEqual(pick(only(rowsNow, 'membership.remove'), ['actor_user_id', 'target_user_id', 'household_id', 'outcome']),
      { actor_user_id: admin.id, target_user_id: leaver.id, household_id: hh, outcome: 'ok' });
    assert.equal(await store.getUser(leaver.id), null, 'liveness: the removal itself still happens');
  });
});

describe('instance operators (AC1)', () => {
  test('operator.mjs grants enrolled users only and refuses revoking the last operator (409)', T, async t => {
    const root = await scratch(t);
    const dataDir = join(root, 'data');
    const { householdId: hh } = await freshInstance(dataDir, 'real');
    const m = await platformModules();
    const platform = m.openPlatform(join(dataDir, PLATFORM_FILE));
    t.after(async () => await platform.close());
    const store = m.createAuthStore(platform);
    const first = await enrollMember(store, hh, 'first-operator@example.test', 'admin');
    const second = await enrollMember(store, hh, 'second-operator@example.test', 'member');
    await store.invite(hh, 'pending-operator@example.test', { role: 'member' });

    const pending = await operatorCli(['grant', 'pending-operator@example.test'], dataDir);
    assert.equal(pending.code, 1, 'a pending user cannot be an operator');
    assert.ok(!pending.stderr.includes('pending-operator@example.test'));
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM instance_operators'), 0);

    const audits = await count(platform, 'SELECT count(*) AS n FROM audit_events');
    const granted = await operatorCli(['grant', first.email], dataDir);
    assert.equal(granted.code, 0, granted.stderr);
    assert.equal(await store.isOperator(first.id), true);
    assert.ok(await count(platform, 'SELECT count(*) AS n FROM audit_events') > audits, 'the grant is audited');

    const last = await operatorCli(['revoke', first.email], dataDir);
    assert.equal(last.code, 1, last.stderr);
    assert.ok(!last.stderr.includes(first.email));
    assert.equal(await store.isOperator(first.id), true);
    await assert.rejects(async () => await store.revokeOperator(first.id), err => err.status === 409);

    assert.equal((await operatorCli(['grant', second.email], dataDir)).code, 0);
    const revoked = await operatorCli(['revoke', first.email], dataDir);
    assert.equal(revoked.code, 0, revoked.stderr);
    assert.equal(await store.isOperator(first.id), false);
    assert.equal(await store.isOperator(second.id), true);
  });
});

// ============================================================================================
// 3. Multi-household gate
// ============================================================================================

describe('second-household provisioning gate (AC3)', () => {
  let root;
  let dataDir;
  let server;
  let base;
  let platform;
  let store;
  let hh;
  let admin;
  let member;
  let operator;
  const as = person => sessionBrowser(base, person.token);
  const households = async () => await count(platform, 'SELECT count(*) AS n FROM households');
  const provision = (person, adminEmail) => as(person).post('/api/operator/households', { displayName: 'Synthetic Second Household', adminEmail });

  before(async () => {
    root = await tempDir('fathom-mt01-gate-');
    dataDir = join(root, 'data');
    ({ householdId: hh } = await freshInstance(dataDir, 'real'));
    server = await spawnServer({ dataDir, env: REAL });
    base = server.baseUrl;
    const m = await platformModules();
    platform = m.openPlatform(join(dataDir, PLATFORM_FILE));
    store = m.createAuthStore(platform);
    admin = await enrollMember(store, hh, 'gate-admin@example.test', 'admin');
    member = await enrollMember(store, hh, 'gate-member@example.test', 'member');
    operator = await enrollMember(store, hh, 'gate-operator@example.test', 'member');
    const granted = await operatorCli(['grant', operator.email], dataDir);
    assert.equal(granted.code, 0, granted.stderr);
  }, T);

  after(async () => {
    await platform?.close();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test('non-operators get 403 and nothing is provisioned', T, async () => {
    for (const person of [admin, member]) {
      const r = await provision(person, 'not-provisioned@example.test');
      assert.equal(r.status, 403, r.text);
    }
    assert.equal(await households(), 1);
  });

  test('an explicit disabled gate refuses provisioning; enabling it provisions; a provisioning household still counts', T, async () => {
    assert.equal(await store.getPlatformSetting('multi_household_enabled', false), true, 'release migration enables provisioning');
    await store.setPlatformSetting('multi_household_enabled', false);
    assert.equal(await store.getPlatformSetting('multi_household_enabled', false), false, 'the gate defaults to off');
    const gated = await provision(operator, 'second-admin@example.test');
    assert.equal(gated.status, 409, gated.text);
    assert.equal(gated.json.code, 'multi_household_gated');
    assert.equal(typeof gated.json.error, 'string');
    assert.equal(await households(), 1);
    assert.equal(await count(platform, 'SELECT count(*) AS n FROM household_invitations WHERE email = ?', 'second-admin@example.test'), 0);

    await store.setPlatformSetting('multi_household_enabled', true);
    const made = await provision(operator, 'second-admin@example.test');
    assert.equal(made.status, 200, made.text);
    assert.equal(made.json.household.status, 'provisioning');
    assert.equal(typeof made.json.household.id, 'string');
    assert.notEqual(made.json.household.id, hh);
    const row = await platform.prepare('SELECT * FROM households WHERE id = ?').get(made.json.household.id);
    assert.deepEqual(pick(row, ['status', 'mode', 'serves_store']), { status: 'provisioning', mode: 'real', serves_store: 0 });
    const invitation = await platform.prepare('SELECT * FROM household_invitations WHERE email = ?').get('second-admin@example.test');
    assert.deepEqual(pick(invitation, ['household_id', 'role']), { household_id: made.json.household.id, role: 'admin' });
    assert.equal((await as(admin).get('/api/identity')).json.identity.householdId, hh, 'the served household is unchanged');

    await store.setPlatformSetting('multi_household_enabled', false);
    const third = await provision(operator, 'third-admin@example.test');
    assert.equal(third.status, 409, third.text);
    assert.equal(third.json.code, 'multi_household_gated');
    assert.equal(await households(), 2);
  });

  test('store level: a sole provisioning real household blocks another; deleted households do not count', T, async t => {
    const dir = join(await scratch(t), 'data');
    const { householdId } = await freshInstance(dir, 'real');
    const m = await platformModules();
    const p = m.openPlatform(join(dir, PLATFORM_FILE));
    t.after(() => p.close());
    const s = m.createAuthStore(p);
    await s.setPlatformSetting('multi_household_enabled', false);
    const op = await enrollMember(s, householdId, 'store-operator@example.test', 'admin');
    await s.grantOperator(op.id);
    await p.prepare("UPDATE households SET status = 'provisioning' WHERE id = ?").run(householdId);
    const request = async email => await s.provisionHousehold({ displayName: 'Synthetic Other Household', adminEmail: email }, { actorId: op.id });
    const gated = err => err.status === 409 && err.code === 'multi_household_gated';
    await assert.rejects(async () => await request('blocked-admin@example.test'), gated);
    assert.equal(await count(p, 'SELECT count(*) AS n FROM households'), 1);

    await p.prepare("UPDATE households SET status = 'deleted' WHERE id = ?").run(householdId);
    const made = await request('allowed-admin@example.test');
    assert.equal(made.household.status, 'provisioning');
    assert.equal(typeof made.token, 'string');
    assert.equal(await count(p, "SELECT count(*) AS n FROM households WHERE status != 'deleted' AND mode = 'real'"), 1);
    await assert.rejects(async () => await request('blocked-again@example.test'), gated, 'the new provisioning household counts');
  });

  test('store level: demo households are exempt from the gate', T, async t => {
    const dir = join(await scratch(t), 'data');
    const { householdId } = await freshInstance(dir, 'demo');
    const m = await platformModules();
    const p = m.openPlatform(join(dir, PLATFORM_FILE));
    t.after(() => p.close());
    const s = m.createAuthStore(p);
    await s.setPlatformSetting('multi_household_enabled', false);
    assert.equal(await s.getPlatformSetting('multi_household_enabled', false), false);
    const op = await enrollMember(s, householdId, 'demo-operator@example.test', 'admin');
    await s.grantOperator(op.id);
    for (const email of ['demo-second@example.test', 'demo-third@example.test']) {
      const made = await s.provisionHousehold({ displayName: 'Synthetic Demo Household', adminEmail: email }, { actorId: op.id });
      assert.equal(made.household.status, 'provisioning');
    }
    assert.equal(await count(p, 'SELECT count(*) AS n FROM households'), 3);
  });
});

// ============================================================================================
// Startup with a platform
// ============================================================================================

describe('startup with a platform database (AC3)', () => {
  test('a fresh real data directory creates the platform and a store bound to its household', T, async t => {
    const dataDir = join(await scratch(t), 'data');
    await startServer(t, dataDir);
    const platformFile = join(dataDir, PLATFORM_FILE);
    assert.ok(existsSync(platformFile));
    const list = await withDb(platformFile, async db => await rows(db, 'households'));
    assert.equal(list.length, 1);
    assert.deepEqual(pick(list[0], ['status', 'mode', 'serves_store']), { status: 'active', mode: 'real', serves_store: 1 });
    const storeFile = (await servedStore(dataDir)).file;
    assert.equal((await withDb(storeFile, async db => await rows(db, 'store_identity')))[0].household_id, list[0].id);
    for (const table of AUTH_TABLES) assert.ok(!(await tableNames(storeFile)).includes(table), table);
  });

  test('a fresh demo creates its synthetic platform automatically and stays open', T, async t => {
    const dataDir = join(await scratch(t), 'data');
    const server = await startServer(t, dataDir, { FATHOM_ENGINE: 'fake' });
    const list = await withDb(join(dataDir, PLATFORM_FILE), async db => await rows(db, 'households'));
    assert.equal(list.length, 1);
    assert.equal(list[0].mode, 'demo');
    assert.equal((await browser(server.baseUrl).get('/api/scenario')).status, 200);
  });

  test('a store bound to another household is refused household_store_mismatch and never served', T, async t => {
    // Since MT-03 one household's bad store makes only that household's runtime unavailable (logged
    // by code); the instance itself still starts for the others.
    const dataDir = join(await scratch(t), 'data');
    await freshInstance(dataDir, 'real');
    await withDb((await servedStore(dataDir)).file, async db => { await db.prepare("UPDATE store_identity SET household_id = 'hh-synthetic-other'").run(); });
    const r = await expectServerExit({ dataDir, env: REAL });
    assert.equal(r.started, true, r.output);
    assert.match(r.output, /household runtime unavailable household_store_mismatch/);
  });

  test('a migration lock file refuses platform_migration_in_progress; without it the instance starts', T, async t => {
    const dataDir = join(await scratch(t), 'data');
    await freshInstance(dataDir, 'real');
    writeFileSync(join(dataDir, LOCK_FILE), JSON.stringify({ operationId: 'op-synthetic' }));
    const r = await expectServerExit({ dataDir, env: REAL });
    assert.equal(r.started, false, r.output);
    assert.equal(r.code, 1);
    assert.match(r.output, /platform_migration_in_progress/);
    rmSync(join(dataDir, LOCK_FILE));
    await startServer(t, dataDir);
  });
});

// ============================================================================================
// 4. Source snapshot helper and rollback
// ============================================================================================

describe('offline source snapshot helper (AC3)', () => {
  let root;
  let fx;
  let snapshot;
  // keyFile: a path, or null to leave FATHOM_BACKUP_KEY_FILE unset; omitted means the right key.
  const restore = (file, out, ...key) => snapshotCli(['restore', '--snapshot', file, '--out', out],
    { FATHOM_BACKUP_KEY_FILE: key.length ? (key[0] ?? undefined) : fx.keyFile });

  before(async () => {
    root = await tempDir('fathom-mt01-snap-');
    fx = await buildLegacyStore(join(root, 'data'));
    fx.keyFile = writeBackupKey(join(root, 'keys'));
    const out = join(root, 'snapshots');
    mkdirSync(out);
    const r = await snapshotCli(['create', '--out', out], { FATHOM_DATA: fx.dataDir, FATHOM_BACKUP_KEY_FILE: fx.keyFile });
    assert.equal(r.code, 0, r.stderr);
    noSecrets(r.stdout + r.stderr, fx, 'create output');
    const made = snapshotsIn(out);
    assert.equal(made.length, 1, `one snapshot file: ${made}`);
    snapshot = join(out, made[0]);
  }, T);
  after(() => rmSync(root, { recursive: true, force: true }));

  test('create encrypts the stopped source and restore round-trips it into a fresh directory', T, async () => {
    const bytes = readFileSync(snapshot);
    assert.ok(bytes.subarray(0, MAGIC.length).equals(MAGIC));
    assert.equal(bytes.indexOf('SQLite format 3'), -1, 'not plaintext SQLite');
    noSecrets(bytes.toString('latin1'), fx, 'the ciphertext');
    assert.deepEqual(await dump(fx.file), fx.preDump, 'the source is unchanged');
    const out = join(root, 'restored');
    const r = await restore(snapshot, out);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await dump(join(out, 'fathom.sqlite')), fx.preDump);
    assert.equal(readFileSync(join(out, 'api-key-secret'), 'utf8').trim(), fx.secretHex);
  });

  test('a wrong key refuses and writes nothing', T, async () => {
    const other = writeBackupKey(join(root, 'keys'), { name: 'other.key' });
    const out = join(root, 'wrong-key');
    const r = await restore(snapshot, out, other);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(existsSync(out), false);
  });

  test('a tampered byte anywhere refuses and writes nothing', T, async () => {
    const size = statSync(snapshot).size;
    for (const [label, at] of [['header', 3], ['body', Math.floor(size / 2)], ['tag', size - 1]]) {
      const copy = join(root, `tampered-${label}.fsnap`);
      copyFileSync(snapshot, copy);
      const bytes = readFileSync(copy);
      bytes[at] ^= 0x01;
      writeFileSync(copy, bytes);
      const out = join(root, `tampered-${label}-out`);
      const r = await restore(copy, out);
      assert.equal(r.code, 1, `${label}: ${r.stderr}`);
      assert.equal(existsSync(out), false, label);
    }
  });

  test('a missing key file refuses backup_key_invalid for create and restore', T, async () => {
    const absent = join(root, 'keys', 'absent.key');
    for (const keyFile of [null, absent]) {
      const dir = join(root, `create-missing-${keyFile ? 'path' : 'unset'}`);
      mkdirSync(dir);
      const c = await snapshotCli(['create', '--out', dir], { FATHOM_DATA: fx.dataDir, FATHOM_BACKUP_KEY_FILE: keyFile ?? undefined });
      assert.equal(c.code, 1, c.stderr);
      assert.match(c.stderr, /backup_key_invalid/);
      assert.deepEqual(readdirSync(dir), []);
      const out = join(root, `restore-missing-${keyFile ? 'path' : 'unset'}`);
      const r = await restore(snapshot, out, keyFile);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /backup_key_invalid/);
      assert.equal(existsSync(out), false);
    }
  });

  test('a group- or world-readable key refuses backup_key_invalid', T, async () => {
    for (const mode of [0o644, 0o640]) {
      const loose = writeBackupKey(join(root, 'keys'), { mode, name: `loose-${mode.toString(8)}.key` });
      writeFileSync(loose, readFileSync(fx.keyFile));
      const dir = join(root, `create-loose-${mode.toString(8)}`);
      mkdirSync(dir);
      const c = await snapshotCli(['create', '--out', dir], { FATHOM_DATA: fx.dataDir, FATHOM_BACKUP_KEY_FILE: loose });
      assert.equal(c.code, 1, c.stderr);
      assert.match(c.stderr, /backup_key_invalid/);
      assert.deepEqual(readdirSync(dir), []);
      const out = join(root, `restore-loose-${mode.toString(8)}`);
      const r = await restore(snapshot, out, loose);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /backup_key_invalid/);
      assert.equal(existsSync(out), false);
    }
  });

  test('restore into an existing directory refuses and leaves it as it was', T, async () => {
    const out = join(root, 'existing');
    mkdirSync(out);
    const r = await restore(snapshot, out);
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(readdirSync(out), []);
  });
});

describe('rollback from the migration snapshot (migration safety)', () => {
  test('rollback builds a new data directory: the snapshot store and secret plus every retained file byte for byte', T, async t => {
    const fx = await legacyFixture(t, { files: true });
    const migrated = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(migrated.code, 0, migrated.stderr);
    const { snapshot } = await assertMigrated(fx);
    const retained = stable(fx.dataDir);
    const out = join(fx.root, 'rolled-back');
    const r = await snapshotCli(['rollback', '--snapshot', snapshot, '--from', fx.dataDir, '--out', out], { FATHOM_BACKUP_KEY_FILE: fx.keyFile });
    assert.equal(r.code, 0, r.stderr);
    const names = readdirSync(out, { recursive: true });
    for (const name of names) {
      assert.doesNotMatch(name, /^platform\.sqlite|^platform-migration\.|\.fsnap$|fathom\.sqlite-(wal|shm)$/, `${name} is not carried over`);
    }
    for (const [rel, bytes] of Object.entries(fx.extraFiles)) {
      assert.ok(readFileSync(join(out, rel)).equals(bytes), `${rel} is byte-identical`);
    }
    assert.equal(readFileSync(join(out, 'api-key-secret'), 'utf8').trim(), fx.secretHex);
    assert.deepEqual(await dump(join(out, 'fathom.sqlite')), fx.preDump, 'the store is the pre-migration store');
    assert.deepEqual(stable(fx.dataDir), retained, 'the migrated directory is untouched');

    const outHashes = stable(out);
    const again = await snapshotCli(['rollback', '--snapshot', snapshot, '--from', fx.dataDir, '--out', out], { FATHOM_BACKUP_KEY_FILE: fx.keyFile });
    assert.equal(again.code, 1, 'an existing --out is refused');
    assert.deepEqual(stable(out), outHashes);
  });

  test('rollback refuses an --out inside --from (out_inside_source) or a --from inside --out (source_inside_out) before writing anything', T, async t => {
    const fx = await legacyFixture(t);
    const migrated = await migrateCli(fx.dataDir, fx.keyFile);
    assert.equal(migrated.code, 0, migrated.stderr);
    const { snapshot } = await assertMigrated(fx);
    const rollback = (from, out) => snapshotCli(['rollback', '--snapshot', snapshot, '--from', from, '--out', out], { FATHOM_BACKUP_KEY_FILE: fx.keyFile });
    const dataBefore = stable(fx.dataDir);
    const listing = readdirSync(fx.dataDir).sort();
    const rootListing = readdirSync(fx.root).sort();
    const alias = join(fx.root, 'data-alias');
    symlinkSync(fx.dataDir, alias);
    const cases = [
      ['--out <data>/rollback', fx.dataDir, join(fx.dataDir, 'rollback'), 'out_inside_source'],
      ['--out nested below <data>', fx.dataDir, join(fx.dataDir, 'files', 'nested', 'rollback'), 'out_inside_source'],
      ['--out under a symlink to <data>', fx.dataDir, join(alias, 'rollback'), 'out_inside_source'],
      ['--from a symlink to <data>, --out inside it', alias, join(fx.dataDir, 'rollback'), 'out_inside_source'],
      ['--out the parent of <data>', fx.dataDir, fx.root, 'source_inside_out'],
    ];
    for (const [label, from, out, code] of cases) {
      const r = await rollback(from, out);
      assert.equal(r.code, 1, `${label}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr.trim(), `source-snapshot: ${code}`, label);
      assert.deepEqual(stable(fx.dataDir), dataBefore, `${label}: the data directory is unchanged`);
      assert.deepEqual(readdirSync(fx.dataDir).sort(), listing, `${label}: nothing is created inside the data directory`);
      assert.deepEqual(readdirSync(fx.root).sort(), [...rootListing, 'data-alias'].sort(), `${label}: nothing is created next to it`);
    }
    // Liveness: a sibling --out still rolls back from the same snapshot.
    const sibling = join(fx.root, 'rolled-back');
    const ok = await rollback(fx.dataDir, sibling);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(await dump(join(sibling, 'fathom.sqlite')), fx.preDump);
    assert.deepEqual(stable(fx.dataDir), dataBefore, 'the migrated directory is untouched');
  });
});

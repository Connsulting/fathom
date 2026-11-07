// Fixtures for the MT-01 platform identity tests (test/tenancy-identity.test.mjs).
//
// buildLegacyStore(dataDir, opts) writes a real-mode `fathom.sqlite` at schema 020 with the auth
// rows in the 018/020 shapes, inserted with raw SQL: an enrolled admin and an enrolled member, each
// holding a real software passkey (test/helpers/webauthn.mjs), a pending invitee with a live invite
// link, a recovery link, an add-a-device link, a live session per enrolled user, a pending sign-in
// challenge and a pending registration challenge bound to the invite link, a rate-limit row, and a
// creator-owned and an ownerless MCP key hashed under a 64-hex `api-key-secret`. Every raw token
// is returned so tests can redeem the unchanged links after migration. All values are synthetic.
//
// Modules that MT-01 adds (src/platform/*) are imported lazily so the test file loads before they
// exist.

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { ROOT, request, postJson, runCommand, childEnv, src } from './server.mjs';
import { createAuthenticator } from './webauthn.mjs';
import { openDb, migrate, setSetting, listTables } from '../../src/store/db.mjs';
import { hashKey } from '../../src/mcp/keys.mjs';

export const REAL = Object.freeze({
  FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_EMAIL_TRANSPORT: 'dev',
  FATHOM_EMAIL_FROM: 'sender@example.test', FATHOM_EMAIL_TO: 'recipient@example.test',
});
export const SESSION = '__Host-fathom-session';
export const CEREMONY = '__Host-fathom-ceremony';
export const EXPIRED = Object.freeze({ error: 'link expired or already used' });
export const MEMBERSHIP_REQUIRED = Object.freeze({ error: 'household membership required' });
export const PLATFORM_FILE = 'platform.sqlite';
export const LOCK_FILE = 'platform-migration.lock';
export const JOURNAL_FILE = 'platform-migration.json';
export const STAGING_FILE = 'platform.sqlite.staging';
export const AUTH_TABLES = Object.freeze(['users', 'households', 'passkeys', 'auth_tokens', 'auth_sessions', 'auth_challenges', 'auth_rate_limits']);
export const PLATFORM_TABLES = Object.freeze(['households', 'users', 'household_memberships', 'instance_operators', 'passkeys',
  'auth_tokens', 'household_invitations', 'auth_sessions', 'auth_challenges', 'auth_rate_limits', 'platform_settings',
  'audit_events', 'platform_operations']);
// onPhase names in contract order.
export const PHASES = Object.freeze(['preflight', 'snapshot-partial', 'snapshot-published', 'snapshot', 'source-schema', 'stage',
  'verify', 'publish', 'mark', 'cleanup', 'complete']);
export const BEFORE_PUBLISH = Object.freeze(['preflight', 'snapshot-partial', 'snapshot-published', 'snapshot', 'source-schema', 'stage', 'verify']);

const RP_ID = 'localhost';
const handle = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const plain = row => (row ? { ...row } : row);

// --------------------------------------------------------------------------- files

// Every regular file under dir, relative path -> sha256. `skip(rel)` leaves a path out.
export function fileHashes(dir, skip = () => false) {
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true })) {
    const path = join(dir, rel);
    if (skip(rel) || !statSync(path).isFile()) continue;
    out[rel] = sha256File(path);
  }
  return out;
}

// Relative paths of every entry under dir whose relative path matches `test`.
export function findFiles(dir, test) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter(rel => test(rel) && statSync(join(dir, rel)).isFile()).sort();
}

export const snapshotsIn = dir => findFiles(dir, rel => rel.endsWith('.fsnap'));
export const partialsIn = dir => findFiles(dir, rel => /\.partial-/.test(rel));

export function writeBackupKey(dir, { mode = 0o600, bytes = 32, name = 'backup.key' } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, randomBytes(bytes).toString('hex') + '\n', { mode });
  chmodSync(file, mode);
  return file;
}

// --------------------------------------------------------------------------- sqlite reads

// Plain connection with no pragmas: reads change nothing, and closing the last connection removes
// a WAL database's -wal and -shm files the way a stopped server leaves them.
export function withDb(file, fn) {
  if (!existsSync(file)) throw new Error(`no database at ${file}`);
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}

export function rows(db, table, order = 'rowid') {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all().map(plain);
}

export function tableNames(file) {
  return withDb(file, db => listTables(db));
}

// Logical dump (sorted JSON rows per table).
function dumpOf(db, { only = null, except = [] } = {}) {
  const out = {};
  for (const t of listTables(db)) {
    if ((only && !only.includes(t)) || except.includes(t)) continue;
    out[t] = db.prepare(`SELECT * FROM "${t}"`).all().map(r => JSON.stringify({ ...r })).sort();
  }
  return out;
}
export const dump = (file, options) => withDb(file, db => dumpOf(db, options));

// --------------------------------------------------------------------------- legacy fixture

// A real credential for `userHandle` made by `device`, as the 018 passkeys row needs it: the id,
// the COSE public key and the counter the real verifier extracts from the attestation.
export async function credentialFor(device, userHandle) {
  const challenge = randomBytes(32).toString('base64url');
  const origin = `http://${RP_ID}`;
  const response = device.createCredential({ rp: { id: RP_ID }, user: { id: userHandle }, challenge }, { origin });
  const verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin,
    expectedRPID: RP_ID, requireUserVerification: true });
  if (!verified.verified) throw new Error('synthetic credential did not verify');
  const { id, publicKey, counter } = verified.registrationInfo.credential;
  return { id, publicKey: Buffer.from(publicKey), counter };
}

const randomKey = () => 'fathom_' + randomBytes(32).toString('base64url');

// See the file header. Options: users (false: an empty real store with only the household row),
// files (synthetic upload, advisor packet and private pack files under the data dir).
export async function buildLegacyStore(dataDir, { users = true, files = false } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'fathom.sqlite');
  const secretHex = randomBytes(32).toString('hex');
  writeFileSync(join(dataDir, 'api-key-secret'), secretHex + '\n', { mode: 0o600 });
  const serverSecret = Buffer.from(secretHex, 'hex');
  const now = Date.now();
  const fx = { dataDir, file, secretHex };
  const db = openDb(file);
  try {
    migrate(db, { through: 20 });
    setSetting(db, 'mode', 'real');
    setSetting(db, 'synthetic.marker', { kept: true });
    db.prepare('INSERT INTO households (id) VALUES (1)').run();
    if (users) {
      const person = (email, role, enrolled) => {
        const p = { id: `usr-${randomBytes(6).toString('hex')}`, email, role, handle: handle(), createdAt: now - 86_400_000, enrolledAt: enrolled ? now - 3_600_000 : null };
        db.prepare('INSERT INTO users (id, household_id, email, role, user_handle, created_at, enrolled_at) VALUES (?, 1, ?, ?, ?, ?, ?)')
          .run(p.id, p.email, p.role, p.handle, p.createdAt, p.enrolledAt);
        return p;
      };
      fx.admin = person('legacy-admin@example.test', 'admin', true);
      fx.member = person('legacy-member@example.test', 'member', true);
      fx.invitee = person('legacy-invitee@example.test', 'member', false);
      for (const p of [fx.admin, fx.member]) {
        p.device = createAuthenticator();
        const credential = await credentialFor(p.device, p.handle);
        p.credentialId = credential.id;
        db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(credential.id, p.id, credential.publicKey, credential.counter, '["internal"]', 'Synthetic legacy device', now - 3_600_000);
      }
      fx.invitee.device = createAuthenticator();
      const token = (userId, purpose) => {
        const raw = handle();
        db.prepare('INSERT INTO auth_tokens (hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
          .run(digest(raw), userId, purpose, now + 20 * 60_000);
        return raw;
      };
      fx.inviteToken = token(fx.invitee.id, 'invite');
      fx.recoveryToken = token(fx.member.id, 'recovery');
      fx.addPasskeyToken = token(fx.admin.id, 'add-passkey');
      const session = userId => {
        const raw = handle();
        db.prepare('INSERT INTO auth_sessions (hash, user_id, signed_in_at, expires_at) VALUES (?, ?, ?, ?)')
          .run(digest(raw), userId, now - 60_000, now + 7 * 86_400_000);
        return raw;
      };
      fx.admin.session = session(fx.admin.id);
      fx.member.session = session(fx.member.id);
      const challenge = (ceremony, { userId = null, tokenRaw = null } = {}) => {
        const raw = handle();
        const value = randomBytes(32).toString('base64url');
        db.prepare(`INSERT INTO auth_challenges (hash, ceremony, user_id, token_hash, session_hash, challenge, expires_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(digest(raw), ceremony, userId, tokenRaw ? digest(tokenRaw) : null, value, now + 5 * 60_000);
        return { cookie: raw, challenge: value };
      };
      fx.signinChallenge = challenge('signin');
      fx.registerChallenge = challenge('register', { userId: fx.invitee.id, tokenRaw: fx.inviteToken });
      db.prepare('INSERT INTO auth_rate_limits (key_hash, window_start, expires_at, attempts) VALUES (?, ?, ?, 1)')
        .run(digest('synthetic:legacy-limit'), now, now + 60 * 60_000);
      const apiKey = (name, userId) => {
        const key = randomKey();
        const id = `key_${randomBytes(6).toString('hex')}`;
        db.prepare('INSERT INTO api_keys (id, name, key_hash, scopes, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, name, hashKey(key, serverSecret), '["read"]', new Date(now - 7_200_000).toISOString(), userId);
        return { id, key };
      };
      fx.ownedKey = apiKey('Synthetic owned agent', fx.admin.id);
      fx.ownerlessKey = apiKey('Synthetic ownerless agent', null);
    }
    fx.legacy = {};
    for (const t of [...AUTH_TABLES, 'api_keys']) fx.legacy[t] = rows(db, t);
    fx.preDump = dumpOf(db);
  } finally {
    db.close();
  }
  if (files) {
    const write = (rel, bytes) => {
      mkdirSync(join(dataDir, rel, '..'), { recursive: true });
      writeFileSync(join(dataDir, rel), bytes, { mode: 0o600 });
    };
    fx.extraFiles = {
      'files/upl-synthetic-0001.bin': randomBytes(4096),
      'files/advpkt-0123456789abcdef.bin': randomBytes(2048),
      'packs/your-plans/manifest.json': Buffer.from(JSON.stringify({ id: 'your-plans', entries: [{ id: 'synthetic-plan', file: 'entries/synthetic-plan.md' }] })),
      'packs/your-plans/entries/synthetic-plan.md': Buffer.from('# Synthetic plan\n\nInvented text for a rollback test.\n'),
    };
    for (const [rel, bytes] of Object.entries(fx.extraFiles)) write(rel, bytes);
  }
  fx.preHashes = fileHashes(dataDir);
  // Strings that must never appear in a journal, log line or snapshot ciphertext.
  fx.secrets = users ? [
    fx.admin.email, fx.member.email, fx.invitee.email, fx.admin.handle, fx.member.handle, fx.invitee.handle,
    fx.inviteToken, fx.recoveryToken, fx.addPasskeyToken, fx.admin.session, fx.member.session,
    digest(fx.inviteToken), digest(fx.admin.session), fx.admin.credentialId, fx.ownedKey.key, fx.ownerlessKey.key, secretHex,
  ] : [secretHex];
  return fx;
}

// Every source auth row still present and unchanged in fathom.sqlite.
export function sourceAuthRows(file) {
  return withDb(file, db => {
    const present = new Set(listTables(db));
    const out = {};
    for (const t of AUTH_TABLES) out[t] = present.has(t) ? rows(db, t) : null;
    return out;
  });
}

// --------------------------------------------------------------------------- CLIs and children

export const migrateCli = (dataDir, keyFile, extra = {}) => runCommand(process.execPath, ['scripts/migrate-platform.mjs'],
  { env: { FATHOM_DATA: dataDir, FATHOM_BACKUP_KEY_FILE: keyFile, ...extra }, timeoutMs: 120000 });
export const snapshotCli = (args, env) => runCommand(process.execPath, ['scripts/source-snapshot.mjs', ...args], { env, timeoutMs: 120000 });
export const operatorCli = (args, dataDir) => runCommand(process.execPath, ['scripts/operator.mjs', ...args], { env: { FATHOM_DATA: dataDir } });

const FAULT_CHILD = `
const { migratePlatform } = await import(process.env.MIGRATE_URL);
const at = process.env.FAULT_AT;
try {
  await migratePlatform({
    dataDir: process.env.FATHOM_DATA, backupKeyFile: process.env.FATHOM_BACKUP_KEY_FILE,
    onPhase: async name => {
      if (name !== at) return;
      if (process.env.FAULT_MODE === 'kill') process.kill(process.pid, 'SIGKILL');
      throw new Error('synthetic phase fault');
    },
  });
  process.exit(0);
} catch (err) {
  console.error('fault: ' + (err && err.message));
  process.exit(7);
}
`;

// Run migratePlatform in a child that SIGKILLs itself (mode 'kill') or throws (mode 'throw') when
// onPhase reports `phase`. Resolves { code, stdout, stderr }; code is null after SIGKILL.
export function migrateWithFault(dataDir, keyFile, phase, mode) {
  return runCommand(process.execPath, ['--input-type=module', '-e', FAULT_CHILD], {
    env: {
      FATHOM_DATA: dataDir, FATHOM_BACKUP_KEY_FILE: keyFile, FAULT_AT: phase, FAULT_MODE: mode,
      MIGRATE_URL: pathToFileURL(join(ROOT, 'src/platform/migrate.mjs')).href,
    },
    timeoutMs: 120000,
  });
}

const HOLDER_CHILD = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.HOLD_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.prepare('SELECT count(*) AS n FROM settings').get();
console.log('holding');
setInterval(() => {}, 1000);
`;

// A live synthetic instance: a child process holding fathom.sqlite open in WAL mode, idle.
// Resolves { stop() } once the child has opened and read the store.
export async function holdStore(file) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER_CHILD], {
    cwd: ROOT, env: childEnv({ HOLD_FILE: file }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`holder did not start: ${out}`)), 15000);
    child.stdout.on('data', d => { out += d; if (out.includes('holding')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', d => { out += d; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`holder exited ${code}: ${out}`)); });
  });
  return {
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    }),
  };
}

// --------------------------------------------------------------------------- HTTP

// A browser: cookie jar applying Set-Cookie, same-origin POSTs.
export function browser(baseUrl, cookies = {}) {
  const jar = new Map(Object.entries(cookies));
  const cookie = () => (jar.size ? [...jar].map(([name, value]) => `${name}=${value}`).join('; ') : undefined);
  const absorb = response => {
    for (const line of response.headers['set-cookie'] || []) {
      const pair = line.split(';', 1)[0];
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return response;
  };
  return {
    jar,
    session: () => jar.get(SESSION) ?? null,
    post: async (path, body = {}, headers = {}) => absorb(await postJson(baseUrl, path, body, { origin: baseUrl, cookie: cookie(), ...headers })),
    get: async path => absorb(await request(baseUrl, { path, headers: { cookie: cookie() } })),
    raw: async (options) => absorb(await request(baseUrl, { ...options, headers: { cookie: cookie(), origin: baseUrl, ...options.headers } })),
  };
}

export const sessionBrowser = (baseUrl, token) => browser(baseUrl, { [SESSION]: token });

export async function signIn(baseUrl, device, credentialId) {
  const client = browser(baseUrl);
  const options = await client.post('/api/auth/signin/options', {});
  if (options.status !== 200) return { client, options, verify: null };
  const response = device.getAssertion(options.json.options, { origin: baseUrl, credentialId });
  const verify = await client.post('/api/auth/signin/verify', { response });
  return { client, options, verify };
}

export async function register(baseUrl, client, device, body = {}, name = 'Synthetic device') {
  const options = await client.post('/api/auth/register/options', { ...body, name });
  if (options.status !== 200) return { options, verify: null };
  const response = device.createCredential(options.json.options, { origin: baseUrl });
  const verify = await client.post('/api/auth/register/verify', { ...body, name, response });
  return { options, verify };
}

let rpcId = 1;
export function mcpList(baseUrl, key) {
  return request(baseUrl, {
    method: 'POST', path: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} }),
  });
}

// --------------------------------------------------------------------------- platform fixtures

export async function platformModules() {
  const [db, store] = await Promise.all([src('src/platform/db.mjs'), src('src/auth/store.mjs')]);
  return { ...db, ...store };
}

// A fresh instance (platform.sqlite + fathom.sqlite) with its handles closed. Returns { householdId }.
export async function freshInstance(dataDir, mode = 'real') {
  const { createInstance } = await src('src/platform/db.mjs');
  mkdirSync(dataDir, { recursive: true });
  const { db, platform, householdId } = createInstance(dataDir, { mode, init() {} });
  db.close();
  platform.close();
  return { householdId };
}

// An enrolled user with an active membership and a live session, made through the platform store
// (invite, consumeInvitation, markEnrolled, createSession). Returns { id, email, token }.
export function enrollMember(store, householdId, email, role = 'member') {
  const { user, token } = store.invite(householdId, email, { role });
  store.consumeInvitation(token, user.id);
  store.markEnrolled(user.id);
  const session = store.createSession(user.id);
  return { id: user.id, email, token: session.token };
}

export function insertPasskey(platform, userId, id = `pk-${randomBytes(6).toString('hex')}`) {
  platform.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run(id, userId, Buffer.from('synthetic public key bytes'), '["internal"]', 'Synthetic credential', Date.now());
  return id;
}

export const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

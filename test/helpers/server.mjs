// Test helpers: run the real server as a child process, talk HTTP to it, and open temp stores.
// Source modules are imported lazily so a test file that only needs the HTTP side still loads.

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openScope } from '../../src/storage/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Each household's store: <dataDir>/households/<householdId>/fathom.sqlite (MT-03 layout).
export const DB_FILE = 'fathom.sqlite';
// Account rows (users, households, memberships, passkeys, auth_*, MCP keys, outbound flags).
export const PLATFORM_FILE = 'platform.sqlite';
export const SERVER_TIMEOUT = 30000;

const running = new Set();
const secretDirs = new Set();
process.on('exit', () => {
  for (const c of running) killGroup(c, 'SIGKILL');
  for (const d of secretDirs) rmSync(d, { recursive: true, force: true });
});

export function src(rel) {
  return import(pathToFileURL(join(ROOT, rel)).href);
}

export async function tempDir(prefix = 'fathom-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------- instance secrets

// Synthetic instance secrets in `dir`: the platform key (wraps household data keys) and the MCP
// HMAC secret, each 64 hex characters in a 0600 file inside a 0700 directory. `mcpSecretHex`
// keeps an existing secret (a migrated instance's api-key-secret). Returns
// { dir, platformKeyFile, mcpSecretFile, platformKey }.
export function writeInstanceSecrets(dir, { mcpSecretHex = randomBytes(32).toString('hex') } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const platformKey = randomBytes(32);
  const write = (name, text) => {
    const file = join(dir, name);
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  };
  return {
    dir,
    platformKeyFile: write('platform.key', platformKey.toString('hex') + '\n'),
    mcpSecretFile: write('mcp.secret', mcpSecretHex + '\n'),
    platformKey,
  };
}

// The synthetic real-mode secrets of the instance in `dataDir`, created once per data directory in
// a temp directory outside it (removed at exit), so every server, CLI and in-process runtime of one
// instance in this test process reads the same keys. `mcpSecretHex` applies when they are created.
const instanceSecrets = new Map();
export function secretsFor(dataDir, { mcpSecretHex } = {}) {
  const key = resolve(dataDir);
  let keys = instanceSecrets.get(key);
  if (!keys) {
    const dir = mkdtempSync(join(tmpdir(), 'fathom-secrets-'));
    secretDirs.add(dir);
    keys = writeInstanceSecrets(join(dir, 'keys'), { mcpSecretHex });
    instanceSecrets.set(key, keys);
  }
  return keys;
}

// The env naming those secrets for a child server or CLI.
export const secretEnv = keys => ({ FATHOM_PLATFORM_KEY_FILE: keys.platformKeyFile, FATHOM_MCP_SECRET_FILE: keys.mcpSecretFile });

// The instance secrets service (src/platform/secrets.mjs) for `dataDir` in `mode`: the synthetic
// real-mode files from secretsFor, or the demo instance's own platform-secrets/. Returns
// { secrets, keys } (keys: null in demo mode).
export async function instanceSecretsOf(dataDir, mode) {
  const { createInstanceSecrets } = await src('src/platform/secrets.mjs');
  const keys = mode === 'demo' ? null : secretsFor(dataDir);
  const config = { dataDir, platformKeyFile: keys?.platformKeyFile ?? null, mcpSecretFile: keys?.mcpSecretFile ?? null };
  return { secrets: createInstanceSecrets({ config, mode }), keys };
}

// The original household of the instance in `dataDir` and its store file (read-only platform read):
// { householdId, mode, root, file }, or null when there is no platform or no rooted household.
export async function servedStore(dataDir) {
  const platformFile = join(dataDir, PLATFORM_FILE);
  if (!existsSync(platformFile)) return null;
  const db = await openScope({ path: platformFile, readOnly: true, journal: null, busyTimeout: 0 });
  let row;
  try {
    row = await db.prepare('SELECT id, mode, storage_root FROM households WHERE serves_store = 1').get();
  } finally {
    await db.close();
  }
  if (!row || !row.storage_root) return null;
  const root = join(dataDir, row.storage_root);
  return { householdId: row.id, mode: row.mode, root, file: join(root, DB_FILE) };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Child env: the parent env minus every FATHOM_* key, then `extra`. An undefined value unsets a key.
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FATHOM_')) env[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

function killGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch { /* already gone */ }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child, ms) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

function launch({ dataDir, port, env, npm }) {
  const cmd = npm ? 'npm' : process.execPath;
  const args = npm ? ['start'] : ['src/server.mjs'];
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: childEnv({ FATHOM_DATA: dataDir, FATHOM_PORT: port, FATHOM_PUBLIC_URL: `http://localhost:${port}`, ...env }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('error', e => { out += `\nspawn error: ${e.message}`; });
  return { child, output: () => out };
}

async function healthy(baseUrl) {
  try {
    const r = await request(baseUrl, { path: '/healthz' });
    return r.status === 200 && r.json && r.json.ok === true;
  } catch {
    return false;
  }
}

const pause = ms => new Promise(r => setTimeout(r, ms));

// True once this child printed its own listening line naming `port`. freePort can hand out a
// port another process binds before the child does, so a healthy /healthz alone may belong to a
// foreign server; the child's own line proves the port is its own.
function listeningOn(text, port) {
  return new RegExp(`fathom listening on \\S*:${port}(?![0-9])`).test(text);
}

// Start `node src/server.mjs` (or `npm start` with npm: true) and wait for the child's own
// `fathom listening on` line naming its port, then GET /healthz. Fails if the child exits first.
// Returns { baseUrl, port, dataDir, householdId, root, dbFile, platformFile, child, output(), stop() }
// where dbFile is the original household's store (households/<id>/fathom.sqlite).
// Real-mode secrets (FATHOM_PLATFORM_KEY_FILE, FATHOM_MCP_SECRET_FILE) come from secretsFor(dataDir)
// unless `env` names them (an undefined value leaves one unset); a demo instance ignores them.
export async function spawnServer({ dataDir, env = {}, npm = false, timeoutMs = 20000 } = {}) {
  dataDir = dataDir || await tempDir();
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const { child, output } = launch({ dataDir, port, env: { ...secretEnv(secretsFor(dataDir)), ...env }, npm });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited(child)) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${output()}`);
    }
    if (listeningOn(output(), port) && await healthy(baseUrl)) break;
    if (Date.now() > deadline) {
      killGroup(child, 'SIGKILL');
      throw new Error(`server not healthy after ${timeoutMs} ms:\n${output()}`);
    }
    await pause(100);
  }
  const stop = async () => {
    if (exited(child)) return;
    killGroup(child, 'SIGTERM');
    if (!(await waitExit(child, 5000))) {
      killGroup(child, 'SIGKILL');
      await waitExit(child, 5000);
    }
  };
  const served = await servedStore(dataDir);
  return {
    baseUrl, port, dataDir, householdId: served?.householdId ?? null, root: served?.root ?? null, dbFile: served?.file ?? null,
    platformFile: join(dataDir, PLATFORM_FILE), child, output, stop, ...sessionClient(baseUrl),
  };
}

// Run fn(server) against a fresh server and always stop it.
export async function withServer(opts, fn) {
  const s = await spawnServer(opts);
  try {
    return await fn(s);
  } finally {
    await s.stop();
  }
}

// Start the server expecting it to refuse. Resolves { code, started, output } where started is
// true when it became healthy instead of exiting (it is then killed).
export async function expectServerExit({ dataDir, env = {}, timeoutMs = 15000 } = {}) {
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const { child, output } = launch({ dataDir, port, env: { ...(dataDir ? secretEnv(secretsFor(dataDir)) : {}), ...env }, npm: false });
  const deadline = Date.now() + timeoutMs;
  while (!exited(child)) {
    if ((listeningOn(output(), port) && await healthy(baseUrl)) || Date.now() > deadline) {
      killGroup(child, 'SIGKILL');
      await waitExit(child, 5000);
      return { code: null, started: true, output: output() };
    }
    await pause(100);
  }
  return { code: child.exitCode, started: false, output: output() };
}

// Run a command in the repo root with a clean FATHOM_* env. Resolves { code, stdout, stderr }.
export function runCommand(cmd, args, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Raw anonymous HTTP with no implicit cookie or Origin.
export function request(baseUrl, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const url = new URL(baseUrl);
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
  if (payload) h['content-length'] = String(payload.length);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    let answered = false;
    req.on('response', () => { answered = true; });
    req.on('error', e => { if (!answered) reject(e); });
    if (payload) req.write(payload);
    req.end();
  });
}

export function postJson(baseUrl, path, body = {}, headers = {}) {
  return request(baseUrl, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export async function getScenario(baseUrl) {
  const r = await request(baseUrl, { path: '/api/scenario' });
  if (r.status !== 200 || !r.json) throw new Error(`GET /api/scenario -> ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}

// Trusted fixture for non-WebAuthn tests, using only this test's synthetic platform database.
// `platform` is an open platform DB handle or a data dir holding platform.sqlite. The user is
// built only through the auth store: an invitation to the served household, consumed by the
// invitee, then enrollment. An existing active member is reused with its role unchanged.
// Returns { user, householdId, role, token, expiresAt, cookie }.
export async function createSessionFixture(platform, { email = 'admin@example.test', role = 'admin', now = () => Date.now() } = {}) {
  if (typeof platform === 'string') {
    const handle = await openPlatformStore(join(platform, PLATFORM_FILE));
    try { return await createSessionFixture(handle, { email, role, now }); } finally { await handle.close(); }
  }
  const { createAuthStore } = await src('src/auth/store.mjs');
  const store = createAuthStore(platform, { now });
  const household = await store.servedHousehold();
  if (!household || typeof household.id !== 'string' || !household.id) throw new Error('the platform has no served household');
  let user = await store.findUser(email);
  let membership = user ? await store.membership(user.id, household.id) : null;
  if (membership?.status !== 'active') {
    const invited = await store.invite(household.id, email, { role });
    await store.consumeInvitation(invited.token, invited.user.id);
    user = invited.user;
    membership = await store.membership(user.id, household.id);
  }
  if ((await store.getUser(user.id)).enrolledAt == null) await store.markEnrolled(user.id);
  user = await store.getUser(user.id);
  const { token, expiresAt } = await store.createSession(user.id);
  return { user, householdId: household.id, role: membership.role, token, expiresAt, cookie: `__Host-fathom-session=${token}` };
}

// The household context assertion a browser sends for a session (src/api/household-context.mjs):
// the session's household at context version 1 (a new session's), or none without a household.
export const contextHeaders = session => (session?.householdId
  ? { 'x-fathom-household': session.householdId, 'x-fathom-context-version': String(session.contextVersion ?? 1) } : {});

export function sessionClient(baseUrl, session = null) {
  const headers = session ? { cookie: session.cookie, origin: new URL(baseUrl).origin, ...contextHeaders(session) } : {};
  const read = (options = {}) => request(baseUrl, { ...options, headers: { ...headers, ...options.headers } });
  return {
    headers,
    request: read,
    postJson: (path, body = {}, extra = {}) => postJson(baseUrl, path, body, { ...headers, ...extra }),
    async getScenario() {
      const r = await read({ path: '/api/scenario' });
      if (r.status !== 200 || !r.json) throw new Error(`GET /api/scenario -> ${r.status}`);
      return r.json;
    },
  };
}

export async function spawnAuthenticatedServer(options = {}) {
  const server = await spawnServer(options);
  try {
    const platform = await openPlatformStore(server.platformFile);
    let session;
    try { session = await createSessionFixture(platform, options.session); } finally { await platform.close(); }
    const stop = server.stop;
    return {
      ...server, session, ...sessionClient(server.baseUrl, session),
      async stop() {
        await stop();
        const platform = await openPlatformStore(server.platformFile);
        try {
          const { createAuthStore } = await src('src/auth/store.mjs');
          await createAuthStore(platform).revokeSession(session.token);
        } finally { await platform.close(); }
      },
    };
  } catch (err) { await server.stop(); throw err; }
}

export async function withAuthenticatedServer(options, fn) {
  const server = await spawnAuthenticatedServer(options);
  try { return await fn(server); } finally { await server.stop(); }
}

// A household context (src/platform/runtime.mjs createHouseholdContext) over the open store `db`
// of household `householdId` on `platform`, with `config` (config.dataDir is the instance data
// directory) and the instance `secrets`. `inject` may supply engine, packs, answerer, scheduler or
// transport; anything else is built as the server builds it. The scheduler is never started.
// close() on the context closes `db`.
export async function householdContext({ db, platform, householdId, mode = 'real', config, secrets, generation = 1, ...inject }) {
  const { createHouseholdContext } = await src('src/platform/runtime.mjs');
  const given = Object.fromEntries(Object.entries(inject).filter(([, v]) => v != null));
  return await createHouseholdContext({ householdId, generation, mode, db, config, platform, secrets, ...given });
}

// In-process router over `db` (src/api/router.mjs createHandler), with the platform, runtime
// registry, auth service and MCP key service the server builds. The platform is `platform` when
// given, else the platform.sqlite in config.dataDir, else a disposable synthetic instance whose
// original household matches the store's mode (for stores built without createInstance). The
// registry serves `db` as that original household's runtime; `engine`, `packs`, `answerer`,
// `scheduler` and `transport` (also the auth mail transport) are injected into it when given;
// `scheduler` may be a function of the context getter (for createScheduler's `household` option).
// close() stops the HTTP server only: `db` stays open for the test.
export async function serveAppFixture({
  db, platform, config, authenticated = false, engine, packs, answerer, scheduler, transport, secrets, webDir, sharedDir,
}) {
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const { createHandler } = await src('src/api/router.mjs');
  const { getSetting } = await src('src/store/db.mjs');
  const { createRuntimeRegistry, buildHouseholdContext } = await src('src/platform/runtime.mjs');
  const { createAuthService } = await src('src/auth/service.mjs');
  const { createKeyService } = await src('src/mcp/keys.mjs');
  const { createTransport } = await src('src/email/transport.mjs');
  const owned = platform ? null : await fixturePlatform(db, config);
  const handle = platform ?? owned.platform;
  const served = await handle.prepare('SELECT id, mode FROM households WHERE serves_store = 1').get();
  const dataDir = config?.dataDir ?? owned?.dir;
  const fixtureConfig = { ...config, dataDir, port, publicUrl: baseUrl };
  const instance = secrets ?? (await instanceSecretsOf(dataDir, served.mode)).secrets;
  let server;
  try {
    // The registry builds contexts synchronously: the served one is built here and handed over.
    let servedContext = null;
    servedContext = await householdContext({
      db, platform: handle, householdId: served.id, mode: served.mode, config: fixtureConfig, secrets: instance,
      engine, packs, answerer, transport, scheduler: typeof scheduler === 'function' ? scheduler(() => servedContext) : scheduler,
    });
    const runtimes = createRuntimeRegistry({
      platform: handle, config: fixtureConfig, secrets: instance,
      build: async args => (args.householdId === served.id ? servedContext : await buildHouseholdContext(args)),
    });
    const authTransport = transport ?? createTransport(fixtureConfig, { outboxDir: join(dataDir, 'outbox') });
    const auth = await createAuthService({ platform: handle, config: fixtureConfig, transport: authTransport, secrets: instance });
    const keys = createKeyService({ platform: handle, secret: () => instance.mcpSecret(), creatorActive: auth.creatorActive });
    const session = authenticated && await getSetting(db, 'mode', null) !== 'demo' ? await createSessionFixture(handle) : null;
    server = http.createServer(createHandler({
      platform: handle, config: fixtureConfig, runtimes, auth, keys,
      ...(webDir ? { webDir } : {}), ...(sharedDir ? { sharedDir } : {}),
    }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return {
      baseUrl, session, config: fixtureConfig, server, platform: handle, household: servedContext, runtimes, auth, keys,
      ...sessionClient(baseUrl, session),
      close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }).then(() => owned?.close()),
    };
  } catch (err) {
    await owned?.close();
    throw err;
  }
}

async function fixturePlatform(db, config) {
  const file = config?.dataDir ? join(config.dataDir, PLATFORM_FILE) : null;
  if (file && existsSync(file)) {
    const { openPlatform } = await src('src/platform/db.mjs');
    const platform = await openPlatform(file);
    return { platform, dir: config.dataDir, close: async () => await platform.close() };
  }
  const { getSetting } = await src('src/store/db.mjs');
  const { createInstance } = await src('src/platform/db.mjs');
  const dir = await tempDir('fathom-platform-');
  const instance = await createInstance(dir, { mode: await getSetting(db, 'mode', null) === 'demo' ? 'demo' : 'real', init: () => {} });
  await instance.db.close();
  return {
    platform: instance.platform,
    dir,
    async close() {
      try { await instance.platform.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A fresh instance built by src/platform/db.mjs createInstance in a new temp dir: platform.sqlite
// with one original household whose root households/<id> holds a migrated fathom.sqlite bound to
// it, and its data key wrapped under the instance platform key (secretsFor(dataDir) in real mode,
// the demo's own platform-secrets/ in demo mode).
// Returns { db, platform, householdId, mode, dataDir, root, file, platformFile, secrets, keys,
// household(config, inject) -> household context (memoized for the default call), close() }.
export async function tempInstance({ mode = 'real', init = () => {} } = {}) {
  const { createInstance } = await src('src/platform/db.mjs');
  const dataDir = await tempDir();
  const { secrets, keys } = await instanceSecretsOf(dataDir, mode);
  const platformKey = secrets.platformKey();
  let made;
  try {
    made = await createInstance(dataDir, { mode, init, platformKey });
  } finally {
    platformKey.fill(0);
  }
  const { db, platform, householdId, root } = made;
  let closed = false;
  let context = null;
  return {
    db, platform, householdId, mode, dataDir, root, secrets, keys,
    file: join(root, DB_FILE), platformFile: join(dataDir, PLATFORM_FILE),
    async household(config = null, inject = {}) {
      const make = async () => householdContext({ db, platform, householdId, mode, config: { ...config, dataDir }, secrets, ...inject });
      if (config || Object.keys(inject).length) return await make();
      context ??= await make();
      return context;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await db.close(); } catch { /* already closed */ }
      try { await platform.close(); } catch { /* already closed */ }
    },
  };
}

// Run the offline tenancy migration (src/platform/migrate-tenancy.mjs) on an MT-02-layout real
// instance (platform.sqlite plus fathom.sqlite at the data root), with synthetic backup and legacy
// keys kept outside the data dir and the instance secrets of secretsFor(dataDir). Its MCP secret
// file is set to the source's api-key-secret when one exists, as the operator steps require, even
// when an earlier refusal check already created the secrets. Every connection to the store must be
// closed. Returns the result.
export async function migrateTenancyStore(dataDir, { legacyKeyFile = null } = {}) {
  const { migrateTenancy } = await src('src/platform/migrate-tenancy.mjs');
  const secretFile = join(dataDir, 'api-key-secret');
  const mcpSecretHex = existsSync(secretFile) ? readFileSync(secretFile, 'latin1').trim() : undefined;
  const keys = secretsFor(dataDir, { mcpSecretHex });
  if (mcpSecretHex) writeFileSync(keys.mcpSecretFile, mcpSecretHex + '\n', { mode: 0o600 });
  const keyDir = await tempDir('fathom-tenancy-keys-');
  const backupKeyFile = join(keyDir, 'backup.key');
  writeFileSync(backupKeyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  let legacy = legacyKeyFile;
  if (!legacy) {
    legacy = join(keyDir, 'data.key');
    writeFileSync(legacy, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  }
  try {
    return await migrateTenancy({ dataDir, backupKeyFile, legacyKeyFile: legacy, platformKeyFile: keys.platformKeyFile, mcpSecretFile: keys.mcpSecretFile });
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
}

// Run the offline platform migration (src/platform/migrate.mjs) on a real store that has no
// platform.sqlite yet, with a synthetic backup key kept outside the data dir. The store must be
// closed by every other connection first. Returns the migration result.
export async function migrateLegacyStore(dataDir) {
  const { migratePlatform } = await src('src/platform/migrate.mjs');
  const keyDir = await tempDir('fathom-backup-key-');
  const backupKeyFile = join(keyDir, 'backup.key');
  writeFileSync(backupKeyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  try {
    return await migratePlatform({ dataDir, backupKeyFile });
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
}

// Open a migrated store in a fresh temp dir. Returns { db, dataDir, file, close() }.
export async function tempDb() {
  const { openDb, migrate } = await src('src/store/db.mjs');
  const dataDir = await tempDir();
  const file = join(dataDir, DB_FILE);
  const db = await openDb(file);
  await migrate(db);
  return { db, dataDir, file, close: async () => await db.close() };
}

// Open an existing store file without migrating it.
export async function openStore(file) {
  const { openDb } = await src('src/store/db.mjs');
  return await openDb(file);
}

// Open an existing platform.sqlite without migrating it (a running server has already done so).
export async function openPlatformStore(file) {
  if (!existsSync(file)) throw new Error('no platform.sqlite at the given path');
  const { openDb } = await src('src/store/db.mjs');
  return await openDb(file);
}

// Run fn(platform, authStore) on a platform file and close it.
export async function withPlatform(file, fn) {
  const platform = await openPlatformStore(file);
  try {
    const { createAuthStore } = await src('src/auth/store.mjs');
    return await fn(platform, createAuthStore(platform));
  } finally { await platform.close(); }
}

// Logical dump of every user table (rows as sorted JSON strings) to compare "unchanged".
export async function dumpStore(file) {
  const { openDb, listTables } = await src('src/store/db.mjs');
  const db = await openDb(file);
  try {
    const out = {};
    for (const t of await listTables(db)) {
      out[t] = (await db.prepare(`SELECT * FROM "${t}"`).all()).map(r => JSON.stringify({ ...r })).sort();
    }
    return out;
  } finally {
    await db.close();
  }
}

export const recOf = (scenario, id) => (scenario.recs || []).find(r => r.id === id);
export const paragraphs = list => list.map(p => `<p>${p}</p>`).join('');

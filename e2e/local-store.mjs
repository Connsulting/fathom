import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { secretEnv, secretsFor, servedStore } from '../test/helpers/server.mjs';

const ownedDirectories = new Set();

export function refuseSuppliedTarget() {
  if (process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL || process.env.FATHOM_SMOKE_TARGET === 'real') {
    throw new Error('Local fixture setup or reset is forbidden with a supplied smoke target');
  }
}

export function createLocalData(label) {
  refuseSuppliedTarget();
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid local fixture label');
  const dir = mkdtempSync(join(tmpdir(), `fathom-e2e-${label}-`));
  ownedDirectories.add(dir);
  return dir;
}

export function removeLocalData(dir) {
  if (!dir) return;
  refuseSuppliedTarget();
  if (!ownedDirectories.has(dir) || dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('fathom-e2e-')) {
    throw new Error('Refusing to remove an unowned fixture directory');
  }
  rmSync(dir, { recursive: true, force: true });
  ownedDirectories.delete(dir);
}

export async function localPort() {
  refuseSuppliedTarget();
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', done);
  });
  const { port } = server.address();
  await new Promise((done, reject) => server.close((err) => err ? reject(err) : done()));
  return port;
}

// The original household's store of the instance in dataDir (households/<id>/fathom.sqlite, read
// from platform.sqlite). Throws when the instance has none yet.
export function householdStoreFile(dataDir) {
  const served = servedStore(dataDir);
  if (!served) throw new Error('No household store in the data directory yet');
  return served.file;
}

// The original household's root of the instance in dataDir (households/<id>): its outbox/ and
// packs/your-plans/ live here. Throws when the instance has none yet.
export function householdRootDir(dataDir) {
  const served = servedStore(dataDir);
  if (!served) throw new Error('No household store in the data directory yet');
  return served.root;
}

// Trusted financial-test fixture only. Auth ceremonies are exercised in identity.spec.mjs.
// A real instance reads the synthetic instance secrets of secretsFor(dataDir), the same ones the
// test store helpers built its data key with. Returns the app plus url, headers, storeFile and
// authenticate(context).
export async function startEnrolledServer({ dataDir, clock } = {}) {
  refuseSuppliedTarget();
  if (!ownedDirectories.has(dataDir)) throw new Error('An owned temporary store is required');
  const [{ startServer }, { loadConfig }, { createAuthStore }, { openDb }, { PLATFORM_FILE }] = await Promise.all([
    import('../src/server.mjs'), import('../src/config.mjs'), import('../src/auth/store.mjs'),
    import('../src/store/db.mjs'), import('../src/platform/db.mjs'),
  ]);
  const port = await localPort();
  const url = `http://localhost:${port}`;
  const config = loadConfig({
    FATHOM_DATA: dataDir,
    FATHOM_DEMO: '0',
    FATHOM_ENGINE: 'off',
    FATHOM_HOST: 'localhost',
    FATHOM_PORT: String(port),
    FATHOM_PUBLIC_URL: url,
    FATHOM_EMAIL_TRANSPORT: 'dev',
    FATHOM_EMAIL_FROM: 'fathom@example.test',
    FATHOM_EMAIL_TO: 'owner@example.test',
    ...(clock ? { FATHOM_CLOCK: clock } : {}),
    ...secretEnv(secretsFor(dataDir)),
  });
  const app = await startServer(config);
  try {
    // Accounts live in the platform DB beside the store; the server created or opened it.
    const platform = openDb(join(dataDir, PLATFORM_FILE));
    let session;
    try {
      const store = createAuthStore(platform);
      const household = store.servedHousehold();
      const { user, token } = store.invite(household.id, 'owner@example.test', { role: 'admin' });
      store.consumeInvitation(token, user.id);
      store.markEnrolled(user.id);
      session = store.createSession(user.id);
    } finally { platform.close(); }
    return {
      ...app,
      url,
      storeFile: householdStoreFile(dataDir),
      headers: { Cookie: `__Host-fathom-session=${session.token}`, Origin: url },
      async authenticate(context) {
        await context.addCookies([{
          name: '__Host-fathom-session', value: session.token,
          domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
          expires: Math.floor(session.expiresAt / 1000),
        }]);
      },
    };
  } catch (err) {
    await app.close();
    throw err;
  }
}

// The local demo instance's data directory (E2E_DATA), resolved.
export const localDataDir = () => resolve(process.env.E2E_DATA || '.e2e-data');

// Seed synthetic rows beside a running local demo server (dataDir, default E2E_DATA) through its
// original household's runtime context, built the way a store-opening CLI builds it (scheduler not
// started), so ingest and stored files go through the household vault. `now` stamps the ingest.
// Returns fn's result and always closes the context.
export async function withLocalHousehold(now, fn, { dataDir = localDataDir() } = {}) {
  refuseSuppliedTarget();
  const [{ loadConfig }, { openCliHousehold }] = await Promise.all([import('../src/config.mjs'), import('../src/platform/cli.mjs')]);
  const served = servedStore(dataDir);
  if (!served) throw new Error('No household store in the data directory yet');
  const config = loadConfig({ FATHOM_DATA: dataDir, FATHOM_DEMO: '1', FATHOM_ENGINE: 'off' });
  const cli = await openCliHousehold(config, ['--household', served.householdId]);
  try {
    const { household } = cli;
    return await fn({ db: household.db, config, household, opts: (engine, extra = {}) => ({ config, household, engine, now, ...extra }) });
  } finally {
    await cli.close();
  }
}

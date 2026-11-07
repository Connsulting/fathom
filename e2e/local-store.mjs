import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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

// Trusted financial-test fixture only. Auth ceremonies are exercised in identity.spec.mjs.
export async function startEnrolledServer({ dataDir, clock, dataKeyFile } = {}) {
  refuseSuppliedTarget();
  if (!ownedDirectories.has(dataDir)) throw new Error('An owned temporary store is required');
  const [{ startServer }, { loadConfig }, { createAuthStore }] = await Promise.all([
    import('../src/server.mjs'), import('../src/config.mjs'), import('../src/auth/store.mjs'),
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
    ...(dataKeyFile ? { FATHOM_DATA_KEY_FILE: dataKeyFile } : {}),
  });
  const app = await startServer(config);
  try {
    const store = createAuthStore(app.db);
    store.ensureHousehold();
    const user = store.inviteUser('owner@example.test', { role: 'admin' });
    app.db.prepare('UPDATE users SET enrolled_at = ? WHERE id = ?').run(Date.now(), user.id);
    const session = store.createSession(user.id);
    return {
      ...app,
      url,
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

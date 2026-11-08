import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openScope } from '../storage/index.mjs';
import { createInstance } from '../platform/db.mjs';
import { openInstance } from '../platform/ready.mjs';
import { createInstanceSecrets } from '../platform/secrets.mjs';
import { createHouseholdContext, createRuntimeRegistry, openHouseholdDb } from '../platform/runtime.mjs';
import { DB_FILE, getSetting, listMigrations, schemaVersion } from '../store/db.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { createHandler, findRoute, normalizePath } from '../api/router.mjs';
import { createStatic } from '../api/static.mjs';
import { createLivePacks } from '../packs/live.mjs';
import { createLiveAnswerer } from '../api/answerer.mjs';
import { createClientAddressResolver } from '../auth/client-ip.mjs';
import { isAllowedHost } from '../mcp/guard.mjs';
import { HttpError, sendError, sendJson, setSecurityHeaders, guardPost } from '../api/http.mjs';
import { createDemoControl, demoRouteBehavior, COOKIE_NAME, DEMO_OFF_MESSAGE } from './control.mjs';
import { createPublicDemoEngine, limitDemoAnswerer } from './engine.mjs';

export async function assertSyntheticStore(file) {
  if (!existsSync(file)) return;
  let db;
  try {
    db = await openScope({ path: file, readOnly: true, journal: null, busyTimeout: 0 });
    if (await getSetting(db, 'mode') !== 'demo' || await getSetting(db, 'synthetic_demo') !== 'synthetic-v1') throw new Error();
  } catch { throw new Error('public demo: refusing a store without the synthetic seeder marker'); }
  finally { await db?.close(); }
}

const SHIPPED_SCHEMA = listMigrations().at(-1)?.id ?? 0;

// One sandbox is its own synthetic demo instance (platform.sqlite plus one household root under
// sandboxes/<id>), served through the household runtime registry with the public demo engine and
// the visitor's turn limits. `platform` is the base instance's platform DB (health only).
export async function createPublicDemoHandler(config, { platform: basePlatform }) {
  const requestAddress = new AsyncLocalStorage();
  const control = await createDemoControl(config);
  const clientAddress = createClientAddressResolver(config.trustedProxies);
  const runtimes = new Map();
  const serveStatic = createStatic({ webDir: fileURLToPath(new URL('../../web/', import.meta.url)),
    sharedDir: fileURLToPath(new URL('../shared/', import.meta.url)) });
  const sandboxDir = id => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid sandbox identity');
    return join(config.dataDir, 'sandboxes', id);
  };
  const cleanup = async () => await control.cleanup(id => {
    const runtime = runtimes.get(id);
    if (runtime?.active) return false;
    runtime?.close();
    runtimes.delete(id);
    rmSync(sandboxDir(id), { recursive: true, force: true });
    return true;
  });
  await cleanup();
  const timer = setInterval(cleanup, 60000);
  timer.unref();
  const runtimeFor = async id => {
    if (runtimes.has(id)) return runtimes.get(id);
    const sandboxConfig = { ...config, dataDir: sandboxDir(id) };
    mkdirSync(sandboxConfig.dataDir, { recursive: true });
    const secrets = createInstanceSecrets({ config: sandboxConfig, mode: 'demo' });
    let platform = (await openInstance(sandboxConfig))?.platform ?? null;
    if (!platform) {
      const platformKey = secrets.platformKey();
      try {
        const made = await createInstance(sandboxConfig.dataDir, { mode: 'demo', init: seedDemo, platformKey });
        await made.db.close();
        platform = made.platform;
      } finally {
        platformKey.fill(0);
      }
    }
    let registry = null;
    try {
      const build = async ({ householdId, generation, mode, relativeRoot }) => {
        await assertSyntheticStore(join(sandboxConfig.dataDir, relativeRoot, DB_FILE));
        const db = await openHouseholdDb({ dataDir: sandboxConfig.dataDir, householdId, storageRoot: relativeRoot });
        try {
          const root = join(sandboxConfig.dataDir, relativeRoot);
          const packs = createLivePacks(db, { dataDir: root });
          const engine = createPublicDemoEngine({ db, config: sandboxConfig, control, visitorId: id });
          // No jobs run in a sandbox: its scheduler has no handlers and is never started.
          return await createHouseholdContext({ householdId, generation, mode, db, relativeRoot, config: sandboxConfig, platform, secrets,
            engine, packs, handlers: {},
            answererFactory: options => limitDemoAnswerer(createLiveAnswerer(options), control, id, () => requestAddress.getStore()) });
        } catch (err) {
          await db.close();
          throw err;
        }
      };
      registry = createRuntimeRegistry({ platform, config: sandboxConfig, secrets, build });
      registry.demo();
      const handler = createHandler({ platform, config: sandboxConfig, runtimes: registry,
        auth: { demo: true, sweep() {}, session: () => ({ demo: true, publicDemo: true, identity: null }) } });
      const runtime = { active: 0,
        handler: (req, res) => requestAddress.run(clientAddress(req), () => handler(req, res)),
        close() { registry.close().catch(() => {}).finally(async () => await platform.close()); },
      };
      runtimes.set(id, runtime);
      return runtime;
    } catch (err) {
      registry?.close().catch(() => {});
      await platform.close();
      throw err;
    }
  };
  return {
    async handle(req, res) {
      setSecurityHeaders(res);
      let runtime;
      try {
        const raw = (req.url || '/').split('?')[0];
        const { path, segments } = normalizePath(raw);
        if (path === '/mcp' || ['/signin', '/enroll', '/account', '/admin/users'].includes(path)) throw new HttpError(403, DEMO_OFF_MESSAGE);
        if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
          sendJson(res, 200, { ok: true, schema: SHIPPED_SCHEMA, platformSchema: await schemaVersion(basePlatform), publicDemo: true });
          return;
        }
        if (segments[0] !== 'api') {
          if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'method not allowed');
          await serveStatic(req, res, '/' + segments.map(encodeURIComponent).join('/'));
          return;
        }
        const ip = clientAddress(req);
        if (!await control.rate(ip)) throw new HttpError(429, 'Demo request limit reached. Please try again shortly.', { 'Retry-After': '60' });
        if (!isAllowedHost(req.headers.host, config)) throw new HttpError(403, 'forbidden host');
        let route;
        try { route = findRoute(req.method, segments).r; }
        catch { throw new HttpError(403, DEMO_OFF_MESSAGE); }
        if (demoRouteBehavior(route.method, route.path) === 'off') throw new HttpError(403, DEMO_OFF_MESSAGE);
        if (req.method === 'POST') guardPost(req, { origin: new URL(config.publicUrl).origin });
        await cleanup();
        const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim().split('='));
        const supplied = cookies.find(([name]) => name === COOKIE_NAME)?.[1];
        const sandbox = await control.sandbox(supplied, ip);
        const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sandbox.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((sandbox.expires - Date.now()) / 1000))}${secure}`);
        runtime = await runtimeFor(sandbox.id);
        runtime.active++;
        await runtime.handler(req, res);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error('fathom: public demo request failed');
        if (req.readable) req.resume();
        sendError(res, err);
      } finally { if (runtime) runtime.active--; }
    },
    async close() {
      clearInterval(timer);
      for (const runtime of runtimes.values()) runtime.close();
      runtimes.clear();
      await control.close();
    },
  };
}

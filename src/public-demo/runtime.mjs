import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createInstance } from '../platform/db.mjs';
import { openServedStore } from '../platform/ready.mjs';
import { DB_FILE, getSetting, schemaVersion } from '../store/db.mjs';
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

export function assertSyntheticStore(file) {
  if (!existsSync(file)) return;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (getSetting(db, 'mode') !== 'demo' || getSetting(db, 'synthetic_demo') !== 'synthetic-v1') throw new Error();
  } catch { throw new Error('public demo: refusing a store without the synthetic seeder marker'); }
  finally { db?.close(); }
}

export function createPublicDemoHandler(config, baseDb) {
  const control = createDemoControl(config);
  const clientAddress = createClientAddressResolver(config.trustedProxies);
  const runtimes = new Map();
  const serveStatic = createStatic({ webDir: fileURLToPath(new URL('../../web/', import.meta.url)),
    sharedDir: fileURLToPath(new URL('../shared/', import.meta.url)) });
  const sandboxDir = id => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid sandbox identity');
    return join(config.dataDir, 'sandboxes', id);
  };
  const cleanup = () => control.cleanup(id => {
    const runtime = runtimes.get(id);
    if (runtime?.active) return false;
    runtime?.close();
    runtimes.delete(id);
    rmSync(sandboxDir(id), { recursive: true, force: true });
    return true;
  });
  cleanup();
  const timer = setInterval(cleanup, 60000);
  timer.unref();
  const runtimeFor = id => {
    if (runtimes.has(id)) return runtimes.get(id);
    const sandboxConfig = { ...config, dataDir: sandboxDir(id) };
    const file = join(sandboxConfig.dataDir, DB_FILE);
    assertSyntheticStore(file);
    const { db, platform } = existsSync(file) ? openServedStore(sandboxConfig)
      : createInstance(sandboxConfig.dataDir, { mode: 'demo', init: seedDemo });
    try {
      const packs = createLivePacks(db, { dataDir: sandboxConfig.dataDir });
      const engine = createPublicDemoEngine({ db, config: sandboxConfig, control, visitorId: id });
      const answerer = createLiveAnswerer({ engine, packs });
      const runtime = { active: 0, db, platform,
        handler(req, res) {
          const limited = limitDemoAnswerer(answerer, control, id, () => clientAddress(req));
          return createHandler({ db, platform, config: sandboxConfig, engine, packs, answerer: limited,
            auth: { sweep() {}, session: () => ({ demo: true, publicDemo: true, identity: null }) } })(req, res);
        },
        close() { db.close(); platform.close(); },
      };
      runtimes.set(id, runtime);
      return runtime;
    } catch (err) { db.close(); platform.close(); throw err; }
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
          sendJson(res, 200, { ok: true, schema: schemaVersion(baseDb), publicDemo: true });
          return;
        }
        if (segments[0] !== 'api') {
          if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'method not allowed');
          await serveStatic(req, res, '/' + segments.map(encodeURIComponent).join('/'));
          return;
        }
        const ip = clientAddress(req);
        if (!control.rate(ip)) throw new HttpError(429, 'Demo request limit reached. Please try again shortly.', { 'Retry-After': '60' });
        if (!isAllowedHost(req.headers.host, config)) throw new HttpError(403, 'forbidden host');
        let route;
        try { route = findRoute(req.method, segments).r; }
        catch { throw new HttpError(403, DEMO_OFF_MESSAGE); }
        if (demoRouteBehavior(route.method, route.path) === 'off') throw new HttpError(403, DEMO_OFF_MESSAGE);
        if (req.method === 'POST') guardPost(req, { origin: new URL(config.publicUrl).origin });
        cleanup();
        const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim().split('='));
        const supplied = cookies.find(([name]) => name === COOKIE_NAME)?.[1];
        const sandbox = control.sandbox(supplied, ip);
        const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sandbox.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((sandbox.expires - Date.now()) / 1000))}${secure}`);
        runtime = runtimeFor(sandbox.id);
        runtime.active++;
        await runtime.handler(req, res);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error('fathom: public demo request failed');
        if (req.readable) req.resume();
        sendError(res, err);
      } finally { if (runtime) runtime.active--; }
    },
    close() {
      clearInterval(timer);
      for (const runtime of runtimes.values()) runtime.close();
      runtimes.clear();
      control.close();
    },
  };
}

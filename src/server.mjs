// Fathom server: one process serving web/ (the Horizon UI), /shared/ (browser-safe shared
// logic) and the JSON API, backed by SQLite at $FATHOM_DATA/fathom.sqlite. One runtime engine
// (src/engine/runtime.mjs) and one live pack view (src/packs/live.mjs) are built at startup and
// handed to the API as ctx.engine and ctx.packs. After them, the
// email transport and the job scheduler are built and handed to the API as ctx.transport and
// ctx.scheduler; the scheduler starts once the server listens and stops before the store closes.
//
// Store mode (settings.mode, set when the store is created, never inferred from contents):
// no store file: create the instance (platform.sqlite with one served household, and the store
// bound to it); demo unless FATHOM_DEMO=0 (then real and empty). Demo stores are seeded once and
// keep their state across restarts. FATHOM_DEMO=1 refuses a real store and FATHOM_DEMO=0 refuses a
// demo store, without changing it. A file with no mode is real. An existing store opens only
// through openServedStore (src/platform/ready.mjs): a real store without platform.sqlite refuses
// platform_migration_required, a migration lock refuses platform_migration_in_progress, and a
// store bound to another household refuses household_store_mismatch.
// Ask threads trashed 30 or more days ago (app clock) are purged once the store is open.

import http from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validatePublicUrl } from './config.mjs';
import { readStoreMode, DB_FILE } from './store/db.mjs';
import { createInstance, LOCK_FILE } from './platform/db.mjs';
import { openServedStore, refuse } from './platform/ready.mjs';
import { createHandler } from './api/router.mjs';
import { createAuthService } from './auth/service.mjs';
import { createLiveAnswerer } from './api/answerer.mjs';
import { createKeyService, loadServerSecret } from './mcp/keys.mjs';
import { createMcpHandler } from './mcp/index.mjs';
import { createRuntimeEngine } from './engine/runtime.mjs';
import { createLivePacks } from './packs/live.mjs';
import { clockNow } from './scenario/build.mjs';
import { createTransport } from './email/transport.mjs';
import { createScheduler, defaultHandlers } from './jobs/scheduler.mjs';
import { seedDemo } from '../demo/seed.mjs';

export class StartupError extends Error {}

// Open (or create) the instance at config.dataDir following the store mode rules. Returns
// { db, platform }: the financial store and the platform DB; the caller closes both.
export function openStore(config) {
  mkdirSync(config.dataDir, { recursive: true });
  const file = join(config.dataDir, DB_FILE);
  const mode = readStoreMode(file);
  if (mode === null) {
    if (existsSync(join(config.dataDir, LOCK_FILE))) throw refuse('platform_migration_in_progress');
    const real = config.demo === false;
    if (real) validatePublicUrl(config.publicUrl, { required: true });
    const { db, platform } = createInstance(config.dataDir, { mode: real ? 'real' : 'demo', init: real ? () => {} : seedDemo });
    return { db, platform };
  }
  if (config.demo === true && mode !== 'demo') {
    throw new StartupError(`FATHOM_DEMO=1 but ${file} is a real store. Refusing to start; it is unchanged. Point FATHOM_DATA at another directory for the demo.`);
  }
  if (config.demo === false && mode === 'demo') {
    throw new StartupError(`FATHOM_DEMO=0 but ${file} is a demo store. Refusing to start; it is unchanged. Point FATHOM_DATA at the real data directory.`);
  }
  if (mode === 'real') validatePublicUrl(config.publicUrl, { required: true });
  const { db, platform } = openServedStore(config);
  return { db, platform };
}

// Log-safe code for a startup failure: never the message, which could carry a value.
const codeOf = err => [err && err.code, err && err.name].find(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v)) || 'unknown';

// Real stores rebuild pack definitions from the pack manifests and the stored facts at startup
// (demo pack definitions are the seeded scenario; a demo store only gains a row for a Your plans
// pack no row backs). A pack load failure never stops startup.
function refreshPacks(packs) {
  try {
    packs.refresh();
  } catch (err) {
    console.error('fathom: pack state refresh failed', codeOf(err));
  }
}

// A reverse proxy keeps idle upstream connections open and reuses them; Node's default 5 s
// keep-alive timeout can close one just as the proxy sends on it (a 502 with an EOF upstream).
// Idle connections stay open longer than common proxy idle timeouts, and headersTimeout must
// exceed keepAliveTimeout.
export const KEEP_ALIVE_TIMEOUT_MS = 65000;
export const HEADERS_TIMEOUT_MS = 66000;

export function applyTimeouts(server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

export async function startServer(config = loadConfig()) {
  const { db, platform } = openStore(config);
  const closeStores = () => {
    try { db.close(); } catch { /* already closed */ }
    try { platform.close(); } catch { /* already closed */ }
  };
  let transport;
  let auth;
  try {
    transport = createTransport(config);
    auth = createAuthService({ platform, config, transport });
  } catch (e) {
    closeStores();
    throw e;
  }
  // One runtime engine per process, on the scenario clock so spend lands in the month the Engine
  // screen shows; packs load from the repository and the data volume.
  let engine;
  let packs;
  try {
    packs = createLivePacks(db, { dataDir: config.dataDir });
    refreshPacks(packs);
    engine = createRuntimeEngine({ db, config, now: () => new Date(clockNow(db, config.clock)) });
    await engine.init();
    if (engine.credentialState === 'failed') console.error('fathom: engine credential unavailable');
  } catch (e) {
    closeStores();
    throw e;
  }
  let keys;
  try {
    keys = createKeyService({ db, serverSecret: loadServerSecret(config.dataDir), creatorActive: auth.creatorActive });
  } catch (e) {
    closeStores();
    throw new StartupError(`API key secret: ${e.message}`);
  }
  const mcp = createMcpHandler({ db, keys, config });
  let scheduler = null;
  try {
    scheduler = createScheduler({ db, config, engine, handlers: defaultHandlers({ publicUrl: config.publicUrl }), transport });
  } catch (err) {
    console.error('fathom: scheduler unavailable', codeOf(err));
  }
  const answerer = createLiveAnswerer({ engine, packs });
  const server = http.createServer(createHandler({ db, platform, config, answerer, engine, packs, keys, mcp, auth, scheduler, transport }));
  applyTimeouts(server);
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
  } catch (e) {
    closeStores();
    if (e && e.code === 'EADDRINUSE') {
      throw new StartupError(`port ${config.port} on ${config.host} is already in use. Set FATHOM_PORT to a free port.`);
    }
    throw e;
  }
  if (scheduler) {
    try {
      const started = scheduler.start();
      if (started && typeof started.then === 'function') started.then(null, err => console.error('fathom: scheduler start failed', codeOf(err)));
    } catch (err) {
      console.error('fathom: scheduler start failed', codeOf(err));
    }
  }
  const { port } = server.address();
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  let closed = false;
  return {
    server,
    db,
    platform,
    url: `http://${host}:${port}`,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      let stopped = Promise.resolve();
      try {
        if (scheduler) stopped = Promise.resolve(scheduler.stop()).catch(() => {});
      } catch { /* stop failed; close anyway */ }
      return stopped.then(() => new Promise(done => {
        server.close(() => { closeStores(); done(); });
        server.closeAllConnections();
      }));
    },
  };
}

async function main() {
  let app;
  try {
    app = await startServer(loadConfig());
  } catch (e) {
    console.error(`fathom: ${e.message}`);
    process.exit(1);
  }
  console.log(`fathom listening on ${app.url}`);
  const stop = () => {
    setTimeout(() => process.exit(0), 3000).unref();
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

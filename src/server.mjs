// Fathom server: one process serving web/ (the Horizon UI), /shared/ (browser-safe shared
// logic), the JSON API and the MCP endpoint over the instance in $FATHOM_DATA: platform.sqlite
// (accounts, memberships, sessions, MCP keys, outbound flags) and one root per household,
// households/<id>/ (its fathom.sqlite, files, packs, outbox and work). There is no process-wide
// financial store: the runtime registry (src/platform/runtime.mjs) builds one context per
// household (store, vault, packs, engine, answerer, scheduler, transport) and every request, MCP
// call and job resolves its own. Schedulers start once the server listens and stop before the
// stores close.
//
// Instance mode (the original household's mode, set at creation, never inferred from contents):
// no instance: create one (createInstance); demo unless FATHOM_DEMO=0 (then real and empty). Demo
// instances are seeded once, keep their state across restarts and keep synthetic secrets under
// platform-secrets/. FATHOM_DEMO=1 refuses a real instance and FATHOM_DEMO=0 refuses a demo
// instance, without changing it. An existing instance opens only through openInstance
// (src/platform/ready.mjs), which refuses unmigrated layouts with fixed codes. Real instances read
// FATHOM_PLATFORM_KEY_FILE and FATHOM_MCP_SECRET_FILE lazily: a missing platform key refuses
// vault operations (uploads 409) and a missing MCP secret refuses key routes (503) and /mcp (401),
// but the server still starts.
// Auth mail goes through the instance transport; its dev outbox is <dataDir>/outbox (platform-private).

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validatePublicUrl } from './config.mjs';
import { createInstance } from './platform/db.mjs';
import { openInstance, StartupError } from './platform/ready.mjs';
import { createInstanceSecrets } from './platform/secrets.mjs';
import { createRuntimeRegistry } from './platform/runtime.mjs';
import { carryAllHouseholds } from './platform/model-carry.mjs';
import { createHandler } from './api/router.mjs';
import { createAuthService } from './auth/service.mjs';
import { createKeyService } from './mcp/keys.mjs';
import { createMcpHandler } from './mcp/index.mjs';
import { createEnrollmentTransport } from './email/transport.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { backfillMergedIdentity } from './ingest/account-merge.mjs';
import { assertSyntheticStore, createPublicDemoHandler } from './public-demo/runtime.mjs';
import { DB_FILE } from './store/db.mjs';

export { StartupError };

const MODE_MISMATCH = {
  real: 'FATHOM_DEMO=1 but the data directory holds a real instance. Refusing to start; it is unchanged. Point FATHOM_DATA at another directory for the demo.',
  demo: 'FATHOM_DEMO=0 but the data directory holds a demo instance. Refusing to start; it is unchanged. Point FATHOM_DATA at the real data directory.',
};

// Open (or create) the instance at config.dataDir following the instance mode rules. Returns
// { platform, mode, secrets }; the caller closes the platform.
export function openOrCreateInstance(config) {
  mkdirSync(config.dataDir, { recursive: true });
  const opened = openInstance(config);
  if (!opened) {
    const mode = config.demo === false ? 'real' : 'demo';
    if (mode === 'real') validatePublicUrl(config.publicUrl, { required: true });
    const secrets = createInstanceSecrets({ config, mode });
    // A demo always has its key; a real instance provisions its first data key now only when the
    // platform key is already configured (otherwise the vault provisions it on first use).
    let platformKey = null;
    try {
      platformKey = secrets.platformKey();
    } catch (err) {
      if (mode === 'demo') throw err;
    }
    try {
      const made = createInstance(config.dataDir, { mode, init: mode === 'demo' ? seedDemo : () => {}, platformKey });
      made.db.close();
      return { platform: made.platform, mode, secrets };
    } finally {
      platformKey?.fill(0);
    }
  }
  const { platform, mode } = opened;
  try {
    // A public demo serves only a synthetic seeded demo; that refusal comes before any other.
    if (config.publicDemo) assertPublicDemoInstance(config, platform, mode);
    if ((config.demo === true && mode !== 'demo') || (config.demo === false && mode === 'demo')) {
      throw new StartupError('instance_mode_mismatch', MODE_MISMATCH[mode]);
    }
    if (mode === 'real') validatePublicUrl(config.publicUrl, { required: true });
  } catch (e) {
    platform.close();
    throw e;
  }
  return { platform, mode, secrets: createInstanceSecrets({ config, mode }) };
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

// Log-safe code for a startup failure: never the message, which could carry a value.
const codeOf = err => [err && err.code, err && err.name].find(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v)) || 'unknown';

// Survivors of merges made before the carry-over existed get their institution and last 4 from
// their SimpleFIN snapshot, in every served household. A failure never stops startup.
function backfillMerged(runtimes) {
  for (const id of runtimes.list()) {
    try {
      const household = runtimes.get(id);
      if (household) backfillMergedIdentity(household.db);
    } catch (err) {
      console.error('fathom: merged account backfill failed', codeOf(err));
    }
  }
}

// A public demo serves only synthetic sandboxes: the instance must be a demo whose household
// store carries the seeder's marker.
function assertPublicDemoInstance(config, platform, mode) {
  const row = platform.prepare('SELECT storage_root FROM households WHERE serves_store = 1').get();
  if (mode !== 'demo' || !row?.storage_root) throw new Error('public demo: refusing a store without the synthetic seeder marker');
  assertSyntheticStore(join(config.dataDir, row.storage_root, DB_FILE));
}

async function listen(server, config) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

const urlOf = (server, config) => `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${server.address().port}`;

async function startPublicDemo(config, platform) {
  let demo;
  try {
    demo = createPublicDemoHandler(config, { platform });
  } catch (err) {
    try { platform.close(); } catch { /* already closed */ }
    throw err;
  }
  const server = applyTimeouts(http.createServer(demo.handle));
  try {
    await listen(server, config);
  } catch (err) {
    demo.close();
    platform.close();
    throw err;
  }
  let closing = null;
  return {
    server, platform, runtimes: null, url: urlOf(server, config),
    close() {
      closing ??= new Promise(done => {
        server.close(() => { demo.close(); platform.close(); done(); });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

// options.engineOptions ({ testTransport, fundingNow }) is programmatic only, for tests: the
// `node src/server.mjs` entry passes none and no config or environment key sets it.
export async function startServer(config = loadConfig(), { engineOptions = {} } = {}) {
  const { platform, mode, secrets } = openOrCreateInstance(config);
  if (config.publicDemo) return startPublicDemo(config, platform);
  let runtimes = null;
  const closeAll = async () => {
    try { await runtimes?.close(); } catch { /* close anyway */ }
    try { platform.close(); } catch { /* already closed */ }
  };
  let server;
  try {
    const transport = createEnrollmentTransport(config, { outboxDir: join(config.dataDir, 'outbox') });
    const auth = createAuthService({ platform, config, transport, secrets });
    // Live mode: every household's pre-MT-05 spend is carried before any household is admitted.
    if (config.engine === 'live') carryAllHouseholds(platform, { dataDir: config.dataDir, now: (engineOptions.fundingNow ?? Date.now)() });
    runtimes = createRuntimeRegistry({ platform, config, secrets, engineOptions });
    backfillMerged(runtimes);
    const keys = createKeyService({ platform, secret: () => secrets.mcpSecret(), creatorActive: auth.creatorActive });
    const mcp = createMcpHandler({ keys, runtimes, config });
    server = http.createServer(createHandler({ platform, config, runtimes, auth, keys, mcp }));
  } catch (e) {
    await closeAll();
    throw e;
  }
  applyTimeouts(server);
  try {
    await listen(server, config);
  } catch (e) {
    await closeAll();
    if (e && e.code === 'EADDRINUSE') {
      throw new StartupError('port_in_use', `port ${config.port} on ${config.host} is already in use. Set FATHOM_PORT to a free port.`);
    }
    throw e;
  }
  runtimes.startAll();
  let closing = null;
  return {
    server,
    platform,
    runtimes,
    url: urlOf(server, config),
    close() {
      closing ??= new Promise(done => {
        server.close(() => done());
        server.closeAllConnections();
      }).then(closeAll);
      return closing;
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

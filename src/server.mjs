// Fathom server: one process serving web/ (the Horizon UI), /shared/ (browser-safe shared
// logic) and the JSON API, backed by SQLite at $FATHOM_DATA/fathom.sqlite.
//
// Store mode (settings.mode, set when the store is created, never inferred from contents):
// no store file: create it; demo unless FATHOM_DEMO=0 (then real and empty). Demo stores are
// seeded once and keep their state across restarts. FATHOM_DEMO=1 refuses a real store and
// FATHOM_DEMO=0 refuses a demo store, without changing it. A file with no mode is real.

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { openDb, migrate, readStoreMode, createStoreFile, setSetting, DB_FILE } from './store/db.mjs';
import { createHandler } from './api/router.mjs';
import { createCannedAnswerer } from './api/answerer.mjs';
import { seedDemo } from '../demo/seed.mjs';

export class StartupError extends Error {}

// Open (or create) the store at config.dataDir following the store mode rules.
export function openStore(config) {
  mkdirSync(config.dataDir, { recursive: true });
  const file = join(config.dataDir, DB_FILE);
  const mode = readStoreMode(file);
  if (mode === null) {
    return createStoreFile(file, db => {
      if (config.demo === false) setSetting(db, 'mode', 'real');
      else seedDemo(db);
    });
  }
  if (config.demo === true && mode !== 'demo') {
    throw new StartupError(`FATHOM_DEMO=1 but ${file} is a real store. Refusing to start; it is unchanged. Point FATHOM_DATA at another directory for the demo.`);
  }
  if (config.demo === false && mode === 'demo') {
    throw new StartupError(`FATHOM_DEMO=0 but ${file} is a demo store. Refusing to start; it is unchanged. Point FATHOM_DATA at the real data directory.`);
  }
  const db = openDb(file);
  try {
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export async function startServer(config = loadConfig()) {
  const db = openStore(config);
  const answerer = createCannedAnswerer();
  const server = http.createServer(createHandler({ db, config, answerer }));
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
  } catch (e) {
    db.close();
    if (e && e.code === 'EADDRINUSE') {
      throw new StartupError(`port ${config.port} on ${config.host} is already in use. Set FATHOM_PORT to a free port.`);
    }
    throw e;
  }
  const { port } = server.address();
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  let closed = false;
  return {
    server,
    db,
    url: `http://${host}:${port}`,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise(done => {
        server.close(() => { db.close(); done(); });
        server.closeAllConnections();
      });
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

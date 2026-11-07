// npm run build:your-plans [-- --file <id> ...]
// Builds the private Your plans pack from the plan and benefits documents in the existing store at
// $FATHOM_DATA (plus any extra files named with --file), through the engine FATHOM_ENGINE selects.
// Uploads are read through the vault under the data key (FATHOM_DATA_KEY_FILE, or the demo store's
// generated key). Refuses when there is no store or no data key. Prints counts only (entries, sources, sections dropped because
// they did not match the document, warnings), never document text. A written pack refreshes the
// store's pack rows here; a running server loads its manifest on its next request (settings
// packs.generation changes). A real store opens only through openServedStore.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openMigrated, getSetting, readStoreMode, DB_FILE } from '../src/store/db.mjs';
import { openServedStore } from '../src/platform/ready.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { clockNow } from '../src/scenario/build.mjs';
import { buildYourPlans, YourPlansRefusal } from '../src/packs/your-plans.mjs';
import { loadDataKey, VaultError } from '../src/ingest/vault.mjs';
import { refreshLivePacks } from '../src/packs/live.mjs';
import { EngineOffError, BudgetExceededError } from '../src/engine/index.mjs';

const NAME = 'build:your-plans';

function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const fileIds = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && typeof argv[i + 1] === 'string' && argv[i + 1]) fileIds.push(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(argv[i])}; usage: npm run ${NAME} -- [--file <id>]...`);
  }
  return fileIds;
}

async function main() {
  const fileIds = parseArgs(process.argv.slice(2));
  let config;
  try { config = loadConfig(); } catch (e) { fail(e.message); }
  const file = join(config.dataDir, DB_FILE);
  if (!existsSync(file)) fail('there is no store in FATHOM_DATA; start the server once (or run seed:demo) first.');
  let db;
  try {
    if (readStoreMode(file) === 'demo') db = openMigrated(file);
    else {
      const served = openServedStore(config);
      served.platform.close();
      db = served.db;
    }
  } catch (e) {
    fail(e.name === 'StartupError' ? e.message : 'the store could not be opened');
  }
  try {
    const engine = createRuntimeEngine({ db, config, now: () => new Date(clockNow(db, config.clock)) });
    const key = await loadDataKey({ dataDir: config.dataDir, keyFile: config.dataKeyFile, mode: getSetting(db, 'mode', null) === 'demo' ? 'demo' : 'real' });
    const result = await buildYourPlans({ db, engine, dataDir: config.dataDir, key, fileIds, clock: config.clock || undefined });
    if (result.written) refreshLivePacks(db, { dataDir: config.dataDir });
    const counts = `${result.entries} entries from ${result.sources.length} sources, ${result.dropped} sections dropped, ${result.warnings.length} warnings`;
    console.log(`${NAME}: ${result.written ? 'built the Your plans pack' : 'nothing to write'}: ${counts}`);
  } catch (e) {
    if (e instanceof YourPlansRefusal || e instanceof VaultError) fail(e.message);
    if (e instanceof EngineOffError) fail('the engine is off; switch it on or set FATHOM_ENGINE.');
    if (e instanceof BudgetExceededError) fail("this month's engine budget is used up; raise the cap first.");
    fail(`the build failed (${e && e.name ? e.name : 'error'}).`);
  } finally {
    db.close();
  }
}

main();

// `npm run plan`: one planning run over the real store in $FATHOM_DATA. Prints the run counts as
// JSON and the warning codes, never amounts. Exit 2 when there is no store or it is a demo store
// (nothing is created or changed), 1 when the run fails.

import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { openMigrated, readStoreMode, DB_FILE } from '../store/db.mjs';
import { createRuntimeEngine } from '../engine/runtime.mjs';
import { defaultPackDirs } from '../packs/state.mjs';
import { runPlanning } from './planner.mjs';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`plan: ${e.message}`);
    return 1;
  }
  const file = join(config.dataDir, DB_FILE);
  const mode = readStoreMode(file);
  if (mode === null) {
    console.error('plan: no store in FATHOM_DATA; start the server once with FATHOM_DEMO=0 to create one.');
    return 2;
  }
  if (mode === 'demo') {
    console.error('plan: FATHOM_DATA holds a demo store; planning runs on real stores only.');
    return 2;
  }
  const db = openMigrated(file);
  try {
    const engine = createRuntimeEngine({ db, config });
    const result = await runPlanning(db, engine, { now: config.clock || undefined, packDirs: defaultPackDirs(config.dataDir) });
    console.log(JSON.stringify(result.counts));
    if (result.warnings.length) console.log(`warnings: ${result.warnings.join(' ')}`);
    return 0;
  } catch (e) {
    console.error(`plan: run failed (${e && e.constructor ? e.constructor.name : 'Error'})`);
    return 1;
  } finally {
    db.close();
  }
}

main().then(code => { process.exitCode = code; });

// `npm run confirm:guess`: backfill engine guesses for every pending confirm question in the store
// in $FATHOM_DATA (plan D7). Prints one JSON line, {skipped} or {batches, items, guessed, costUsd,
// stopped?}, never a question or a value. Exit 0 when the run finishes or is skipped, 1 when there
// is no store (nothing is created) or the run fails.

import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { openMigrated, readStoreMode, DB_FILE } from '../store/db.mjs';
import { createRuntimeEngine } from '../engine/runtime.mjs';
import { guessPending } from '../ingest/guess.mjs';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`confirm:guess: ${e.message}`);
    return 1;
  }
  const file = join(config.dataDir, DB_FILE);
  if (readStoreMode(file) === null) {
    console.error('confirm:guess: no store in FATHOM_DATA; start the server once to create one.');
    return 1;
  }
  const db = openMigrated(file);
  try {
    const engine = createRuntimeEngine({ db, config });
    await engine.init();
    const out = await guessPending(db, engine);
    if (out.skipped) {
      console.log(JSON.stringify({ skipped: out.skipped }));
      return 0;
    }
    const sum = (key) => out.batches.reduce((n, b) => n + (Number(b[key]) || 0), 0);
    console.log(JSON.stringify({
      batches: out.batches.length, items: sum('items'), guessed: sum('guessed'), costUsd: Number(sum('costUsd').toFixed(6)),
      ...(out.stopped ? { stopped: out.stopped } : {}),
    }));
    return 0;
  } catch (e) {
    console.error(`confirm:guess: run failed (${e && e.constructor ? e.constructor.name : 'Error'})`);
    return 1;
  } finally {
    db.close();
  }
}

main().then(code => { process.exitCode = code; });

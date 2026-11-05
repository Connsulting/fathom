// `npm run plan`: one manual planning run over the real store in $FATHOM_DATA, through a scheduler
// that has only the plan handler (planning runs only through the scheduler, so the run takes the
// job lease and gets its job_runs row like any other). Prints the run counts as JSON and the
// warning codes, never amounts. Exit 2 when there is no store or it is a demo store (nothing is
// created or changed), 3 when another process (the server) holds the job lease, 1 when the run
// fails.

import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { openMigrated, readStoreMode, DB_FILE } from '../store/db.mjs';
import { createRuntimeEngine } from '../engine/runtime.mjs';
import { createScheduler, defaultHandlers, SchedulerError } from './scheduler.mjs';

const quiet = { log() {} };

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
  let scheduler = null;
  try {
    const engine = createRuntimeEngine({ db, config });
    const base = defaultHandlers({ publicUrl: config.publicUrl }).plan;
    let planning = null;
    const plan = async (ctx) => {
      const out = await base(ctx);
      planning = out.planning;
      return out;
    };
    scheduler = createScheduler({ db, config, engine, handlers: { plan }, log: quiet });
    const run = await scheduler.runNow('plan');
    if (!run || run.status !== 'ok' || !planning) {
      console.error(`plan: run failed (${(run && run.errorClass) || 'Error'})`);
      return 1;
    }
    console.log(JSON.stringify(planning.counts));
    if (planning.warnings.length) console.log(`warnings: ${planning.warnings.join(' ')}`);
    return 0;
  } catch (e) {
    if (e instanceof SchedulerError && e.code === 'locked') {
      console.error('plan: another Fathom process (likely the running server) holds the job lease; use Run now on the plan job in the app, or POST /api/jobs/plan/run.');
      return 3;
    }
    console.error(`plan: run failed (${e && e.constructor ? e.constructor.name : 'Error'})`);
    return 1;
  } finally {
    if (scheduler) await scheduler.stop();
    db.close();
  }
}

main().then(code => { process.exitCode = code; });

// `npm run confirm:guess`: one manual run of the confirm-guess job over the store in $FATHOM_DATA,
// through a scheduler that has only the confirm-guess handler (guesses run only through the
// scheduler, so the run takes the job lease and gets its job_runs row like any other). Prints one
// JSON line {status, note} (counts only, never a question or a value). Exit 0 when the run is ok
// or skipped, 1 when there is no store (nothing is created) or the run fails, 3 when another
// process (the server) holds the job lease.

import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { openMigrated, readStoreMode, DB_FILE } from '../store/db.mjs';
import { createRuntimeEngine } from '../engine/runtime.mjs';
import { createScheduler, defaultHandlers, SchedulerError } from './scheduler.mjs';

const JOB = 'confirm-guess';
const quiet = { log() {} };

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
  let scheduler = null;
  try {
    const engine = createRuntimeEngine({ db, config });
    await engine.init();
    const handlers = { [JOB]: defaultHandlers({ publicUrl: config.publicUrl })[JOB] };
    scheduler = createScheduler({ db, config, engine, handlers, log: quiet });
    const run = await scheduler.runNow(JOB);
    if (!run || !['ok', 'skipped'].includes(run.status)) {
      console.error(`confirm:guess: run failed (${(run && run.errorClass) || 'Error'})`);
      return 1;
    }
    console.log(JSON.stringify({ status: run.status, note: run.note }));
    return 0;
  } catch (e) {
    if (e instanceof SchedulerError && e.code === 'locked') {
      console.error(`confirm:guess: another Fathom process (likely the running server) holds the job lease; use Run now on the ${JOB} job in the app, or POST /api/jobs/${JOB}/run.`);
      return 3;
    }
    console.error(`confirm:guess: run failed (${e && e.constructor ? e.constructor.name : 'Error'})`);
    return 1;
  } finally {
    if (scheduler) await scheduler.stop();
    db.close();
  }
}

main().then(code => { process.exitCode = code; });

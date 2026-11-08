// `npm run confirm:guess -- --household <id>`: one manual run of the confirm-guess job over that
// household's store, through a scheduler with the resolver and its follow-up plan handler (resolution runs only
// through the scheduler, so the run takes the job lease, gets its job_runs row like any other and
// honours the household's outbound jobs flag). Prints one JSON line {status, note} (counts only,
// never a question or a value). Exit 0 when the run is ok or skipped, 1 when the household cannot
// be opened (a fixed code) or the run fails, 3 when another process (the server) holds the job
// lease or the household's outbound jobs are paused.

import { loadConfig } from '../config.mjs';
import { openCliHousehold } from '../platform/cli.mjs';
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
  let cli;
  try {
    cli = await openCliHousehold(config, process.argv.slice(2));
  } catch (e) {
    console.error(`confirm:guess: ${typeof e?.code === 'string' ? e.code : 'store_unavailable'}`);
    return 1;
  }
  const { household } = cli;
  let scheduler = null;
  try {
    await household.engine.init();
    const defaults = defaultHandlers({ publicUrl: config.publicUrl });
    const handlers = { [JOB]: defaults[JOB], plan: defaults.plan };
    scheduler = createScheduler({
      db: household.db, config, engine: household.engine, handlers, log: quiet,
      allowed: () => household.outbound.enabled('jobs'), household: () => household,
    });
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
    if (e instanceof SchedulerError && e.code === 'paused') {
      console.error('confirm:guess: outbound jobs are paused for that household; an admin resumes them in the app.');
      return 3;
    }
    console.error(`confirm:guess: run failed (${e && e.constructor ? e.constructor.name : 'Error'})`);
    return 1;
  } finally {
    if (scheduler) await scheduler.stop();
    await cli.close();
  }
}

main().then(code => { process.exitCode = code; });

// `npm run plan -- --household <id>`: one manual planning run over that household's store, through
// a scheduler that has only the plan handler (planning runs only through the scheduler, so the run
// takes the job lease and gets its job_runs row like any other, and honours the household's
// outbound jobs flag). Prints the run counts as JSON and the warning codes, never amounts. Exit 2
// when the household is a demo household (nothing is changed), 3 when another process (the
// server) holds the job lease or the household's outbound jobs are paused, 1 when the household
// cannot be opened (a fixed code: household_required, household_unavailable or a readiness code)
// or the run fails.

import { loadConfig } from '../config.mjs';
import { openCliHousehold } from '../platform/cli.mjs';
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
  let cli;
  try {
    cli = await openCliHousehold(config, process.argv.slice(2));
  } catch (e) {
    console.error(`plan: ${typeof e?.code === 'string' ? e.code : 'store_unavailable'}`);
    return 1;
  }
  const { household } = cli;
  let scheduler = null;
  try {
    if (household.mode === 'demo') {
      console.error('plan: that household is a demo household; planning runs on real households only.');
      return 2;
    }
    const base = defaultHandlers({ publicUrl: config.publicUrl }).plan;
    let planning = null;
    const plan = async (ctx) => {
      const out = await base(ctx);
      planning = out.planning;
      return out;
    };
    scheduler = createScheduler({
      db: household.db, config, engine: household.engine, handlers: { plan }, log: quiet,
      allowed: async () => await household.outbound.enabled('jobs'), household: () => household,
    });
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
    if (e instanceof SchedulerError && e.code === 'paused') {
      console.error('plan: outbound jobs are paused for that household; an admin resumes them in the app.');
      return 3;
    }
    console.error(`plan: run failed (${e && e.constructor ? e.constructor.name : 'Error'})`);
    return 1;
  } finally {
    if (scheduler) await scheduler.stop();
    await cli.close();
  }
}

main().then(code => { process.exitCode = code; });

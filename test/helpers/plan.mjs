// Planning in tests goes the way production plans: through a scheduler with the default plan
// handler (src/jobs/scheduler.mjs), which claims the job_runs row and hands its id to the planner.
//
// planRun(db, {engine, now, dataDir})  -> Promise<{runId, status, counts, warnings, costUsd, run}>
//   one manual run (runNow('plan')) on a scheduler built for this call and stopped after it.
//   `now` is the scheduler's fixed clock (an ISO date); `dataDir` is the instance data directory
//   whose original household root (households/<id>, its packs/your-plans) feeds defaultPackDirs
//   through ctx.household.root (null: the repo packs only). A run whose handler threw rejects with that error after the scheduler
//   recorded it; a skipped run (demo store) resolves with status 'skipped' and no planner fields.
// claimPlanRun(db, {now})                -> job_runs id, for tests that call runPlanning directly
//   (a manual-style claim, as the scheduler makes, with the plan jobs row ensured).

import { createScheduler, defaultHandlers, JOBS } from '../../src/jobs/scheduler.mjs';
import { CLOCK } from './real-store.mjs';
import { servedStore } from './server.mjs';

const quiet = { log() {} };
let seq = 0;

export async function planRun(db, { engine = null, now = CLOCK, dataDir = null } = {}) {
  const base = defaultHandlers({ publicUrl: null }).plan;
  let out = null;
  let failure = null;
  const plan = async (ctx) => {
    try {
      out = await base(ctx);
      return out;
    } catch (e) {
      failure = e;
      throw e;
    }
  };
  // The plan handler reads only the household root from its household context.
  const household = { root: dataDir ? (await servedStore(dataDir))?.root ?? null : null };
  const s = createScheduler({
    db, config: { clock: now, dataDir }, engine, handlers: { plan }, household: () => household,
    tickMs: 3600000, holder: `test-plan-${process.pid}-${++seq}`, log: quiet,
  });
  try {
    const run = await s.runNow('plan');
    if (failure) throw failure;
    if (!out || !out.planning) return { runId: run.id, status: run.status, run };
    const p = out.planning;
    return { runId: p.runId, status: run.status, counts: p.counts, warnings: p.warnings, costUsd: p.costUsd, run };
  } finally {
    await s.stop();
  }
}

export async function claimPlanRun(db, { now = new Date().toISOString() } = {}) {
  const job = JOBS.find((j) => j.id === 'plan');
  await db.prepare('INSERT OR IGNORE INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 100)')
    .run(job.id, job.name, job.cadence, job.does);
  return (await db.prepare("INSERT INTO job_runs (job_id, started_at, status, period_key, trigger) VALUES ('plan', ?, 'running', ?, 'manual') RETURNING id")
    .get(now, `manual:${now}+test${++seq}`)).id;
}

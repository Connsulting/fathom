import { queueAccountPairs } from '../ingest/account-merge.mjs';
import { buildScenario } from '../scenario/build.mjs';
import { tourPending } from '../auth/tour.mjs';
import { serviceStatus } from '../jobs/service-status.mjs';

const OUTBOUND = ['jobs', 'email', 'simplefin', 'engine'];

// The shared service status for this context (GET /api/jobs and the scenario), or null when the
// context cannot give one. Read-only; a failure never fails the caller.
export async function servicesOf(ctx) {
  try {
    const guard = ctx.household?.outbound;
    const outbound = Object.fromEntries(OUTBOUND.map((k) => [k, typeof guard?.enabled === 'function' ? guard.enabled(k) === true : true]));
    return await serviceStatus({
      db: ctx.db, outbound, engine: ctx.household?.engine ?? ctx.engine ?? null,
      scheduler: ctx.scheduler ?? ctx.household?.scheduler ?? null, now: new Date(),
    });
  } catch {
    return null;
  }
}

export async function scenarioOf(ctx) {
  await queueAccountPairs(ctx.db);
  const scenario = await buildScenario(ctx.db, { clock: ctx.config && ctx.config.clock, engineMode: ctx.config && ctx.config.engine, modelConfig: ctx.config?.modelPorts, packs: ctx.packs || null });
  scenario.live.publicDemo = ctx.config?.publicDemo === true;
  // The signed-in user's own tour flag; false for a demo or any caller without an identity.
  scenario.live.tourPending = await tourPending(ctx);
  scenario.live.services = await servicesOf(ctx);
  return scenario;
}


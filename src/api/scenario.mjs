import { queueAccountPairs } from '../ingest/account-merge.mjs';
import { buildScenario } from '../scenario/build.mjs';
import { tourPending } from '../auth/tour.mjs';

export function scenarioOf(ctx) {
  queueAccountPairs(ctx.db);
  const scenario = buildScenario(ctx.db, { clock: ctx.config && ctx.config.clock, engineMode: ctx.config && ctx.config.engine, modelConfig: ctx.config?.modelPorts, packs: ctx.packs || null });
  scenario.live.publicDemo = ctx.config?.publicDemo === true;
  // The signed-in user's own tour flag; false for a demo or any caller without an identity.
  scenario.live.tourPending = tourPending(ctx);
  return scenario;
}


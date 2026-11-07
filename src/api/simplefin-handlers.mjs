// SimpleFIN connection API: connect with a setup token, disconnect, and the status that rides in
// the scenario (live.simplefin). The access URL never appears in a response, a log or an error:
// errors map to fixed messages and the router logs these routes as a code only. Connecting while
// the household's simplefin outbound flag is off is 409; a vault refusal is 409 naming
// FATHOM_PLATFORM_KEY_FILE. Sync runs only
// through the scheduler job 'simplefin-sync' (POST /api/jobs/simplefin-sync/run is Sync now).

import { getSetting } from '../store/db.mjs';
import { VaultError } from '../ingest/vault.mjs';
import { connectSimplefin, disconnectSimplefin, createFakeSimplefin, SimplefinError } from '../ingest/simplefin.mjs';
import { clockNow } from '../scenario/build.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';

const MAX_TOKEN = 4096;

// A demo store always talks to the synthetic fake bridge; a real store to the network, behind the
// allowlist.
export function simplefinFetchFor(ctx) {
  if (getSetting(ctx.db, 'mode', null) === 'demo') return createFakeSimplefin({ today: () => clockNow(ctx.db, ctx.config && ctx.config.clock).slice(0, 10) });
  return globalThis.fetch;
}

export async function connect(ctx) {
  const token = ctx.body.token;
  if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN) throw new HttpError(400, 'paste the SimpleFIN setup token');
  let status;
  try {
    status = await connectSimplefin(ctx.db, token, { household: ctx.household, hosts: ctx.config.simplefinHosts, fetch: simplefinFetchFor(ctx), now: new Date().toISOString() });
  } catch (err) {
    if (err instanceof SimplefinError) throw new HttpError(err.status, err.message);
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
  // The first sync runs now, under the lease; a busy scheduler leaves it to the next run.
  let run = null;
  if (ctx.scheduler) {
    try { run = await ctx.scheduler.runNow('simplefin-sync'); } catch { run = null; }
  }
  return { scenario: scenarioOf(ctx), connected: status.connected, run };
}

export function disconnect(ctx) {
  const out = disconnectSimplefin(ctx.db);
  return { scenario: scenarioOf(ctx), disconnected: out.disconnected };
}

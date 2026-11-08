// POST /api/tour/seen: the signed-in user finished or dismissed the guided tour. Clears the flag on
// the caller's own row (never one named in the request) and answers with the fresh scenario.

import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { setTourPending } from '../auth/tour.mjs';

export async function tourSeen(ctx) {
  if (typeof ctx.identity?.id !== 'string' || !ctx.platform) throw new HttpError(401, 'unauthorized');
  await setTourPending(ctx, false);
  return { scenario: await scenarioOf(ctx) };
}

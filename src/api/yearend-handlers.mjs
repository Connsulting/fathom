// Year end API: the "not needed this year" marks and the packet download. Both sit behind the owner
// gate in real mode like every /api route. The packet route is `raw`: it writes the zip to the
// response itself.

import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { getSetting } from '../store/db.mjs';
import { resolveClock } from '../scenario/build.mjs';
import { loadDataKey, VaultError } from '../ingest/vault.mjs';
import { taxYearFor, yearendChecklist, setMark } from '../yearend/expected.mjs';
import { buildPacket, streamPacket } from '../yearend/packet.mjs';

export const MAX_REASON = 300;

function yearOf(ctx, raw) {
  const clock = resolveClock(ctx.db, ctx.config && ctx.config.clock);
  if (raw === undefined || raw === null || raw === '') return { year: taxYearFor(clock), clock };
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'year must be a four digit tax year');
  return { year, clock };
}

// POST /api/yearend/marks {year?, key, reason}: mark an expected item not needed this year (reason
// required, at most MAX_REASON characters), or clear the mark with reason null.
export function markItem(ctx) {
  const { key, reason } = ctx.body;
  const { year, clock } = yearOf(ctx, ctx.body.year);
  if (typeof key !== 'string' || !key || key.length > 200) throw new HttpError(400, 'key must name an expected item');
  if (reason !== null && (typeof reason !== 'string' || !reason.trim() || reason.trim().length > MAX_REASON)) {
    throw new HttpError(400, `reason must be a non-empty string of at most ${MAX_REASON} characters, or null to clear`);
  }
  if (!yearendChecklist(ctx.db, { year, clock }).items.some((i) => i.key === key)) throw new HttpError(404, 'no such expected item for that year');
  setMark(ctx.db, { year, key, reason: reason === null ? null : reason.trim() });
  return { scenario: scenarioOf(ctx) };
}

// GET /api/yearend/packet?year=YYYY: build and stream the accountant packet zip.
export async function downloadPacket(ctx) {
  if (ctx.req.method !== 'GET') throw new HttpError(405, 'method not allowed', { Allow: 'GET' });
  const q = new URL(ctx.req.url || '/', 'http://x').searchParams;
  const { year, clock } = yearOf(ctx, q.get('year'));
  let key;
  try {
    key = await loadDataKey({ dataDir: ctx.config.dataDir, keyFile: ctx.config.dataKeyFile, mode: getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : 'real' });
  } catch (e) {
    if (e instanceof VaultError) throw new HttpError(409, e.message);
    throw e;
  }
  const packet = await buildPacket(ctx.db, { year, clock, dataDir: ctx.config.dataDir, key });
  await streamPacket(ctx.res, packet);
}

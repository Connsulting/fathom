// Advisor workflow handlers (item 24; src/advisor). Writes answer with the fresh scenario. The
// packet download is the one non-JSON response: the router sends a `download: true` route's
// { filename, type, bytes } as an attachment.

import { tx } from '../store/db.mjs';
import { clockNow } from '../scenario/build.mjs';
import { sendToAdvisor, recordVerdict, setCheckin, AdvisorError, VETO_REASON } from '../advisor/index.mjs';
import { buildAndStorePacket, readPacket } from '../advisor/packet.mjs';
import { openVault, VaultError } from '../ingest/vault.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf, applyStatusAction } from './handlers.mjs';

const nowIso = () => new Date().toISOString();
const stamp = ctx => clockNow(ctx.db, ctx.config && ctx.config.clock);

function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AdvisorError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

// The household vault; a refusal (missing platform or data key) is 409 naming FATHOM_PLATFORM_KEY_FILE.
async function householdVault(ctx) {
  try {
    return await openVault(ctx.household);
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
}

// POST /api/advisor/reviews { recId }: send a rec to the advisor.
export function sendReview(ctx) {
  const { recId } = ctx.body;
  if (typeof recId !== 'string' || !recId) throw new HttpError(400, 'recId is required');
  const reviewId = guard(() => tx(ctx.db, () => sendToAdvisor(ctx.db, recId, { now: stamp(ctx) })));
  return { reviewId, scenario: scenarioOf(ctx) };
}

// POST /api/advisor/reviews/:id/verdict { verdict, note, date }
export function reviewVerdict(ctx) {
  const { verdict, note, date } = ctx.body;
  const db = ctx.db;
  guard(() => tx(db, () => recordVerdict(db, ctx.params.id, { verdict, note, date, now: stamp(ctx) },
    row => applyStatusAction(db, row, 'dismiss', VETO_REASON))));
  return { scenario: scenarioOf(ctx) };
}

// POST /api/advisor/checkin { date, time, lengthMin }
export function saveCheckin(ctx) {
  const { date, time, lengthMin } = ctx.body;
  guard(() => setCheckin(ctx.db, { date, time, lengthMin, now: nowIso() }));
  return { scenario: scenarioOf(ctx) };
}

// POST /api/advisor/packets: build the packet for every waiting review and store it encrypted.
export async function createPacket(ctx) {
  let result;
  try {
    result = await buildAndStorePacket(ctx.db, { scenario: scenarioOf(ctx), now: stamp(ctx), vault: () => householdVault(ctx) });
  } catch (err) {
    if (err instanceof AdvisorError) throw new HttpError(err.status, err.message);
    if (err instanceof VaultError) throw new HttpError(500, 'the packet could not be stored');
    throw err;
  }
  return { packetId: result.packetId, scenario: scenarioOf(ctx) };
}

// GET /api/advisor/packets/:id: the stored packet as an HTML attachment.
export async function downloadPacket(ctx) {
  const vault = await householdVault(ctx);
  let got;
  try {
    got = await readPacket(ctx.db, { vault, id: ctx.params.id });
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(500, 'the packet could not be read');
    throw err;
  }
  if (!got) throw new HttpError(404, 'no such packet');
  return { filename: `advisor-packet-${got.row.clock}.html`, type: 'text/html; charset=utf-8', bytes: got.bytes };
}

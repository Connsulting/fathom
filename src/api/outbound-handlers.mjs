// GET and POST /api/household/outbound: the household's outbound pause flags and whether each kind
// can actually leave the instance now. Same contract as ./handlers.mjs; ctx.platform is the
// platform DB and ctx.household the request's household. GET is for members, POST for admins
// (route `admin: true`).
//
// Body: { outbound: { <kind>: { enabled, effective, reason } } } for every kind of OUTBOUND_KINDS.
// enabled is the stored flag; effective is whether that work would run; reason is null when
// effective, else the first that applies of:
// jobs: paused, not_configured (no scheduler).
// email: paused, not_configured (sender, recipients or credential missing), recipient_unverified
//   (a real household has no verified subscribed members or recipient migration is blocked).
// simplefin: paused, not_connected (no healthy connection).
// engine: paused, not_configured (engine mode or setting off, or the engine refused further calls),
//   credential_unavailable (live credential not loaded), funding_unavailable (live mode without
//   instance funding), funding_exhausted (this month's spend reached the household cap).
// POST takes { jobs?, email?, simplefin?, engine? } booleans (anything else 400, nothing changed),
// writes them in one audited transaction (omitted kinds keep their value) and answers as GET.

import { HttpError } from './http.mjs';
import { OUTBOUND_KINDS, readOutbound, setOutbound } from '../platform/outbound.mjs';

const verdict = (enabled, reason) => ({ enabled, effective: enabled && reason === null, reason: enabled ? reason : 'paused' });

async function emailReason(ctx) {
  const status = await ctx.household.emailRecipients.status();
  if (status.state === 'recipient_unverified') return 'recipient_unverified';
  return status.state === 'dev' || status.state === 'configured' ? null : 'not_configured';
}

async function simplefinReason(ctx) {
  const row = await ctx.household.db.prepare('SELECT status FROM simplefin_connection WHERE id = 1').get();
  return row?.status === 'ok' ? null : 'not_connected';
}

async function engineReason(ctx) {
  const engine = ctx.household.engine;
  await engine.init();
  const s = engine.status();
  if (!s.on) return 'not_configured';
  if (s.mode === 'live' && s.credentialState !== 'loaded') return 'credential_unavailable';
  if (!s.funded) return 'funding_unavailable';
  if (!(s.spentUsd < s.capUsd)) return 'funding_exhausted';
  return engine.isOn() ? null : 'not_configured';
}

async function outboundBody(ctx) {
  const flags = await readOutbound(ctx.platform, ctx.household.householdId);
  const reasons = {
    jobs: ctx.household.scheduler ? null : 'not_configured',
    email: flags.email ? await emailReason(ctx) : null,
    simplefin: flags.simplefin ? await simplefinReason(ctx) : null,
    engine: flags.engine ? await engineReason(ctx) : null,
  };
  return { outbound: Object.fromEntries(OUTBOUND_KINDS.map(k => [k, verdict(flags[k], reasons[k])])) };
}

export async function getOutbound(ctx) {
  return outboundBody(ctx);
}

export async function setOutboundFlags(ctx) {
  try {
    await setOutbound(ctx.platform, ctx.household.householdId, ctx.body, { actorUserId: ctx.identity?.id ?? null });
  } catch (err) {
    if (err?.code === 'bad_outbound') throw new HttpError(400, 'body must be an object of jobs, email, simplefin and engine booleans');
    throw err;
  }
  return outboundBody(ctx);
}

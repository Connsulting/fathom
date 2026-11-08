// Household and instance model budgets (MT-05): the platform authority every paid live round
// passes, across server and CLI processes, before it is dispatched. Tables (platform migration
// 005): household_model_budgets (operator allocation per household; no row is zero) and
// model_rounds (one row per reserved round, plus one 'carry' row per household and month holding
// the household's pre-MT-05 spend). Every write runs in one BEGIN IMMEDIATE transaction on the
// platform connection. Funding months are the actual UTC month of `now` (never FATHOM_CLOCK).
// Committed spend of a row: settled -> cost_usd; reserved or held -> max(reserved_usd, cost_usd).
//
// MAX_BUDGET_USD, RESERVATION_TTL_MS (a reserved round older than this is held 'interrupted' at
// the household's next reserve or reconcile; its reservation is never released).
// parseUsd(text) -> dollars rounded to cents (strict decimal, 0..10000), else codeError bad_usd.
// fundingMonth(nowMs) -> 'YYYY-MM' (UTC). instanceCapUsd(platform), allocationUsd(platform, id),
// committedUsd(platform, { householdId?, month }).
// ensureCarry(platform, { householdId, month, legacySpendUsd, now }) records the household's carry
//   row for the month (its pre-MT-05 spend, settled) unless one exists; an existing row is never
//   changed. A household's runtime engine records it at construction in live mode, reserve records
//   it for its own household, and scripts/model-budget.mjs records every active household's before
//   any change, so pre-MT-05 spend of a household that never reserved still counts against the
//   instance cap and against reductions.
// createModelLedger(platform, { householdId, generation, now }) -> { reserve, settle, hold, rounds,
//   status, held }:
//   reserve({ purpose, model, boundUsd, adminCapUsd, legacySpendUsd, principal }) -> { roundId,
//     boundUsd, month }. Expires stale reservations, then refuses (after committing the expiry
//     and the month's carry row): EngineOffError household_unavailable (not active, or another
//     generation), EngineOffError authorization_revoked (principal.check() is not true),
//     ModelAccountingError accounting_hold (any held round), ModelCallError funding_unavailable
//     (instance cap 0), BudgetExceededError (household committed + bound over min(adminCap,
//     allocation), or instance committed + bound over the instance cap). A refusal writes no round.
//   settle(roundId, { costUsd, inputTokens, outputTokens }): a reserved round settles when the cost
//     fits its reservation, else is held reservation_bound_exceeded with the cost recorded. Any
//     other state is left as it is (idempotent; committed never decreases).
//   hold(roundId, code = 'cost_unknown'): a reserved round is held with its full reservation.
//   rounds(month) -> this household's settled and held rounds of the month (for the mirror).
//   status(month) -> { allocationUsd, instanceCapUsd, committedUsd, instanceCommittedUsd, held }.
// setInstanceCap(platform, usd, { now }) / setAllocation(platform, householdId, usd, { now }) ->
//   { changed }. Unchanged values write nothing; a change writes the value and an audit_events row
//   (model.instance_cap / model.allocation, outcome ok). Refusals: bad_usd, no_such_household,
//   allocation_above_cap, below_committed (under the current month's committed spend).
// reconcileRound(platform, { householdId, roundId, costUsd, receiptRef, now }) -> 'settled' |
//   'unchanged'. Refusals: bad_receipt_ref, bad_cost, no_such_round, foreign_round,
//   round_in_flight, already_settled, reservation_bound_exceeded (a cost over the reservation is
//   recorded as debt and the hold kept, audited with that outcome). Audits model.reconcile with
//   fixed codes only; receipt_ref is kept on the round, never in audit_events.
// None of these touch household_outbound.
// Principal: runWithPrincipal(principal, fn), currentPrincipal(), withoutPrincipal(fn) over
// AsyncLocalStorage; principal = { check() -> boolean } (the router sets it per gated request).

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { codeError } from './db.mjs';
import { EngineOffError, BudgetExceededError, ModelAccountingError, fundingUnavailable, withCode } from '../engine/errors.mjs';

export const MAX_BUDGET_USD = 10000;
export const RESERVATION_TTL_MS = 10 * 60 * 1000;
export const FUNDING_SETTING = 'instance_model_cap_usd';
const EPS = 1e-9;
const DECIMAL = /^\d+(\.\d+)?$/;
const RECEIPT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOLD_CODES = ['cost_unknown', 'interrupted', 'reservation_bound_exceeded'];

const cents = usd => Math.round(usd * 100) / 100;
const money = n => Number(Number(n).toFixed(12));

function checkUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_BUDGET_USD) throw codeError('bad_usd');
  return cents(usd);
}

export function parseUsd(text) {
  if (typeof text !== 'string' || !DECIMAL.test(text)) throw codeError('bad_usd');
  return checkUsd(Number(text));
}

export const fundingMonth = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 7);

// One BEGIN IMMEDIATE transaction. fn returns { value } or { refuse: error }; a refusal still
// commits what fn wrote (an expiry, a carry row) and is thrown after the commit.
async function immediate(platform, fn) {
  const out = await platform.transaction(fn);
  if (out.refuse) throw out.refuse;
  return out.value;
}

const audit = async (platform, { at, householdId = null, action, outcome = 'ok' }) => await platform.prepare(`INSERT INTO audit_events
  (at, actor_user_id, household_id, target_user_id, action, outcome) VALUES (?, NULL, ?, NULL, ?, ?)`).run(at, householdId, action, outcome);

// The stored instance cap as written (undefined when absent or not JSON).
async function storedCap(platform) {
  const row = await platform.prepare('SELECT value FROM platform_settings WHERE key = ?').get(FUNDING_SETTING);
  try { return row ? JSON.parse(row.value) : undefined; } catch { return undefined; }
}

export async function instanceCapUsd(platform) {
  const v = await storedCap(platform);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export async function allocationUsd(platform, householdId) {
  return (await platform.prepare('SELECT allocation_usd FROM household_model_budgets WHERE household_id = ?').get(householdId))?.allocation_usd ?? 0;
}

const COMMITTED = "coalesce(sum(CASE WHEN state = 'settled' THEN coalesce(cost_usd, 0) ELSE max(reserved_usd, coalesce(cost_usd, 0)) END), 0)";

export async function committedUsd(platform, { householdId = null, month } = {}) {
  const row = householdId == null
    ? await platform.prepare(`SELECT ${COMMITTED} AS s FROM model_rounds WHERE month = ?`).get(month)
    : await platform.prepare(`SELECT ${COMMITTED} AS s FROM model_rounds WHERE month = ? AND household_id = ?`).get(month, householdId);
  return money(row.s);
}

const expireStale = async (platform, householdId, now) => await platform.prepare(`UPDATE model_rounds SET state = 'held', hold_code = 'interrupted'
  WHERE household_id = ? AND kind = 'round' AND state = 'reserved' AND expires_at < ?`).run(householdId, now);

const hasHold = async (platform, householdId) =>
  Boolean(await platform.prepare("SELECT 1 AS x FROM model_rounds WHERE household_id = ? AND state = 'held' LIMIT 1").get(householdId));

const count = v => (Number.isInteger(v) && v >= 0 ? v : null);

// The month's carry row (inside the caller's transaction); an existing row is never changed.
const insertCarry = async (platform, { householdId, month, legacySpendUsd, at }) => await platform.prepare(`INSERT INTO model_rounds
  (id, household_id, month, kind, state, reserved_usd, cost_usd, reserved_at, expires_at, settled_at)
  VALUES (?, ?, ?, 'carry', 'settled', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
  .run(`mr-${randomUUID()}`, householdId, month, money(legacySpendUsd), money(legacySpendUsd), at, at, at);

export async function ensureCarry(platform, { householdId, month, legacySpendUsd = 0, now = Date.now() } = {}) {
  if (!platform || typeof householdId !== 'string' || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)
    || !Number.isFinite(legacySpendUsd) || legacySpendUsd < 0 || !Number.isFinite(now)) throw new TypeError('Invalid carry');
  return await immediate(platform, async (platform) => {
    await insertCarry(platform, { householdId, month, legacySpendUsd, at: now });
    return { value: undefined };
  });
}

export function createModelLedger(platform, { householdId, generation, now = Date.now } = {}) {
  if (!platform || typeof householdId !== 'string' || !Number.isInteger(generation) || typeof now !== 'function') {
    throw new TypeError('createModelLedger needs the platform, a household, its generation and a clock');
  }
  const own = async id => await platform.prepare("SELECT * FROM model_rounds WHERE id = ? AND household_id = ? AND kind = 'round'").get(id, householdId);
  return {
    async reserve({ purpose, model, boundUsd, adminCapUsd, legacySpendUsd = 0, principal = null }) {
      if (!Number.isFinite(boundUsd) || boundUsd < 0 || !Number.isFinite(adminCapUsd) || !Number.isFinite(legacySpendUsd) || legacySpendUsd < 0) {
        throw new TypeError('Invalid reservation');
      }
      const at = now();
      const month = fundingMonth(at);
      return await immediate(platform, async (platform) => {
        await expireStale(platform, householdId, at);
        const hh = await platform.prepare('SELECT status, generation FROM households WHERE id = ?').get(householdId);
        if (!hh || hh.status !== 'active' || Number(hh.generation) !== generation) return { refuse: withCode(new EngineOffError(), 'household_unavailable') };
        let authorized = true;
        if (principal) {
          try { authorized = await principal.check() === true; } catch { authorized = false; }
        }
        if (!authorized) return { refuse: withCode(new EngineOffError(), 'authorization_revoked') };
        if (await hasHold(platform, householdId)) return { refuse: withCode(new ModelAccountingError(), 'accounting_hold') };
        await insertCarry(platform, { householdId, month, legacySpendUsd, at });
        const instanceCap = await instanceCapUsd(platform);
        if (!(instanceCap > 0)) return { refuse: fundingUnavailable() };
        const limit = Math.min(adminCapUsd, await allocationUsd(platform, householdId));
        if (await committedUsd(platform, { householdId, month }) + boundUsd > limit + EPS
          || await committedUsd(platform, { month }) + boundUsd > instanceCap + EPS) return { refuse: new BudgetExceededError() };
        const roundId = `mr-${randomUUID()}`;
        await platform.prepare(`INSERT INTO model_rounds (id, household_id, month, kind, purpose, model, state, reserved_usd, reserved_at, expires_at)
          VALUES (?, ?, ?, 'round', ?, ?, 'reserved', ?, ?, ?)`)
          .run(roundId, householdId, month, String(purpose), model == null ? null : String(model), boundUsd, at, at + RESERVATION_TTL_MS);
        return { value: { roundId, boundUsd, month } };
      });
    },
    async settle(roundId, { costUsd, inputTokens = null, outputTokens = null } = {}) {
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new TypeError('Invalid round cost');
      return await immediate(platform, async (platform) => {
        const row = await own(roundId);
        if (!row) throw codeError('no_such_round');
        if (row.state === 'reserved') {
          const within = costUsd <= row.reserved_usd;
          await platform.prepare(`UPDATE model_rounds SET state = ?, hold_code = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, settled_at = ?
            WHERE id = ?`).run(within ? 'settled' : 'held', within ? null : 'reservation_bound_exceeded', costUsd,
            count(inputTokens), count(outputTokens), within ? now() : null, roundId);
        }
        return { value: { ...await own(roundId) } };
      });
    },
    async hold(roundId, code = 'cost_unknown') {
      if (!HOLD_CODES.includes(code)) throw new TypeError('Invalid hold code');
      await platform.prepare("UPDATE model_rounds SET state = 'held', hold_code = ? WHERE id = ? AND household_id = ? AND state = 'reserved'")
        .run(code, roundId, householdId);
    },
    async rounds(month) {
      return (await platform.prepare(`SELECT * FROM model_rounds WHERE household_id = ? AND month = ? AND kind = 'round' AND state != 'reserved'
        ORDER BY reserved_at, rowid`).all(householdId, month)).map(r => ({ ...r }));
    },
    held: async () => await hasHold(platform, householdId),
    async status(month) {
      return {
        allocationUsd: await allocationUsd(platform, householdId), instanceCapUsd: await instanceCapUsd(platform),
        committedUsd: await committedUsd(platform, { householdId, month }), instanceCommittedUsd: await committedUsd(platform, { month }),
        held: await hasHold(platform, householdId),
      };
    },
  };
}

export async function setInstanceCap(platform, usd, { now = Date.now() } = {}) {
  const value = checkUsd(usd);
  return await immediate(platform, async (platform) => {
    if (await storedCap(platform) === value) return { value: { changed: false } };
    if (value + EPS < await committedUsd(platform, { month: fundingMonth(now) })) return { refuse: codeError('below_committed') };
    await platform.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(FUNDING_SETTING, JSON.stringify(value), now);
    await audit(platform, { at: now, action: 'model.instance_cap' });
    return { value: { changed: true } };
  });
}

export async function setAllocation(platform, householdId, usd, { now = Date.now() } = {}) {
  const value = checkUsd(usd);
  return await immediate(platform, async (platform) => {
    const hh = typeof householdId === 'string' ? await platform.prepare('SELECT status FROM households WHERE id = ?').get(householdId) : null;
    if (!hh || hh.status === 'deleted') return { refuse: codeError('no_such_household') };
    const current = await platform.prepare('SELECT allocation_usd FROM household_model_budgets WHERE household_id = ?').get(householdId);
    if ((current?.allocation_usd ?? 0) === value) return { value: { changed: false } };
    if (value > await instanceCapUsd(platform) + EPS) return { refuse: codeError('allocation_above_cap') };
    if (value + EPS < await committedUsd(platform, { householdId, month: fundingMonth(now) })) return { refuse: codeError('below_committed') };
    await platform.prepare(`INSERT INTO household_model_budgets (household_id, allocation_usd, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(household_id) DO UPDATE SET allocation_usd = excluded.allocation_usd, updated_at = excluded.updated_at`).run(householdId, value, now);
    await audit(platform, { at: now, householdId, action: 'model.allocation' });
    return { value: { changed: true } };
  });
}

export async function reconcileRound(platform, { householdId, roundId, costUsd, receiptRef, now = Date.now() } = {}) {
  if (typeof receiptRef !== 'string' || !RECEIPT_REF.test(receiptRef)) throw codeError('bad_receipt_ref');
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) throw codeError('bad_cost');
  return await immediate(platform, async (platform) => {
    const found = typeof roundId === 'string' ? await platform.prepare("SELECT household_id FROM model_rounds WHERE id = ? AND kind = 'round'").get(roundId) : null;
    if (!found) return { refuse: codeError('no_such_round') };
    if (found.household_id !== householdId) return { refuse: codeError('foreign_round') };
    await expireStale(platform, householdId, now);
    const row = await platform.prepare('SELECT * FROM model_rounds WHERE id = ?').get(roundId);
    if (row.state === 'reserved') return { refuse: codeError('round_in_flight') };
    if (row.state === 'settled') {
      return row.cost_usd === costUsd && row.receipt_ref === receiptRef ? { value: 'unchanged' } : { refuse: codeError('already_settled') };
    }
    if (row.hold_code === 'reservation_bound_exceeded') return { refuse: codeError('reservation_bound_exceeded') };
    if (costUsd > row.reserved_usd) {
      await platform.prepare("UPDATE model_rounds SET hold_code = 'reservation_bound_exceeded', cost_usd = ?, receipt_ref = ? WHERE id = ?")
        .run(costUsd, receiptRef, roundId);
      await audit(platform, { at: now, householdId, action: 'model.reconcile', outcome: 'reservation_bound_exceeded' });
      return { refuse: codeError('reservation_bound_exceeded') };
    }
    await platform.prepare("UPDATE model_rounds SET state = 'settled', hold_code = NULL, cost_usd = ?, receipt_ref = ?, settled_at = ? WHERE id = ?")
      .run(costUsd, receiptRef, now, roundId);
    await audit(platform, { at: now, householdId, action: 'model.reconcile' });
    return { value: 'settled' };
  });
}

const principals = new AsyncLocalStorage();
export const runWithPrincipal = (principal, fn) => principals.run(principal, fn);
export const currentPrincipal = () => principals.getStore() ?? null;
export const withoutPrincipal = fn => principals.run(null, fn);

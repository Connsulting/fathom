// Per-household outbound pause flags (platform table household_outbound, 1 = enabled). Outbound
// work is anything that leaves the instance or spends money on the household's behalf: background
// jobs, email, SimpleFIN calls and model engine calls. A missing row means every kind is paused
// (fail closed). A household that is not `active` (provisioning, suspended, deleted) is never
// enabled, whatever its row says; the flags survive suspension unchanged.
//
// OUTBOUND_KINDS: the four kinds, in display order.
// readOutbound(platform, householdId) -> { jobs, email, simplefin, engine } booleans (the stored
//   flags only; status is not applied).
// setOutbound(platform, householdId, patch, { actorUserId }) -> readOutbound after the change.
//   patch is a plain object whose keys are kinds and values booleans (else codeError bad_outbound);
//   omitted kinds keep their value. One transaction with an audit_events row (household.outbound).
// outboundGuard(platform, householdId) -> { enabled(kind) } reading the platform on every call.
// initOutbound(platform, householdId, { enabled, now }) inserts the row with every kind set to
//   `enabled` (createInstance, createHouseholdStorage and the tenancy migration).


import { codeError } from './db.mjs';

export const OUTBOUND_KINDS = Object.freeze(['jobs', 'email', 'simplefin', 'engine']);

const ALL_PAUSED = Object.freeze(Object.fromEntries(OUTBOUND_KINDS.map(k => [k, false])));

const rowOf = (platform, id) => platform.prepare('SELECT jobs, email, simplefin, engine FROM household_outbound WHERE household_id = ?').get(id);

export function readOutbound(platform, householdId) {
  const row = typeof householdId === 'string' ? rowOf(platform, householdId) : null;
  if (!row) return { ...ALL_PAUSED };
  return Object.fromEntries(OUTBOUND_KINDS.map(k => [k, row[k] === 1]));
}

function checkPatch(patch) {
  const plain = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
    && (Object.getPrototypeOf(patch) === Object.prototype || Object.getPrototypeOf(patch) === null);
  if (!plain) throw codeError('bad_outbound');
  const keys = Object.keys(patch);
  if (!keys.every(k => OUTBOUND_KINDS.includes(k) && typeof patch[k] === 'boolean')) throw codeError('bad_outbound');
  return keys;
}

export function initOutbound(platform, householdId, { enabled = false, now = Date.now(), actorUserId = null } = {}) {
  const v = enabled ? 1 : 0;
  platform.prepare(`INSERT INTO household_outbound (household_id, jobs, email, simplefin, engine, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(householdId, v, v, v, v, now, actorUserId);
}

export function setOutbound(platform, householdId, patch, { actorUserId = null, now = Date.now() } = {}) {
  const keys = checkPatch(patch);
  if (typeof householdId !== 'string') throw codeError('bad_outbound');
  const nested = platform.isTransaction;
  platform.exec(nested ? 'SAVEPOINT outbound_write' : 'BEGIN IMMEDIATE');
  try {
    const next = { ...readOutbound(platform, householdId) };
    for (const k of keys) next[k] = patch[k];
    const flag = k => (next[k] ? 1 : 0);
    platform.prepare(`INSERT INTO household_outbound (household_id, jobs, email, simplefin, engine, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(household_id) DO UPDATE SET jobs = excluded.jobs, email = excluded.email, simplefin = excluded.simplefin,
        engine = excluded.engine, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(householdId, flag('jobs'), flag('email'), flag('simplefin'), flag('engine'), now, actorUserId);
    platform.prepare(`INSERT INTO audit_events (at, actor_user_id, household_id, target_user_id, action, outcome)
      VALUES (?, ?, ?, NULL, 'household.outbound', 'ok')`).run(now, actorUserId, householdId);
    platform.exec(nested ? 'RELEASE outbound_write' : 'COMMIT');
  } catch (e) {
    if (nested) {
      platform.exec('ROLLBACK TO outbound_write');
      platform.exec('RELEASE outbound_write');
    } else platform.exec('ROLLBACK');
    throw e;
  }
  return readOutbound(platform, householdId);
}

export function outboundGuard(platform, householdId) {
  const status = platform.prepare('SELECT status FROM households WHERE id = ?');
  return Object.freeze({
    householdId,
    enabled(kind) {
      if (!OUTBOUND_KINDS.includes(kind)) return false;
      try {
        if (status.get(householdId)?.status !== 'active') return false;
        return readOutbound(platform, householdId)[kind] === true;
      } catch {
        return false;
      }
    },
  });
}

// The auth store over the platform DB (platform.sqlite): global users, household memberships and
// invitations, instance operators, passkeys, recovery and add-a-device tokens, sessions, ceremony
// challenges, rate limits, platform settings and audit events (and a removed member's MCP keys).
// It never touches a financial store. Outer writes run under BEGIN IMMEDIATE; nested ones use a
// savepoint. servedHousehold() (households.serves_store) only tells the instance mode; it never
// selects a financial household.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from '../api/http.mjs';
import { newHouseholdId } from '../platform/db.mjs';
import { atomically, currentHandle } from '../storage/index.mjs';
import { mapSeries } from '../shared/series.mjs';

export const TOKEN_TTL = 20 * 60 * 1000;
export const TOKEN_PURPOSES = Object.freeze(['recovery', 'add-passkey']);
export const CHALLENGE_TTL = 5 * 60 * 1000;
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const INVITATIONS_PER_HOUR = 20;
const HOUR = 60 * 60 * 1000;
export const validHandle = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const digest = value => createHash('sha256').update(value).digest('hex');
const randomHandle = () => randomBytes(32).toString('base64url');

export function normalizeEmail(value) {
  if (typeof value !== 'string' || /[^\x00-\x7f]/.test(value)) throw new HttpError(400, 'invalid email');
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  if (email.length > 254 || parts.length !== 2) throw new HttpError(400, 'invalid email');
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !domain || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new HttpError(400, 'invalid email');
  }
  return email;
}

const checkRole = role => {
  if (role !== 'admin' && role !== 'member') throw new HttpError(400, 'invalid role');
};

function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new HttpError(400, 'invalid household name');
  }
  return value.trim();
}

const expiredLink = () => new HttpError(410, 'link expired or already used');
const lastAdmin = () => new HttpError(409, 'cannot remove or demote the last enrolled administrator');

const projectUser = row => row ? {
  id: row.id, email: row.email, login: row.email, name: row.email, enrolledAt: row.enrolled_at,
} : null;

export function createAuthStore(platform, { now = () => Date.now() } = {}) {
  // Statements follow the caller's open platform transaction, if any, so a store write inside one
  // joins it as a savepoint.
  const db = { prepare: text => currentHandle(platform).prepare(text) };
  async function transaction(fn) {
    return await atomically(currentHandle(platform), async () => await fn());
  }

  const userRow = async id => typeof id === 'string' ? await db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null : null;
  const getUser = async id => projectUser(await userRow(id));
  const householdRow = async id => typeof id === 'string' ? await db.prepare('SELECT * FROM households WHERE id = ?').get(id) || null : null;
  async function servedHousehold() {
    const row = await db.prepare('SELECT id, mode, status FROM households WHERE serves_store = 1').get();
    return row ? { id: row.id, mode: row.mode, status: row.status } : null;
  }
  const membershipRow = async (userId, householdId) => await db.prepare('SELECT * FROM household_memberships WHERE user_id = ? AND household_id = ?')
    .get(userId, householdId) || null;
  async function membership(userId, householdId) {
    const row = await membershipRow(userId, householdId);
    return row ? { role: row.role, status: row.status, version: row.version } : null;
  }
  const isOperator = async userId => Boolean(await db.prepare('SELECT 1 AS x FROM instance_operators WHERE user_id = ?').get(userId));
  // Live: not consumed, not revoked, not expired, in a household that is not deleted.
  async function liveInvitationRow(raw) {
    if (!validHandle(raw)) return null;
    return await db.prepare(`SELECT i.* FROM household_invitations i JOIN households h ON h.id = i.household_id
      WHERE i.hash = ? AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND h.status != 'deleted'`)
      .get(digest(raw), now()) || null;
  }
  // The open (unconsumed, unrevoked) invitation of a user in a household, expired or not.
  const pendingInvitationRow = async (householdId, userId) => await db.prepare(`SELECT * FROM household_invitations
    WHERE household_id = ? AND user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get(householdId, userId) || null;
  async function audit(action, { actorId = null, householdId = null, targetUserId = null, outcome = 'ok' } = {}) {
    await db.prepare('INSERT INTO audit_events (at, actor_user_id, household_id, target_user_id, action, outcome) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), actorId, householdId, targetUserId, action, outcome);
  }
  const enrolledAdmins = async householdId => await db.prepare(`SELECT u.* FROM household_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.household_id = ? AND m.status = 'active' AND m.role = 'admin' AND u.enrolled_at IS NOT NULL ORDER BY u.created_at, u.id`)
    .all(householdId);
  // Per household: an enrolled admin with an active membership may not leave the household without one.
  async function guardLastAdmin(householdId, userId) {
    const m = await membershipRow(userId, householdId);
    const user = await userRow(userId);
    if (m?.status === 'active' && m.role === 'admin' && user?.enrolled_at != null && (await enrolledAdmins(householdId)).length <= 1) throw lastAdmin();
  }
  // The household a new session works in: the user's only active membership (in a household that
  // is not deleted), else none. The instance's original household gets no preference.
  async function defaultHousehold(userId) {
    const active = await db.prepare(`SELECT m.household_id FROM household_memberships m JOIN households h ON h.id = m.household_id
      WHERE m.user_id = ? AND m.status = 'active' AND h.status != 'deleted'`).all(userId);
    return active.length === 1 ? active[0].household_id : null;
  }
  async function token(raw) {
    if (!validHandle(raw)) return null;
    const row = await db.prepare('SELECT user_id, purpose, expires_at FROM auth_tokens WHERE hash = ? AND expires_at > ?').get(digest(raw), now());
    return row ? { userId: row.user_id, purpose: row.purpose, expiresAt: row.expires_at } : null;
  }
  async function revokeSession(raw) {
    if (validHandle(raw)) await db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(digest(raw));
  }
  const revokeUserSessions = async id => { await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id); };
  // Delete the account once no active membership and no operator grant holds it (cascades
  // passkeys, tokens, sessions, challenges and its invitations).
  async function deleteIfUnheld(userId) {
    const held = await db.prepare("SELECT 1 AS x FROM household_memberships WHERE user_id = ? AND status = 'active'").get(userId) || await isOperator(userId);
    if (!held) await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return !held;
  }
  // status is 'active' for an active member and 'pending' for an invitee with an open invitation.
  async function personOf(householdId, row) {
    const m = await membershipRow(row.id, householdId);
    const active = m?.status === 'active';
    const role = active ? m.role : (await pendingInvitationRow(householdId, row.id))?.role ?? null;
    return { ...projectUser(row), role, status: active ? 'active' : 'pending' };
  }
  async function consume(raw, userId) {
    const row = await liveInvitationRow(raw);
    if (!row || row.user_id !== userId) throw expiredLink();
    const at = now();
    await db.prepare('UPDATE household_invitations SET consumed_at = ? WHERE hash = ?').run(at, row.hash);
    const existing = await membershipRow(userId, row.household_id);
    // The first person to join a household founds it and completes its onboarding, which is what
    // flags a user's tour (src/auth/tour.mjs). Everyone who joins after another member never
    // onboards, so accepting the invitation flags them instead.
    const joinsMembers = existing?.status !== 'active'
      && await db.prepare("SELECT 1 AS x FROM household_memberships WHERE household_id = ? AND user_id != ? AND status = 'active' LIMIT 1").get(row.household_id, userId) != null;
    if (!existing) {
      await db.prepare(`INSERT INTO household_memberships (user_id, household_id, role, status, version, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 1, ?, ?)`).run(userId, row.household_id, row.role, at, at);
    } else if (existing.status !== 'active') {
      await db.prepare(`UPDATE household_memberships SET role = ?, status = 'active', version = version + 1, updated_at = ?
        WHERE user_id = ? AND household_id = ?`).run(row.role, at, userId, row.household_id);
    }
    if (joinsMembers) await db.prepare('UPDATE users SET tour_pending = 1 WHERE id = ?').run(userId);
    await audit('membership.join', { actorId: userId, householdId: row.household_id, targetUserId: userId });
    // A provisioned household becomes active when its first admin joins, and only once its storage
    // exists (a household with no root is never served).
    if (row.role === 'admin') {
      const activated = (await db.prepare(`UPDATE households SET status = 'active', updated_at = ?
        WHERE id = ? AND status = 'provisioning' AND storage_root IS NOT NULL`).run(at, row.household_id)).changes > 0;
      if (activated) await audit('household.activate', { actorId: userId, householdId: row.household_id, targetUserId: userId });
    }
    return { householdId: row.household_id, ...await membership(userId, row.household_id) };
  }
  async function invite(householdId, email, { role = 'member', inviterId = null } = {}) {
    const canonical = normalizeEmail(email);
    checkRole(role);
    return await transaction(async () => {
      const household = await householdRow(householdId);
      if (!household || household.status === 'deleted') throw new HttpError(404, 'no such household');
      const existing = await db.prepare('SELECT * FROM users WHERE email = ?').get(canonical);
      if (existing && (await membershipRow(existing.id, householdId))?.status === 'active') {
        throw new HttpError(409, 'this person is already a member; use the role change action instead');
      }
      // Every invitation sent in the last hour counts, reissues and revoked links included.
      const at = now();
      const recent = await db.prepare('SELECT count(*) AS n, min(created_at) AS first FROM household_invitations WHERE household_id = ? AND created_at > ?')
        .get(householdId, at - HOUR);
      if (recent.n >= INVITATIONS_PER_HOUR) {
        const wait = Math.max(1, Math.ceil((recent.first + HOUR - at) / 1000));
        throw new HttpError(429, 'too many requests', { 'Retry-After': String(wait) });
      }
      let userId = existing?.id;
      if (!userId) {
        userId = randomUUID();
        await db.prepare('INSERT INTO users (id, email, user_handle, created_at) VALUES (?, ?, ?, ?)').run(userId, canonical, randomHandle(), at);
      }
      await db.prepare(`UPDATE household_invitations SET revoked_at = ?
        WHERE household_id = ? AND email = ? AND consumed_at IS NULL AND revoked_at IS NULL`).run(at, householdId, canonical);
      const raw = randomHandle();
      const expiresAt = at + TOKEN_TTL;
      await db.prepare(`INSERT INTO household_invitations (hash, household_id, email, role, user_id, inviter_user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(digest(raw), householdId, canonical, role, userId, inviterId, at, expiresAt);
      await audit('invitation.issue', { actorId: inviterId, householdId, targetUserId: userId });
      return { user: await getUser(userId), token: raw, expiresAt };
    });
  }

  async function clearAddPasskey(userId) {
    await db.prepare(`DELETE FROM auth_challenges WHERE token_hash IN (
      SELECT hash FROM auth_tokens WHERE user_id = ? AND purpose = 'add-passkey')`).run(userId);
    await db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'add-passkey'").run(userId);
  }
  const store = {
    transaction, userRow, getUser, servedHousehold, membership, isOperator, audit, defaultHousehold,
    async findUser(email) {
      let canonical;
      try { canonical = normalizeEmail(email); } catch { return null; }
      return projectUser(await db.prepare('SELECT * FROM users WHERE email = ?').get(canonical));
    },
    async activeMemberships(userId) {
      return (await db.prepare(`SELECT m.household_id, m.role, h.display_name FROM household_memberships m JOIN households h ON h.id = m.household_id
        WHERE m.user_id = ? AND m.status = 'active' AND h.status != 'deleted' ORDER BY m.created_at, m.household_id`)
        .all(userId)).map(row => ({ householdId: row.household_id, role: row.role, name: row.display_name ?? null }));
    },
    // Enrolled admins with an active membership in the household (for security notices).
    async householdAdmins(householdId) { return (await enrolledAdmins(householdId)).map(projectUser); },
    invite,
    async invitation(raw) {
      const row = await liveInvitationRow(raw);
      return row ? { householdId: row.household_id, email: row.email, role: row.role, userId: row.user_id, expiresAt: row.expires_at } : null;
    },
    async revokeInvitation(raw) {
      if (validHandle(raw)) {
        await db.prepare('UPDATE household_invitations SET revoked_at = ? WHERE hash = ? AND consumed_at IS NULL AND revoked_at IS NULL').run(now(), digest(raw));
      }
    },
    async consumeInvitation(raw, userId) { return await transaction(async () => await consume(raw, userId)); },
    // A signed-in user redeems an invitation addressed to their own account. The role comes from
    // the invitation only. 410 for a dead link, 403 for another account's link (nothing changes).
    async acceptInvitation(raw, sessionUserId) {
      return await transaction(async () => {
        const row = await liveInvitationRow(raw);
        if (!row) throw expiredLink();
        const user = await userRow(sessionUserId);
        if (!user || user.enrolled_at === null || user.email !== row.email) throw new HttpError(403, 'this invitation is for another account');
        return await consume(raw, user.id);
      });
    },
    async markEnrolled(userId) {
      await db.prepare('UPDATE users SET enrolled_at = coalesce(enrolled_at, ?) WHERE id = ?').run(now(), userId);
    },
    // People of a household: active members and pending invitees (an open invitation, expired or
    // not), each with the membership or invitation role.
    async listPeople(householdId) {
      return await mapSeries((await db.prepare(`SELECT u.* FROM users u WHERE u.id IN (
          SELECT user_id FROM household_memberships WHERE household_id = ? AND status = 'active'
          UNION SELECT user_id FROM household_invitations WHERE household_id = ? AND consumed_at IS NULL AND revoked_at IS NULL)
        ORDER BY u.created_at, u.id`).all(householdId, householdId)), async row => await personOf(householdId, row));
    },
    // The person in this household (active member or pending invitee), or null. Only an active
    // member's credentials are the household's to list or revoke; check status before touching them.
    async person(householdId, userId) {
      const row = await userRow(userId);
      if (!row) return null;
      const active = (await membershipRow(userId, householdId))?.status === 'active';
      return active || await pendingInvitationRow(householdId, userId) ? await personOf(householdId, row) : null;
    },
    async setRole(householdId, userId, role, { actorId = null } = {}) {
      checkRole(role);
      return await transaction(async () => {
        const row = await userRow(userId);
        const m = row ? await membershipRow(userId, householdId) : null;
        if (m?.status === 'active') {
          if (role !== 'admin') await guardLastAdmin(householdId, userId);
          await db.prepare('UPDATE household_memberships SET role = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND household_id = ?')
            .run(role, now(), userId, householdId);
          await db.prepare(`UPDATE notification_subscriptions SET membership_version = ?, updated_at = ?
            WHERE household_id = ? AND user_id = ? AND membership_version = ?`)
            .run(m.version + 1, now(), householdId, userId, m.version);
        } else {
          const pending = row ? await pendingInvitationRow(householdId, userId) : null;
          if (!pending) throw new HttpError(404, 'no such user');
          await db.prepare('UPDATE household_invitations SET role = ? WHERE hash = ?').run(role, pending.hash);
        }
        await audit('membership.role', { actorId, householdId, targetUserId: userId });
        return await personOf(householdId, row);
      });
    },
    // An active member: removes the membership, revokes their open invitation and the invitations
    // they issued in this household, signs them out, then deletes the account when nothing holds it.
    // A pending invitee: revokes the invitation only; a never-enrolled account the invitation
    // created is then deleted when nothing holds it, an enrolled account is left untouched.
    // An active member's MCP keys in this household are deleted with the membership. False when the
    // user is not in the household.
    async removeMember(householdId, userId, { actorId = null } = {}) {
      return await transaction(async () => {
        const row = await userRow(userId);
        if (!row) return false;
        const m = await membershipRow(userId, householdId);
        const active = m?.status === 'active';
        if (!active && !await pendingInvitationRow(householdId, userId)) return false;
        const at = now();
        if (active) {
          await guardLastAdmin(householdId, userId);
          await db.prepare("UPDATE household_memberships SET status = 'removed', version = version + 1, updated_at = ? WHERE user_id = ? AND household_id = ?")
            .run(at, userId, householdId);
        }
        await db.prepare('UPDATE household_invitations SET revoked_at = ? WHERE household_id = ? AND user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL')
          .run(at, householdId, userId);
        if (active) {
          await db.prepare('UPDATE household_invitations SET revoked_at = ? WHERE household_id = ? AND inviter_user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL')
            .run(at, householdId, userId);
          await revokeUserSessions(userId);
          await db.prepare('DELETE FROM api_keys WHERE household_id = ? AND user_id = ?').run(householdId, userId);
        }
        await audit('membership.remove', { actorId, householdId, targetUserId: userId });
        if (active || row.enrolled_at === null) await deleteIfUnheld(userId);
        return true;
      });
    },
    async grantOperator(userId, { actorId = null } = {}) {
      return await transaction(async () => {
        const row = await userRow(userId);
        if (!row || row.enrolled_at === null) throw new HttpError(409, 'only an enrolled user can be an operator');
        await db.prepare('INSERT OR IGNORE INTO instance_operators (user_id, granted_at, granted_by) VALUES (?, ?, ?)').run(userId, now(), actorId);
        await audit('operator.grant', { actorId, targetUserId: userId });
        return true;
      });
    },
    async revokeOperator(userId, { actorId = null } = {}) {
      return await transaction(async () => {
        if (!await isOperator(userId)) throw new HttpError(404, 'no such operator');
        if ((await db.prepare('SELECT count(*) AS n FROM instance_operators').get()).n <= 1) throw new HttpError(409, 'cannot revoke the last operator');
        await db.prepare('DELETE FROM instance_operators WHERE user_id = ?').run(userId);
        await audit('operator.revoke', { actorId, targetUserId: userId });
        return true;
      });
    },
    // A new household in status provisioning with an admin invitation. Real instances allow one
    // non-deleted real household (provisioning included) until multi_household_enabled is set;
    // demo instances are exempt.
    async provisionHousehold({ displayName: name, adminEmail } = {}, { actorId = null } = {}) {
      const label = displayName(name);
      const email = normalizeEmail(adminEmail);
      return await transaction(async () => {
        if (!actorId || !await isOperator(actorId)) throw new HttpError(403, 'operator required');
        const mode = (await servedHousehold())?.mode === 'demo' ? 'demo' : 'real';
        if (mode === 'real' && await store.getPlatformSetting('multi_household_enabled', false) !== true) {
          const n = (await db.prepare("SELECT count(*) AS n FROM households WHERE status != 'deleted' AND mode = 'real'").get()).n;
          if (n >= 1) throw new HttpError(409, 'additional households are not enabled on this instance', undefined, 'multi_household_gated');
        }
        const id = newHouseholdId();
        const at = now();
        await db.prepare(`INSERT INTO households (id, status, mode, display_name, serves_store, created_at, updated_at)
          VALUES (?, 'provisioning', ?, ?, 0, ?, ?)`).run(id, mode, label, at, at);
        await audit('household.provision', { actorId, householdId: id });
        const issued = await invite(id, email, { role: 'admin', inviterId: actorId });
        return { household: { id, status: 'provisioning' }, token: issued.token, user: issued.user, expiresAt: issued.expiresAt };
      });
    },
    async getPlatformSetting(key, fallback) {
      const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return fallback; }
    },
    async setPlatformSetting(key, value) {
      await db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), now());
    },
    async listPasskeys(userId) {
      return (await db.prepare('SELECT id, name, created_at, transports FROM passkeys WHERE user_id = ? ORDER BY created_at, id').all(userId))
        .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, transports: JSON.parse(row.transports) }));
    },
    // Audited as passkey.revoke with the household it was revoked in (the admin's, or the
    // session's for self revocation) when one applies.
    async revokePasskey(userId, id, { actorId = null, householdId = null } = {}) {
      return await transaction(async () => {
        const removed = (await db.prepare('DELETE FROM passkeys WHERE user_id = ? AND id = ?').run(userId, id)).changes > 0;
        if (removed) {
          await revokeUserSessions(userId);
          await clearAddPasskey(userId);
          await audit('passkey.revoke', { actorId, householdId, targetUserId: userId });
        }
        return removed;
      });
    },
    async createToken(userId, purpose) {
      if (!TOKEN_PURPOSES.includes(purpose)) throw new HttpError(400, 'invalid token purpose');
      return await transaction(async () => {
        if (!await userRow(userId)) throw new HttpError(404, 'no such user');
        const raw = randomHandle();
        const expiresAt = now() + TOKEN_TTL;
        await db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
        await db.prepare('INSERT INTO auth_tokens (hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(digest(raw), userId, purpose, expiresAt);
        return { token: raw, expiresAt };
      });
    },
    token,
    async consumeToken(raw) {
      return await transaction(async () => {
        const row = await token(raw);
        if (row) await store.revokeToken(raw);
        return row;
      });
    },
    async revokeToken(raw) {
      if (validHandle(raw)) await db.prepare('DELETE FROM auth_tokens WHERE hash = ?').run(digest(raw));
    },
    async createSession(userId) {
      return await transaction(async () => {
        if ((await getUser(userId))?.enrolledAt == null) throw new HttpError(401, 'unauthorized');
        const raw = randomHandle();
        const signedInAt = now();
        const expiresAt = signedInAt + SESSION_TTL;
        await db.prepare('INSERT INTO auth_sessions (hash, user_id, signed_in_at, expires_at, household_id) VALUES (?, ?, ?, ?, ?)')
          .run(digest(raw), userId, signedInAt, expiresAt, await defaultHousehold(userId));
        return { token: raw, expiresAt };
      });
    },
    // The session's user, plus the household the session works in (sessionHouseholdId, null when
    // none was bound) and its context version (rotated by every switch), or null.
    async session(raw) {
      if (!validHandle(raw)) return null;
      const row = await db.prepare(`SELECT u.*, s.household_id AS session_household_id, s.context_version FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.hash = ? AND s.expires_at > ? AND u.enrolled_at IS NOT NULL`).get(digest(raw), now());
      return row ? { ...projectUser(row), sessionHouseholdId: row.session_household_id, contextVersion: row.context_version } : null;
    },
    // Select the session's household: only an active membership in an active household. Binds it
    // and rotates the context version in one write; anything else is the generic 403 with nothing
    // changed. Returns { id, name, role } of the selected household.
    async switchHousehold(raw, householdId) {
      return await transaction(async () => {
        const user = store.session(raw);
        if (!user) throw new HttpError(401, 'unauthorized');
        const row = typeof householdId === 'string' ? await db.prepare(`SELECT h.id, h.display_name, m.role FROM household_memberships m
          JOIN households h ON h.id = m.household_id
          WHERE m.user_id = ? AND m.household_id = ? AND m.status = 'active' AND h.status = 'active'`).get(user.id, householdId) : null;
        if (!row) throw new HttpError(403, 'household membership required');
        await db.prepare('UPDATE auth_sessions SET household_id = ?, context_version = context_version + 1 WHERE hash = ?').run(row.id, digest(raw));
        return { id: row.id, name: row.display_name ?? null, role: row.role };
      });
    },
    async sessionSignedInAt(raw) {
      if (!validHandle(raw)) return null;
      return (await db.prepare(`SELECT s.signed_in_at FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.hash = ? AND s.expires_at > ? AND u.enrolled_at IS NOT NULL`).get(digest(raw), now()))?.signed_in_at ?? null;
    },
    revokeSession, revokeUserSessions, clearAddPasskey,
    // A ceremony challenge. A registration bound to an emailed link names it as `token` (recovery or
    // add-passkey) or `invitation` (an invitation link).
    async createChallenge({ ceremony, userId = null, token: linkToken = null, invitation = null, session: sessionToken = null, challenge }) {
      const raw = randomHandle();
      const expiresAt = now() + CHALLENGE_TTL;
      await db.prepare(`INSERT INTO auth_challenges (hash, ceremony, user_id, token_hash, invitation_hash, session_hash, challenge, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(digest(raw), ceremony, userId, linkToken ? digest(linkToken) : null, invitation ? digest(invitation) : null,
          sessionToken ? digest(sessionToken) : null, challenge, expiresAt);
      return { token: raw, expiresAt };
    },
    async consumeChallenge(raw) {
      if (!validHandle(raw)) return null;
      const row = await db.prepare('DELETE FROM auth_challenges WHERE hash = ? RETURNING *').get(digest(raw));
      return row && row.expires_at > now() ? row : null;
    },
    async revokeChallenge(raw) {
      if (validHandle(raw)) await db.prepare('DELETE FROM auth_challenges WHERE hash = ?').run(digest(raw));
    },
    async rateLimit(key, { limit = 120, windowMs = 60_000 } = {}) {
      const at = now();
      const row = await db.prepare(`INSERT INTO auth_rate_limits (key_hash, window_start, expires_at, attempts) VALUES (?, ?, ?, 1)
        ON CONFLICT(key_hash) DO UPDATE SET
          attempts = CASE WHEN expires_at <= ? THEN 1 ELSE min(attempts + 1, ?) END,
          window_start = CASE WHEN expires_at <= ? THEN excluded.window_start ELSE window_start END,
          expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
        RETURNING attempts`).get(digest(key), at, at + windowMs, at, limit + 1, at, at);
      if (row.attempts > limit) throw new HttpError(429, 'too many requests', { 'Retry-After': String(Math.ceil(windowMs / 1000)) });
    },
    // Invitations are kept after expiry: an open one keeps a pending invitee listed.
    async sweep() {
      const at = now();
      for (const table of ['auth_challenges', 'auth_tokens', 'auth_sessions', 'auth_rate_limits']) {
        await db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT 256)`).run(at);
      }
    },
  };
  return store;
}

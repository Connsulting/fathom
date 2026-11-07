import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from '../api/http.mjs';

export const TOKEN_TTL = 20 * 60 * 1000;
export const TOKEN_PURPOSES = Object.freeze(['invite', 'recovery', 'add-passkey']);
export const CHALLENGE_TTL = 5 * 60 * 1000;
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
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

const projectUser = row => row ? {
  id: row.id, email: row.email, login: row.email, name: row.email,
  householdId: row.household_id, role: row.role, enrolledAt: row.enrolled_at,
} : null;

export function createAuthStore(db, { now = () => Date.now() } = {}) {
  function transaction(fn) {
    const nested = db.isTransaction;
    db.exec(nested ? 'SAVEPOINT auth_write' : 'BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec(nested ? 'RELEASE auth_write' : 'COMMIT');
      return result;
    } catch (err) {
      if (nested) {
        db.exec('ROLLBACK TO auth_write');
        db.exec('RELEASE auth_write');
      } else db.exec('ROLLBACK');
      throw err;
    }
  }

  const userRow = id => typeof id === 'string' ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null : null;
  const getUser = id => projectUser(userRow(id));
  function ensureHousehold() {
    db.prepare('INSERT OR IGNORE INTO households (id) VALUES (1)').run();
    return { id: 1 };
  }
  function guardLastAdmin(user) {
    if (user.role === 'admin' && user.enrolled_at !== null
      && db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND enrolled_at IS NOT NULL").get().n <= 1) {
      throw new HttpError(409, 'cannot remove or demote the last enrolled administrator');
    }
  }
  function token(raw) {
    if (!validHandle(raw)) return null;
    const row = db.prepare('SELECT user_id, purpose, expires_at FROM auth_tokens WHERE hash = ? AND expires_at > ?').get(digest(raw), now());
    return row ? { userId: row.user_id, purpose: row.purpose, expiresAt: row.expires_at } : null;
  }
  function revokeSession(raw) {
    if (validHandle(raw)) db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(digest(raw));
  }
  const revokeUserSessions = id => { db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id); };
  function clearAddPasskey(userId) {
    db.prepare(`DELETE FROM auth_challenges WHERE token_hash IN (
      SELECT hash FROM auth_tokens WHERE user_id = ? AND purpose = 'add-passkey')`).run(userId);
    db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'add-passkey'").run(userId);
  }
  const store = {
    transaction, userRow, ensureHousehold, getUser,
    findUser(email) {
      let canonical;
      try { canonical = normalizeEmail(email); } catch { return null; }
      return projectUser(db.prepare('SELECT * FROM users WHERE email = ?').get(canonical));
    },
    inviteUser(email, { role = 'member' } = {}) {
      const canonical = normalizeEmail(email);
      checkRole(role);
      return transaction(() => {
        ensureHousehold();
        const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(canonical);
        if (existing) {
          if (existing.enrolled_at !== null) throw new HttpError(409, 'user is already enrolled; use the role change action');
          db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, existing.id);
          return getUser(existing.id);
        }
        db.prepare(`INSERT INTO users (id, household_id, email, role, user_handle, created_at)
          VALUES (?, 1, ?, ?, ?, ?)`)
          .run(randomUUID(), canonical, role, randomHandle(), now());
        return store.findUser(canonical);
      });
    },
    listUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at, id').all().map(projectUser); },
    setRole(id, role) {
      checkRole(role);
      return transaction(() => {
        const user = userRow(id);
        if (!user) throw new HttpError(404, 'no such user');
        if (role !== 'admin') guardLastAdmin(user);
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
        return getUser(id);
      });
    },
    removeUser(id) {
      return transaction(() => {
        const user = userRow(id);
        if (!user) return false;
        guardLastAdmin(user);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return true;
      });
    },
    listPasskeys(userId) {
      return db.prepare('SELECT id, name, created_at, transports FROM passkeys WHERE user_id = ? ORDER BY created_at, id').all(userId)
        .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, transports: JSON.parse(row.transports) }));
    },
    revokePasskey(userId, id) {
      return transaction(() => {
        const removed = db.prepare('DELETE FROM passkeys WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
        if (removed) {
          revokeUserSessions(userId);
          clearAddPasskey(userId);
        }
        return removed;
      });
    },
    createToken(userId, purpose) {
      if (!TOKEN_PURPOSES.includes(purpose)) throw new HttpError(400, 'invalid token purpose');
      return transaction(() => {
        if (!userRow(userId)) throw new HttpError(404, 'no such user');
        const raw = randomHandle();
        const expiresAt = now() + TOKEN_TTL;
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
        db.prepare('INSERT INTO auth_tokens (hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(digest(raw), userId, purpose, expiresAt);
        return { token: raw, expiresAt };
      });
    },
    token,
    consumeToken(raw) {
      return transaction(() => {
        const row = token(raw);
        if (row) store.revokeToken(raw);
        return row;
      });
    },
    revokeToken(raw) {
      if (validHandle(raw)) db.prepare('DELETE FROM auth_tokens WHERE hash = ?').run(digest(raw));
    },
    createSession(userId) {
      return transaction(() => {
        if (getUser(userId)?.enrolledAt == null) throw new HttpError(401, 'unauthorized');
        const raw = randomHandle();
        const signedInAt = now();
        const expiresAt = signedInAt + SESSION_TTL;
        db.prepare('INSERT INTO auth_sessions (hash, user_id, signed_in_at, expires_at) VALUES (?, ?, ?, ?)')
          .run(digest(raw), userId, signedInAt, expiresAt);
        return { token: raw, expiresAt };
      });
    },
    session(raw) {
      if (!validHandle(raw)) return null;
      return projectUser(db.prepare(`SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.hash = ? AND s.expires_at > ? AND u.enrolled_at IS NOT NULL`).get(digest(raw), now()));
    },
    sessionSignedInAt(raw) {
      if (!validHandle(raw)) return null;
      return db.prepare(`SELECT s.signed_in_at FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.hash = ? AND s.expires_at > ? AND u.enrolled_at IS NOT NULL`).get(digest(raw), now())?.signed_in_at ?? null;
    },
    revokeSession, revokeUserSessions, clearAddPasskey,
    createChallenge({ ceremony, userId = null, token: linkToken = null, session: sessionToken = null, challenge }) {
      const raw = randomHandle();
      const expiresAt = now() + CHALLENGE_TTL;
      db.prepare(`INSERT INTO auth_challenges (hash, ceremony, user_id, token_hash, session_hash, challenge, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(digest(raw), ceremony, userId, linkToken ? digest(linkToken) : null, sessionToken ? digest(sessionToken) : null, challenge, expiresAt);
      return { token: raw, expiresAt };
    },
    consumeChallenge(raw) {
      if (!validHandle(raw)) return null;
      const row = db.prepare('DELETE FROM auth_challenges WHERE hash = ? RETURNING *').get(digest(raw));
      return row && row.expires_at > now() ? row : null;
    },
    revokeChallenge(raw) {
      if (validHandle(raw)) db.prepare('DELETE FROM auth_challenges WHERE hash = ?').run(digest(raw));
    },
    rateLimit(key, { limit = 120, windowMs = 60_000 } = {}) {
      const at = now();
      const row = db.prepare(`INSERT INTO auth_rate_limits (key_hash, window_start, expires_at, attempts) VALUES (?, ?, ?, 1)
        ON CONFLICT(key_hash) DO UPDATE SET
          attempts = CASE WHEN expires_at <= ? THEN 1 ELSE min(attempts + 1, ?) END,
          window_start = CASE WHEN expires_at <= ? THEN excluded.window_start ELSE window_start END,
          expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
        RETURNING attempts`).get(digest(key), at, at + windowMs, at, limit + 1, at, at);
      if (row.attempts > limit) throw new HttpError(429, 'too many requests', { 'Retry-After': String(Math.ceil(windowMs / 1000)) });
    },
    sweep() {
      const at = now();
      for (const table of ['auth_challenges', 'auth_tokens', 'auth_sessions', 'auth_rate_limits']) {
        db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT 256)`).run(at);
      }
    },
  };
  return store;
}

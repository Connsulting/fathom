// App-issued API keys for the MCP server. A key is `fathom_` plus 43 base64url characters, shown
// once at creation. The store holds only HMAC-SHA256(key) under a per-deployment server secret
// kept in `$FATHOM_DATA/api-key-secret` (0600), so a copied database alone cannot verify a guess.

import crypto, { randomBytes, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJson } from '../store/db.mjs';
import { tools } from '../tools/index.mjs';

export const KEY_PREFIX = 'fathom_';
export const SCOPE_INFO = Object.freeze([
  { id: 'read', label: 'Read', access: 'Read household facts, accounts, transactions, recommendations, deadlines, goals, figures and knowledge packs.' },
  { id: 'write:recs', label: 'Change recommendation status and owner', access: 'Set a recommendation status (doing it, done, later, not for us) with set_recommendation_status, and who acts on it (you, spouse, both, advisor, automatic) with set_recommendation_owner. Nothing else is writable.' },
]);
export const SCOPES = Object.freeze(SCOPE_INFO.map(s => s.id));
export const SECRET_FILE = 'api-key-secret';

const KEY_LENGTH = KEY_PREFIX.length + 43;
const NAME_MAX = 80;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export class KeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyError';
    this.code = code;
  }
}

// Requested scopes to the stored set: read always, ordered per SCOPES, no duplicates.
export function normalizeScopes(input) {
  if (input === undefined || input === null) return ['read'];
  if (!Array.isArray(input)) throw new KeyError('bad_input', 'scopes must be an array');
  for (const s of input) {
    if (!SCOPES.includes(s)) throw new KeyError('bad_input', `unknown scope ${typeof s === 'string' ? JSON.stringify(s.slice(0, 40)) : typeof s}`);
  }
  const want = new Set(['read', ...input]);
  return SCOPES.filter(s => want.has(s));
}

// The server secret as a Buffer: created on first use (32 random bytes as 64 hex chars, 0600,
// never overwritten), refused when the file holds anything else.
export function loadServerSecret(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, SECRET_FILE);
  try {
    writeFileSync(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const text = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error(`${file} must hold 64 hex characters; fix or remove it (removing it invalidates every API key)`);
  return Buffer.from(text, 'hex');
}

export function hashKey(secret, serverSecret) {
  return createHmac('sha256', serverSecret).update(secret).digest('hex');
}

// Registry entries a key with `scopes` may see and call.
export function toolsForScopes(scopes, registry = tools) {
  return registry.filter(t => scopes.includes(t.scope));
}

const toRecord = r => ({
  id: r.id,
  name: r.name,
  scopes: parseJson(r.scopes, []),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

function cleanName(name) {
  if (typeof name !== 'string' || CONTROL.test(name)) throw new KeyError('bad_input', 'name must be text with no control characters');
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > NAME_MAX) throw new KeyError('bad_input', `name must be 1 to ${NAME_MAX} characters`);
  return trimmed;
}

export function createKeyService({ db, serverSecret, now = () => new Date() }) {
  const byId = db.prepare('SELECT * FROM api_keys WHERE id = ?');
  const all = db.prepare('SELECT * FROM api_keys ORDER BY created_at, id');
  const owned = db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at, id');
  const insert = db.prepare('INSERT INTO api_keys (id, name, key_hash, scopes, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)');
  const revokeStmt = db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  const touchStmt = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');

  return {
    // Returns { key, record }; the key is not kept anywhere after this call.
    create({ name, scopes, userId = null } = {}) {
      const clean = cleanName(name);
      const scopeList = normalizeScopes(scopes);
      const key = KEY_PREFIX + randomBytes(32).toString('base64url');
      const id = 'key_' + randomBytes(6).toString('hex');
      insert.run(id, clean, hashKey(key, serverSecret), JSON.stringify(scopeList), now().toISOString(), userId);
      return { key, record: toRecord(byId.get(id)) };
    },

    list({ userId } = {}) {
      return (userId === undefined ? all.all() : owned.all(userId)).map(toRecord);
    },

    revoke(id, { userId } = {}) {
      const row = typeof id === 'string' ? byId.get(id) : null;
      if (!row) throw new KeyError('not_found', 'no such key');
      if (userId !== undefined && row.user_id !== userId) throw new KeyError('forbidden', 'cannot manage another user key');
      revokeStmt.run(now().toISOString(), id);
      return toRecord(byId.get(id));
    },

    // The live record for a presented key, or null. Every stored hash is compared in constant
    // time, with no early exit, so timing does not reveal which row matched.
    verify(presented) {
      if (typeof presented !== 'string' || presented.length !== KEY_LENGTH || !presented.startsWith(KEY_PREFIX)) return null;
      const want = Buffer.from(hashKey(presented, serverSecret), 'hex');
      let match = null;
      for (const row of all.all()) {
        const have = Buffer.from(String(row.key_hash), 'hex');
        const same = have.length === want.length && crypto.timingSafeEqual(have, want);
        if (same && match === null) match = row;
      }
      if (!match || match.revoked_at !== null) return null;
      return toRecord(match);
    },

    touch(id) {
      touchStmt.run(now().toISOString(), id);
    },
  };
}

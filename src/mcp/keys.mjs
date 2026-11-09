import { currentHandle } from '../storage/index.mjs';
// App-issued API keys for the MCP server. A key is `fathom_` plus 43 base64url characters, shown
// once at creation. The platform's api_keys table holds only HMAC-SHA256(key) under the instance
// MCP secret (FATHOM_MCP_SECRET_FILE, read by src/platform/secrets.mjs), so a copied database alone
// cannot verify a guess. Every key is bound to one household for life (household_id).

import crypto, { randomBytes, createHmac } from 'node:crypto';
import { parseJson } from '../store/db.mjs';
import { tools, operationScopes } from '../tools/index.mjs';

export const KEY_PREFIX = 'fathom_';
export const SCOPE_INFO = Object.freeze([
  { id: 'read', label: 'Read', access: 'Read household facts, accounts, transactions, recommendations, deadlines, goals, figures and knowledge packs.' },
  { id: 'write:recs', label: 'Change recommendation status and owner', access: 'Set a recommendation status (doing it, done, later, not for us) with act_on_recommendation.status, and who acts on it (you, spouse, both, advisor, automatic) with act_on_recommendation.owner. No outbound actions are available.' },
  { id: 'write:preferences', label: 'Remember preferences', access: 'Remember your stated household preferences and definitions, edit them and undo your changes.' },
  { id: 'write:facts', label: 'Record household facts', access: 'Record or correct facts from your typed Ask statements or stored data, and undo your changes.' },
  { id: 'write:steps', label: 'Check recommendation steps', access: 'Check or uncheck recommendation steps, and undo your changes.' },
  { id: 'write:goals', label: 'Create and edit goals', access: 'Create or edit goals, target amounts and dates from your statements or stored data, and undo your changes.' },
  { id: 'write:accounts', label: 'Change accounts', access: 'Rename accounts, set their last four, owner and kind, and merge duplicates with confirmation.' },
  { id: 'write:categories', label: 'Correct categories', access: 'Correct transaction categories and set merchant rules.' },
  { id: 'write:confirm', label: 'Answer Confirm questions', access: 'Answer and reopen Confirm questions and mark expected tax documents.' },
  { id: 'write:imports', label: 'Import documents', access: 'Import files, record expected payments and retry or build from imported documents.' },
  { id: 'write:jobs', label: 'Run jobs', access: 'Run planning, sync, freshness and guess jobs now.' },
  { id: 'write:decisions', label: 'Change decisions', access: 'Pick and decide war-game options and reopen decisions.' },
  { id: 'write:sources', label: 'Manage data sources', access: 'Archive or restore accounts, remove imported files, merge duplicate accounts, and undo your changes.' },
]);
export const SCOPES = Object.freeze(SCOPE_INFO.map(s => s.id));

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

export function hashKey(secret, serverSecret) {
  return createHmac('sha256', serverSecret).update(secret).digest('hex');
}

export const isMcpTool = tool => !tool.askOnly;

// Registry entries a key with `scopes` may see and call.
export function toolsForScopes(scopes, registry = tools) {
  return registry.filter(isMcpTool).flatMap(t => {
    const allowed = t.operations.filter(o => operationScopes(o).some(scope => scopes.includes(scope)));
    if (!allowed.length) return [];
    return [{ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, operation: { ...t.inputSchema.properties.operation, enum: allowed.map(o => o.name) } } } }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const toRecord = r => ({
  id: r.id,
  householdId: r.household_id,
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

// createKeyService({ platform, secret, creatorActive }): `secret()` returns the MCP HMAC secret or
// throws (a missing or invalid secret makes every call throw KeyError('unavailable'));
// creatorActive(userId, householdId) answers whether a key's creator is still an active member of
// the key's household. Membership version and household generation are captured at creation and
// rechecked on verification. Only a synthetic demo household may issue an ownerless key.
// create({ householdId, name, scopes, userId }) -> { key, record }
// list({ householdId, userId }) -> records of that household (only userId's own when userId is set)
// revoke(id, { householdId, userId }) -> record; an id of another household is not_found, another
//   user's key is forbidden when userId is set
// verify(presented) -> live record incl. householdId, or null (constant time over all rows)
export function createKeyService({ platform, secret, creatorActive, now = () => new Date() }) {
  if (!platform) throw new TypeError('createKeyService needs the platform database');
  if (typeof secret !== 'function') throw new TypeError('createKeyService needs the secret');
  if (typeof creatorActive !== 'function') throw new TypeError('createKeyService needs creatorActive');
  // Statements run on the caller's open platform transaction when there is one (budget reservation
  // verifies the principal inside its transaction).
  const follow = text => ({
    get: (...a) => currentHandle(platform).prepare(text).get(...a),
    all: (...a) => currentHandle(platform).prepare(text).all(...a),
    run: (...a) => currentHandle(platform).prepare(text).run(...a),
  });
  const byId = follow('SELECT * FROM api_keys WHERE id = ? AND household_id = ?');
  const all = follow('SELECT * FROM api_keys ORDER BY created_at, id');
  const ofHousehold = follow('SELECT * FROM api_keys WHERE household_id = ? ORDER BY created_at, id');
  const owned = follow('SELECT * FROM api_keys WHERE household_id = ? AND user_id = ? ORDER BY created_at, id');
  const insert = follow('INSERT INTO api_keys (id, household_id, name, key_hash, scopes, created_at, user_id, household_generation, membership_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const householdState = follow('SELECT status, mode, generation FROM households WHERE id = ?');
  const membership = follow('SELECT status, version FROM household_memberships WHERE user_id = ? AND household_id = ?');
  const revokeStmt = follow('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND household_id = ? AND revoked_at IS NULL');
  const touchStmt = follow('UPDATE api_keys SET last_used_at = ? WHERE id = ?');

  function hmacSecret() {
    try {
      return secret();
    } catch {
      throw new KeyError('unavailable', 'API keys are unavailable on this instance');
    }
  }
  const household = id => {
    if (typeof id !== 'string' || !id) throw new KeyError('not_found', 'no such key');
    return id;
  };

  return {
    // Returns { key, record }; the key is not kept anywhere after this call.
    async create({ householdId, name, scopes, userId = null } = {}) {
      const hh = household(householdId);
      const clean = cleanName(name);
      const scopeList = normalizeScopes(scopes);
      const state = await householdState.get(hh);
      const member = userId === null ? null : await membership.get(userId, hh);
      if (state?.status !== 'active' || (userId === null ? state.mode !== 'demo' : member?.status !== 'active' || !await creatorActive(userId, hh))) {
        throw new KeyError('forbidden', 'active household membership required');
      }
      const serverSecret = hmacSecret();
      const key = KEY_PREFIX + randomBytes(32).toString('base64url');
      const id = 'key_' + randomBytes(6).toString('hex');
      await insert.run(id, hh, clean, hashKey(key, serverSecret), JSON.stringify(scopeList), now().toISOString(), userId, state.generation, member?.version ?? null);
      return { key, record: toRecord(await byId.get(id, hh)) };
    },

    async list({ householdId, userId } = {}) {
      const hh = household(householdId);
      hmacSecret();
      return (userId === undefined ? await ofHousehold.all(hh) : await owned.all(hh, userId)).map(toRecord);
    },

    async revoke(id, { householdId, userId } = {}) {
      const hh = household(householdId);
      hmacSecret();
      const row = typeof id === 'string' ? await byId.get(id, hh) : null;
      if (!row) throw new KeyError('not_found', 'no such key');
      if (userId !== undefined && row.user_id !== userId) throw new KeyError('forbidden', 'cannot manage another user key');
      await revokeStmt.run(now().toISOString(), id, hh);
      return toRecord(await byId.get(id, hh));
    },

    // The live record for a presented key, or null. Every stored hash is compared in constant
    // time, with no early exit, so timing does not reveal which row matched. Throws
    // KeyError('unavailable') when the secret is missing.
    async verify(presented) {
      const serverSecret = hmacSecret();
      if (typeof presented !== 'string' || presented.length !== KEY_LENGTH || !presented.startsWith(KEY_PREFIX)) return null;
      const want = Buffer.from(hashKey(presented, serverSecret), 'hex');
      let match = null;
      for (const row of await all.all()) {
        const have = Buffer.from(String(row.key_hash), 'hex');
        const same = have.length === want.length && crypto.timingSafeEqual(have, want);
        if (same && match === null) match = row;
      }
      if (!match || match.revoked_at !== null) return null;
      const state = await householdState.get(match.household_id);
      if (state?.status !== 'active' || state.generation !== match.household_generation) return null;
      if (match.user_id === null) {
        if (state.mode !== 'demo') return null;
      } else {
        const member = await membership.get(match.user_id, match.household_id);
        if (member?.status !== 'active' || member.version !== match.membership_version || !await creatorActive(match.user_id, match.household_id)) return null;
      }
      return { ...toRecord(match), userId: match.user_id };
    },

    async touch(id) {
      await touchStmt.run(now().toISOString(), id);
    },
  };
}

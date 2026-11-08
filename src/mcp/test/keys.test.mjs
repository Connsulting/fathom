// AC3/AC5 (unit): app-issued API keys in src/mcp/keys.mjs against the platform api_keys table of a
// temp instance (MT-03: keys moved to the platform, bound to one household each).

import test, { describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHmac } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempInstance, tempDir } from '../../../test/helpers/server.mjs';
import {
  KEY_PREFIX, SCOPES, normalizeScopes, hashKey, createKeyService, toolsForScopes,
} from '../keys.mjs';
import { createInstanceSecrets, DEMO_SECRETS_DIR, DEMO_MCP_SECRET } from '../../platform/secrets.mjs';
import { createAuthStore } from '../../auth/store.mjs';
import { tools } from '../../tools/index.mjs';
import { KEY_RE } from './helpers.mjs';

const isCode = code => err => err instanceof Error && err.code === code;
const SECRET = Buffer.alloc(32, 7);
const LIST_FIELDS = ['createdAt', 'householdId', 'id', 'lastUsedAt', 'name', 'revokedAt', 'scopes'];

let t;
let clock;
let raw;
let svc;
let hh;
// Creators with an active membership in the key's household (the platform's answer, faked here:
// the key service only sees creatorActive).
const active = new Set();
const creatorActive = userId => active.has(userId);
const users = {};

before(async () => {
  t = await tempInstance({ mode: 'demo' });
  hh = t.householdId;
  // Real platform users, so the api_keys.user_id foreign key holds.
  const store = createAuthStore(t.platform);
  for (const name of ['creator', 'member']) {
    const invited = store.invite(hh, `${name}@example.test`);
    store.consumeInvitation(invited.token, invited.user.id);
    users[name] = invited.user.id;
  }
  clock = new Date('2026-11-05T15:00:00.000Z');
  raw = createKeyService({ platform: t.platform, secret: () => SECRET, creatorActive, now: () => clock });
  // The tests below act inside the instance's household unless they say otherwise.
  svc = {
    create: (opts = {}) => raw.create({ householdId: hh, ...opts }),
    list: (opts = {}) => raw.list({ householdId: hh, ...opts }),
    revoke: (id, opts = {}) => raw.revoke(id, { householdId: hh, ...opts }),
    verify: k => raw.verify(k),
    touch: id => raw.touch(id),
  };
});
after(() => t && t.close());

const tick = () => { clock = new Date(clock.getTime() + 1000); };
const rows = () => t.platform.prepare('SELECT * FROM api_keys ORDER BY created_at, id').all().map(r => ({ ...r }));

describe('constants and scopes', () => {
  test('prefix and scope list', () => {
    assert.equal(KEY_PREFIX, 'fathom_');
    assert.deepEqual([...SCOPES], ['read', 'write:recs', 'write:preferences', 'write:facts', 'write:steps', 'write:goals',
      'write:accounts', 'write:categories', 'write:confirm', 'write:imports', 'write:jobs', 'write:decisions']);
  });

  test('keys accept and retain every new write scope without widening older keys', () => {
    const old = svc.create({ name: 'Existing', scopes: ['write:recs'] });
    for (const scope of ['write:accounts', 'write:categories', 'write:confirm', 'write:imports', 'write:jobs', 'write:decisions']) {
      const created = svc.create({ name: 'Scoped', scopes: [scope] });
      assert.deepEqual(created.record.scopes, ['read', scope]);
      assert.deepEqual(svc.verify(created.key).scopes, ['read', scope]);
    }
    assert.deepEqual(svc.verify(old.key).scopes, ['read', 'write:recs']);
  });

  test('normalizeScopes: empty means read, read always included, ordered and deduplicated', () => {
    assert.deepEqual(normalizeScopes(undefined), ['read']);
    assert.deepEqual(normalizeScopes([]), ['read']);
    assert.deepEqual(normalizeScopes(['read']), ['read']);
    assert.deepEqual(normalizeScopes(['write:recs']), ['read', 'write:recs']);
    assert.deepEqual(normalizeScopes(['write:recs', 'read', 'write:recs', 'read']), ['read', 'write:recs']);
  });

  test('normalizeScopes refuses an unknown scope with bad_input', () => {
    for (const bad of [['admin'], ['read', 'write'], ['READ'], ['write:recs', '']]) {
      assert.throws(() => normalizeScopes(bad), isCode('bad_input'), JSON.stringify(bad));
    }
  });

  test('toolsForScopes filters the registry by scope', () => {
    const readOnly = toolsForScopes(['read']).map(x => x.name);
    assert.ok(readOnly.length > 0);
    assert.ok(!readOnly.includes('act_on_recommendation'));
    assert.ok(!readOnly.includes('show'));
    assert.deepEqual(readOnly, tools.filter(x => !x.askOnly && x.kind === 'read').map(x => x.name));
    const both = toolsForScopes(['read', 'write:recs']).map(x => x.name);
    assert.deepEqual(both, tools.filter(x => !x.askOnly && x.operations.some(o => (o.scopes || [o.scope]).some(s => ['read', 'write:recs'].includes(s)))).map(x => x.name));
    assert.deepEqual(toolsForScopes([]), []);
    const registry = [{ name: 'a', operations: [{ name: 'list', scope: 'read' }], inputSchema: { properties: { operation: {} } } }, { name: 'b', operations: [{ name: 'status', scope: 'write:recs' }], inputSchema: { properties: { operation: {} } } }, { name: 'c', operations: [{ name: 'list', scope: 'read' }], inputSchema: { properties: { operation: {} } } }];
    assert.deepEqual(toolsForScopes(['read'], registry).map(x => x.name), ['a', 'c']);
    assert.deepEqual(toolsForScopes(['write:recs'], registry).map(x => x.name), ['b']);
  });
});

// MT-03: the HMAC secret is an instance secret (src/platform/secrets.mjs), no longer created
// beside the store on first use. A real instance reads FATHOM_MCP_SECRET_FILE and never generates
// it; a demo instance creates its own once under platform-secrets/.
describe('MCP secret', () => {
  const writeSecret = (file, text, mode = 0o600) => { writeFileSync(file, text, { mode }); chmodSync(file, mode); return file; };
  const realSecrets = (dataDir, mcpSecretFile) => createInstanceSecrets({ config: { dataDir, platformKeyFile: null, mcpSecretFile }, mode: 'real' });

  test('a demo instance creates it on first use as a 0600 file of 64 hex chars and reuses it after', async () => {
    const dir = await tempDir();
    const file = join(dir, DEMO_SECRETS_DIR, DEMO_MCP_SECRET);
    assert.ok(!existsSync(file));
    const first = createInstanceSecrets({ config: { dataDir: dir }, mode: 'demo' }).mcpSecret();
    assert.ok(Buffer.isBuffer(first));
    assert.equal(first.length, 32);
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, DEMO_SECRETS_DIR)).mode & 0o777, 0o700);
    const before = readFileSync(file, 'utf8');
    const second = createInstanceSecrets({ config: { dataDir: dir }, mode: 'demo' }).mcpSecret();
    assert.ok(first.equals(second), 'the same secret is returned on reuse');
    assert.equal(readFileSync(file, 'utf8'), before, 'the file is not rewritten');
  });

  test('two demo data dirs get different secrets', async () => {
    const a = createInstanceSecrets({ config: { dataDir: await tempDir() }, mode: 'demo' }).mcpSecret();
    const b = createInstanceSecrets({ config: { dataDir: await tempDir() }, mode: 'demo' }).mcpSecret();
    assert.ok(!a.equals(b));
  });

  test('a real instance reads FATHOM_MCP_SECRET_FILE and never creates one', async () => {
    const dir = await tempDir();
    const hex = 'ab'.repeat(32);
    const file = writeSecret(join(dir, 'mcp.secret'), hex + '\n');
    assert.ok(realSecrets(dir, file).mcpSecret().equals(Buffer.from(hex, 'hex')));
    assert.throws(() => realSecrets(dir, null).mcpSecret(), isCode('mcp_secret_missing'));
    assert.throws(() => realSecrets(dir, join(dir, 'absent.secret')).mcpSecret(), isCode('mcp_secret_missing'));
    assert.ok(!existsSync(join(dir, 'absent.secret')), 'a missing secret is not generated');
    assert.ok(!existsSync(join(dir, DEMO_SECRETS_DIR)), 'a real instance creates no demo secrets');
  });

  test('a corrupt secret file is refused, not replaced', async () => {
    for (const bad of ['', 'not hex at all', 'ab'.repeat(16), 'zz'.repeat(32), 'ab'.repeat(33)]) {
      const dir = await tempDir();
      const file = writeSecret(join(dir, 'mcp.secret'), bad);
      assert.throws(() => realSecrets(dir, file).mcpSecret(), isCode('mcp_secret_invalid'), JSON.stringify(bad));
      assert.equal(readFileSync(file, 'utf8'), bad, 'the corrupt file is left as it was');
    }
    const dir = await tempDir();
    const open = writeSecret(join(dir, 'mcp.secret'), 'ab'.repeat(32), 0o640);
    assert.throws(() => realSecrets(dir, open).mcpSecret(), isCode('mcp_secret_invalid'), 'a group-readable file is refused');
  });

  test('a key service whose secret is unavailable refuses every call with unavailable', () => {
    const none = createKeyService({ platform: t.platform, secret: () => { throw new Error('mcp_secret_missing'); }, creatorActive, now: () => clock });
    const before = rows().length;
    assert.throws(() => none.create({ householdId: hh, name: 'No secret' }), isCode('unavailable'));
    assert.throws(() => none.list({ householdId: hh }), isCode('unavailable'));
    assert.throws(() => none.verify('fathom_' + 'Q'.repeat(43)), isCode('unavailable'));
    assert.equal(rows().length, before, 'nothing stored without the secret');
  });
});

describe('hashing', () => {
  test('hashKey is HMAC-SHA256 hex of the key under the server secret', () => {
    const key = 'fathom_' + 'x'.repeat(43);
    const want = createHmac('sha256', SECRET).update(key).digest('hex');
    assert.equal(hashKey(key, SECRET), want);
    assert.match(hashKey(key, SECRET), /^[0-9a-f]{64}$/);
    assert.notEqual(hashKey(key, Buffer.alloc(32, 8)), want, 'a different server secret gives a different hash');
    assert.notEqual(hashKey(key.slice(0, -1) + 'y', SECRET), want);
  });
});

describe('key service', () => {
  test('create issues a prefixed 43-char base64url key, shown once, and stores only its hash', () => {
    const { key, record } = svc.create({ name: 'Laptop agent' });
    assert.match(key, KEY_RE);
    assert.equal(key.length, 50);
    assert.match(record.id, /^key_[0-9a-f]+$/);
    assert.equal(record.householdId, hh);
    assert.equal(record.name, 'Laptop agent');
    assert.deepEqual(record.scopes, ['read']);
    assert.equal(record.createdAt, clock.toISOString());
    assert.equal(record.lastUsedAt, null);
    assert.equal(record.revokedAt, null);
    const row = t.platform.prepare('SELECT * FROM api_keys WHERE id = ?').get(record.id);
    assert.equal(row.household_id, hh);
    assert.equal(row.key_hash, hashKey(key, SECRET));
    assert.deepEqual(JSON.parse(row.scopes), ['read']);
    const dump = JSON.stringify(rows());
    assert.ok(!dump.includes(key), 'the key is not stored');
    assert.ok(!dump.includes(key.slice(KEY_PREFIX.length)), 'no part of the key body is stored');
    tick();
  });

  test('keys are unique across many creations', () => {
    const seen = new Set();
    const ids = new Set();
    for (let i = 0; i < 25; i++) {
      const { key, record } = svc.create({ name: `Bulk ${i}` });
      assert.match(key, KEY_RE);
      seen.add(key);
      ids.add(record.id);
    }
    assert.equal(seen.size, 25);
    assert.equal(ids.size, 25);
    tick();
  });

  test('create normalizes scopes and refuses unknown ones', () => {
    const w = svc.create({ name: 'Writer', scopes: ['write:recs'] });
    assert.deepEqual(w.record.scopes, ['read', 'write:recs']);
    const before = rows().length;
    assert.throws(() => svc.create({ name: 'Bad scope', scopes: ['admin'] }), isCode('bad_input'));
    assert.equal(rows().length, before, 'nothing stored on bad input');
    tick();
  });

  test('name is trimmed, 1 to 80 chars, with no control characters', () => {
    assert.equal(svc.create({ name: '  Padded name  ' }).record.name, 'Padded name');
    assert.equal(svc.create({ name: 'n'.repeat(80) }).record.name, 'n'.repeat(80));
    const before = rows().length;
    for (const bad of ['', '   ', 'n'.repeat(81), 'line\nbreak', 'bell\u0007', 'tab\there', 'nul\u0000', undefined, 42, null]) {
      assert.throws(() => svc.create({ name: bad }), isCode('bad_input'), JSON.stringify(bad));
    }
    assert.equal(rows().length, before);
    tick();
  });

  test('verify returns the record for a live key and null otherwise', () => {
    const { key, record } = svc.create({ name: 'Verify me', scopes: ['write:recs'] });
    const got = svc.verify(key);
    assert.ok(got);
    assert.equal(got.id, record.id);
    assert.equal(got.householdId, hh, 'verify names the key household');
    assert.deepEqual(got.scopes, ['read', 'write:recs']);
    const other = 'fathom_' + 'Q'.repeat(43);
    const flipped = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    for (const bad of [other, flipped, key + 'x', key.slice(0, -1), key.slice(KEY_PREFIX.length), 'other_' + key.slice(7),
      'FATHOM_' + key.slice(7), '', 'fathom_', undefined, null, 42, {}, ` ${key}`]) {
      assert.equal(svc.verify(bad), null, `refused: ${typeof bad === 'string' ? bad.length + ' chars' : typeof bad}`);
    }
    tick();
  });

  test('a revoked key no longer verifies; revoke is idempotent and keeps the first timestamp', () => {
    const { key, record } = svc.create({ name: 'Short lived' });
    assert.ok(svc.verify(key));
    tick();
    const first = svc.revoke(record.id);
    assert.equal(first.id, record.id);
    assert.equal(first.revokedAt, clock.toISOString());
    assert.equal(svc.verify(key), null);
    const stamp = first.revokedAt;
    tick();
    const again = svc.revoke(record.id);
    assert.equal(again.revokedAt, stamp, 'second revoke keeps the first timestamp');
    assert.equal(svc.list().find(k => k.id === record.id).revokedAt, stamp);
    assert.equal(svc.verify(key), null);
  });

  // Contradiction 1: with no users foreign key, verify fails closed on a creator who is no longer an
  // active member; ownerless keys do not depend on any member.
  test('a creator-owned key verifies only while its creator is an active member; ownerless keys are unaffected', () => {
    active.add(users.creator);
    const owned = svc.create({ name: 'Creator key', userId: users.creator });
    const ownerless = svc.create({ name: 'Ownerless key' });
    assert.equal(svc.verify(owned.key).id, owned.record.id);
    assert.equal(svc.verify(ownerless.key).id, ownerless.record.id);
    active.delete(users.creator);
    assert.equal(svc.verify(owned.key), null, 'a removed creator key no longer verifies');
    assert.equal(svc.verify(ownerless.key).id, ownerless.record.id);
    assert.ok(rows().some(r => r.id === owned.record.id), 'verification alone deletes nothing');
    active.add(users.creator);
    assert.equal(svc.verify(owned.key).id, owned.record.id, 'an active creator verifies again');
    active.delete(users.creator);
    tick();
  });

  test('ownerless keys stay manageable by an unscoped (admin) caller and refused to a member caller', () => {
    const ownerless = svc.create({ name: 'Admin managed key' });
    assert.ok(svc.list().some(k => k.id === ownerless.record.id), 'the unscoped listing carries it');
    assert.ok(!svc.list({ userId: users.member }).some(k => k.id === ownerless.record.id));
    assert.throws(() => svc.revoke(ownerless.record.id, { userId: users.member }), isCode('forbidden'));
    tick();
    assert.equal(svc.revoke(ownerless.record.id).revokedAt, clock.toISOString());
    assert.equal(svc.verify(ownerless.key), null);
    tick();
  });

  test('createKeyService requires creatorActive', () => {
    assert.throws(() => createKeyService({ platform: t.platform, secret: () => SECRET, now: () => clock }));
  });

  test('revoke of an unknown id is not_found', () => {
    assert.throws(() => svc.revoke('key_000000000000'), isCode('not_found'));
    assert.throws(() => svc.revoke(''), isCode('not_found'));
  });

  test('a key is bound to its household: another household cannot list, revoke or manage it', () => {
    const { key, record } = svc.create({ name: 'Bound key' });
    const other = 'hh-synthetic-other';
    assert.ok(!raw.list({ householdId: other }).some(k => k.id === record.id));
    assert.throws(() => raw.revoke(record.id, { householdId: other }), isCode('not_found'));
    assert.throws(() => raw.list({}), isCode('not_found'), 'no household, no listing');
    assert.equal(raw.verify(key).householdId, hh);
    tick();
  });

  test('verify compares against every stored row with timingSafeEqual', () => {
    const total = rows().length;
    assert.ok(total > 5);
    // The key under test is created first and several rows are created after it, so a verifier
    // that returns on the first match would stop before reaching them.
    const firstKey = svc.create({ name: 'First of many' });
    for (let i = 0; i < 5; i++) {
      tick();
      svc.create({ name: `Later key ${i}` });
    }
    const all = rows().length;
    assert.ok(all >= total + 6);
    assert.equal(rows().findIndex(r => r.id === firstKey.record.id), total, 'the matched key sits before the later rows');
    const spy = mock.method(crypto, 'timingSafeEqual');
    syncBuiltinESMExports();
    try {
      assert.equal(svc.verify(firstKey.key).id, firstKey.record.id);
      assert.ok(spy.mock.callCount() >= all, `matched earlier key: ${spy.mock.callCount()} compares for ${all} rows`);
      spy.mock.resetCalls();
      assert.equal(svc.verify('fathom_' + 'Z'.repeat(43)), null);
      assert.ok(spy.mock.callCount() >= all, `unknown key: ${spy.mock.callCount()} compares for ${all} rows`);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    tick();
  });

  test('touch sets last_used_at', () => {
    const { key, record } = svc.create({ name: 'Touched' });
    tick();
    svc.touch(record.id);
    const listed = svc.list().find(k => k.id === record.id);
    assert.equal(listed.lastUsedAt, clock.toISOString());
    assert.ok(svc.verify(key));
    tick();
  });

  test('list is ordered by creation and never exposes a hash or a key', () => {
    const list = svc.list();
    assert.ok(list.length > 10);
    for (const k of list) {
      assert.deepEqual(Object.keys(k).sort(), LIST_FIELDS);
      assert.ok(Array.isArray(k.scopes));
      assert.ok(k.scopes.includes('read'));
    }
    const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.deepEqual(list.map(k => k.id), sorted.map(k => k.id));
    const text = JSON.stringify(list);
    for (const r of rows()) assert.ok(!text.includes(r.key_hash), 'no hash in the listing');
    assert.ok(!/fathom_[A-Za-z0-9_-]{43}/.test(text), 'no key in the listing');
  });

  test('a record returned by create has the listing shape', () => {
    const { record } = svc.create({ name: 'Shape check' });
    assert.deepEqual(Object.keys(record).sort(), LIST_FIELDS);
    assert.deepEqual(svc.list().find(k => k.id === record.id), record);
  });
});

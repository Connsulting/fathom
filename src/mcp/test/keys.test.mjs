// AC3/AC5 (unit): app-issued API keys in src/mcp/keys.mjs against a temp migrated store.

import test, { describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHmac } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDb, tempDir } from '../../../test/helpers/server.mjs';
import {
  KEY_PREFIX, SCOPES, normalizeScopes, loadServerSecret, hashKey, createKeyService, toolsForScopes,
} from '../keys.mjs';
import { tools } from '../../tools/index.mjs';
import { KEY_RE } from './helpers.mjs';

const isCode = code => err => err instanceof Error && err.code === code;
const SECRET = Buffer.alloc(32, 7);
const LIST_FIELDS = ['createdAt', 'id', 'lastUsedAt', 'name', 'revokedAt', 'scopes'];

let t;
let clock;
let svc;

before(async () => {
  t = await tempDb();
  clock = new Date('2026-11-05T15:00:00.000Z');
  svc = createKeyService({ db: t.db, serverSecret: SECRET, now: () => clock });
});
after(() => t && t.close());

const tick = () => { clock = new Date(clock.getTime() + 1000); };
const rows = () => t.db.prepare('SELECT * FROM api_keys ORDER BY created_at, id').all().map(r => ({ ...r }));

describe('constants and scopes', () => {
  test('prefix and scope list', () => {
    assert.equal(KEY_PREFIX, 'fathom_');
    assert.deepEqual([...SCOPES], ['read', 'write:recs']);
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
    assert.ok(!readOnly.includes('set_recommendation_status'));
    assert.deepEqual(readOnly, tools.filter(x => x.scope === 'read').map(x => x.name));
    const both = toolsForScopes(['read', 'write:recs']).map(x => x.name);
    assert.deepEqual(both, tools.map(x => x.name));
    assert.deepEqual(toolsForScopes([]), []);
    const registry = [{ name: 'a', scope: 'read' }, { name: 'b', scope: 'write:recs' }, { name: 'c', scope: 'read' }];
    assert.deepEqual(toolsForScopes(['read'], registry).map(x => x.name), ['a', 'c']);
    assert.deepEqual(toolsForScopes(['write:recs'], registry).map(x => x.name), ['b']);
  });
});

describe('server secret', () => {
  test('created on first use as a 0600 file of 64 hex chars and reused after', async () => {
    const dir = await tempDir();
    const file = join(dir, 'api-key-secret');
    assert.ok(!existsSync(file));
    const first = loadServerSecret(dir);
    assert.ok(Buffer.isBuffer(first));
    assert.ok(first.length > 0);
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const before = readFileSync(file, 'utf8');
    const second = loadServerSecret(dir);
    assert.ok(first.equals(second), 'the same secret is returned on reuse');
    assert.equal(readFileSync(file, 'utf8'), before, 'the file is not rewritten');
  });

  test('two data dirs get different secrets', async () => {
    const a = loadServerSecret(await tempDir());
    const b = loadServerSecret(await tempDir());
    assert.ok(!a.equals(b));
  });

  test('a corrupt secret file is refused, not replaced', async () => {
    for (const bad of ['', 'not hex at all', 'ab'.repeat(16), 'zz'.repeat(32), 'ab'.repeat(33)]) {
      const dir = await tempDir();
      const file = join(dir, 'api-key-secret');
      writeFileSync(file, bad, { mode: 0o600 });
      assert.throws(() => loadServerSecret(dir), Error, JSON.stringify(bad));
      assert.equal(readFileSync(file, 'utf8'), bad, 'the corrupt file is left as it was');
    }
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
    assert.equal(record.name, 'Laptop agent');
    assert.deepEqual(record.scopes, ['read']);
    assert.equal(record.createdAt, clock.toISOString());
    assert.equal(record.lastUsedAt, null);
    assert.equal(record.revokedAt, null);
    const row = t.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(record.id);
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

  test('revoke of an unknown id is not_found', () => {
    assert.throws(() => svc.revoke('key_000000000000'), isCode('not_found'));
    assert.throws(() => svc.revoke(''), isCode('not_found'));
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

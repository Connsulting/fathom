import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { twoHouseholds, enrollSession } from './helpers/tenancy-runtime.mjs';
import { sessionClient } from './helpers/server.mjs';

test('a packet assembled after membership removal is refused and cleaned up; active download succeeds', { timeout: 120000 }, async () => {
  const f = await twoHouseholds();
  try {
    const member = await enrollSession(f.platform, f.A.id, 'packet-member@example.test');
    const client = sessionClient(f.baseUrl, member);
    const before = await client.request({ path: '/api/yearend/packet' });
    assert.equal(before.status, 200);
    assert.equal(before.headers['content-type'], 'application/zip');
    // Observe the real packet builder's first async filesystem operation without replacing it.
    // Revocation runs synchronously before that operation completes and before any packet bytes.
    let removed = false;
    const hook = createHook({ init(_id, type) {
      if (removed || type !== 'FSREQPROMISE') return;
      removed = true;
      f.store.removeMember(f.A.id, member.user.id, { actorId: f.A.admin.user.id });
    } });
    hook.enable();
    let response;
    try { response = await client.request({ path: '/api/yearend/packet' }); }
    finally { hook.disable(); }
    assert.ok(removed, 'revoked during real asynchronous packet assembly');
    assert.equal(response.status, 401, 'removed member gets no ZIP');
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(response.json, { error: 'unauthorized' });
    assert.deepEqual(readdirSync(join(f.rootOf(f.A.id), 'work')), [], 'plaintext intermediates removed');
    const live = await f.A.client.request({ path: '/api/yearend/packet' });
    assert.equal(live.status, 200);
  } finally { await f.close(); }
});

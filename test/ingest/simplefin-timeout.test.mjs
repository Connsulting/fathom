// SimpleFIN accounts request against a slow bridge. The bridge refreshes the banks before it
// answers an authenticated accounts request, which takes about 30 seconds, so the accounts call
// waits up to ACCOUNTS_TIMEOUT_MS and retries once on a timeout or network error. The claim call
// spends a one-time token and is never retried. Every bridge here is synthetic (the fake bridge
// behind an injected delay); no real network and no real clock waits beyond a few hundred ms.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import { realStore, NOW } from '../helpers/ingest.mjs';

let S;
before(async () => { S = await src('src/ingest/simplefin.mjs'); });

const TODAY = NOW.slice(0, 10);
// Simulated time: 1 real ms stands for SCALE ms of bridge time, so 45 s becomes 225 ms.
const SCALE = 200;

async function withConnected(fn) {
  const s = await realStore();
  try {
    const fake = S.createFakeSimplefin({ today: () => TODAY });
    await S.connectSimplefin(s.db, S.fakeToken(), { household: s.household, now: NOW, fetch: fake });
    return await fn(s, fake);
  } finally { s.close(); }
}

const isAccounts = (url) => String(url).includes('/accounts');

// Answers an accounts request after `ms`, honoring the request's abort signal like real fetch.
function slowBridge(inner, ms, log) {
  return (url, init = {}) => {
    if (!isAccounts(url)) return inner(url, init);
    log.push('accounts');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(inner(url, init)), ms);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
  };
}

const syncOpts = (s, fetch, extra = {}) => ({ config: s.config, household: s.household, now: NOW, clock: TODAY, fetch, ...extra });

test('the accounts timeout is two minutes and the retry delay is short', () => {
  assert.equal(S.ACCOUNTS_TIMEOUT_MS, 120000);
  assert.ok(S.RETRY_DELAY_MS > 0 && S.RETRY_DELAY_MS <= 10000);
});

test('a bridge that answers after 45 seconds completes the sync on the first try', () => withConnected(async (s, fake) => {
  const log = [];
  const out = await S.syncSimplefin(s.db, syncOpts(s, slowBridge(fake, 45000 / SCALE, log), { timeoutMs: S.ACCOUNTS_TIMEOUT_MS / SCALE, retryDelayMs: 0 }));
  assert.equal(out.status, 'ok');
  assert.equal(out.counts.accounts, 4);
  assert.deepEqual(log, ['accounts'], 'one request, no retry');
}));

test('liveness: the old 30 second limit would have failed the same 45 second bridge', () => withConnected(async (s, fake) => {
  const log = [];
  const out = await S.syncSimplefin(s.db, syncOpts(s, slowBridge(fake, 45000 / SCALE, log), { timeoutMs: 30000 / SCALE, retryDelayMs: 0 }));
  assert.deepEqual([out.status, out.code], ['error', 'network']);
  assert.equal(log.length, 2, 'it retried once, then gave up');
}));

test('the default accounts request is cancelled by a two minute signal', () => withConnected(async (s, fake) => {
  const seen = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { seen.push(ms); return original.call(AbortSignal, ms); };
  try {
    const out = await S.syncSimplefin(s.db, syncOpts(s, fake));
    assert.equal(out.status, 'ok');
  } finally { AbortSignal.timeout = original; }
  assert.ok(seen.includes(120000), `signals used: ${seen}`);
}));

test('a network error on the first try is retried once and the sync completes', () => withConnected(async (s, fake) => {
  let accountsCalls = 0;
  const flaky = (url, init) => {
    if (isAccounts(url) && ++accountsCalls === 1) return Promise.reject(new TypeError('fetch failed'));
    return fake(url, init);
  };
  const out = await S.syncSimplefin(s.db, syncOpts(s, flaky, { retryDelayMs: 0 }));
  assert.equal(out.status, 'ok');
  assert.equal(accountsCalls, 2);
  assert.equal(s.db.prepare('SELECT status, error_code FROM simplefin_connection WHERE id = 1').get().status, 'ok');
}));

test('the retry waits the configured delay before the second request', () => withConnected(async (s, fake) => {
  const stamps = [];
  const flaky = (url, init) => {
    if (isAccounts(url)) { stamps.push(Date.now()); if (stamps.length === 1) return Promise.reject(new TypeError('fetch failed')); }
    return fake(url, init);
  };
  await S.syncSimplefin(s.db, syncOpts(s, flaky, { retryDelayMs: 60 }));
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 50, `gap ${stamps[1] - stamps[0]} ms`);
}));

test('a bridge that always times out ends in the network status after exactly two requests', () => withConnected(async (s, fake) => {
  const log = [];
  const never = slowBridge(fake, 60 * 60 * 1000, log);
  const out = await S.syncSimplefin(s.db, syncOpts(s, never, { timeoutMs: 120000 / 1000, retryDelayMs: 0 }));
  assert.deepEqual([out.status, out.code], ['error', 'network']);
  assert.equal(log.length, 2);
  const row = s.db.prepare('SELECT status, error_code FROM simplefin_connection WHERE id = 1').get();
  assert.deepEqual([row.status, row.error_code], ['error', 'network']);
}));

test('refusals the bridge answers are not retried', () => withConnected(async (s, fake) => {
  for (const [status, code] of [[403, 'revoked'], [402, 'payment_required'], [500, 'bad_response']]) {
    let calls = 0;
    const refuse = async (url, init) => {
      if (!isAccounts(url)) return fake(url, init);
      calls += 1;
      return new Response('no', { status });
    };
    const out = await S.syncSimplefin(s.db, syncOpts(s, refuse, { retryDelayMs: 0 }));
    assert.equal(out.code, code);
    assert.equal(calls, 1, `${status} is answered once`);
    s.db.prepare("UPDATE simplefin_connection SET status = 'ok', error_code = NULL WHERE id = 1").run();
  }
}));

test('claiming a setup token is never retried', async () => {
  let calls = 0;
  const failing = () => { calls += 1; return Promise.reject(new TypeError('fetch failed')); };
  await assert.rejects(S.claimToken(S.fakeToken(), { hosts: S.DEFAULT_HOSTS, fetch: failing }), (e) => e.code === 'network');
  assert.equal(calls, 1);
});

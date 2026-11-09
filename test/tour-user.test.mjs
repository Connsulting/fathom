// The guided tour for signed-in users: per-user state in the platform DB (users.tour_pending).
// A user gets the tour once, right after completing onboarding (the done transition), and
// completing or dismissing it clears the flag for that user only, on every device. Users who had
// finished onboarding before this change are never flagged, and the public demo keeps its
// browser-local rule. Synthetic data only.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { src, tempDb, tempDir, PLATFORM_FILE } from './helpers/server.mjs';

let H;
let T;
let P;
let D;
let TOUR;
before(async () => {
  H = await src('src/api/handlers.mjs');
  T = await src('src/api/tour-handlers.mjs');
  P = await src('src/platform/db.mjs');
  D = await src('src/store/db.mjs');
  TOUR = await src('web/horizon/screens/tour.js');
});

async function fixture() {
  const store = await tempDb();
  const dir = await tempDir();
  const platform = await P.openPlatform(join(dir, PLATFORM_FILE));
  const addUser = async (id) => await platform.prepare('INSERT INTO users (id, email, user_handle, created_at, enrolled_at) VALUES (?, ?, ?, 1, 1)')
    .run(id, `${id}@example.test`, `handle-${id}`);
  await addUser('u-owner');
  await addUser('u-spouse');
  const ctxFor = (userId, body = {}) => ({ db: store.db, platform, config: {}, identity: userId ? { id: userId } : null, body, params: {}, query: {} });
  const pending = async (id) => (await platform.prepare('SELECT tour_pending AS p FROM users WHERE id = ?').get(id)).p;
  return { store, platform, ctxFor, pending, close: async () => { await platform.close(); await store.close(); } };
}

describe('the tour flag on a new column of users', () => {
  test('the platform migration is additive and every user starts with no tour pending', async () => {
    const f = await fixture();
    try {
      const cols = await f.platform.prepare("SELECT name, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('users')").all();
      const col = cols.find((c) => c.name === 'tour_pending');
      assert.ok(col, 'users.tour_pending exists');
      assert.equal(col.nn, 1);
      assert.equal(String(col.d), '0');
      assert.equal(await f.pending('u-owner'), 0);
      assert.ok(cols.some((c) => c.name === 'email') && cols.some((c) => c.name === 'enrolled_at'), 'existing columns are untouched');
    } finally { await f.close(); }
  });
});

describe('the onboarding-complete transition', () => {
  test('a new user finishing onboarding gets the tour pending, shown on the scenario', async () => {
    const f = await fixture();
    try {
      assert.equal((await H.scenarioOf(f.ctxFor('u-owner'))).live.tourPending, false);
      await H.onboarding(f.ctxFor('u-owner', { step: 3 }));
      assert.equal(await f.pending('u-owner'), 0, 'a step before the end does not start it');
      const out = (await H.onboarding(f.ctxFor('u-owner', { step: 6 })));
      assert.equal(out.scenario.live.tourPending, true);
      assert.equal(await f.pending('u-owner'), 1);
      assert.equal(await f.pending('u-spouse'), 0, 'only the user who finished onboarding');
    } finally { await f.close(); }
  });

  test('a user who finished onboarding before the change is never flagged, even on the done step again', async () => {
    const f = await fixture();
    try {
      await D.setSetting(f.store.db, 'onboarding', { done: true, step: 6 });
      const out = (await H.onboarding(f.ctxFor('u-owner', { step: 6 })));
      assert.equal(out.scenario.live.tourPending, false);
      assert.equal(await f.pending('u-owner'), 0);
      await H.onboarding(f.ctxFor('u-owner', { step: 2 }));
      assert.equal(await f.pending('u-owner'), 0, 'revisiting Setup does not flag either');
    } finally { await f.close(); }
  });

  test('a demo or signed-out caller has no identity to flag', async () => {
    const f = await fixture();
    try {
      const out = (await H.onboarding(f.ctxFor(null, { step: 6 })));
      assert.equal(out.scenario.live.tourPending, false);
      assert.equal((await f.platform.prepare('SELECT COUNT(*) AS n FROM users WHERE tour_pending = 1').get()).n, 0);
    } finally { await f.close(); }
  });
});

describe('POST /api/tour/seen', () => {
  test('clears the flag, so a second session or device of the same user does not see the tour', async () => {
    const f = await fixture();
    try {
      await H.onboarding(f.ctxFor('u-owner', { step: 6 }));
      assert.equal((await H.scenarioOf(f.ctxFor('u-owner'))).live.tourPending, true, 'a second session before it is dismissed');
      const out = (await T.tourSeen(f.ctxFor('u-owner')));
      assert.equal(out.scenario.live.tourPending, false);
      assert.equal((await H.scenarioOf(f.ctxFor('u-owner'))).live.tourPending, false, 'a second session after');
      await H.onboarding(f.ctxFor('u-owner', { step: 6 }));
      assert.equal(await f.pending('u-owner'), 0, 'finishing onboarding again does not bring it back');
    } finally { await f.close(); }
  });

  test('touches only the caller and refuses a request without a session', async () => {
    const f = await fixture();
    try {
      await f.platform.prepare('UPDATE users SET tour_pending = 1').run();
      await assert.rejects(async () => await T.tourSeen(f.ctxFor(null)), (e) => e.status === 401);
      assert.equal(await f.pending('u-owner'), 1);
      await T.tourSeen({ ...f.ctxFor('u-owner'), body: { userId: 'u-spouse' }, params: { id: 'u-spouse' } });
      assert.equal(await f.pending('u-owner'), 0);
      assert.equal(await f.pending('u-spouse'), 1, 'a body or path id never selects another user');
    } finally { await f.close(); }
  });
});

describe('autoStartMode: which rule starts the tour on page load', () => {
  test('the public demo keeps its once-per-browser rule', () => {
    assert.equal(TOUR.autoStartMode({ publicDemo: true, tourPending: false, localDone: false }), 'demo');
    assert.equal(TOUR.autoStartMode({ publicDemo: true, tourPending: false, localDone: true }), null);
    assert.equal(TOUR.autoStartMode({ publicDemo: true, tourPending: true, localDone: false }), 'demo', 'the server flag is not used on the demo');
  });

  test('a signed-in instance follows the server flag and ignores the browser flag', () => {
    assert.equal(TOUR.autoStartMode({ publicDemo: false, tourPending: true, localDone: false }), 'user');
    assert.equal(TOUR.autoStartMode({ publicDemo: false, tourPending: true, localDone: true }), 'user', 'another browser already finished the old local tour');
    assert.equal(TOUR.autoStartMode({ publicDemo: false, tourPending: false, localDone: false }), null);
  });
});

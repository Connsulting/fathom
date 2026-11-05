// Returning owner: a real store that already holds data (an account or an imported file) builds
// as november, not fresh, so the owner lands in the app instead of onboarding. Demo stores keep
// their own rule (onboarding done or not).

import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { setSetting } from '../src/store/db.mjs';
import { tempDb } from './helpers/server.mjs';

async function withRealStore(fn) {
  const t = await tempDb();
  try {
    setSetting(t.db, 'mode', 'real');
    return await fn(t.db);
  } finally {
    t.close();
  }
}

const addAccount = db => db.prepare(`INSERT INTO accounts (id, inst, name, owner, kind, mirror, parser)
  VALUES ('acct-synth-1', 'Synthetic Bank', 'Synthetic Checking', NULL, 'checking', 'manual', 'test')`).run();

const addFile = db => db.prepare(`INSERT INTO files (id, name, mime, size, uploaded_at, status)
  VALUES ('f-synth-1', 'synthetic.csv', 'text/csv', 64, '2026-11-01T09:00:00Z', 'imported')`).run();

test('an empty real store is fresh (first-run onboarding)', () => withRealStore(db => {
  const sc = buildScenario(db);
  assert.equal(sc.live.mode, 'real');
  assert.equal(sc.live.demo, 'fresh');
}));

test('a store with no mode row is real and, empty, is fresh', async () => {
  const t = await tempDb();
  try {
    const sc = buildScenario(t.db);
    assert.equal(sc.live.mode, 'real');
    assert.equal(sc.live.demo, 'fresh');
  } finally {
    t.close();
  }
});

test('a real store with one account is november', () => withRealStore(db => {
  addAccount(db);
  const sc = buildScenario(db);
  assert.equal(sc.live.mode, 'real');
  assert.equal(sc.live.demo, 'november');
  assert.equal(sc.accounts.length, 1);
}));

test('a real store with one files row and no account is november', () => withRealStore(db => {
  addFile(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0, 'precondition: no accounts');
  assert.equal(buildScenario(db).live.demo, 'november');
}));

test('a real store with onboarding done stays november, with or without data', () => withRealStore(db => {
  setSetting(db, 'onboarding', { done: true, step: 6 });
  assert.equal(buildScenario(db).live.demo, 'november', 'empty but onboarded');
  addAccount(db);
  assert.equal(buildScenario(db).live.demo, 'november', 'onboarded with data');
}));

test('the demo seed stays november', async () => {
  const t = await tempDb();
  try {
    seedDemo(t.db);
    const sc = buildScenario(t.db);
    assert.equal(sc.live.mode, 'demo');
    assert.equal(sc.live.demo, 'november');
  } finally {
    t.close();
  }
});

test('a demo store with data but onboarding not done is still fresh (demo rule unchanged)', async () => {
  const t = await tempDb();
  try {
    seedDemo(t.db);
    assert.ok(t.db.prepare('SELECT count(*) AS n FROM accounts').get().n > 0, 'precondition: the demo seed has accounts');
    setSetting(t.db, 'onboarding', { done: false, step: 0 });
    assert.equal(buildScenario(t.db).live.demo, 'fresh');
  } finally {
    t.close();
  }
});

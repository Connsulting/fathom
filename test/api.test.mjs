// AC4 (HTTP): the real server child persists every action to the store, guards its API, and
// follows the store-mode rules (pinned decision 5).

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, symlinkSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import demo from '../demo/scenario.mjs';
import { needsYou, verdictLevel } from '../src/shared/rules.mjs';
import { setSetting } from '../src/store/db.mjs';
import {
  ROOT, SERVER_TIMEOUT, spawnServer, withServer, expectServerExit,
  tempDb, tempDir, tempInstance, openStore, dumpStore, runCommand, recOf, src, serveAppFixture, spawnAuthenticatedServer, withAuthenticatedServer,
} from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const T2 = { timeout: SERVER_TIMEOUT * 2 };
const ENGINE_OFF = 'Engine is off, so answers are paused. Switch it back on to get an answer.';
// A fixed Ask thread key for rows written straight into a store.
const STORE_THREAD = 'ask:0123456789ab';
// A suggested question's exact text: sent as free text, it gets the canned answer and its refs.
const suggested = id => demo.ask.suggested.find(x => x.id === id);
const newThread = (s, body = {}) => s.postJson('/api/threads', body);

const act = (s, id, action, arg) =>
  s.postJson(`/api/recs/${encodeURIComponent(id)}/action`, arg === undefined ? { action } : { action, arg });

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.ok(r.json && r.json.scenario, 'response carries the scenario');
  return r.json;
}

async function fails(resPromise, status) {
  const r = await resPromise;
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.equal(typeof (r.json && r.json.error), 'string', 'error body is { error }');
  return r;
}

async function readDb(file, fn) {
  const db = await openStore(file);
  try { return await fn(db); } finally { db.close(); }
}

// A real store with data: facts, a conversation with a message, and the onboarding setting.
// Recs in a real-store scenario that the planner does not own. The server's startup tick may run
// the nightly plan job, so a real store can carry planner recs; it never carries seeded ones.
async function nonPlannerRecs(file, sc) {
  const planned = await readDb(file, db => db.prepare('SELECT rec_id FROM planner_recs').all().map(r => r.rec_id));
  return sc.recs.filter(r => !planned.includes(r.id)).map(r => r.id);
}

async function populatedRealStore() {
  const dataDir = await tempDir();
  await withAuthenticatedServer({ dataDir, env: { FATHOM_DEMO: '0' } }, async () => {});
  const file = join(dataDir, 'fathom.sqlite');
  await readDb(file, db => {
    db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                VALUES ('household.dependents', '2', 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`).run();
    db.prepare('INSERT OR IGNORE INTO conversations (key, created_at, last_at) VALUES (?, ?, ?)')
      .run(STORE_THREAD, '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z');
    db.prepare(`INSERT INTO messages (conversation_key, role, text, refs, notice, ts)
                VALUES (?, 'me', '<p>Synthetic note for the store test.</p>', '[]', 0, '2026-11-01T09:00:00Z')`).run(STORE_THREAD);
    setSetting(db, 'onboarding', { done: true, step: 6 });
  });
  return { dataDir, file };
}

describe('rec actions', () => {
  test('each action transitions per CONTRACT, persists across a restart, and writes rec_events', T2, async () => {
    const s = await spawnServer();
    const steps = [
      ['start', undefined, 'doing'],
      ['snooze', 'Dec 10 check-in', 'snoozed'],
      ['snooze', undefined, 'snoozed'],
      ['dismiss', undefined, 'dismissed'],
      ['reopen', undefined, 'proposed'],
      ['complete', undefined, 'done'],
    ];
    try {
      for (const [action, arg, want] of steps) {
        const { scenario } = await ok(act(s, 'deferral', action, arg));
        const r = recOf(scenario, 'deferral');
        assert.equal(r.status, want, `${action} -> ${want}`);
        if (action === 'snooze') assert.equal(r.wake, arg ?? 'Next month', 'snooze wake label');
      }
    } finally {
      await s.stop();
    }
    const events = await readDb(s.dbFile, db =>
      db.prepare("SELECT action, from_status, to_status, actor FROM rec_events WHERE rec_id = 'deferral' AND actor = 'ui' ORDER BY id").all().map(r => ({ ...r })));
    assert.deepEqual(events.map(e => [e.action, e.to_status]), steps.map(([a, , w]) => [a, w]));
    assert.equal(events[0].from_status, 'proposed');
    for (let i = 1; i < events.length; i++) assert.equal(events[i].from_status, events[i - 1].to_status);

    await withServer({ dataDir: s.dataDir }, async s2 => {
      assert.equal(recOf(await s2.getScenario(), 'deferral').status, 'done', 'persists across restart');
    });
  });

  test('task toggle flips done, persists, and completing every task does not complete the rec', T2, async () => {
    const s = await spawnServer();
    const base = demo.recs.find(r => r.id === 'offcycle');
    try {
      let { scenario } = await ok(act(s, 'offcycle', 'task', 0));
      assert.equal(recOf(scenario, 'offcycle').tasks[0].done, !base.tasks[0].done);
      ({ scenario } = await ok(act(s, 'offcycle', 'task', 0)));
      assert.equal(recOf(scenario, 'offcycle').tasks[0].done, !!base.tasks[0].done, 'second toggle flips back');
      for (let i = 0; i < base.tasks.length; i++) {
        if (!recOf(scenario, 'offcycle').tasks[i].done) ({ scenario } = await ok(act(s, 'offcycle', 'task', i)));
      }
      const r = recOf(scenario, 'offcycle');
      assert.ok(r.tasks.every(x => x.done));
      assert.equal(r.status, 'doing', 'status unchanged');
      await fails(act(s, 'offcycle', 'task', base.tasks.length), 400);
      await fails(act(s, 'offcycle', 'task', -1), 400);
      await fails(act(s, 'offcycle', 'task', 'x'), 400);
    } finally {
      await s.stop();
    }
    await withServer({ dataDir: s.dataDir }, async s2 => {
      assert.ok(recOf(await s2.getScenario(), 'offcycle').tasks.every(x => x.done), 'tasks persist');
    });
  });

  test('bad action 400, unknown rec 404, hidden rec 404', T, () => withServer({}, async s => {
    await fails(act(s, 'deferral', 'explode'), 400);
    await fails(act(s, 'deferral', 'accept'), 400);
    await fails(s.postJson('/api/recs/deferral/action', {}), 400);
    await fails(act(s, 'no-such-rec', 'start'), 404);
    await fails(act(s, 'daf', 'start'), 404);
    await fails(act(s, 'daf', 'task', 0), 404);
    await ok(act(s, 'dcfsa', 'start'));
  }));

  test('completing every needs-you rec flips the verdict to clear and it persists', T2, async () => {
    const s = await spawnServer();
    try {
      let scenario = await s.getScenario();
      const ny = needsYou(scenario.recs);
      assert.ok(ny.length > 0);
      assert.equal(verdictLevel(scenario.recs), 'attention');
      for (const r of ny) ({ scenario } = await ok(act(s, r.id, 'complete')));
      assert.deepEqual(needsYou(scenario.recs), []);
      assert.equal(verdictLevel(scenario.recs), 'clear');
    } finally {
      await s.stop();
    }
    await withServer({ dataDir: s.dataDir }, async s2 => {
      assert.equal(verdictLevel((await s2.getScenario()).recs), 'clear');
    });
  });
});

describe('war game, packs and engine', () => {
  test('war-game pick persists and rejects out of range', T2, async () => {
    const s = await spawnServer();
    const last = demo.wargame.deferral.options.length - 1;
    try {
      const { scenario } = await ok(s.postJson('/api/wargame/deferral/pick', { index: last }));
      assert.equal(scenario.live.picks.deferral, last);
      await ok(s.postJson('/api/wargame/salary/pick', { index: 0 }));
      await fails(s.postJson('/api/wargame/deferral/pick', { index: last + 1 }), 400);
      await fails(s.postJson('/api/wargame/deferral/pick', { index: -1 }), 400);
      await fails(s.postJson('/api/wargame/salary/pick', { index: demo.wargame.salary.points.length }), 400);
      const bad = await s.postJson('/api/wargame/bogus/pick', { index: 0 });
      assert.ok([400, 404].includes(bad.status), `unknown war game -> ${bad.status}`);
    } finally {
      await s.stop();
    }
    await withServer({ dataDir: s.dataDir }, async s2 => {
      const sc = await s2.getScenario();
      assert.deepEqual(sc.live.picks, { salary: 0, deferral: last });
    });
  });

  test('pack toggle turns a hidden rec into proposed and back', T, () => withServer({}, async s => {
    const on = await ok(s.postJson('/api/packs/giving/toggle', {}));
    assert.equal(on.status, 'active');
    assert.equal(on.scenario.live.packs.giving.active, true);
    assert.equal(recOf(on.scenario, 'daf').status, 'proposed');
    await ok(act(s, 'daf', 'start'));
    await ok(act(s, 'daf', 'reopen'));

    const off = await ok(s.postJson('/api/packs/giving/toggle', {}));
    assert.equal(off.status, 'suggested');
    assert.notEqual(off.scenario.live.packs.giving.active, true);
    const daf = recOf(off.scenario, 'daf');
    assert.ok(!daf || daf.status === 'hidden', 'daf is hidden again');
    await fails(act(s, 'daf', 'start'), 404);

    const scorp = await ok(s.postJson('/api/packs/scorp/toggle', {}));
    assert.equal(scorp.status, 'available', 'an active pack turned off reads available');
    await fails(s.postJson('/api/packs/no-such-pack/toggle', {}), 404);
  }));

  test('what-if marks the pack exploring and appends the live conversation once', T, () => withServer({}, async s => {
    const p = demo.packs.find(x => x.id === 'contractor');
    const { scenario } = await ok(s.postJson('/api/packs/contractor/whatif', {}));
    assert.equal(scenario.live.packs.contractor.exploring, true);
    assert.equal(scenario.live.packs.contractor.whatIfDone, true);
    const conv = scenario.live.conversations['pack:contractor'];
    assert.equal(conv.length, 2);
    assert.equal(conv[0].role, 'me');
    assert.ok(conv[0].text.includes(p.whatIf.prompt));
    assert.equal(conv[1].role, 'fathom');
    assert.equal(conv[1].notice, false);
    assert.ok(conv[1].text.length > 0);
    assert.equal(conv[1].provenance.engine, 'fake', 'the answer carries provenance');
    assert.deepEqual(conv[1].refs, [], 'the contractor unlocks name no rec');
    const again = await ok(s.postJson('/api/packs/contractor/whatif', {}));
    assert.deepEqual(again.scenario.live.conversations['pack:contractor'], conv, 'no duplicate answer');
    await fails(s.postJson('/api/packs/no-such-pack/whatif', {}), 404);
  }));

  test('what-if with the engine off appends a single notice and does not mark done', T, () => withServer({}, async s => {
    await ok(s.postJson('/api/engine', { on: false }));
    let { scenario } = await ok(s.postJson('/api/packs/rental/whatif', {}));
    ({ scenario } = await ok(s.postJson('/api/packs/rental/whatif', {})));
    let conv = scenario.live.conversations['pack:rental'];
    assert.equal(conv.length, 2);
    assert.equal(conv[1].notice, true);
    assert.ok(conv[1].text.includes(ENGINE_OFF));
    assert.equal(scenario.live.packs.rental.whatIfDone, false);
    assert.equal(scenario.live.packs.rental.exploring, true);

    await ok(s.postJson('/api/engine', { on: true }));
    ({ scenario } = await ok(s.postJson('/api/packs/rental/whatif', {})));
    conv = scenario.live.conversations['pack:rental'];
    assert.equal(conv.length, 3);
    assert.equal(conv[2].role, 'fathom');
    assert.equal(conv[2].notice, false);
    assert.equal(conv[2].provenance.engine, 'fake');
    assert.equal(scenario.live.packs.rental.whatIfDone, true);
  }));

  test('engine off persists and ask stores the engine-off notice', T2, async () => {
    const s = await spawnServer();
    try {
      const { scenario } = await ok(s.postJson('/api/engine', { on: false }));
      assert.equal(scenario.live.engine, false);
      await fails(s.postJson('/api/engine', { on: 'no' }), 400);
    } finally {
      await s.stop();
    }
    await withServer({ dataDir: s.dataDir }, async s2 => {
      assert.equal((await s2.getScenario()).live.engine, false, 'engine setting persists');
      const r = await ok(newThread(s2, { text: suggested('defer').q }));
      assert.equal(r.message.notice, true);
      assert.ok(r.message.text.includes(ENGINE_OFF));
      const conv = r.scenario.live.conversations[r.thread.key];
      assert.equal(conv.length, 2);
      assert.equal(conv[0].role, 'me');
      assert.equal(conv[1].notice, true);

      const back = await ok(s2.postJson('/api/engine', { on: true }));
      assert.equal(back.scenario.live.engine, true);
      const ans = await ok(s2.postJson('/api/ask', { key: r.thread.key, text: suggested('defer').q }));
      assert.ok(!ans.message.notice, 'answers return once the engine is on');
    });
  });
});

describe('ask', () => {
  test('a suggested question appends me and fathom messages with a live answer and persists', T2, async () => {
    const s = await spawnServer();
    const q = suggested('defer');
    let answer;
    let key;
    try {
      const r = await ok(newThread(s, { text: q.q }));
      key = r.thread.key;
      answer = r.message;
      assert.equal(r.message.role, 'fathom');
      assert.equal(r.message.notice, false);
      assert.ok(r.message.text.length > 0);
      assert.equal(r.message.provenance.engine, 'fake');
      assert.ok(r.message.provenance.tools.length > 0, 'provenance lists the tools used');
      for (const id of q.refs) assert.ok(r.message.refs.includes(id), `refs include ${id}`);
      const conv = r.scenario.live.conversations[key];
      assert.equal(conv.length, 2);
      assert.equal(conv[0].role, 'me');
      assert.ok(conv[0].text.includes(q.q));
      assert.deepEqual(conv[1], r.message);
      assert.notEqual(conv[0].id, conv[1].id);
    } finally {
      await s.stop();
    }
    await withServer({ dataDir: s.dataDir }, async s2 => {
      const conv = (await s2.getScenario()).live.conversations[key];
      assert.equal(conv.length, 2, 'conversation persists');
      assert.deepEqual(conv[1], answer, 'the answer and its provenance persist');
    });
  });

  test('a rec question by index answers in a new thread asked from the rec', T, () => withServer({}, async s => {
    const rec = demo.recs.find(x => x.id === 'deferral');
    const r = await ok(newThread(s, { recId: 'deferral', questionId: 0 }));
    assert.equal(r.thread.recId, 'deferral');
    assert.equal(r.message.role, 'fathom');
    assert.equal(r.message.notice, false);
    assert.ok(r.message.provenance, 'the answer carries provenance');
    assert.ok(r.message.refs.includes('deferral'));
    const conv = r.scenario.live.conversations[r.thread.key];
    assert.equal(conv.length, 2, 'question and answer');
    assert.ok(conv[0].text.includes(rec.qa[0].q));
  }));

  test('free text matching a question answers with its refs, other free text answers from the summary', T, () => withServer({}, async s => {
    const q = suggested('screwing');
    const hit = await ok(newThread(s, { text: '  ' + q.q.toLowerCase() + ' ' }));
    const key = hit.thread.key;
    assert.equal(hit.message.notice, false);
    assert.ok(hit.message.provenance, 'the answer carries provenance');
    for (const id of q.refs) assert.ok(hit.message.refs.includes(id), `refs include ${id}`);
    assert.ok(hit.scenario.live.conversations[key][0].text.includes(q.q.toLowerCase()), 'the owner message is the text sent');
    const miss = await ok(s.postJson('/api/ask', { key, text: 'How tall is the office ficus?' }));
    assert.equal(miss.message.notice, false);
    assert.ok(miss.message.provenance.tools.some(x => x.name === 'household'));
    assert.deepEqual(miss.message.refs, []);
    const conv = miss.scenario.live.conversations[key];
    assert.equal(conv.length, 4);
    assert.ok(conv[2].text.includes('How tall is the office ficus?'));
  }));

  test('ask validates its body', T, () => withServer({}, async s => {
    const { thread } = await ok(newThread(s));
    const key = thread.key;
    await fails(s.postJson('/api/ask', {}), 400);
    await fails(s.postJson('/api/ask', { key }), 400);
    await fails(s.postJson('/api/ask', { text: 'hello' }), 400);
    await fails(s.postJson('/api/ask', { key, questionId: 'defer', text: 'both' }), 400);
    await fails(s.postJson('/api/ask', { key, text: '   ' }), 400);
    await fails(s.postJson('/api/ask', { key, text: '' }), 400);
    await fails(s.postJson('/api/ask', { key, text: 7 }), 400);
    await fails(s.postJson('/api/ask', { key: 7, text: 'hello' }), 400);
    await fails(s.postJson('/api/ask', { key, text: 'x'.repeat(4001) }), 400);
    const unknownQ = await s.postJson('/api/ask', { key, questionId: 'no-such-question' });
    assert.ok([400, 404].includes(unknownQ.status), `unknown question -> ${unknownQ.status}`);
    // A key that is neither an Ask thread nor a pack conversation (a bare rec id included) is 400.
    await fails(s.postJson('/api/ask', { key: 'no-such-rec', text: 'hello' }), 400);
    await fails(s.postJson('/api/ask', { key: 'deferral', text: 'hello' }), 400);
    for (const body of [{ questionId: 'yearend', text: 'both' }, { text: '' }, { text: '   ' }, { text: 7 }, { text: 'x'.repeat(4001) }]) {
      await fails(newThread(s, body), 400);
    }
    await ok(s.postJson('/api/ask', { key, text: 'hello' }));
  }));

  test('free text is HTML escaped and cannot inject tokens', T, () => withServer({}, async s => {
    const first = await ok(newThread(s, { text: '<img src=x onerror=1>' }));
    const r = await ok(s.postJson('/api/ask', { key: first.thread.key, text: 'show {f:anything} and {n:spouse}' }));
    const mine = r.scenario.live.conversations[first.thread.key].filter(m => m.role === 'me').map(m => m.text);
    assert.equal(mine.length, 2);
    assert.ok(!mine[0].includes('<img'), mine[0]);
    assert.ok(mine[0].includes('&lt;img'), mine[0]);
    assert.ok(!mine[1].includes('{f:') && !mine[1].includes('{n:'), mine[1]);
    assert.ok(mine[1].includes('&#123;f:anything&#125;'), mine[1]);
    const raw = (await s.request({ path: '/api/scenario' })).text;
    assert.ok(!raw.includes('{f:anything}'));
    assert.ok(!raw.includes('<img src=x'));
  }));
});

describe('onboarding and demo reset', () => {
  test('onboarding step persists and step 6 completes it', T2, async () => {
    const s = await spawnAuthenticatedServer({ env: { FATHOM_DEMO: '0' } });
    try {
      const first = await s.getScenario();
      assert.equal(first.live.demo, 'fresh');
      const { scenario } = await ok(s.postJson('/api/onboarding', { step: 3 }));
      assert.equal(scenario.live.onboardStep, 3);
      assert.equal(scenario.live.demo, 'fresh');
      await fails(s.postJson('/api/onboarding', { step: 7 }), 400);
      await fails(s.postJson('/api/onboarding', { step: -1 }), 400);
      await fails(s.postJson('/api/onboarding', { step: 'x' }), 400);
    } finally {
      await s.stop();
    }
    const s2 = await spawnAuthenticatedServer({ dataDir: s.dataDir, env: { FATHOM_DEMO: '0' } });
    try {
      assert.equal((await s2.getScenario()).live.onboardStep, 3, 'step persists');
      const { scenario } = await ok(s2.postJson('/api/onboarding', { step: 6 }));
      assert.equal(scenario.live.demo, 'november');
    } finally {
      await s2.stop();
    }
    await withAuthenticatedServer({ dataDir: s.dataDir, env: { FATHOM_DEMO: '0' } }, async s3 => {
      assert.equal((await s3.getScenario()).live.demo, 'november', 'completion persists');
    });
  });

  test('demo reset restores the November store', T, () => withServer({}, async s => {
    const initial = await s.getScenario();
    await ok(act(s, 'deferral', 'complete'));
    await ok(s.postJson('/api/engine', { on: false }));
    const asked = await ok(newThread(s, { text: 'hello' }));
    const { scenario } = await ok(s.postJson('/api/demo/reset', {}));
    assert.equal(recOf(scenario, 'deferral').status, 'proposed');
    assert.equal(scenario.live.engine, true);
    assert.deepEqual(scenario.live.conversations[asked.thread.key] || [], []);
    assert.deepEqual(scenario.live.threads, [], 'demo reset clears threads');
    assert.deepEqual(scenario.recs.map(r => [r.id, r.status]), initial.recs.map(r => [r.id, r.status]));
  }));
});

describe('store modes', () => {
  test('a demo store restarts without reseeding, also with FATHOM_DEMO=1', T2, async () => {
    const s = await spawnServer();
    try {
      await ok(act(s, 'dcfsa', 'dismiss'));
    } finally {
      await s.stop();
    }
    for (const env of [{}, { FATHOM_DEMO: '1' }]) {
      await withServer({ dataDir: s.dataDir, env }, async s2 => {
        const sc = await s2.getScenario();
        assert.equal(sc.live.mode, 'demo');
        assert.equal(recOf(sc, 'dcfsa').status, 'dismissed');
      });
    }
  });

  test('FATHOM_DEMO=0 refuses a demo store and changes nothing', T2, async () => {
    const s = await spawnServer();
    await s.stop();
    const before = await dumpStore(s.dbFile);
    const r = await expectServerExit({ dataDir: s.dataDir, env: { FATHOM_DEMO: '0' } });
    assert.equal(r.started, false, 'server must not start');
    assert.notEqual(r.code, 0);
    assert.match(r.output, /demo/i);
    assert.deepEqual(await dumpStore(s.dbFile), before);
  });

  test('a populated real store survives npm start with FATHOM_DEMO unset and 0', T2, async () => {
    const { dataDir, file } = await populatedRealStore();
    for (const env of [{ FATHOM_DEMO: undefined }, { FATHOM_DEMO: '0' }]) {
      await withAuthenticatedServer({ dataDir, env, npm: env.FATHOM_DEMO === undefined }, async s => {
        const sc = await s.getScenario();
        assert.equal(sc.live.mode, 'real');
        assert.deepEqual(await nonPlannerRecs(file, sc), [], 'no seeded recs');
        assert.equal(sc.live.demo, 'november', 'onboarding setting kept');
        assert.ok(sc.live.conversations[STORE_THREAD].some(m => m.text.includes('Synthetic note for the store test.')));
      });
    }
    await readDb(file, db => {
      assert.equal(db.prepare("SELECT value FROM facts WHERE key = 'household.dependents'").get().value, '2');
      assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM files').get().n, 0);
    });
  });

  test('FATHOM_DEMO=1 refuses a real store and changes nothing', T2, async () => {
    const { dataDir, file } = await populatedRealStore();
    const before = await dumpStore(file);
    const r = await expectServerExit({ dataDir, env: { FATHOM_DEMO: '1' } });
    assert.equal(r.started, false, 'server must not start');
    assert.notEqual(r.code, 0);
    assert.match(r.output, /real/i);
    assert.deepEqual(await dumpStore(file), before);
  });

  test('demo reset and seed:demo refuse a real store and change nothing', T2, async () => {
    const { dataDir, file } = await populatedRealStore();
    await withAuthenticatedServer({ dataDir, env: { FATHOM_DEMO: '0' } }, async s => {
      const before = await dumpStore(file);
      await fails(s.postJson('/api/demo/reset', {}), 404);
      assert.deepEqual(await dumpStore(file), before);
    });
    const before = await dumpStore(file);
    const seed = await runCommand('npm', ['run', 'seed:demo'], { env: { FATHOM_DATA: dataDir } });
    assert.notEqual(seed.code, 0);
    assert.deepEqual(await dumpStore(file), before);
  });

  test('a store file with no mode setting is treated as real', T2, async () => {
    // A migrated instance (store plus platform.sqlite) whose store carries no mode row.
    const t = await tempInstance({ mode: 'real' });
    t.db.prepare("DELETE FROM settings WHERE key = 'mode'").run();
    assert.equal(t.db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'mode'").get().n, 0);
    t.close();
    await withAuthenticatedServer({ dataDir: t.dataDir }, async s => {
      const sc = await s.getScenario();
      assert.equal(sc.live.mode, 'real');
      assert.deepEqual(await nonPlannerRecs(t.file, sc), [], 'no seeded recs');
    });
    const before = await dumpStore(t.file);
    const r = await expectServerExit({ dataDir: t.dataDir, env: { FATHOM_DEMO: '1' } });
    assert.equal(r.started, false);
    assert.notEqual(r.code, 0);
    assert.deepEqual(await dumpStore(t.file), before);
  });
});

describe('FATHOM_CLOCK', () => {
  test('a January server opens the 2027 salary decision and shifts windows; the stored clock is kept', T2, async () => {
    const s = await spawnServer();
    const nov = await s.getScenario();
    await s.stop();
    await withServer({ dataDir: s.dataDir, env: { FATHOM_CLOCK: '2027-01-05' } }, async j => {
      const jan = await j.getScenario();
      assert.equal(jan.meta.clock, '2027-01-05');
      assert.equal(jan.live.clock, '2027-01-05');
      assert.equal(jan.decisions.find(d => d.id === 'salary27').status, 'open');
      assert.equal(jan.wargame.salary.status, 'open');
      for (const r of nov.recs.filter(x => x.window && typeof x.window.days === 'number' && x.status !== 'hidden')) {
        assert.equal(recOf(jan, r.id).window.days, r.window.days - 61, r.id);
      }
    });
    await withServer({ dataDir: s.dataDir }, async s2 => {
      const back = await s2.getScenario();
      assert.equal(back.meta.clock, '2026-11-05');
      assert.equal(back.decisions.find(d => d.id === 'salary27').status, 'upcoming');
    });
  });
});

describe('HTTP guards', () => {
  let s;
  before(async () => { s = await spawnServer(); }, T);
  after(async () => { if (s) await s.stop(); });

  test('POST without a JSON content type is 415; JSON with a charset is accepted', async () => {
    await fails(s.request({ method: 'POST', path: '/api/engine', headers: { 'content-type': 'text/plain' }, body: '{"on":true}' }), 415);
    await fails(s.request({ method: 'POST', path: '/api/engine', body: '{"on":true}' }), 415);
    await fails(s.request({ method: 'POST', path: '/api/engine', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'on=true' }), 415);
    await ok(s.request({ method: 'POST', path: '/api/engine', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"on":true}' }));
  });

  test('a cross-origin POST is 403; same-origin and no-origin POSTs are accepted', async () => {
    const host = new URL(s.baseUrl).host;
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${Number(s.port) + 1}`, `http://evil.example:${s.port}`]) {
      await fails(s.postJson('/api/engine', { on: true }, { origin }), 403);
    }
    await ok(s.postJson('/api/engine', { on: true }, { origin: `http://${host}` }));
    await ok(s.postJson('/api/engine', { on: true }));
  });

  test('a body over 64 KiB is 413; a large body under the cap is not', async () => {
    const big = JSON.stringify({ on: true, pad: 'x'.repeat(64 * 1024) });
    await fails(s.postJson('/api/engine', big), 413);
    const under = JSON.stringify({ text: 'y'.repeat(60 * 1024) });
    const r = await s.postJson('/api/ask', under);
    assert.notEqual(r.status, 413);
  });

  test('malformed JSON is 400', async () => {
    await fails(s.postJson('/api/engine', '{"on":'), 400);
  });

  test('unknown API path is 404 JSON and a wrong method is 405', async () => {
    await fails(s.request({ path: '/api/no-such-thing' }), 404);
    await fails(s.postJson('/api/no-such-thing', {}), 404);
    await fails(s.request({ path: '/api/engine' }), 405);
    await fails(s.postJson('/api/scenario', {}), 405);
    await fails(s.request({ method: 'DELETE', path: '/api/recs/deferral/action' }), 405);
    assert.equal((await s.request({ path: '/api/scenario' })).status, 200);
  });

  test('responses carry the security headers', async () => {
    const api = await s.request({ path: '/api/scenario' });
    assert.equal(api.headers['x-content-type-options'], 'nosniff');
    assert.match(api.headers['cache-control'] || '', /no-store/);
    assert.match(api.headers['content-type'], /application\/json/);
    const page = await s.request({ path: '/' });
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    const csp = page.headers['content-security-policy'] || '';
    for (const d of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
      assert.ok(csp.includes(d), `CSP has ${d}`);
    }
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts');
  });

  test('path traversal returns 404, never the file', async () => {
    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    const paths = [
      '/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/..%2fpackage.json',
      '/shared/../../package.json', '/shared/%2e%2e/%2e%2e/package.json', '/core/..%2f..%2fpackage.json',
      '/shared/..%2f..%2fsrc%2fserver.mjs',
    ];
    for (const p of paths) {
      const r = await s.request({ path: p });
      assert.equal(r.status, 404, `${p} -> ${r.status}`);
      assert.ok(!r.text.includes('"seed:demo"') && r.text !== pkg, `${p} leaked package.json`);
    }
    const server = readFileSync(join(ROOT, 'src/server.mjs'), 'utf8');
    for (const p of ['/src/server.mjs', '/package.json', '/demo/seed.mjs']) {
      const r = await s.request({ path: p });
      assert.ok(r.text !== server && !r.text.includes('"seed:demo"') && !r.text.includes('seedDemo'), `${p} served a file outside web/`);
    }
  });

  test('static files and shared modules are served, and app routes fall back to index.html', async () => {
    const rules = await s.request({ path: '/shared/rules.mjs' });
    assert.equal(rules.status, 200);
    assert.match(rules.headers['content-type'], /javascript/);
    assert.match(rules.text, /needsRule/);
    const core = await s.request({ path: '/core/core.js' });
    assert.equal(core.status, 200);
    assert.match(core.headers['content-type'], /javascript/);
    const css = await s.request({ path: '/horizon/design.css' });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    const fallback = await s.request({ path: '/plan' });
    assert.equal(fallback.status, 200);
    assert.match(fallback.text, /<div id="app"/);
  });
});

describe('static symlinks', () => {
  // createHandler takes a webDir option, so serve a temp copy of web/ in-process.
  let srv, base, td, secretText, indexText;
  before(async () => {
    td = await tempDb();
    const root = await tempDir();
    const webDir = join(root, 'web');
    cpSync(join(ROOT, 'web'), webDir, { recursive: true });
    secretText = 'TOP-SECRET-OUTSIDE-ROOT';
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, secretText);
    symlinkSync(outside, join(webDir, 'leak.txt'));
    symlinkSync(join(webDir, 'index.html'), join(webDir, 'alias.html'));
    indexText = readFileSync(join(webDir, 'index.html'), 'utf8');
    srv = await serveAppFixture({ authenticated: true, db: td.db, config: { dataDir: td.dataDir }, webDir });
    base = srv.baseUrl;
  }, T);
  after(async () => {
    if (srv) await srv.close();
    if (td) td.close();
  });

  test('a symlink to a file outside the root is a 404 and leaks nothing', async () => {
    const r = await srv.request({ path: '/leak.txt' });
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes(secretText));
  });

  test('a symlink to a file inside the root may be served', async () => {
    const r = await srv.request({ path: '/alias.html' });
    assert.equal(r.status, 200);
    assert.equal(r.text, indexText);
  });
});

describe('streamed body overflow', () => {
  let s;
  before(async () => { s = await spawnServer(); }, T);
  after(async () => { if (s) await s.stop(); });

  test('a chunked POST over 64 KiB without Content-Length is 413 and the server keeps serving', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/ask',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      let answered = false;
      req.on('response', () => { answered = true; });
      req.on('error', e => { if (!answered) reject(e); });
      const chunk = Buffer.alloc(16 * 1024, 'a');
      req.write('{"text":"');
      for (let i = 0; i < 8; i++) req.write(chunk);
      req.end('"}');
    });
    assert.equal(status, 413);
    const h = await s.request({ path: '/healthz' });
    assert.equal(h.status, 200);
  });
});

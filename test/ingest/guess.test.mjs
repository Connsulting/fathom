// AC8: engine best guesses per confirm card (plan D6, D7). Purpose 'confirm' is a single
// messages round with no tools, recorded in the ledger under 'confirm'. guessPending batches
// pending items with no guess row, keeps a guess only when it passes validation, stores a row for
// every item sent so it is never re-sent, and never answers anything. Engine off, fake mode
// without a per-call script, and an exhausted budget make no guess. Every value here is synthetic.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { src, tempDb, tempDir, runCommand, request, DB_FILE, TEST_OWNER } from '../helpers/server.mjs';
import { fixture, fixturePath, realStore, offEngine, all, one, count, NOW } from '../helpers/ingest.mjs';

let G;
let C;
let E;
let T;
let RT;
let FR;
let DB;
let P;
before(async () => {
  G = await src('src/ingest/guess.mjs');
  C = await src('src/ingest/confirm.mjs');
  E = await src('src/engine/index.mjs');
  T = await src('src/engine/tools.mjs');
  RT = await src('src/engine/runtime.mjs');
  FR = await src('src/ingest/freshness.mjs');
  DB = await src('src/store/db.mjs');
  P = await src('src/ingest/pipeline.mjs');
});

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await pause(20);
  }
  return true;
}

const pad = (i) => String(i).padStart(2, '0');
// A per-item marker in the question, and a locator cell that must never reach the model.
const marker = (i) => `Q${pad(i)}Q`;
const cellOf = (i) => `CELL-SECRET-${pad(i)}`;

// Queue n synthetic account_kind questions with no file. Item i has last4 4000 + i in its context.
function queue(db, n, { start = 1 } = {}) {
  const ids = [];
  for (let i = start; i < start + n; i++) {
    const r = C.ask(db, {
      kind: 'account_kind', subject: `acct-synthetic-${pad(i)}`, question: `What kind of account is Synthetic account ${marker(i)}?`,
      options: C.KIND_OPTIONS, context: { last4: String(4000 + i), locator: { cells: [cellOf(i)] } }, now: NOW,
    });
    assert.equal(r.queued, true);
    ids.push(r.id);
  }
  return ids;
}

// The runtime engine over the store's spend ledger, with a fixed clock, wrapped to record calls.
function runtimeEngine(db, mode = 'fake') {
  const rt = RT.createRuntimeEngine({ db, config: { engine: mode }, now: () => new Date(NOW) });
  const calls = [];
  return { mode: rt.mode, isOn: () => rt.isOn(), calls, call: (req) => { calls.push(structuredClone(req)); return rt.call(req); } };
}
const script = (guesses) => [{ text: JSON.stringify({ guesses }) }];
const guessRows = (db) => all(db, 'SELECT item_id, option_id, reason, model, ts FROM confirm_guesses ORDER BY item_id');
const rowOf = (db, id) => one(db, 'SELECT item_id, option_id, reason, model, ts FROM confirm_guesses WHERE item_id = ?', id);
const userText = (req) => {
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  assert.equal(typeof req.messages[0].content, 'string');
  return req.messages[0].content;
};

// A stub engine in live mode that counts calls. hold: the first call waits for release().
function stubEngine({ hold = false, fail = false } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    mode: 'live',
    isOn: () => true,
    calls,
    release: () => release(),
    async call(req) {
      calls.push(structuredClone(req));
      if (fail) throw new Error('synthetic model failure');
      if (hold && calls.length === 1) await gate;
      return { text: JSON.stringify({ guesses: [] }), model: 'stub', costUsd: 0.01 };
    },
    async extract() { throw new Error('no extraction in this test'); },
  };
}

describe("engine purpose 'confirm'", () => {
  const MESSAGES = [{ role: 'user', content: '{"items":[]}' }];

  test('a fake confirm call succeeds and is recorded in the ledger under confirm', async () => {
    const ledger = E.createMemoryLedger();
    const engine = E.createEngine({ mode: 'fake', ledger });
    const text = JSON.stringify({ guesses: [] });
    const out = await engine.call({ purpose: 'confirm', system: 'Synthetic guess system', messages: MESSAGES, maxTokens: 2048, fake: [{ text }] });
    assert.equal(out.text, text);
    assert.equal(out.model, 'fake');
    assert.deepEqual(ledger.entries.map((e) => e.purpose), ['confirm']);
  });

  test('a confirm call offers no tools and runs no tool loop', async () => {
    let ran = 0;
    const probe = {
      name: 'probe', scope: 'read', description: 'Synthetic probe tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => { ran += 1; return { ok: true }; },
    };
    assert.deepEqual(T.createRegistryServer([probe], { purpose: 'confirm' }).names, [], 'the registry offers nothing for confirm');
    const ledger = E.createMemoryLedger();
    const engine = E.createEngine({ mode: 'fake', ledger });
    const text = JSON.stringify({ guesses: [] });
    // One script only: a tool loop would need a second round and fail on the empty queue.
    const out = await engine.call({ purpose: 'confirm', messages: MESSAGES, maxTokens: 2048, tools: [probe], fake: [{ text, toolCalls: [{ name: 'probe', args: {} }] }] });
    assert.equal(out.text, text);
    assert.equal(ran, 0, 'the tool handler never runs');
    assert.equal(ledger.entries.length, 1, 'one round');
  });

  test('an unknown purpose still throws Invalid call purpose', async () => {
    const engine = E.createEngine({ mode: 'fake' });
    await assert.rejects(engine.call({ purpose: 'guess', messages: MESSAGES, fake: [{ text: '{}' }] }), { name: 'TypeError', message: 'Invalid call purpose' });
  });
});

describe('guessPending', () => {
  test('stores valid guesses with option, reason, model and ts; the scenario items carry guess and fileName', () => withStore(async (s) => {
    const off = await offEngine();
    const r = await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(off));
    assert.equal(r.status, 'imported');
    const pending = C.pendingItems(s.db);
    const owner = pending.find((i) => i.kind === 'account_owner');
    const kind = pending.find((i) => i.kind === 'account_kind');
    assert.ok(owner && kind);
    const engine = runtimeEngine(s.db);
    const guesses = [
      { item: owner.id, option: 'owner', reason: 'Named like a personal account' },
      { item: kind.id, option: 'checking', reason: 'The export reads like a checking account' },
    ];
    const out = await G.guessPending(s.db, engine, { now: NOW, fake: [script(guesses)] });

    assert.equal(engine.calls.length, 1);
    const req = engine.calls[0];
    assert.equal(req.purpose, 'confirm');
    assert.equal(req.maxTokens, 2048);
    assert.deepEqual(req.schema, G.GUESS_SCHEMA);
    assert.ok(!req.tools || req.tools.length === 0, 'no tools are sent');
    assert.equal(typeof req.system, 'string');
    JSON.parse(userText(req));

    assert.equal(out.batches.length, 1);
    assert.equal(out.batches[0].guessed, 2);
    assert.equal(out.batches[0].model, 'fake');
    assert.equal(rowOf(s.db, owner.id).option_id, 'owner');
    assert.deepEqual(rowOf(s.db, kind.id), { item_id: kind.id, option_id: 'checking', reason: guesses[1].reason, model: 'fake', ts: NOW });
    assert.equal(count(s.db, 'confirm_guesses'), pending.length, 'a row for every item sent');
    assert.equal(count(s.db, 'spend_ledger', "purpose = 'confirm'"), 1, 'the cost is recorded under confirm');

    const items = FR.ingestState(s.db).items;
    const byId = (id) => items.find((i) => i.id === id);
    assert.deepEqual(byId(owner.id).guess, { option: 'owner', label: 'You', reason: guesses[0].reason, model: 'fake', ts: NOW });
    assert.deepEqual(byId(kind.id).guess, { option: 'checking', label: 'Checking', reason: guesses[1].reason, model: 'fake', ts: NOW });
    for (const i of items) assert.equal(i.fileName, 'Chase7766_Activity_20320305.csv');
  }));

  test('the scenario guess is null when the stored row has no option or an option no longer offered', () => withStore(async (s) => {
    const [a, b, c] = queue(s.db, 3);
    const insert = s.db.prepare('INSERT INTO confirm_guesses (item_id, option_id, reason, model, ts) VALUES (?, ?, ?, ?, ?)');
    insert.run(a, null, null, 'fake', NOW);
    insert.run(b, 'retired-option', 'Synthetic reason', 'fake', NOW);
    insert.run(c, 'cash', 'Synthetic reason', 'fake', NOW);
    const items = FR.ingestState(s.db).items;
    const byId = (id) => items.find((i) => i.id === id);
    assert.equal(byId(a).guess, null);
    assert.equal(byId(b).guess, null);
    assert.deepEqual(byId(c).guess, { option: 'cash', label: 'Savings or cash', reason: 'Synthetic reason', model: 'fake', ts: NOW });
    for (const i of items) assert.equal(i.fileName, null, 'an item with no file has no file name');
  }));

  test('validation drops bad guesses, stores a null row for each, and never re-sends the batch', () => withStore(async (s) => {
    const ids = queue(s.db, 11);
    const id = (i) => ids[i - 1];
    const [answered] = queue(s.db, 1, { start: 12 });
    C.answerItem(s.db, answered, 'checking', { now: NOW });
    const guesses = [
      { item: id(1), option: 'not-an-option', reason: 'Synthetic reason' },
      { item: 999999, option: 'checking', reason: 'Not in the batch' },
      { item: answered, option: 'card', reason: 'Answered items are not in the batch' },
      { item: id(3), option: 'checking', reason: 'First line\nsecond line' },
      { item: id(4), option: 'checking', reason: '' },
      { item: id(5), option: 'checking', reason: 'x'.repeat(161) },
      { item: id(6), option: 'card', reason: 'Ends in 9999 like a card' },
      { item: id(7), option: 'checking', reason: 'Ends in 4007 like the checking export' },
      { item: id(8), option: '529', reason: 'Reads like a 529 plan' },
      { item: id(9), option: 'checking', reason: 'Ends in 4007 like another account' },
      { item: id(10), option: 'checking', reason: 'Named like a checking account' },
      { item: id(11), option: 'cash', reason: 'y'.repeat(160) },
    ];
    const engine = runtimeEngine(s.db);
    await G.guessPending(s.db, engine, { now: NOW, fake: [script(guesses)] });
    assert.equal(engine.calls.length, 1);

    const kept = { [id(7)]: 'checking', [id(8)]: '529', [id(10)]: 'checking', [id(11)]: 'cash' };
    const rows = guessRows(s.db);
    assert.deepEqual(rows.map((r) => r.item_id), ids, 'a row for every item sent and none for items outside the batch');
    for (const r of rows) {
      assert.equal(r.option_id, kept[r.item_id] ?? null, `item ${r.item_id}`);
      assert.equal(r.model, 'fake');
      assert.equal(r.ts, NOW);
    }
    assert.equal(rowOf(s.db, id(7)).reason, 'Ends in 4007 like the checking export', 'a number from its own context is kept');
    assert.equal(rowOf(s.db, id(8)).reason, 'Reads like a 529 plan', 'a number from its own option labels is kept');
    assert.equal(rowOf(s.db, 999999), undefined);
    assert.equal(rowOf(s.db, answered), undefined);

    const second = runtimeEngine(s.db);
    const again = await G.guessPending(s.db, second, { now: NOW, fake: [] });
    assert.equal(second.calls.length, 0, 'nothing is re-sent');
    assert.ok(again.skipped === 'none_pending' || (Array.isArray(again.batches) && again.batches.length === 0), JSON.stringify(again));
    assert.equal(count(s.db, 'confirm_guesses'), ids.length);
    assert.equal(count(s.db, 'spend_ledger', "purpose = 'confirm'"), 1);
  }));

  test('validateGuesses keeps only guesses that pass every rule', () => withStore(async (s) => {
    const [a, b] = queue(s.db, 2);
    const batch = C.pendingItems(s.db);
    const accepted = G.validateGuesses(batch, { guesses: [
      { item: a, option: 'checking', reason: 'Ends in 4001' },
      { item: b, option: 'checking', reason: 'Ends in 4001' },
      { item: 999999, option: 'checking', reason: 'Synthetic reason' },
    ] });
    assert.deepEqual(accepted, [{ item: a, option: 'checking', reason: 'Ends in 4001' }]);
  }));

  test('25 pending items with batchSize 20 make two calls, each carrying only its own items with no locator', () => withStore(async (s) => {
    const ids = queue(s.db, 25);
    const engine = runtimeEngine(s.db);
    const out = await G.guessPending(s.db, engine, { now: NOW, batchSize: 20, fake: [script([]), script([])] });
    assert.equal(engine.calls.length, 2);
    assert.equal(out.batches.length, 2);
    const sent = engine.calls.map((req) => ids.filter((_, k) => userText(req).includes(marker(k + 1))));
    assert.deepEqual(sent.map((list) => list.length).sort((x, y) => x - y), [5, 20]);
    assert.deepEqual([...sent[0], ...sent[1]].sort((x, y) => x - y), ids, 'every item is sent exactly once');
    for (const req of engine.calls) {
      const text = userText(req);
      assert.ok(!text.includes('CELL-SECRET'), 'no locator cell is sent');
      assert.ok(!text.includes('"locator"'), 'no locator key is sent');
      // Each item's payload is the object holding its question; it carries no other item's marker.
      const payloads = [];
      const walk = (v) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          if (Object.values(v).some((x) => typeof x === 'string' && /^What kind of account is Synthetic account Q\d{2}Q\?$/.test(x))) payloads.push(v);
          Object.values(v).forEach(walk);
        }
      };
      walk(JSON.parse(text));
      assert.ok(payloads.length > 0, 'item payloads are found by their question');
      for (const p of payloads) {
        const own = JSON.stringify(p).match(/Q\d{2}Q/g);
        assert.equal(new Set(own).size, 1, `one item's data per payload, got ${[...new Set(own)].join(',')}`);
      }
    }
    assert.equal(count(s.db, 'confirm_guesses'), 25);
    assert.equal(count(s.db, 'spend_ledger', "purpose = 'confirm'"), 2);
  }));

  test('a guess never answers: every item stays pending', () => withStore(async (s) => {
    const ids = queue(s.db, 3);
    const engine = runtimeEngine(s.db);
    await G.guessPending(s.db, engine, { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', reason: 'Named like a checking account' })))] });
    assert.equal(count(s.db, 'confirm_guesses', 'option_id IS NOT NULL'), 3, 'precondition: every guess was kept');
    for (const id of ids) {
      assert.deepEqual(one(s.db, 'SELECT status, answer, answered_at FROM confirm_items WHERE id = ?', id), { status: 'pending', answer: null, answered_at: null });
    }
    assert.deepEqual(C.pendingItems(s.db).map((i) => i.id), ids);
  }));
});

describe('guessPending makes no guess when it must not', () => {
  test('engine setting off: skipped engine_off, no call and no ledger row', () => withStore(async (s) => {
    queue(s.db, 2);
    DB.setSetting(s.db, 'engine', { on: false });
    const engine = runtimeEngine(s.db);
    const out = await G.guessPending(s.db, engine, { now: NOW, fake: [script([])] });
    assert.deepEqual(out, { skipped: 'engine_off' });
    assert.equal(engine.calls.length, 0);
    assert.equal(count(s.db, 'spend_ledger'), 0);
    assert.equal(count(s.db, 'confirm_guesses'), 0);
  }));

  test('fake mode with no per-call script: skipped not_live, no call and no ledger row', () => withStore(async (s) => {
    queue(s.db, 2);
    const engine = runtimeEngine(s.db);
    const out = await G.guessPending(s.db, engine, { now: NOW });
    assert.deepEqual(out, { skipped: 'not_live' });
    assert.equal(engine.calls.length, 0);
    assert.equal(count(s.db, 'spend_ledger'), 0);
    assert.equal(count(s.db, 'confirm_guesses'), 0);
  }));

  test('engine mode off gives no guess', () => withStore(async (s) => {
    const ids = queue(s.db, 2);
    const engine = runtimeEngine(s.db, 'off');
    const out = await G.guessPending(s.db, engine, { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', reason: 'Synthetic reason' })))] });
    assert.equal(out.skipped, 'engine_off');
    assert.equal(engine.calls.length, 0);
    assert.equal(count(s.db, 'confirm_guesses'), 0);
    assert.ok(FR.ingestState(s.db).items.every((i) => i.guess === null));
  }));

  test('a zero monthly cap stops the run with no stored guesses', () => withStore(async (s) => {
    const ids = queue(s.db, 2);
    DB.setSetting(s.db, 'cap', { usd: 0 });
    const out = await G.guessPending(s.db, runtimeEngine(s.db), { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', reason: 'Synthetic reason' })))] });
    assert.equal(typeof out.stopped, 'string', JSON.stringify(out));
    assert.equal(count(s.db, 'confirm_guesses'), 0);
    assert.equal(count(s.db, 'spend_ledger'), 0);
  }));

  test('a month already spent past the cap stops the run with no stored guesses', () => withStore(async (s) => {
    const ids = queue(s.db, 2);
    s.db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)')
      .run(NOW, NOW.slice(0, 7), 'chat', 250, 'fake', '{}');
    const out = await G.guessPending(s.db, runtimeEngine(s.db), { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', reason: 'Synthetic reason' })))] });
    assert.equal(typeof out.stopped, 'string', JSON.stringify(out));
    assert.equal(count(s.db, 'confirm_guesses'), 0);
    assert.equal(count(s.db, 'spend_ledger'), 1, 'nothing more is spent');
    assert.ok(C.pendingItems(s.db).length === 2);
  }));

  test('a model call error stops the run and stores nothing', () => withStore(async (s) => {
    queue(s.db, 2);
    const engine = stubEngine({ fail: true });
    const out = await G.guessPending(s.db, engine, { now: NOW });
    assert.equal(engine.calls.length, 1);
    assert.equal(typeof out.stopped, 'string', JSON.stringify(out));
    assert.equal(count(s.db, 'confirm_guesses'), 0);
  }));
});

describe('scheduleGuesses', () => {
  test('single flight: overlapping triggers run one batch at a time and rerun once', () => withStore(async (s) => {
    queue(s.db, 3);
    const engine = stubEngine({ hold: true });
    const p1 = G.scheduleGuesses(s.db, engine);
    assert.equal(typeof p1?.then, 'function', 'scheduleGuesses returns a promise');
    assert.ok(await waitFor(() => engine.calls.length === 1), 'the first run calls the engine');
    const p2 = G.scheduleGuesses(s.db, engine);
    const p3 = G.scheduleGuesses(s.db, engine);
    await pause(50);
    assert.equal(engine.calls.length, 1, 'no second run while one is in flight');
    const [late] = queue(s.db, 1, { start: 4 });
    engine.release();
    await Promise.all([p1, p2, p3]);
    assert.ok(await waitFor(() => rowOf(s.db, late) !== undefined), 'the rerun guesses the item queued meanwhile');
    await pause(50);
    assert.equal(engine.calls.length, 2, 'one in-flight run plus exactly one rerun');
    const rerun = userText(engine.calls[1]);
    assert.ok(rerun.includes(marker(4)) && !rerun.includes(marker(1)), 'the rerun sends only the new item');
    assert.equal(count(s.db, 'confirm_guesses'), 4);
    assert.equal(rowOf(s.db, late).model, 'stub');
  }));

  test('a failing run is swallowed and stores nothing', () => withStore(async (s) => {
    queue(s.db, 2);
    const engine = stubEngine({ fail: true });
    await G.scheduleGuesses(s.db, engine);
    assert.equal(engine.calls.length, 1);
    assert.equal(count(s.db, 'confirm_guesses'), 0);
  }));

  test('an upload that imports a file schedules guesses for its questions', () => withStore(async (s) => {
    const { createHandler } = await src('src/api/router.mjs');
    const engine = stubEngine();
    const config = { ...s.config, ownerLogins: TEST_OWNER, ownerLoginsFile: null };
    const server = http.createServer(createHandler({ db: s.db, config, engine }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const boundary = 'fathom-guess-test-boundary';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="Chase7766_Activity_20320305.csv"\r\nContent-Type: text/csv\r\n\r\n`),
        readFileSync(fixturePath('Chase7766_Activity_20320305.csv')),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const r = await request(base, { method: 'POST', path: '/api/files', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const pending = C.pendingItems(s.db).length;
      assert.ok(pending > 0, 'the upload asked questions');
      assert.ok(await waitFor(() => count(s.db, 'confirm_guesses') === pending, 5000), 'every new question gets a guess row');
      assert.ok(engine.calls.length >= 1);
      assert.ok(engine.calls.every((req) => req.purpose === 'confirm'));
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  }));
});

describe('guess CLI', () => {
  test('on a real store with the engine off it exits 0 and prints one JSON line with skipped', async () => {
    const store = await tempDb();
    try {
      DB.setSetting(store.db, 'mode', 'real');
      queue(store.db, 1);
      store.close();
      const r = await runCommand(process.execPath, ['src/jobs/guess-cli.mjs'], { env: { FATHOM_DATA: store.dataDir, FATHOM_ENGINE: 'off', FATHOM_DEMO: '0' } });
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 1, r.stdout);
      assert.equal(JSON.parse(lines[0]).skipped, 'engine_off');
    } finally {
      rmSync(store.dataDir, { recursive: true, force: true });
    }
  });

  test('with no store in FATHOM_DATA it exits 1 and creates nothing', async () => {
    const dir = await tempDir('fathom-guess-empty-');
    try {
      const r = await runCommand(process.execPath, ['src/jobs/guess-cli.mjs'], { env: { FATHOM_DATA: dir, FATHOM_ENGINE: 'off', FATHOM_DEMO: '0' } });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.equal(existsSync(join(dir, DB_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

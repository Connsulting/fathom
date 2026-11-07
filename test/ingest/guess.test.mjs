// AC8: engine best guesses per confirm card (plan D6, D7). Purpose 'confirm' is a single
// messages round with no tools, recorded in the ledger under 'confirm'. guessPending batches
// pending items with no guess row, keeps a guess only when it passes validation, stores a row for
// every item sent so it is never re-sent, and never answers anything. Engine off, fake mode
// without a per-call script, and an exhausted budget make no guess. Imports trigger the
// confirm-guess scheduler job (test/jobs/confirm-guess.test.mjs covers the job itself), and
// npm run confirm:guess runs that job once. Every value here is synthetic.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { src, tempDb, tempDir, runCommand, request, postJson, DB_FILE, TEST_OWNER } from '../helpers/server.mjs';
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
const FIXED_TEXTS = () => Object.values(G.REASON_TEXT);
// The scenario guess: the stored option, label, model and ts; evidence is concrete stored values
// (never a fixed sentence) and reason equals evidence.
function assertScenarioGuess(guess, { option, label, source = 'engine', model = 'fake', ts = NOW }) {
  assert.ok(guess, 'the item carries a guess');
  assert.equal(guess.option, option);
  assert.equal(guess.label, label);
  assert.equal(guess.source, source);
  assert.equal(guess.model, model);
  assert.equal(guess.ts, ts);
  assert.equal(typeof guess.evidence, 'string');
  assert.ok(guess.evidence.length > 0, 'the evidence has text');
  assert.equal(guess.reason, guess.evidence, 'reason equals evidence');
  assert.ok(!FIXED_TEXTS().includes(guess.evidence), 'the evidence is not a fixed reason sentence');
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

// A stub engine in live mode that counts calls.
function stubEngine({ fail = false } = {}) {
  const calls = [];
  return {
    mode: 'live',
    isOn: () => true,
    calls,
    async call(req) {
      calls.push(structuredClone(req));
      if (fail) throw new Error('synthetic model failure');
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
      { item: owner.id, option: 'owner', basis: 'account_name' },
      { item: kind.id, option: 'checking', basis: 'source_file' },
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
    assert.deepEqual(rowOf(s.db, kind.id), { item_id: kind.id, option_id: 'checking', reason: G.REASON_TEXT.source_file, model: 'fake', ts: NOW });
    assert.equal(count(s.db, 'confirm_guesses'), pending.length, 'a row for every item sent');
    assert.equal(count(s.db, 'spend_ledger', "purpose = 'confirm'"), 1, 'the cost is recorded under confirm');

    const items = FR.ingestState(s.db).items;
    const byId = (id) => items.find((i) => i.id === id);
    assertScenarioGuess(byId(owner.id).guess, { option: 'owner', label: 'You' });
    assertScenarioGuess(byId(kind.id).guess, { option: 'checking', label: 'Checking' });
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
    assertScenarioGuess(byId(c).guess, { option: 'cash', label: 'Savings or cash' });
    assert.notEqual(byId(c).guess.evidence, 'Synthetic reason', 'the stored reason text is not the evidence');
    for (const i of items) assert.equal(i.fileName, null, 'an item with no file has no file name');
  }));

  test('validation drops bad guesses, stores a null row for each, and never re-sends the batch', () => withStore(async (s) => {
    const ids = queue(s.db, 11);
    const id = (i) => ids[i - 1];
    const [answered] = queue(s.db, 1, { start: 12 });
    C.answerItem(s.db, answered, 'checking', { now: NOW });
    const guesses = [
      { item: id(1), option: 'not-an-option', basis: 'question' },
      { item: 999999, option: 'checking', basis: 'question' },
      { item: answered, option: 'card', basis: 'question' },
      { item: id(3), option: 'checking', basis: 'made_up' },
      { item: id(4), option: 'checking' },
      { item: id(5), option: 'checking', basis: 7 },
      { item: id(6), option: 'card', basis: 'account-name' },
      { item: id(7), option: 'checking', basis: 'imported_values', reason: 'Ends in 4007 like the checking export' },
      { item: id(8), option: '529', basis: 'question' },
      { item: id(9), option: 'checking', basis: null, reason: 'Named like another account' },
      { item: id(10), option: 'checking', basis: 'account_name' },
      { item: id(11), option: 'cash', basis: 'document_type' },
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
    assert.equal(rowOf(s.db, id(7)).reason, G.REASON_TEXT.imported_values, 'free text next to a valid basis is not stored');
    assert.equal(rowOf(s.db, id(8)).reason, G.REASON_TEXT.question);
    assert.equal(rowOf(s.db, id(10)).reason, G.REASON_TEXT.account_name);
    assert.equal(rowOf(s.db, id(11)).reason, G.REASON_TEXT.document_type);
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
      { item: a, option: 'checking', basis: 'account_name' },
      { item: b, option: 'checking', basis: 'made_up' },
      { item: 999999, option: 'checking', basis: 'question' },
    ] });
    assert.deepEqual(accepted, [{ item: a, option: 'checking', reason: G.REASON_TEXT.account_name }]);
  }));

  describe('validateGuesses takes a fixed basis code and never stores model-written text', () => {
    const OPTIONS = [{ id: 'checking', label: 'Checking' }, { id: 'cash', label: 'Savings or cash' }];
    const EXPECTED = {
      account_name: 'The account name suggests this answer.',
      institution: 'The institution and account details suggest this answer.',
      source_file: 'The source file suggests this answer.',
      question: 'The wording of the question suggests this answer.',
      imported_values: 'The values imported with this question suggest this answer.',
      document_type: 'The type of document suggests this answer.',
    };
    function queueOne(db, subject = 'acct-basis') {
      const r = C.ask(db, { kind: 'account_kind', subject, question: 'What kind of account is this synthetic account?', options: OPTIONS, context: { amount: '100' }, now: NOW });
      assert.equal(r.queued, true);
      return r.id;
    }
    const keptWith = (batch, id, extra) => G.validateGuesses(batch, { guesses: [{ item: id, option: 'checking', ...extra }] });

    test('every basis code renders its fixed text and no text holds a numeral', () => {
      assert.deepEqual([...G.REASON_CODES].sort(), Object.keys(EXPECTED).sort());
      assert.deepEqual(Object.fromEntries(G.REASON_CODES.map((c) => [c, G.REASON_TEXT[c]])), EXPECTED);
      for (const [code, text] of Object.entries(G.REASON_TEXT)) assert.ok(!/\p{N}/u.test(text), `no numeral in ${code}`);
    });

    test('GUESS_SCHEMA requires a basis enum of the reason codes and has no reason field', () => {
      const item = G.GUESS_SCHEMA.properties.guesses.items;
      assert.deepEqual(item.properties.basis.enum, [...G.REASON_CODES]);
      assert.ok(item.required.includes('basis'));
      assert.equal('reason' in item.properties, false);
      assert.equal(item.required.includes('reason'), false);
    });

    test('a guess with a valid basis keeps the fixed text for each code', () => withStore(async (s) => {
      const id = queueOne(s.db);
      const batch = C.pendingItems(s.db);
      for (const code of G.REASON_CODES) {
        assert.deepEqual(keptWith(batch, id, { basis: code }), [{ item: id, option: 'checking', reason: EXPECTED[code] }], code);
      }
    }));

    test('an unknown, missing or wrongly typed basis is dropped', () => withStore(async (s) => {
      const id = queueOne(s.db);
      const batch = C.pendingItems(s.db);
      for (const basis of ['made_up', 'Question', 'account-name', '', ' question', 'question ', 7, null, true, ['question'], { code: 'question' }]) {
        assert.deepEqual(keptWith(batch, id, { basis }), [], `dropped: ${JSON.stringify(basis)}`);
      }
      assert.deepEqual(keptWith(batch, id, {}), [], 'dropped: no basis');
      assert.deepEqual(keptWith(batch, id, { reason: 'Named like a checking account' }), [], 'dropped: free text without a basis');
    }));

    test('free text sent next to a valid basis is ignored and only the fixed text is stored', () => withStore(async (s) => {
      const id = queueOne(s.db);
      const batch = C.pendingItems(s.db);
      const out = keptWith(batch, id, { basis: 'imported_values', reason: 'The import lists 100, $100, 12.5% and one hundred thousand.', note: 'extra 250' });
      assert.deepEqual(out, [{ item: id, option: 'checking', reason: EXPECTED.imported_values }]);
      assert.equal(/\p{N}/u.test(out[0].reason), false);
      assert.deepEqual(Object.keys(out[0]).sort(), ['item', 'option', 'reason']);
    }));

    test('guessPending stores the fixed text, drops a bad basis to a null row, and ignores model-written text', () => withStore(async (s) => {
      const good = queueOne(s.db, 'acct-basis-good');
      const noisy = queueOne(s.db, 'acct-basis-noisy');
      const bad = queueOne(s.db, 'acct-basis-bad');
      const engine = runtimeEngine(s.db);
      await G.guessPending(s.db, engine, { now: NOW, fake: [script([
        { item: good, option: 'checking', basis: 'account_name' },
        { item: noisy, option: 'cash', basis: 'source_file', reason: 'The import reports $100k of income, 100 thousand.' },
        { item: bad, option: 'checking', basis: 'not_a_code', reason: 'Named like a checking account' },
      ])] });
      assert.equal(count(s.db, 'confirm_guesses'), 3, 'a row for every item sent');
      assert.deepEqual(rowOf(s.db, good), { item_id: good, option_id: 'checking', reason: EXPECTED.account_name, model: 'fake', ts: NOW });
      assert.deepEqual(rowOf(s.db, noisy), { item_id: noisy, option_id: 'cash', reason: EXPECTED.source_file, model: 'fake', ts: NOW });
      assert.equal(rowOf(s.db, bad).option_id, null);
      assert.equal(rowOf(s.db, bad).reason, null);
      for (const r of guessRows(s.db)) if (r.reason !== null) assert.equal(/\p{N}/u.test(r.reason), false);
      const items = FR.ingestState(s.db).items;
      const byId = (id) => items.find((i) => i.id === id);
      assertScenarioGuess(byId(good).guess, { option: 'checking', label: 'Checking' });
      assertScenarioGuess(byId(noisy).guess, { option: 'cash', label: 'Savings or cash' });
      assert.ok(!/100k|thousand/.test(byId(noisy).guess.evidence), 'model-written text never reaches the scenario');
      assert.equal(byId(bad).guess, null);
    }));
  });

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

  describe('guessPending returns costUsd, the run spend including failed calls, equal to the confirm ledger delta', () => {
    const confirmSpend = (db) => one(db, "SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE purpose = 'confirm'").s;
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    const empty = JSON.stringify({ guesses: [] });

    test('a normal two-batch run: costUsd is the ledger delta and the sum of the batch costs', () => withStore(async (s) => {
      queue(s.db, 25);
      const before = confirmSpend(s.db);
      const out = await G.guessPending(s.db, runtimeEngine(s.db), { now: NOW, batchSize: 20, fake: [[{ text: empty, costUsd: 0.5 }], [{ text: empty, costUsd: 0.25 }]] });
      assert.equal(out.batches.length, 2);
      assert.ok(near(out.costUsd, 0.75), `costUsd ${out.costUsd}`);
      assert.ok(near(out.costUsd, confirmSpend(s.db) - before));
      assert.ok(near(out.costUsd, out.batches.reduce((n, b) => n + b.costUsd, 0)));
    }));

    test('an unparseable response still counts its cost', () => withStore(async (s) => {
      queue(s.db, 2);
      const before = confirmSpend(s.db);
      const out = await G.guessPending(s.db, runtimeEngine(s.db), { now: NOW, fake: [[{ text: 'not json', costUsd: 0.05 }]] });
      assert.equal(out.stopped, 'bad_response');
      assert.deepEqual(out.batches, []);
      assert.ok(near(out.costUsd, 0.05), `costUsd ${out.costUsd}`);
      assert.ok(near(out.costUsd, confirmSpend(s.db) - before));
    }));

    test('a ledger-recorded failed call counts its cost, after an earlier good batch', () => withStore(async (s) => {
      queue(s.db, 25);
      const before = confirmSpend(s.db);
      const out = await G.guessPending(s.db, runtimeEngine(s.db), { now: NOW, batchSize: 20, fake: [[{ text: empty, costUsd: 0.5 }], [{ text: '', status: 'error_max_turns', costUsd: 0.25 }]] });
      assert.equal(typeof out.stopped, 'string', JSON.stringify(out));
      assert.notEqual(out.stopped, 'bad_response');
      assert.equal(out.batches.length, 1);
      assert.ok(near(out.batches[0].costUsd, 0.5));
      assert.ok(near(out.costUsd, 0.75), `costUsd ${out.costUsd}`);
      assert.ok(near(out.costUsd, confirmSpend(s.db) - before));
    }));
  });

  test('a guess never answers: every item stays pending', () => withStore(async (s) => {
    const ids = queue(s.db, 3);
    const engine = runtimeEngine(s.db);
    await G.guessPending(s.db, engine, { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', basis: 'question' })))] });
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
    const out = await G.guessPending(s.db, engine, { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', basis: 'question' })))] });
    assert.equal(out.skipped, 'engine_off');
    assert.equal(engine.calls.length, 0);
    assert.equal(count(s.db, 'confirm_guesses'), 0);
    assert.ok(FR.ingestState(s.db).items.every((i) => i.guess === null));
  }));

  test('a zero monthly cap stops the run with no stored guesses', () => withStore(async (s) => {
    const ids = queue(s.db, 2);
    DB.setSetting(s.db, 'cap', { usd: 0 });
    const out = await G.guessPending(s.db, runtimeEngine(s.db), { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', basis: 'question' })))] });
    assert.equal(typeof out.stopped, 'string', JSON.stringify(out));
    assert.equal(count(s.db, 'confirm_guesses'), 0);
    assert.equal(count(s.db, 'spend_ledger'), 0);
  }));

  test('a month already spent past the cap stops the run with no stored guesses', () => withStore(async (s) => {
    const ids = queue(s.db, 2);
    s.db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)')
      .run(NOW, NOW.slice(0, 7), 'chat', 250, 'fake', '{}');
    const out = await G.guessPending(s.db, runtimeEngine(s.db), { now: NOW, fake: [script(ids.map((item) => ({ item, option: 'checking', basis: 'question' })))] });
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

describe('imports trigger the confirm-guess job through the scheduler', () => {
  const HEADERS = ['posted on', 'memo text', 'value usd'];
  const novelCsv = () => [HEADERS.join(','), '2032-03-02,SYNTH NOVEL A,-1.25', '2032-03-03,SYNTH NOVEL B,-2.25'].join('\n') + '\n';
  const MAPPING = { target: 'transaction', date: 'posted on', amount: 'value usd', description: 'memo text', amountSign: 'as_is', dateOrder: 'ymd' };

  // Records every trigger; runs nothing.
  function fakeScheduler() {
    const calls = [];
    return {
      calls,
      trigger(jobId, reason) { calls.push([jobId, reason]); return Promise.resolve(null); },
      runNow() { throw new Error('not used'); },
      jobs: () => [],
      runs: () => [],
      start() {},
      stop() {},
    };
  }
  const sorted = (calls) => [...calls].sort((a, b) => a[0].localeCompare(b[0]));

  async function serve(s, engine, scheduler) {
    const { createHandler } = await src('src/api/router.mjs');
    const config = { ...s.config, ownerLogins: TEST_OWNER, ownerLoginsFile: null };
    const server = http.createServer(createHandler({ db: s.db, config, engine, scheduler }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
    };
  }

  function multipart(name, bytes, mime = 'text/csv') {
    const boundary = 'fathom-guess-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { method: 'POST', path: '/api/files', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body };
  }

  test('scheduleGuesses is gone: the scheduler job is the only guess runner', () => {
    assert.equal('scheduleGuesses' in G, false);
  });

  test('an upload that imports a file triggers confirm-guess and plan, and guesses nothing itself', () => withStore(async (s) => {
    const engine = stubEngine();
    const scheduler = fakeScheduler();
    const app = await serve(s, engine, scheduler);
    try {
      const r = await request(app.base, multipart('Chase7766_Activity_20320305.csv', readFileSync(fixturePath('Chase7766_Activity_20320305.csv'))));
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.json.files[0].status, 'imported');
      assert.ok(C.pendingItems(s.db).length > 0, 'the upload asked questions');
      assert.deepEqual(sorted(scheduler.calls), [['confirm-guess', 'ingest'], ['plan', 'ingest']], 'one trigger each');
      await pause(100);
      assert.equal(count(s.db, 'confirm_guesses'), 0, 'no guess outside the scheduler job');
      assert.ok(engine.calls.every((req) => req.purpose !== 'confirm'), 'no confirm call outside the scheduler job');
    } finally {
      await app.close();
    }
  }));

  test('an upload that imports nothing triggers nothing; a retry that imports triggers confirm-guess and plan', () => withStore(async (s) => {
    const { headerSignature } = await src('src/ingest/mapping.mjs');
    const scheduler = fakeScheduler();
    const app = await serve(s, await offEngine(), scheduler);
    try {
      const waiting = await request(app.base, multipart('novel-export.csv', novelCsv()));
      assert.equal(waiting.status, 200, waiting.text.slice(0, 300));
      const file = waiting.json.files[0];
      assert.equal(file.status, 'needs_mapping');
      assert.deepEqual(scheduler.calls, [], 'an upload that imports nothing does not trigger');

      const stillWaiting = await postJson(app.base, `/api/files/${file.fileId}/retry`, {});
      assert.equal(stillWaiting.status, 200, stillWaiting.text.slice(0, 300));
      assert.equal(stillWaiting.json.file.status, 'needs_mapping');
      assert.deepEqual(scheduler.calls, [], 'an unsuccessful retry does not trigger');

      s.db.prepare("INSERT INTO column_mappings (signature, mapping, src, created_at, uses) VALUES (?, ?, 'test', ?, 0)")
        .run(headerSignature(HEADERS), JSON.stringify(MAPPING), NOW);
      const done = await postJson(app.base, `/api/files/${file.fileId}/retry`, {});
      assert.equal(done.status, 200, done.text.slice(0, 300));
      assert.equal(done.json.file.status, 'imported');
      assert.deepEqual(sorted(scheduler.calls), [['confirm-guess', 'ingest'], ['plan', 'ingest']], 'a successful retry triggers each once');
    } finally {
      await app.close();
    }
  }));

  test('a trigger that rejects never fails the upload', () => withStore(async (s) => {
    const calls = [];
    const scheduler = {
      trigger(jobId) { calls.push(jobId); return Promise.reject(new Error('synthetic rejection')); },
      runNow() { throw new Error('not used'); }, jobs: () => [], runs: () => [], start() {}, stop() {},
    };
    const app = await serve(s, await offEngine(), scheduler);
    try {
      const r = await request(app.base, multipart('Chase7766_Activity_20320305.csv', readFileSync(fixturePath('Chase7766_Activity_20320305.csv'))));
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.json.files[0].status, 'imported');
      assert.deepEqual([...calls].sort(), ['confirm-guess', 'plan']);
    } finally {
      await app.close();
    }
  }));
});

describe('guess CLI (npm run confirm:guess runs the confirm-guess job once through the scheduler)', () => {
  test('on a migrated real store with the engine off it exits 0, prints one JSON line with a skipped status, and records the run', async () => {
    const store = await tempDb();
    try {
      DB.setSetting(store.db, 'mode', 'real');
      queue(store.db, 1);
      store.close();
      const r = await runCommand(process.execPath, ['src/jobs/guess-cli.mjs'], { env: { FATHOM_DATA: store.dataDir, FATHOM_ENGINE: 'off', FATHOM_DEMO: '0' } });
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 1, r.stdout);
      const out = JSON.parse(lines[0]);
      assert.equal(out.status, 'skipped');
      assert.deepEqual(out.note, { pending: 1 });
      assert.ok(!r.stdout.includes('Synthetic account'), 'no question text is printed');
      const db = DB.openDb(join(store.dataDir, DB_FILE));
      try {
        const runs = db.prepare("SELECT status, trigger, period_key FROM job_runs WHERE job_id = 'confirm-guess'").all().map((x) => ({ ...x }));
        assert.equal(runs.length, 1, 'one job_runs row for the CLI run');
        assert.equal(runs[0].status, 'skipped');
        assert.equal(runs[0].trigger, 'manual');
        assert.match(runs[0].period_key, /^manual:/);
        assert.equal(db.prepare('SELECT count(*) AS n FROM confirm_guesses').get().n, 0);
      } finally { db.close(); }
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
